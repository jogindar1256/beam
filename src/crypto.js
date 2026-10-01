// Beam Transfer Protocol (BTP/1): handshake and encrypted framing.
//
// Handshake (plaintext, both sides send the same shape):
//   'BEAM' | version u8 | kind u8 (0 = control, 1 = data) | ...
//   control: ephemeral X25519 pub (32) | static X25519 pub (32)
//   data:    session id (16) | connection index u8
//
// master = HKDF-SHA256(DH(eph,eph) || DH(static,static), salt = transcript hash)
// The ephemeral DH gives forward secrecy; the static DH binds the session to both
// devices' long-term keys, which is what the 6-digit pairing code verifies.
//
// Frames after the handshake:
//   u32 length | AES-256-GCM(ciphertext of [type u8 | payload]) | 16-byte tag
//   nonce = 4 zero bytes | u64 frame counter (never reused: fresh key per connection
//   and direction). GCM authenticates every frame, so corruption or tampering is
//   detected per frame without a separate hash pass.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAGIC = Buffer.from('BEAM');
const VERSION = 1;
const MAX_FRAME = 16 * 1024 * 1024 + 64;
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');

const rawPub = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32);
const pubFromRaw = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' });
const hkdf = (ikm, salt, info, len = 32) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
const sha256 = (...bufs) => { const h = crypto.createHash('sha256'); bufs.forEach((b) => h.update(b)); return h.digest(); };

function loadIdentity(dir) {
  const file = path.join(dir, 'identity.pem');
  let privateKey;
  if (fs.existsSync(file)) privateKey = crypto.createPrivateKey(fs.readFileSync(file));
  else {
    privateKey = crypto.generateKeyPairSync('x25519').privateKey;
    fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  }
  const pub = rawPub(crypto.createPublicKey(privateKey));
  return { privateKey, pub, id: sha256(pub).subarray(0, 8).toString('hex') };
}

/** Stable per device pair: the same two devices always see the same code. */
function pairingCode(pubA, pubB) {
  const [x, y] = [pubA, pubB].sort(Buffer.compare);
  const n = sha256(Buffer.from('beam-pairing'), x, y).readUInt32BE(0) % 1_000_000;
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/** Read exactly n bytes from a socket that is still in paused/handshake mode. */
function readExact(sock, n, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let got = 0, finished = false;
    const t = setTimeout(() => finish(new Error('handshake timeout')), timeoutMs);
    const onData = (d) => {
      if (finished) return;
      parts.push(d);
      got += d.length;
      if (got < n) return;
      const all = Buffer.concat(parts);
      // Stop the flow BEFORE pushing back the surplus, otherwise Node re-emits it
      // immediately into this listener and the bytes are lost.
      finish(null, all.subarray(0, n));
      if (all.length > n) sock.unshift(all.subarray(n));
    };
    const onEnd = () => finish(new Error('connection closed during handshake'));
    function finish(err, val) {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      sock.pause();
      sock.off('data', onData); sock.off('end', onEnd); sock.off('error', onEnd); sock.off('close', onEnd);
      err ? reject(err) : resolve(val);
    }
    sock.on('data', onData); sock.once('end', onEnd); sock.once('error', onEnd); sock.once('close', onEnd);
    sock.resume();
  });
}

async function readHeader(sock) {
  const h = await readExact(sock, 6);
  if (!h.subarray(0, 4).equals(MAGIC)) throw new Error('not a Beam peer');
  if (h[4] !== VERSION) throw new Error(`unsupported protocol version ${h[4]}`);
  return h[5];
}

/**
 * Control handshake. The dialing side (client) reads the server's header here; the
 * server has already read the client's header to learn the connection kind.
 */
async function controlHandshake(sock, identity, isClient) {
  const eph = crypto.generateKeyPairSync('x25519');
  const ephPub = rawPub(eph.publicKey);
  sock.write(Buffer.concat([MAGIC, Buffer.from([VERSION, 0]), ephPub, identity.pub]));
  if (isClient && (await readHeader(sock)) !== 0) throw new Error('expected control connection');
  const peer = await readExact(sock, 64);
  const peerEph = peer.subarray(0, 32), peerStatic = peer.subarray(32);
  const dh1 = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pubFromRaw(peerEph) });
  const dh2 = crypto.diffieHellman({ privateKey: identity.privateKey, publicKey: pubFromRaw(peerStatic) });
  const [cEph, cStatic, sEph, sStatic] = isClient ? [ephPub, identity.pub, peerEph, peerStatic] : [peerEph, peerStatic, ephPub, identity.pub];
  const transcript = sha256(MAGIC, cEph, cStatic, sEph, sStatic);
  const master = hkdf(Buffer.concat([dh1, dh2]), transcript, 'beam master');
  return {
    master,
    sessionId: hkdf(master, Buffer.alloc(0), 'beam session id', 16),
    peerPub: Buffer.from(peerStatic),
    peerId: sha256(peerStatic).subarray(0, 8).toString('hex'),
    code: pairingCode(identity.pub, peerStatic),
  };
}

function directionKeys(master, label, isClient) {
  const c2s = hkdf(master, Buffer.alloc(0), `${label} c2s`);
  const s2c = hkdf(master, Buffer.alloc(0), `${label} s2c`);
  return isClient ? { send: c2s, recv: s2c } : { send: s2c, recv: c2s };
}

/**
 * Encrypted, framed, back-pressured channel over a TCP socket.
 * Incoming frames are handled one at a time; the socket stays paused while the async
 * handler runs, so a slow disk slows the sender through TCP instead of filling RAM.
 */
class SecureChannel extends EventEmitter {
  constructor(sock, keys, handler) {
    super();
    this.sock = sock;
    this.sendKey = keys.send;
    this.recvKey = keys.recv;
    this.sendCtr = 0n;
    this.recvCtr = 0n;
    this.handler = handler;
    this.chunks = [];
    this.have = 0;
    this.busy = false;
    this.closed = false;
    sock.setNoDelay(true);
    this.lastSeen = Date.now();
    sock.on('data', (d) => { this.lastSeen = Date.now(); this.chunks.push(d); this.have += d.length; this.pump(); });
    const close = (err) => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', err);
    };
    sock.on('close', () => close());
    sock.on('error', (e) => close(e));
    sock.resume();
  }

  nonce(ctr) { const n = Buffer.alloc(12); n.writeBigUInt64BE(ctr, 4); return n; }

  /** Returns false when the socket buffer is full; await drain() before sending more. */
  send(type, payload = Buffer.alloc(0)) {
    if (this.closed) throw new Error('channel closed');
    const cipher = crypto.createCipheriv('aes-256-gcm', this.sendKey, this.nonce(this.sendCtr++));
    const head = cipher.update(Buffer.from([type]));
    const body = cipher.update(payload);
    cipher.final();
    const len = Buffer.alloc(4);
    len.writeUInt32BE(head.length + body.length + 16);
    this.sock.write(len);
    this.sock.write(head);
    this.sock.write(body);
    return this.sock.write(cipher.getAuthTag());
  }
  sendJSON(type, obj) { return this.send(type, Buffer.from(JSON.stringify(obj))); }
  drain() {
    if (this.closed || !this.sock.writableNeedDrain) return Promise.resolve();
    return new Promise((r) => { const f = () => { this.sock.off('close', f); this.sock.off('drain', f); r(); }; this.sock.once('drain', f); this.sock.once('close', f); });
  }

  take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
    this.have -= n;
    return out;
  }
  peekLen() {
    if (this.chunks[0].length >= 4) return this.chunks[0].readUInt32BE(0);
    const b = this.take(4);
    this.chunks.unshift(b);
    this.have += 4;
    return b.readUInt32BE(0);
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.closed && this.have >= 4) {
        const len = this.peekLen();
        if (len > MAX_FRAME || len < 17) throw new Error('bad frame length');
        if (this.have < 4 + len) break;
        this.take(4);
        const frame = this.take(len);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.recvKey, this.nonce(this.recvCtr++));
        decipher.setAuthTag(frame.subarray(len - 16));
        const plain = decipher.update(frame.subarray(0, len - 16));
        decipher.final(); // throws if the frame was tampered with or corrupted
        this.sock.pause();
        await this.handler(plain[0], plain.subarray(1));
        if (!this.closed) this.sock.resume();
      }
    } catch (err) {
      this.emit('error', err);
      this.sock.destroy(err);
    } finally {
      this.busy = false;
    }
  }

  close() { this.sock.end(); setTimeout(() => this.sock.destroy(), 2000).unref(); }
}

module.exports = { MAGIC, VERSION, loadIdentity, pairingCode, controlHandshake, directionKeys, readHeader, readExact, SecureChannel, sha256 };
