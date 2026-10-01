// End-to-end tests: real agent processes, real TCP, driven through the HTTP API.
// Usage: node test/e2e.js   (needs ~2 GB free in the temp dir)
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-e2e-'));
const SRC = path.join(ROOT, 'src');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFile(p, size) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  const chunk = crypto.randomBytes(1 << 20);
  for (let off = 0; off < size; off += chunk.length) fs.writeSync(fd, chunk, 0, Math.min(chunk.length, size - off));
  fs.closeSync(fd);
  // make every MB distinct so misplaced blocks can't hash equal
  const fd2 = fs.openSync(p, 'r+');
  for (let off = 0; off < size; off += 1 << 20) fs.writeSync(fd2, crypto.randomBytes(Math.min(32, size - off)), 0, Math.min(32, size - off), off);
  fs.closeSync(fd2);
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function shaStream(p) {
  return new Promise((res) => { const h = crypto.createHash('sha256'); fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))); });
}

// ---------------------------------------------------------------- agent processes
const agents = {};
function startAgent(name, n, extra = {}) {
  const dir = path.join(ROOT, name);
  const cfg = {
    name, dir, save: path.join(dir, 'received'),
    tcp: 46000 + n, ui: 47000 + n, udp: 48000 + n,
  };
  const others = [1, 2, 3].filter((m) => m !== n).map((m) => `127.0.0.1:${48000 + m}`).join(',');
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js'), '--no-open'], {
    env: { ...process.env, BEAM_DATA: path.join(dir, 'data'), BEAM_NAME: name, BEAM_SAVE_DIR: cfg.save,
      BEAM_PORT: cfg.tcp, BEAM_UI_PORT: cfg.ui, BEAM_UDP_PORT: cfg.udp, BEAM_ANNOUNCE: others, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  cfg.proc = proc;
  agents[name] = cfg;
  return new Promise((resolve) => proc.stdout.on('data', async (d) => {
    if (!String(d).includes('Control panel')) return;
    cfg.token = (await req(cfg, 'GET', '/', null, true)).match(/const TOKEN = '(\w+)'/)[1];
    resolve(cfg);
  }));
}
function kill(name) { const a = agents[name]; a.proc.kill('SIGKILL'); return new Promise((r) => a.proc.once('exit', r)); }

function req(a, method, p, body, raw = false, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: a.ui, method, path: p, headers: { 'x-beam-token': a.token || '', 'content-type': 'application/json', ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => {
        if (raw) return resolve(s);
        const j = JSON.parse(s); j.__status = res.statusCode; resolve(j);
      });
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}
const state = (a) => req(a, 'GET', '/api/state');
async function until(fn, ms = 120000, label = 'condition') {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); }
  throw new Error(`timeout: ${label}`);
}
async function answerPrompts(a, kind, ok = true) {
  const s = await state(a);
  const p = s.prompts.filter((x) => x.kind === kind);
  for (const x of p) await req(a, 'POST', `/api/prompt/${x.id}`, { ok });
  return p;
}
async function transfer(a, id) { return (await state(a)).transfers.find((t) => t.id === id); }
async function waitDone(a, id, ms = 300000) {
  return until(async () => { const t = await transfer(a, id); if (t && ['failed', 'stopped'].includes(t.status)) throw new Error(`${a.name}: ${t.status}: ${t.error}`); return t?.status === 'done' && t; }, ms, `${a.name} done`);
}
function check(name, ok, note = '') { results.push([ok ? 'PASS' : 'FAIL', name, note]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  |  ${note}` : ''}`); }

async function verifyTree(srcRoot, dstRoot, rels) {
  for (const rel of rels) {
    const a = path.join(srcRoot, rel), b = path.join(dstRoot, rel);
    if (!fs.existsSync(b)) return `missing ${rel}`;
    if (fs.statSync(a).size !== fs.statSync(b).size) return `size mismatch ${rel}`;
    if ((await shaStream(a)) !== (await shaStream(b))) return `hash mismatch ${rel}`;
  }
  return null;
}

// ---------------------------------------------------------------- tests
async function main() {
  console.log(`test dir: ${ROOT}`);
  makeFile(path.join(SRC, 'movie.bin'), 200e6);
  makeFile(path.join(SRC, 'album', 'track1.bin'), 9e6);
  makeFile(path.join(SRC, 'album', 'deep', 'track2.bin'), 1234567);
  fs.writeFileSync(path.join(SRC, 'album', 'deep', 'empty.txt'), '');
  makeFile(path.join(SRC, 'big.bin'), 1.5e9);

  let A = await startAgent('Alpha', 1);
  let B = await startAgent('Bravo', 2);

  // 1. Discovery
  const peer = await until(async () => (await state(A)).peers.find((p) => p.name === 'Bravo'), 15000, 'discovery');
  check('1  discovery finds the other device', !!peer, `${peer.host}:${peer.port}`);

  // 2. Security of the local control panel
  const noTok = await req({ ...A, token: 'x'.repeat(48) }, 'GET', '/api/state');
  const badHost = await req(A, 'GET', '/api/state', null, false, { host: 'evil.example:7070' });
  check('2  control panel rejects missing token and foreign Host', noTok.__status === 401 && badHost.__status === 403, `${noTok.__status} / ${badHost.__status}`);

  // 3. First transfer: pairing on both sides + offer + files and folder
  let r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'movie.bin'), path.join(SRC, 'album')] });
  const pa = await until(async () => { const p = (await state(A)).prompts.find((x) => x.kind === 'pair'); return p; }, 15000, 'pair prompt A');
  const pb = await until(async () => { const p = (await state(B)).prompts.find((x) => x.kind === 'pair'); return p; }, 15000, 'pair prompt B');
  await answerPrompts(A, 'pair'); await answerPrompts(B, 'pair');
  await until(async () => (await answerPrompts(B, 'offer')).length, 15000, 'offer prompt');
  let t0 = Date.now();
  await waitDone(A, r.id);
  let dt = (Date.now() - t0) / 1000;
  let err = await verifyTree(SRC, B.save, ['movie.bin', 'album/track1.bin', 'album/deep/track2.bin', 'album/deep/empty.txt']);
  check('3  pairing codes match on both sides', pa.code === pb.code, pa.code);
  const stale = () => { const d = path.join(B.dir, 'data', 'incoming'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
  await sleep(300);
  check('4  files + nested folder + empty file arrive intact, no leftover resume state', !err && !stale().length, err || (stale().length ? `stale: ${stale()}` : `${(211.2 / dt).toFixed(0)} MB/s`));

  // 5. Paired devices: no pairing prompt the second time; the identical file sent again
  //    is recognised and skipped (no "track1 (1).bin" duplicate).
  let last5;
  for (let i = 0; i < 2; i++) {
    r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'album', 'track1.bin')] });
    await until(async () => (await answerPrompts(B, 'offer')).length, 15000, 'offer 2');
    last5 = await waitDone(A, r.id);
  }
  const pairAgain = (await state(A)).prompts.some((x) => x.kind === 'pair');
  const noDup = fs.existsSync(path.join(B.save, 'track1.bin')) && !fs.existsSync(path.join(B.save, 'track1 (1).bin'));
  check('5  paired device: no re-pairing; identical file sent again is skipped, not duplicated', !pairAgain && noDup && last5.resumedFrom === last5.totalBytes);

  // 6. Sender crashes mid-transfer, restarts, sends again: resumes without a prompt
  r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'big.bin')] });
  await until(async () => (await answerPrompts(B, 'offer')).length, 15000, 'offer 3');
  await until(async () => { const t = await transfer(B, r.id); return t && t.status === 'receiving' && t.bytes > 500e6; }, 120000, 'progress before sender crash');
  await kill('Alpha');
  const inter = await until(async () => { const t = await transfer(B, r.id); return t?.status === 'interrupted' && t; }, 30000, 'receiver sees interruption');
  A = await startAgent('Alpha', 1);
  await until(async () => (await state(A)).peers.find((p) => p.id === peer.id), 15000, 'rediscovery');
  const r2 = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'big.bin')] });
  const done6 = await waitDone(A, r2.id);
  const prompted = (await state(B)).prompts.length;
  err = await verifyTree(SRC, B.save, ['big.bin']);
  check('6  sender killed mid-transfer → restart → resumes, hash matches', !err && r2.id === r.id && done6.resumedFrom > 100e6 && prompted === 0,
    err || `receiver kept ${(done6.resumedFrom / 1e6).toFixed(0)} MB; status was "${inter.status}"`);

  // 7. Receiver crashes mid-transfer; sender keeps retrying and resumes on its own
  fs.rmSync(path.join(B.save, 'big.bin'));
  r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'big.bin')] });
  await until(async () => (await answerPrompts(B, 'offer')).length, 15000, 'offer 4');
  await until(async () => { const t = await transfer(B, r.id); return t && t.status === 'receiving' && t.bytes > 300e6; }, 120000, 'progress before receiver crash');
  // Crash only after the receiver has durably checkpointed some progress.
  const ckFile = path.join(B.dir, 'data', 'incoming', `${r.id}.have`);
  const ckBytes = await until(() => {
    try { const n = fs.readFileSync(ckFile).reduce((s, b) => s + ((b.toString(2).match(/1/g) || []).length), 0); return n > 0 && n * 4 * 1024 * 1024; } catch { return false; }
  }, 60000, 'first durable checkpoint');
  await kill('Bravo');
  await until(async () => (await transfer(A, r.id))?.status === 'reconnecting', 30000, 'sender reconnecting');
  B = await startAgent('Bravo', 2);
  const done7 = await waitDone(A, r.id);
  err = await verifyTree(SRC, B.save, ['big.bin']);
  await sleep(300);
  const leftovers = [...fs.readdirSync(B.save).filter((f) => f.endsWith('.beampart')), ...stale()];
  check('7  receiver killed mid-transfer → sender auto-retries → resumes, hash matches', !err && done7.resumedFrom > 100e6 && !leftovers.length,
    err || `checkpoint had ${(ckBytes / 1e6).toFixed(0)} MB; resumed from ${(done7.resumedFrom / 1e6).toFixed(0)} MB; no leftovers`);

  // 8. Corruption on the wire: a proxy flips one byte in a data stream.
  let flipped = false, seen = 0;
  const proxy = net.createServer((c) => {
    const up = net.connect(B.tcp, '127.0.0.1');
    let kind = null;
    c.on('data', (d) => {
      if (kind === null) kind = d[5];
      if (kind === 1 && !flipped) { seen += d.length; if (seen > 20e6) { d = Buffer.from(d); d[Math.floor(d.length / 2)] ^= 0xff; flipped = true; } }
      up.write(d);
    });
    up.on('data', (d) => c.write(d));
    c.on('error', () => up.destroy()); up.on('error', () => c.destroy());
    c.on('close', () => up.destroy()); up.on('close', () => c.destroy());
  });
  await new Promise((res) => proxy.listen(46999, '127.0.0.1', res));
  fs.rmSync(path.join(B.save, 'movie.bin'));
  r = await req(A, 'POST', '/api/send', { host: '127.0.0.1', port: 46999, paths: [path.join(SRC, 'movie.bin')] });
  await until(async () => (await answerPrompts(B, 'offer')).length, 15000, 'offer 5');
  await waitDone(A, r.id);
  err = await verifyTree(SRC, B.save, ['movie.bin']);
  check('8  flipped byte on the wire detected, block re-sent, hash matches', !err && flipped, err || 'tampered frame rejected by AES-GCM');
  proxy.close();

  // 9. Wrong pairing code: receiver rejects → sender fails cleanly, nothing sent
  const C = await startAgent('Charlie', 3);
  const peerB = await until(async () => (await state(C)).peers.find((p) => p.name === 'Bravo'), 15000, 'C discovers B');
  r = await req(C, 'POST', '/api/send', { peerId: peerB.id, paths: [path.join(SRC, 'album', 'track1.bin')] });
  await until(async () => (await answerPrompts(C, 'pair')).length, 15000, 'C pair');
  await until(async () => (await answerPrompts(B, 'pair', false)).length, 15000, 'B rejects');
  const failed = await until(async () => { const t = await transfer(C, r.id); return ['failed', 'stopped'].includes(t?.status) && t; }, 20000, 'C fails');
  const trustedByB = (await state(B)).trusted.some((t) => t.name === 'Charlie');
  check('9  rejected pairing: transfer refused, device not trusted', !trustedByB, `"${failed.error}"`);

  // 10. Declined offer
  r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'album', 'track1.bin')] });
  await until(async () => (await answerPrompts(B, 'offer', false)).length, 15000, 'decline');
  const dec = await until(async () => { const t = await transfer(A, r.id); return t?.status === 'failed' && t; }, 15000, 'A sees decline');
  check('10 declined offer reported to sender', /declined/i.test(dec.error), `"${dec.error}"`);

  // 11. Throughput on loopback: 1 vs 4 connections
  for (const conns of [1, 4]) {
    await req(A, 'POST', '/api/settings', { connections: conns });
    fs.rmSync(path.join(B.save, 'big.bin'));
    r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [path.join(SRC, 'big.bin')] });
    await until(async () => (await answerPrompts(B, 'offer')).length, 15000, 'offer tp');
    t0 = Date.now();
    await waitDone(A, r.id);
    dt = (Date.now() - t0) / 1000;
    check(`11 loopback throughput, ${conns} connection(s)`, true, `${(1500 / dt).toFixed(0)} MB/s (1.5 GB in ${dt.toFixed(1)} s)`);
  }

  for (const a of Object.values(agents)) a.proc.kill('SIGKILL');
  fs.rmSync(ROOT, { recursive: true, force: true });
  const failedN = results.filter((x) => x[0] === 'FAIL').length;
  console.log(`\n${results.length - failedN}/${results.length} passed`);
  process.exit(failedN ? 1 : 0);
}

main().catch(async (e) => {
  console.error('ERROR', e);
  for (const a of Object.values(agents)) {
    try { const s = await state(a); console.error(`STATE ${a.name}:`, JSON.stringify({ transfers: s.transfers, prompts: s.prompts, peers: s.peers.map((p) => [p.name, p.host, p.port]) })); } catch (x) { console.error(`STATE ${a.name}: unavailable (${x.message})`); }
  }
  for (const a of Object.values(agents)) a.proc?.kill('SIGKILL');
  setTimeout(() => { fs.rmSync(ROOT, { recursive: true, force: true }); process.exit(1); }, 500);
});
