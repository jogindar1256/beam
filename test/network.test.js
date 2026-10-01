// Network-failure and resend behaviour.
//  - A relay between the computers simulates a SILENT Wi-Fi drop: it stops forwarding but
//    keeps every connection open, so neither computer's TCP stack notices.
//  - Resending files that already arrived must not create "name (1)" duplicates.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-net-'));
const SRC = path.join(ROOT, 'src');
const results = [];
const procs = [];
const check = (n, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${note ? `  |  ${note}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function start(name, n, extra = {}) {
  const dir = path.join(ROOT, name);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js'), '--no-open'], {
    env: { ...process.env, BEAM_DATA: path.join(dir, 'data'), BEAM_NAME: name, BEAM_SAVE_DIR: path.join(dir, 'recv'), BEAM_PORT: String(46800 + n), BEAM_UI_PORT: String(47800 + n), BEAM_UDP_PORT: String(48800 + n), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  const a = { name, ui: 47800 + n, tcp: 46800 + n, save: path.join(dir, 'recv') };
  return new Promise((res) => p.stdout.on('data', async (d) => {
    if (!String(d).includes('Control panel')) return;
    a.token = (await req(a, 'GET', '/', null, true)).match(/const TOKEN = '(\w+)'/)[1];
    res(a);
  }));
}
function req(a, method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: a.ui, method, path: p, agent: false, headers: { 'x-beam-token': a.token || '', 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(raw ? s : JSON.parse(s)));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
async function until(fn, ms, label) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(200); } throw new Error(`timeout after ${ms / 1000}s: ${label}`); }
const transfer = async (a, id) => (await req(a, 'GET', '/api/state')).transfers.find((t) => t.id === id);
async function acceptAll(a) { for (const p of (await req(a, 'GET', '/api/state')).prompts) await req(a, 'POST', `/api/prompt/${p.id}`, { ok: true }); }

/** Relay: 'pass' forwards; 'blackhole' silently stops forwarding on every open connection. */
function relay(listenPort, targetPort) {
  const conns = new Set();
  const r = { mode: 'pass', server: null };
  r.server = net.createServer((c) => {
    const up = net.connect(targetPort, '127.0.0.1');
    const pair = { c, up, dead: r.mode === 'blackhole' };
    conns.add(pair);
    const fwd = (from, to) => from.on('data', (d) => { if (!pair.dead) to.write(d); });
    fwd(c, up); fwd(up, c);
    const end = () => { c.destroy(); up.destroy(); conns.delete(pair); };
    c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
  });
  r.blackhole = () => { r.mode = 'blackhole'; for (const p of conns) { p.dead = true; p.c.pause(); } }; // paused: sender's buffers fill, like a dead link
  r.restore = () => { r.mode = 'pass'; }; // old connections stay dead forever, new ones work
  return new Promise((res) => r.server.listen(listenPort, '127.0.0.1', () => res(r)));
}

(async () => {
  fs.mkdirSync(path.join(SRC, 'vendor', 'pkg', 'src'), { recursive: true });
  { const fd = fs.openSync(path.join(SRC, 'big.bin'), 'w'); const c = crypto.randomBytes(50e6); for (let i = 0; i < 30; i++) fs.writeSync(fd, c); fs.closeSync(fd); } // 1.5 GB
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(SRC, 'vendor', 'pkg', 'src', `F${i}.php`), crypto.randomBytes(3000 + i));
  fs.writeFileSync(path.join(SRC, 'vendor', 'autoload.php'), crypto.randomBytes(500));

  const deadEnv = process.env.TEST_DEAD_MS ? { BEAM_DEAD_MS: process.env.TEST_DEAD_MS } : {};
  const A = await start('Alpha', 1, { BEAM_RETRY_FOR_MS: '60000', ...deadEnv });
  const B = await start('Bravo', 2, deadEnv);
  const R = await relay(46899, B.tcp);
  await req(A, 'POST', '/api/peer', { host: '127.0.0.1', port: 46899 });
  const peerId = 'manual-127.0.0.1-46899';

  // Pair once (small transfer).
  let r = await req(A, 'POST', '/api/send', { peerId, paths: [path.join(SRC, 'vendor')] });
  await until(async () => { await acceptAll(A); await acceptAll(B); return (await transfer(A, r.id))?.status === 'done'; }, 30000, 'first transfer');
  const vendorId = r.id;

  // 1-3. Silent drop in the middle of a big transfer.
  r = await req(A, 'POST', '/api/send', { peerId, paths: [path.join(SRC, 'big.bin')] });
  await until(async () => { await acceptAll(B); const t = await transfer(B, r.id); return t?.status === 'receiving' && t.bytes > 150e6; }, 60000, 'big transfer under way');
  R.blackhole();
  const t0 = Date.now();
  console.log('  status at blackhole:', (await transfer(A, r.id))?.status, Math.round(((await transfer(B, r.id))?.bytes || 0) / 1e6), 'MB');
  await until(async () => (await transfer(A, r.id))?.status === 'reconnecting', Number(process.env.TEST_NOTICE_MS) || 60000, 'sender notices the dead link');
  const senderNoticed = (Date.now() - t0) / 1000;
  await until(async () => (await transfer(B, r.id))?.status === 'interrupted', 60000, 'receiver notices the dead link');
  const receiverNoticed = (Date.now() - t0) / 1000;
  check('1  silent drop: sender notices and starts retrying', senderNoticed < 30, `after ${senderNoticed.toFixed(0)} s`);
  check('2  silent drop: receiver notices and saves progress', receiverNoticed < 30, `after ${receiverNoticed.toFixed(0)} s`);
  await sleep(5000);
  R.restore();
  const done = await until(async () => { const t = await transfer(A, r.id); return t?.status === 'done' && t; }, 120000, 'resumes after the link returns');
  const intact = sha(path.join(B.save, 'big.bin')) === sha(path.join(SRC, 'big.bin'));
  check('3  link comes back -> resumes by itself, file intact', intact && done.resumedFrom > 100e6, `resumed with ${(done.resumedFrom / 1e6).toFixed(0)} MB already there`);

  // 4. Resend the same folder: nothing duplicated, nothing re-sent.
  r = await req(A, 'POST', '/api/send', { peerId, paths: [path.join(SRC, 'vendor')] });
  const again = await until(async () => { await acceptAll(B); const t = await transfer(A, r.id); return t?.status === 'done' && t; }, 30000, 'resend');
  const all = fs.readdirSync(path.join(B.save, 'vendor'), { recursive: true });
  const dups = all.filter((f) => /\(\d+\)/.test(f));
  check('4  resending the same folder: no "(1)" duplicates, nothing re-sent', dups.length === 0 && again.resumedFrom === again.totalBytes && r.id === vendorId,
    `${dups.length} duplicates; ${(again.resumedFrom / 1e3).toFixed(0)} of ${(again.totalBytes / 1e3).toFixed(0)} KB skipped`);

  // 5. A changed file is NOT silently overwritten: it arrives next to the old one.
  fs.writeFileSync(path.join(SRC, 'vendor', 'autoload.php'), crypto.randomBytes(777));
  r = await req(A, 'POST', '/api/send', { peerId, paths: [path.join(SRC, 'vendor')] });
  await until(async () => { await acceptAll(B); return (await transfer(A, r.id))?.status === 'done'; }, 30000, 'changed resend');
  const v = fs.readdirSync(path.join(B.save, 'vendor'));
  const others = fs.readdirSync(path.join(B.save, 'vendor', 'pkg', 'src')).filter((f) => /\(\d+\)/.test(f));
  check('5  changed file kept beside the old one ("(1)"); unchanged files untouched', v.includes('autoload (1).php') && others.length === 0, v.filter((f) => f.startsWith('autoload')).join(', '));

  // 6. Leftover .beampart from an old crash (no resume record) is replaced, not duplicated.
  fs.writeFileSync(path.join(SRC, 'clip.bin'), crypto.randomBytes(5e6));
  fs.writeFileSync(path.join(B.save, 'clip.bin.beampart'), Buffer.alloc(1234));
  r = await req(A, 'POST', '/api/send', { peerId, paths: [path.join(SRC, 'clip.bin')] });
  await until(async () => { await acceptAll(B); return (await transfer(A, r.id))?.status === 'done'; }, 30000, 'orphan');
  const names = fs.readdirSync(B.save).filter((f) => f.startsWith('clip'));
  check('6  stale .beampart leftover is replaced, not turned into "(1)"', names.join() === 'clip.bin' && sha(path.join(B.save, 'clip.bin')) === sha(path.join(SRC, 'clip.bin')), names.join(', '));

  // 7. When automatic retries give up, "Retry" resumes the same transfer.
  fs.writeFileSync(path.join(SRC, 'late.bin'), crypto.randomBytes(20e6));
  await req(A, 'POST', '/api/peer', { host: '127.0.0.1', port: 46898 }); // nothing listening yet
  r = await req(A, 'POST', '/api/send', { peerId: 'manual-127.0.0.1-46898', paths: [path.join(SRC, 'late.bin')] });
  const failed = await until(async () => { const t = await transfer(A, r.id); return t?.status === 'failed' && t; }, 120000, 'gives up');
  const R2 = await relay(46898, B.tcp);
  await req(A, 'POST', `/api/transfer/${r.id}/retry`, {});
  await until(async () => { await acceptAll(B); return (await transfer(A, r.id))?.status === 'done'; }, 60000, 'manual retry');
  check('7  after giving up, "Retry" sends it (no re-picking files)', sha(path.join(B.save, 'late.bin')) === sha(path.join(SRC, 'late.bin')), `gave up with: "${failed.error.slice(0, 60)}"`);

  procs.forEach((p) => p.kill('SIGKILL'));
  R.server.close(); R2.server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error('ERROR', e.message);
  for (const [n, port] of [['A', 47801], ['B', 47802]]) {
    try { const a = { ui: port }; a.token = (await req(a, 'GET', '/', null, true)).match(/const TOKEN = '(\w+)'/)[1]; const st = await req(a, 'GET', '/api/state');
      console.error(`STATE ${n}:`, JSON.stringify(st.transfers.map((t) => [t.status, Math.round(t.bytes / 1e6), t.error]))); } catch (x) { console.error(n, x.message); }
  }
  procs.forEach((p) => p.kill('SIGKILL'));
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
