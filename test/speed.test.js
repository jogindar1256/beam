// Speed test + Wi-Fi link diagnostics.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/linkinfo');

const results = [];
const check = (n, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${note ? `  |  ${note}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1-4: link parsing on realistic OS output
const win11 = `There is 1 interface on the system:

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6 AX201 160MHz
    State                  : connected
    SSID                   : HomeWiFi
    Radio type             : 802.11ax
    Band                   : 5 GHz
    Channel                : 36
    Receive rate (Mbps)    : 1201
    Transmit rate (Mbps)   : 960
    Signal                 : 88%
    Hosted network status  : Not available
`;
const w = L.parseNetshInterfaces(win11);
check('1  Windows 11 netsh: band, channel, link rate, signal', w.band === '5' && w.channel === 36 && w.rateMbps === 960 && w.signal === '88%', JSON.stringify({ band: w.band, ch: w.channel, rate: w.rateMbps }));
const win10 = win11.replace(/^\s*Band.*\n/m, '').replace('Channel                : 36', 'Channel                : 6').replace(/1201|960/g, '72');
const w10 = L.parseNetshInterfaces(win10);
check('2  Windows 10 (no Band line): band inferred from channel 6 -> 2.4 GHz, slow-link tips', w10.band === '2.4' && L.advice(w10).length === 2, L.advice(w10).map((t) => t.slice(0, 40)).join(' / '));
const macOn = (ch, rate) => JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{ _name: 'en0', spairport_current_network_information: { _name: '<redacted>', spairport_network_phymode: '802.11ac', spairport_network_channel: ch, spairport_network_rate: rate, spairport_signal_noise: '-52 dBm / -94 dBm' } }] }] });
const m5 = L.parseMacAirport(macOn('36 (5GHz, 80MHz)', 866));
check('3  Mac on 5 GHz/80 MHz at 866 Mbps: parsed, no warnings', m5.band === '5' && m5.width === 80 && m5.rateMbps === 866 && L.advice(m5).length === 0, JSON.stringify({ band: m5.band, width: m5.width, rate: m5.rateMbps }));
const m24 = L.parseMacAirport(macOn('6 (2GHz, 20MHz)', 72));
const user = L.parseMacAirport(macOn('11 (2GHz, 20MHz)', 103)); // the user's actual Mac reading
check('4  the user\'s Mac (802.11ax, 2.4 GHz ch 11, 20 MHz, 103 Mbps): flagged with the 5 GHz fix', user.band === '2.4' && user.channel === 11 && user.width === 20 && L.advice(user).length === 2 && /5 GHz network/.test(L.advice(user)[0]), L.advice(user)[0].slice(0, 70) + '…');

// --- 8-10: Windows with netsh blocked by the location-permission rule
async function windowsLocationTests() {
  const { execFileSync } = require('child_process');
  const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-win-'));
  const write = (n, body) => fs.writeFileSync(path.join(FAKE, n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write('netsh', `echo "Network shell commands need location permission to access WLAN information. Turn on Location services on the Location page in Privacy & security settings."; exit 1`);
  write('powershell.exe', `echo '{"ok":true,"connected":true,"adapter":"Intel(R) Wi-Fi 6 AX201 160MHz","rx":866700000,"tx":780000000}'`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${FAKE}:${savedPath}`;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  delete require.cache[require.resolve('../src/linkinfo')];
  const li = await require('../src/linkinfo').linkInfo();
  check('8  netsh blocked by location rule -> link rate still shown via adapter speed', li.connected && li.rateMbps === 780 && li.limited === true && !li.error, `${li.rateMbps} Mbps, ${li.adapter}`);
  check('9  user is told exactly which setting unlocks band/channel; no speed guess shown', li.tips.some((t) => /Let desktop apps access your location/.test(t)) && li.estimate === undefined, 'location tip shown');
  write('netsh', `echo "The Wireless AutoConfig Service (wlansvc) is not running."; exit 1`);
  const li2 = await require('../src/linkinfo').linkInfo();
  check('10 other netsh failures show the real reason, not "Command failed"', /wlansvc/.test(li2.error || '') && !/Command failed/.test(li2.error), li2.error);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  process.env.PATH = savedPath;
  fs.rmSync(FAKE, { recursive: true, force: true });
}

// --- 5-6: real speed test between two agents
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-speed-'));
const agents = [];
function start(name, n) {
  const dir = path.join(ROOT, name);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js'), '--no-open'], {
    env: { ...process.env, BEAM_DATA: path.join(dir, 'data'), BEAM_NAME: name, BEAM_SAVE_DIR: path.join(dir, 'recv'), BEAM_PORT: 46400 + n, BEAM_UI_PORT: 47400 + n, BEAM_UDP_PORT: 48400 + n, BEAM_ANNOUNCE: `127.0.0.1:${48400 + (n === 1 ? 2 : 1)}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agents.push(p);
  const a = { name, ui: 47400 + n, save: path.join(dir, 'recv') };
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
  await windowsLocationTests();
  const A = await start('Alpha', 1), B = await start('Bravo', 2);
  let peer;
  for (let i = 0; i < 60 && !peer; i++) { await sleep(250); peer = (await req(A, 'GET', '/api/state')).peers.find((p) => p.name === 'Bravo'); }
  const pending = req(A, 'POST', '/api/speedtest', { peerId: peer.id, seconds: 5 });
  // first contact: confirm pairing on both sides, as a person would
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    for (const a of [A, B]) for (const pr of (await req(a, 'GET', '/api/state')).prompts) await req(a, 'POST', `/api/prompt/${pr.id}`, { ok: true });
  }
  const r = await pending;
  check('5  speed test runs over the real encrypted protocol', r.MBps > 0 && r.connections === 4 && r.ms >= 3000, `${r.MBps} MB/s over ${r.connections} connections (${(r.bytes / 1e6).toFixed(0)} MB in ${(r.ms / 1000).toFixed(1)} s)`);
  const wrote = fs.existsSync(B.save) ? fs.readdirSync(B.save) : [];
  check('6  speed test never touches the receiver\'s disk', wrote.length === 0, wrote.length ? wrote.join(',') : 'save folder untouched');
  const r2 = await req(A, 'POST', '/api/speedtest', { peerId: peer.id, seconds: 3 });
  check('7  once paired, repeat tests need no prompts', r2.MBps > 0, `${r2.MBps} MB/s`);
  agents.forEach((p) => p.kill('SIGKILL'));
  fs.rmSync(ROOT, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); agents.forEach((p) => p.kill('SIGKILL')); process.exit(1); });
