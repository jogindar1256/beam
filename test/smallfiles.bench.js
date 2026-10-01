// Benchmark: thousands of small files (like a photo/code folder). Usage:
//   node test/smallfiles.bench.js [agentDir] [files] [kb]
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AGENT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const N = Number(process.argv[3]) || 4000;
const KB = Number(process.argv[4]) || 250;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-small-'));
const SRC = path.join(ROOT, 'photos');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

function start(name, n) {
  const dir = path.join(ROOT, name);
  // BENCH_ULIMIT=256 runs both agents under a low open-file limit (macOS default is 256;
  // Windows allows ~8,000), which makes file-handle leaks fail fast instead of at 8,000.
  const lim = process.env.BENCH_ULIMIT;
  const cmd = lim ? '/bin/sh' : process.execPath;
  const args = lim ? ['-c', `ulimit -n ${lim} && exec "${process.execPath}" "${path.join(AGENT, 'src', 'main.js')}" --no-open`] : [path.join(AGENT, 'src', 'main.js'), '--no-open'];
  const p = spawn(cmd, args, {
    env: { ...process.env, BEAM_DATA: path.join(dir, 'data'), BEAM_NAME: name, BEAM_SAVE_DIR: path.join(dir, 'recv'), BEAM_PORT: 46500 + n, BEAM_UI_PORT: 47500 + n, BEAM_UDP_PORT: 48500 + n, BEAM_ANNOUNCE: `127.0.0.1:${48500 + (n === 1 ? 2 : 1)}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);

  p.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  const a = { name, ui: 47500 + n, save: path.join(dir, 'recv') };
  return new Promise((res) => p.stdout.on('data', async (d) => {
    if (!String(d).includes('Control panel')) return;
    a.token = (await req(a, 'GET', '/', null, true)).match(/const TOKEN = '(\w+)'/)[1];
    res(a);
  }));
}
function req(a, method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: a.ui, method, path: p, headers: { 'x-beam-token': a.token || '', 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(raw ? s : JSON.parse(s)));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}

(async () => {
  const hashes = new Map();
  for (let i = 0; i < N; i++) {
    const rel = `sub${i % 40}/IMG_${String(i).padStart(5, '0')}.jpg`;
    const buf = crypto.randomBytes(Math.round(KB * 1024 * (0.5 + ((i * 7919) % 100) / 100)));
    fs.mkdirSync(path.join(SRC, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(SRC, rel), buf);
    hashes.set(rel, crypto.createHash('sha256').update(buf).digest('hex'));
  }
  const total = [...fs.readdirSync(SRC, { recursive: true })].reduce((s, f) => { const st = fs.statSync(path.join(SRC, f)); return s + (st.isFile() ? st.size : 0); }, 0);
  const A = await start('Alpha', 1), B = await start('Bravo', 2);
  let peer;
  for (let i = 0; i < 60 && !peer; i++) { await sleep(250); peer = (await req(A, 'GET', '/api/state')).peers.find((p) => p.name === 'Bravo'); }
  const { id } = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [SRC] });
  let t0 = null, done = null, maxFds = 0;
  const senderPid = procs[0].pid;
  const fdTimer = setInterval(() => { try { maxFds = Math.max(maxFds, fs.readdirSync(`/proc/${senderPid}/fd`).length); } catch {} }, 20);
  for (let i = 0; i < 6000 && !done; i++) {
    await sleep(100);
    for (const a of [A, B]) for (const pr of (await req(a, 'GET', '/api/state')).prompts) { await req(a, 'POST', `/api/prompt/${pr.id}`, { ok: true }); if (pr.kind === 'offer') t0 = Date.now(); }
    const t = (await req(A, 'GET', '/api/state')).transfers.find((x) => x.id === id);
    if (t?.status === 'failed') throw new Error(t.error);
    if (t?.status === 'done') done = Date.now();
  }
  clearInterval(fdTimer);
  const secs = (done - t0) / 1000;
  let bad = 0;
  for (const [rel, h] of hashes) {
    const p = path.join(B.save, 'photos', rel);
    if (!fs.existsSync(p) || crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== h) bad++;
  }
  console.log(`${N} files, ${(total / 1e6).toFixed(0)} MB in ${secs.toFixed(1)} s  ->  ${(total / 1e6 / secs).toFixed(1)} MB/s, ${(N / secs).toFixed(0)} files/s, ${bad} bad files, sender peak open handles: ${maxFds}`);
  procs.forEach((p) => p.kill('SIGKILL'));
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); procs.forEach((p) => p.kill('SIGKILL')); process.exit(1); });
