// Agent core: listens for peers, runs pairing, sends and receives transfers.
'use strict';
const net = require('net');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { MAGIC, VERSION, loadIdentity, controlHandshake, directionKeys, readHeader, readExact, SecureChannel } = require('./crypto');
const { listenWithFallback } = require('./ports');
const { BLOCK, T, bits, bytesIn, expandSelection, transferId, Incoming, Outgoing } = require('./transfer');

const VERSION_STR = require('../package.json').version;
const PAIR_TIMEOUT = 5 * 60 * 1000;
const RETRY_FOR = Number(process.env.BEAM_RETRY_FOR_MS) || 60 * 60 * 1000; // keep retrying for an hour
const PING_EVERY = 4000;
const DEAD_AFTER = Number(process.env.BEAM_DEAD_MS) || 20000;

/**
 * Wi-Fi often drops SILENTLY: no packet says goodbye, so TCP on both sides believes the
 * connection is fine and the OS keeps retransmitting for up to ~15 minutes. Both sides
 * ping every 4 s; if nothing at all arrives for 20 s the link is declared dead and torn
 * down, which starts the normal retry/resume path. Only used when the other side
 * supports it (older versions would not understand the ping).
 */
function heartbeat(ch) {
  const t = setInterval(() => {
    if (ch.closed) return clearInterval(t);
    if (Date.now() - ch.lastSeen > DEAD_AFTER) {
      clearInterval(t);
      ch.deadLink = true;
      ch.sock.destroy(new Error('no response from the other computer'));
      return;
    }
    try { ch.send(T.PING); } catch {}
  }, PING_EVERY);
  ch.on('close', () => clearInterval(t));
}

class Mailbox {
  constructor() { this.q = []; this.w = []; this.err = null; }
  push(m) { const w = this.w.shift(); w ? w.resolve(m) : this.q.push(m); }
  fail(err) { this.err = err || new Error('connection closed'); for (const w of this.w.splice(0)) w.reject(this.err); }
  next(timeoutMs = 0) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      if (timeoutMs) setTimeout(() => { const i = this.w.indexOf(w); if (i >= 0) { this.w.splice(i, 1); reject(new Error('timed out waiting for the other device')); } }, timeoutMs);
      this.w.push(w);
    });
  }
}

class FinalError extends Error {} // don't retry: declined, cancelled, rejected

function connect(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`could not reach ${host}:${port}`)); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(t); sock.pause(); sock.setKeepAlive(true, 10000); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const json = (buf) => JSON.parse(buf.toString('utf8'));

function validFiles(files) {
  return Array.isArray(files) && files.length > 0 && files.length <= 1_000_000
    && files.every((f) => f && typeof f.path === 'string' && f.path.length < 4096 && Number.isSafeInteger(f.size) && f.size >= 0);
}

class Agent extends EventEmitter {
  constructor(opts) {
    super();
    this.dataDir = opts.dataDir;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.identity = loadIdentity(this.dataDir);
    this.tcpPort = opts.tcpPort;
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.trustFile = path.join(this.dataDir, 'trusted.json');
    this.stateDir = path.join(this.dataDir, 'incoming');
    this.settings = {
      name: opts.name || os.hostname().replace(/\.local$/, ''),
      saveDir: path.join(os.homedir(), 'Downloads', 'Beam'),
      connections: 4,
      autoAcceptTrusted: false,
      ...readJson(this.settingsFile),
    };
    if (opts.saveDir) this.settings.saveDir = opts.saveDir;
    this.trusted = readJson(this.trustFile) || {};
    this.peers = new Map();
    this.transfers = new Map();
    this.prompts = new Map(); // id -> { kind: 'pair'|'offer', ..., resolve }
    this.sessions = new Map();
    this.cancels = new Map();
    this.active = new Map(); // transfer id -> { ch, done } for the receiving session that owns it
  }

  get me() {
    return { version: VERSION_STR, id: this.identity.id, name: this.settings.name, os: process.platform, port: this.tcpPort, addresses: localAddresses() };
  }

  /** Make sure Beam can really save files in `dir` (creating it if needed). Returns the absolute path. */
  async checkSaveDir(dir) {
    const raw = String(dir || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
    if (!raw) throw new Error('Choose a folder to save received files in.');
    if (!path.isAbsolute(raw)) throw new Error('Use a full folder path, for example ' + path.join(os.homedir(), 'Downloads', 'Beam'));
    const abs = path.resolve(raw);
    const st = await fsp.stat(abs).catch(() => null);
    if (st && !st.isDirectory()) throw new Error(`"${abs}" is a file, not a folder.`);
    try { await fsp.mkdir(abs, { recursive: true }); }
    catch (e) { throw new Error(`Can't create "${abs}": ${e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission' : e.code || e.message}.`); }
    const probe = path.join(abs, `.beam-write-test-${process.pid}`);
    try { await fsp.writeFile(probe, ''); await fsp.unlink(probe); }
    catch (e) { throw new Error(`Beam can't save files in "${abs}": ${e.code === 'EACCES' || e.code === 'EPERM' ? 'no permission' : e.code === 'EROFS' ? 'the drive is read-only' : e.code || e.message}.`); }
    return abs;
  }

  async saveSettings(patch) {
    if ('saveDir' in patch) patch = { ...patch, saveDir: await this.checkSaveDir(patch.saveDir) };
    for (const k of ['name', 'saveDir', 'connections', 'autoAcceptTrusted']) if (k in patch) this.settings[k] = patch[k];
    this.settings.connections = Math.max(1, Math.min(16, Number(this.settings.connections) || 4));
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.changed();
  }

  changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => { this.changeTimer = null; this.emit('update'); }, 150);
  }

  snapshot() {
    const now = Date.now();
    return {
      me: this.me,
      desktop: this.desktop ? { ...this.desktop } : null,
      settings: this.settings,
      peers: [...this.peers.values()].filter((p) => p.manual || now - p.lastSeen < 8000)
        .map((p) => ({ ...p, trusted: !!this.trusted[p.id] })),
      trusted: Object.entries(this.trusted).map(([id, t]) => ({ id, name: t.name, since: t.since })),
      prompts: [...this.prompts.values()].map(({ resolve, ...rest }) => rest),
      transfers: [...this.transfers.values()].sort((a, b) => b.started - a.started),
    };
  }

  notePeer(p) {
    const old = this.peers.get(p.id);
    this.peers.set(p.id, { ...old, ...p, lastSeen: Date.now() });
    if (!old || old.host !== p.host || old.name !== p.name) this.changed();
  }

  // ---------------------------------------------------------------- prompts
  ask(kind, data, timeoutMs) {
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.prompts.delete(id); this.changed(); resolve(false); }, timeoutMs);
      this.prompts.set(id, { id, kind, ...data, created: Date.now(), resolve: (v) => { clearTimeout(t); this.prompts.delete(id); this.changed(); resolve(v); } });
      this.changed();
    });
  }
  answer(id, value) { const p = this.prompts.get(id); if (!p) return false; p.resolve(!!value); return true; }

  async pair(ch, mbox, hs, peerName) {
    const t = this.trusted[hs.peerId];
    const known = !!t && t.pub === hs.peerPub.toString('hex');
    const ok = known || (await this.ask('pair', { peerId: hs.peerId, peerName, code: hs.code }, PAIR_TIMEOUT));
    ch.send(ok ? T.PAIR_OK : T.PAIR_NO);
    if (!ok) throw new FinalError('Pairing was not confirmed on this device.');
    const m = await mbox.next(PAIR_TIMEOUT);
    if (m.type !== T.PAIR_OK) throw new FinalError(`${peerName} did not confirm the pairing code.`);
    if (!known) {
      this.trusted[hs.peerId] = { name: peerName, pub: hs.peerPub.toString('hex'), since: Date.now() };
      fs.writeFileSync(this.trustFile, JSON.stringify(this.trusted, null, 2));
    }
    return known;
  }

  forget(peerId) { delete this.trusted[peerId]; fs.writeFileSync(this.trustFile, JSON.stringify(this.trusted, null, 2)); this.changed(); }

  // ---------------------------------------------------------------- server
  async listen() {
    this.server = net.createServer((sock) => this.onConnection(sock).catch(() => sock.destroy()));
    this.preferredTcpPort = this.tcpPort;
    this.tcpPort = await listenWithFallback(this.server, '0.0.0.0', this.tcpPort);
    this.server.on('error', (e) => console.error(`Transfer server error: ${e.message}`));
    return this.tcpPort;
  }

  async onConnection(sock) {
    sock.pause();
    sock.setKeepAlive(true, 10000);
    const kind = await readHeader(sock);
    if (kind === 0) return this.serveControl(sock);
    if (kind === 1) return this.serveData(sock);
    sock.destroy();
  }

  async serveData(sock) {
    const rest = await readExact(sock, 17);
    const sess = this.sessions.get(rest.subarray(0, 16).toString('hex'));
    if (!sess) return sock.destroy();
    const idx = rest[16];
    const ch = new SecureChannel(sock, directionKeys(sess.master, `data ${idx}`, false), async (type, payload) => {
      if (type === T.BLOCK && sess.speed) { // speed test: count and discard, never touch the disk
        const sp = sess.speed, now = Date.now();
        if (!sp.start) sp.start = now;
        sp.last = now;
        sp.bytes += payload.length;
        sp.frames[idx] = (sp.frames[idx] || 0) + 1;
        return;
      }
      if (type !== T.BLOCK || !sess.incoming) throw new Error('unexpected data frame');
      await sess.incoming.onBlock(idx, payload);
    });
    ch.on('error', () => {});
    sess.dataChs?.add(ch);
    ch.on('close', () => { sess.dataChs?.delete(ch); sess.incoming?.closedConns.add(idx); sess.incoming?.notify(); });
  }

  async serveControl(sock) {
    const hs = await controlHandshake(sock, this.identity, false);
    const sid = hs.sessionId.toString('hex');
    const sess = { master: hs.master, incoming: null, dataChs: new Set() };
    this.sessions.set(sid, sess);
    const mbox = new Mailbox();
    const ch = new SecureChannel(sock, directionKeys(hs.master, 'ctrl', false), async (type, payload) => { if (type !== T.PING) mbox.push({ type, payload }); });
    ch.on('error', () => {});
    ch.on('close', () => {
      mbox.fail();
      // The data connections share the dead link: tear them down too.
      for (const d of sess.dataChs) d.sock.destroy();
    });
    let rec = null, timer = null, ownedId = null, ownedRelease = null;
    try {
      ch.sendJSON(T.INFO, { name: this.settings.name, os: process.platform, version: VERSION_STR, hb: true });
      const info = json((await mbox.next(15000)).payload);
      if (info.hb) heartbeat(ch);
      const peerName = String(info.name || 'Unknown device').slice(0, 64);
      const wasTrusted = await this.pair(ch, mbox, hs, peerName);

      const m = await mbox.next(0);
      if (m.type === T.SPEEDTEST) {
        sess.speed = { bytes: 0, start: 0, last: 0, frames: {} };
        ch.sendJSON(T.ACCEPT, {});
        const end = await mbox.next(120000);
        const sent = end.type === T.END ? json(end.payload).sent || {} : {};
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !Object.entries(sent).every(([i, n]) => (sess.speed.frames[i] || 0) >= n)) await new Promise((r) => setTimeout(r, 50));
        ch.sendJSON(T.SPEEDRESULT, { bytes: sess.speed.bytes, ms: Math.max(1, sess.speed.last - sess.speed.start) });
        await new Promise((r) => setTimeout(r, 300));
        ch.close();
        return;
      }
      if (m.type !== T.OFFER) throw new Error('expected an offer');
      const offer = json(m.payload);
      if (!validFiles(offer.files) || !/^[0-9a-f]{32}$/.test(offer.id) || ![BLOCK, 1 << 20, 8 << 20, 16 << 20].includes(offer.block)) {
        ch.sendJSON(T.DECLINE, { reason: 'Invalid offer.' });
        throw new FinalError('Received an invalid offer.');
      }
      const total = offer.files.reduce((s, f) => s + f.size, 0);
      // A reconnecting sender may arrive before we noticed the old connection died.
      // Shut the old session down and let it save its progress before taking over.
      const prev = this.active.get(offer.id);
      if (prev) { prev.ch.sock.destroy(); await prev.done; }
      let release;
      this.active.set(offer.id, { ch, done: new Promise((r) => (release = r)) });
      ownedId = offer.id;
      ownedRelease = release;
      const state = await Incoming.loadState(this.stateDir, offer.id);
      const resuming = !!state && state.peerId === hs.peerId;
      const accepted = resuming || (wasTrusted && this.settings.autoAcceptTrusted)
        || (await this.ask('offer', { peerId: hs.peerId, peerName, count: offer.files.length, totalBytes: total, names: offer.files.slice(0, 20).map((f) => f.path) }, 30 * 60 * 1000));
      if (!accepted) { ch.sendJSON(T.DECLINE, { reason: `${this.settings.name} declined the transfer.` }); throw new FinalError('Declined.'); }

      const inc = new Incoming({ id: offer.id, files: offer.files, block: offer.block, saveDir: this.settings.saveDir, stateDir: this.stateDir, peerId: hs.peerId });
      rec = this.record(offer.id, { direction: 'in', peerName, count: offer.files.length, totalBytes: total, status: 'receiving', saveDir: this.settings.saveDir }, true);
      try { await inc.prepare(resuming ? state : null); }
      catch (e) {
        const reason = e.code === 'ENOSPC_PRECHECK' ? `${this.settings.name} does not have enough free disk space.` : `${this.settings.name} could not prepare the save folder.`;
        ch.sendJSON(T.DECLINE, { reason });
        throw new FinalError(e.code === 'ENOSPC_PRECHECK' ? 'Not enough free disk space for this transfer.' : e.message);
      }
      sess.incoming = inc;
      rec.resumedFrom = inc.bytes;
      this.track(rec, () => inc.bytes);
      this.cancels.set(offer.id, () => { try { ch.sendJSON(T.CANCEL, { reason: `Cancelled on ${this.settings.name}.` }); } catch {} ch.close(); });
      ch.sendJSON(T.ACCEPT, { have: inc.have.toString('base64') });

      let n = 0;
      timer = setInterval(() => {
        try { ch.sendJSON(T.PROGRESS, { bytes: inc.bytes }); } catch {}
        if (++n % 4 === 0) inc.checkpoint().catch(() => {});
      }, 500);

      for (;;) {
        const msg = await mbox.next(0);
        if (msg.type === T.CANCEL) throw new FinalError(json(msg.payload).reason || 'The sender cancelled.');
        if (msg.type !== T.END) continue;
        await inc.settle(json(msg.payload).sent || {});
        if (inc.complete()) {
          await inc.finalize();
          ch.sendJSON(T.COMPLETE, {});
          this.finish(rec, 'done');
          break;
        }
        ch.sendJSON(T.MISSING, { have: inc.have.toString('base64') });
      }
      ch.close();
    } catch (e) {
      if (sess.incoming) await sess.incoming.suspend();
      if (rec && rec.status === 'receiving') {
        const final = e instanceof FinalError;
        this.finish(rec, final ? 'stopped' : 'interrupted', final ? e.message : 'Connection lost. Progress is saved; it resumes automatically when the sender reconnects.');
      }
      ch.close();
    } finally {
      clearInterval(timer);
      this.sessions.delete(sid);
      if (rec) this.cancels.delete(rec.id);
      if (ownedId && this.active.get(ownedId)?.ch === ch) this.active.delete(ownedId);
      ownedRelease?.();
    }
  }

  // ---------------------------------------------------------------- transfer records
  /** fresh: start a new record for a new run (same files sent again = same id). */
  record(id, fields, fresh = false) {
    let rec = this.transfers.get(id);
    if (!rec || fresh) {
      if (rec) clearInterval(rec._timer);
      rec = { id, bytes: 0, speed: 0, started: Date.now() };
      this.transfers.set(id, rec);
    }
    Object.assign(rec, fields);
    rec.error = fields.error || null;
    rec.updated = Date.now();
    this.changed();
    return rec;
  }
  track(rec, getBytes) {
    clearInterval(rec._timer);
    let lastB = getBytes(), lastT = Date.now();
    Object.defineProperty(rec, '_timer', { value: setInterval(() => {
      const b = getBytes(), t = Date.now();
      const inst = ((b - lastB) * 1000) / Math.max(1, t - lastT);
      rec.speed = rec.speed ? rec.speed * 0.7 + inst * 0.3 : inst;
      rec.bytes = b; lastB = b; lastT = t;
      this.changed();
    }, 500), enumerable: false, writable: true, configurable: true });
  }
  finish(rec, status, error = null) {
    clearInterval(rec._timer);
    rec.status = status;
    rec.error = error;
    rec.speed = 0;
    if (status === 'done') { rec.bytes = rec.totalBytes; rec.finished = Date.now(); }
    this.changed();
  }
  /** Send a failed/stopped outgoing transfer again; it resumes where it stopped. */
  async retry(id) {
    const rec = this.transfers.get(id);
    if (!rec?._retry || rec.direction !== 'out') throw new Error('Nothing to retry for this transfer.');
    if (['connecting', 'pairing', 'waiting', 'sending', 'reconnecting'].includes(rec.status)) throw new Error('It is already running.');
    return this.send(rec._retry.target, rec._retry.paths);
  }

  cancel(id) { const c = this.cancels.get(id); if (c) c(); return !!c; }

  // ---------------------------------------------------------------- sending
  async send(target, paths) {
    const files = await expandSelection(paths);
    if (!files.length) throw new Error('Nothing to send: the selection has no files.');
    const id = transferId(files, this.identity.pub);
    const out = new Outgoing(files);
    const rec = this.record(id, { direction: 'out', peerName: target.name || target.host, count: files.length, totalBytes: out.L.totalBytes, status: 'connecting' }, true);
    Object.defineProperty(rec, '_retry', { value: { target, paths }, enumerable: false, configurable: true, writable: true });
    let cancelled = false;
    let live = null;
    this.cancels.set(id, () => { cancelled = true; try { live?.sendJSON(T.CANCEL, { reason: `${this.settings.name} cancelled.` }); live?.close(); } catch {} });
    (async () => {
      // The retry window counts from the last moment data was flowing, not from the
      // start: a 3-hour transfer that drops at hour 2 still gets a full hour of retries.
      let lastAlive = Date.now();
      let attempt = 0;
      for (;;) {
        try {
          const host = this.peers.get(target.id)?.host || target.host;
          const port = this.peers.get(target.id)?.port || target.port;
          await this.sendOnce(host, port, id, out, rec, (ch) => (live = ch), () => cancelled, () => { lastAlive = Date.now(); attempt = 0; });
          this.finish(rec, 'done');
          break;
        } catch (e) {
          if (cancelled) { this.finish(rec, 'stopped', 'Cancelled.'); break; }
          if (e instanceof FinalError) { this.finish(rec, 'failed', e.message); break; }
          if (Date.now() - lastAlive > RETRY_FOR) { this.finish(rec, 'failed', `${e.message}. Gave up after ${Math.round(RETRY_FOR / 60000) || 1} min of retrying; press Retry to continue where it stopped.`); break; }
          attempt++;
          this.record(id, { status: 'reconnecting', error: `${e.message}. Retrying (attempt ${attempt})…` });
          await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 10000)));
        }
      }
      await out.close();
      this.cancels.delete(id);
    })();
    return id;
  }

  /** Measure the raw network: memory-to-memory over the same encrypted parallel connections. */
  async speedTest(target, seconds = 8) {
    const host = this.peers.get(target.id)?.host || target.host;
    const port = this.peers.get(target.id)?.port || target.port;
    const sock = await connect(host, port);
    const hs = await controlHandshake(sock, this.identity, true);
    const mbox = new Mailbox();
    const ch = new SecureChannel(sock, directionKeys(hs.master, 'ctrl', true), async (type, payload) => { if (type !== T.PING) mbox.push({ type, payload }); });
    ch.on('error', () => {});
    const data = [];
    ch.on('close', () => { mbox.fail(new Error('connection lost')); for (const d of data) d.ch.sock.destroy(); });
    try {
      ch.sendJSON(T.INFO, { name: this.settings.name, os: process.platform, version: VERSION_STR, hb: true });
      const info = json((await mbox.next(15000)).payload);
      if (info.hb) heartbeat(ch);
      await this.pair(ch, mbox, hs, String(info.name || host).slice(0, 64));
      ch.sendJSON(T.SPEEDTEST, { seconds });
      const ok = await mbox.next(15000);
      if (ok.type !== T.ACCEPT) throw new Error('The other computer does not support speed tests; update Beam there.');
      const conns = this.settings.connections;
      for (let idx = 0; idx < conns; idx++) {
        const dsock = await connect(host, port);
        dsock.write(Buffer.concat([MAGIC, Buffer.from([VERSION, 1]), hs.sessionId, Buffer.from([idx])]));
        const dch = new SecureChannel(dsock, directionKeys(hs.master, `data ${idx}`, true), async () => {});
        dch.on('error', () => {});
        data.push({ idx, ch: dch });
      }
      const payload = crypto.randomBytes(BLOCK + 8);
      payload.writeBigUInt64BE(0n, 0);
      const sent = {};
      const until = Date.now() + seconds * 1000;
      await Promise.all(data.map(async ({ idx, ch: dch }) => {
        sent[idx] = 0;
        while (Date.now() < until && !dch.closed) { sent[idx]++; if (!dch.send(T.BLOCK, payload)) await dch.drain(); }
      }));
      ch.sendJSON(T.END, { sent });
      const r = await mbox.next(30000);
      if (r.type !== T.SPEEDRESULT) throw new Error('unexpected reply');
      const { bytes, ms } = json(r.payload);
      return { MBps: Math.round((bytes / ms) * 1000 / 1e5) / 10, bytes, ms, connections: conns, peerName: info.name };
    } finally {
      for (const d of data) d.ch.close();
      ch.close();
    }
  }

  async sendOnce(host, port, id, out, rec, setLive, isCancelled, onAlive = () => {}) {
    const sock = await connect(host, port);
    const hs = await controlHandshake(sock, this.identity, true);
    const mbox = new Mailbox();
    let remoteBytes = rec.bytes;
    const data = [];
    const ch = new SecureChannel(sock, directionKeys(hs.master, 'ctrl', true), async (type, payload) => {
      if (type === T.PROGRESS) { remoteBytes = json(payload).bytes; onAlive(); }
      else if (type !== T.PING) mbox.push({ type, payload });
    });
    ch.on('error', () => {});
    ch.on('close', () => {
      mbox.fail(new Error(ch.deadLink ? 'no response from the other computer (Wi-Fi dropped?)' : 'connection lost'));
      // Unblock send workers stuck waiting on the dead link, so the retry can start.
      for (const d of data) d.ch.sock.destroy();
    });
    setLive(ch);
    try {
      ch.sendJSON(T.INFO, { name: this.settings.name, os: process.platform, version: VERSION_STR, hb: true });
      const info = json((await mbox.next(15000)).payload);
      if (info.hb) heartbeat(ch);
      const peerName = String(info.name || host).slice(0, 64);
      this.record(id, { peerName, status: this.trusted[hs.peerId] ? 'waiting' : 'pairing', pairCode: hs.code });
      await this.pair(ch, mbox, hs, peerName);
      this.record(id, { status: 'waiting' });
      ch.sendJSON(T.OFFER, { id, block: out.L.block, files: out.files.map(({ path: p, size, mtime }) => ({ path: p, size, mtime })) });
      const reply = await mbox.next(0);
      if (reply.type === T.DECLINE) throw new FinalError(json(reply.payload).reason || 'Declined.');
      if (reply.type !== T.ACCEPT) throw new Error('unexpected reply');
      out.setHave(bits.from64(json(reply.payload).have, out.L.total));
      remoteBytes = bytesIn(out.L, out.have);
      this.record(id, { status: 'sending', resumedFrom: remoteBytes });
      this.track(rec, () => remoteBytes);

      const sent = {};
      let nextIdx = 0, stalls = 0;
      for (;;) {
        // (Re)open data connections so there are N healthy ones.
        for (let i = data.length - 1; i >= 0; i--) if (data[i].ch.closed) data.splice(i, 1);
        while (data.length < this.settings.connections && nextIdx < 250) {
          const idx = nextIdx++;
          const dsock = await connect(host, port);
          dsock.write(Buffer.concat([MAGIC, Buffer.from([VERSION, 1]), hs.sessionId, Buffer.from([idx])]));
          const dch = new SecureChannel(dsock, directionKeys(hs.master, `data ${idx}`, true), async () => {});
          dch.on('error', () => {});
          data.push({ idx, ch: dch });
          sent[idx] = 0;
        }
        const before = bits.count(out.have, 0, out.L.total);
        await Promise.all(data.map(async ({ idx, ch: dch }) => {
          for (let g = out.next(); g !== null; g = out.next()) {
            if (dch.closed || isCancelled()) return;
            const buf = await out.read(g);
            if (dch.closed) return;
            sent[idx]++;
            if (!dch.send(T.BLOCK, buf)) await dch.drain();
          }
        }));
        if (isCancelled()) throw new FinalError('Cancelled.');
        if (ch.closed) throw new Error('connection lost');
        ch.sendJSON(T.END, { sent });
        const r = await mbox.next(0);
        if (r.type === T.COMPLETE) { remoteBytes = out.L.totalBytes; break; }
        if (r.type === T.CANCEL) throw new FinalError(json(r.payload).reason || 'The receiver cancelled.');
        if (r.type !== T.MISSING) throw new Error('unexpected reply');
        out.setHave(bits.from64(json(r.payload).have, out.L.total));
        const after = bits.count(out.have, 0, out.L.total);
        stalls = after > before ? 0 : stalls + 1;
        if (stalls >= 3) throw new Error('no progress');
      }
      ch.close();
    } finally {
      for (const d of data) d.ch.close();
    }
  }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function localAddresses() {
  const out = [];
  let ifaces = {};
  // Throws when the process is out of file handles (EMFILE). That used to crash Beam
  // from a timer; an empty list for a moment is harmless.
  try { ifaces = os.networkInterfaces(); } catch { return out; }
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ iface: name, address: a.address, netmask: a.netmask });
  }
  return out;
}

module.exports = { Agent, localAddresses };
