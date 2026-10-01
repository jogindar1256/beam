// Startup robustness tests: blocked/busy ports, duplicate launch, blocked discovery port.
'use strict';
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { listenWithFallback } = require('../src/ports');

const results = [];
const check = (name, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  |  ${note}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN = path.join(__dirname, '..', 'src', 'main.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-ports-'));

// Fake server reproducing Windows' excluded port ranges: listen() fails with EACCES.
class BlockedServer extends EventEmitter {
  constructor(blocked) { super(); this.blocked = blocked; this.port = null; }
  listen(port) {
    setImmediate(() => {
      if (this.blocked(port)) { const e = new Error(`listen EACCES: permission denied 127.0.0.1:${port}`); e.code = 'EACCES'; this.emit('error', e); }
      else { this.port = port || 51234; this.emit('listening'); }
    });
  }
  address() { return { port: this.port }; }
}

function run(name, n, env = {}) {
  const dir = path.join(ROOT, name);
  const proc = spawn(process.execPath, [MAIN, '--no-open'], {
    env: { ...process.env, BEAM_DATA: path.join(dir, 'data'), BEAM_NAME: name, BEAM_SAVE_DIR: path.join(dir, 'recv'),
      BEAM_PORT: 46300 + n, BEAM_UI_PORT: 47300 + n, BEAM_UDP_PORT: 48300 + n, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.out = '';
  proc.stdout.on('data', (d) => (proc.out += d));
  proc.stderr.on('data', (d) => (proc.out += d));
  return proc;
}
async function waitFor(proc, re, ms = 10000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (re.test(proc.out)) return true; await sleep(100); }
  return false;
}
function apiState(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let html = ''; res.on('data', (d) => (html += d)); res.on('end', () => {
        const token = html.match(/const TOKEN = '(\w+)'/)[1];
        http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { 'x-beam-token': token } }, (r2) => {
          let s = ''; r2.on('data', (d) => (s += d)); r2.on('end', () => resolve(JSON.parse(s)));
        }).on('error', reject);
      });
    }).on('error', reject);
  });
}

async function main() {
  // 1. Exactly the Windows failure: 7070 reserved -> next port.
  let p = await listenWithFallback(new BlockedServer((port) => port === 7070), '127.0.0.1', 7070);
  check('1  port 7070 reserved (EACCES) -> uses 7071', p === 7071, `got ${p}`);

  // 2. A whole reserved block (Hyper-V reserves ranges of 100) -> OS-assigned port.
  p = await listenWithFallback(new BlockedServer((port) => port >= 7000 && port <= 7099), '127.0.0.1', 7070);
  check('2  entire 7000-7099 block reserved -> falls back to an OS-assigned port', p === 51234, `got ${p}`);

  // 3. Non-port errors are not swallowed.
  const weird = new EventEmitter();
  weird.listen = () => setImmediate(() => { const e = new Error('boom'); e.code = 'EMFILE'; weird.emit('error', e); });
  const threw = await listenWithFallback(weird, '127.0.0.1', 7070).then(() => false, (e) => e.code === 'EMFILE');
  check('3  unrelated errors still surface instead of looping', threw);

  // 4. Real agent: UI port and transfer port already taken by another program.
  const squatUi = net.createServer().listen(47301, '127.0.0.1');
  const squatTcp = net.createServer().listen(46301, '0.0.0.0');
  await sleep(200);
  const a = run('Alpha', 1);
  const started = await waitFor(a, /Control panel: http:\/\/127\.0\.0\.1:(\d+)/);
  const uiPort = Number((a.out.match(/Control panel: http:\/\/127\.0\.0\.1:(\d+)/) || [])[1]);
  const st = started ? await apiState(uiPort) : null;
  check('4  busy UI + transfer ports -> agent starts on fallback ports and works',
    started && uiPort === 47302 && st?.me.port === 46302 && /47301 is blocked or busy/.test(a.out), `UI ${uiPort}, transfers ${st?.me.port}`);

  // 5. Launching twice: second copy detects the first and exits cleanly.
  const a2 = run('Alpha', 1, { BEAM_UI_PORT: String(uiPort) });
  const exited = await new Promise((r) => { a2.on('exit', (code) => r(code)); setTimeout(() => r('still running'), 8000); });
  check('5  second launch reuses the running copy instead of crashing', exited === 0 && /already running/.test(a2.out), a2.out.trim().split('\n')[0]);

  // 6. Discovery port blocked on B: both devices still find each other.
  const blockUdp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((r) => blockUdp.bind(48303, '0.0.0.0', r));
  const b = run('Bravo', 3, { BEAM_UDP_PORT: '48303', BEAM_ANNOUNCE: '127.0.0.1:48301' });
  // Alpha announces only to Bravo's standard (blocked) port, as broadcast would.
  await waitFor(b, /Control panel: http:\/\/127\.0\.0\.1:(\d+)/);
  const bUi = Number(b.out.match(/Control panel: http:\/\/127\.0\.0\.1:(\d+)/)[1]);
  let seenByA = false, seenByB = false;
  for (let i = 0; i < 40 && !(seenByA && seenByB); i++) {
    await sleep(250);
    seenByA = (await apiState(uiPort)).peers.some((x) => x.name === 'Bravo');
    seenByB = (await apiState(bUi)).peers.some((x) => x.name === 'Alpha');
  }
  check('6  discovery port blocked on one device -> still discovered both ways', seenByA && seenByB && /Discovery port 48303 is blocked/.test(b.out), `A sees B: ${seenByA}, B sees A: ${seenByB}`);

  // 7. Startup failure prints a readable message, not a stack trace.
  const bad = spawn(process.execPath, [MAIN, '--no-open'], { env: { ...process.env, BEAM_DATA: path.join(__filename, 'not-a-dir') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let badOut = ''; bad.stdout.on('data', (d) => (badOut += d)); bad.stderr.on('data', (d) => (badOut += d));
  const code = await new Promise((r) => bad.on('exit', r));
  check('7  fatal startup error is readable, no raw stack trace', code === 1 && /Beam could not start/.test(badOut) && !/\n\s+at /.test(badOut), badOut.trim().split('\n').slice(-1)[0]);

  for (const pr of [a, b]) pr.kill('SIGKILL');
  squatUi.close(); squatTcp.close(); blockUdp.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('ERROR', e); process.exit(1); });
