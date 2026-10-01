// Hotspot logic tests that run anywhere. Windows' Wi-Fi APIs themselves can only be
// exercised on a real Windows PC.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A stand-in "powershell.exe": returns FAKE_JSON if set, otherwise runs the script with a
// real PowerShell (pwsh) when one is installed.
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-ps-'));
let PWSH = process.env.PWSH || null;
if (!PWSH) { try { PWSH = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['pwsh']).toString().split(/\r?\n/)[0].trim() || null; } catch {} }
fs.writeFileSync(path.join(FAKE, 'powershell.exe'), `#!/bin/sh
while [ $# -gt 0 ]; do if [ "$1" = "-EncodedCommand" ]; then shift; ENC=$1; fi; shift; done
echo "$ENC" > "${FAKE}/last.b64"
if [ -n "$FAKE_JSON" ]; then echo "$FAKE_JSON"; exit 0; fi
exec "${PWSH || 'pwsh'}" -NoProfile -NonInteractive -EncodedCommand "$ENC"
`, { mode: 0o755 });
const h = require('../src/hotspot');
const results = [];
const check = (name, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  |  ${note}` : ''}`); };

(async () => {
  // 1. The exact error text from the user's Windows PC.
  const clixml = '#< CLIXML <Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><S S="Error">Windows refused to start the hotspot: WiFiDeviceOff x000Dx000A</S><S S="Error">At line:22 char:26_x000D_x000A</S></Objs>';
  const cleaned = h.cleanError(clixml);
  check('1  raw PowerShell CLIXML error becomes one readable line', cleaned === 'Windows refused to start the hotspot: WiFiDeviceOff', `"${cleaned}"`);

  // 2. Status codes -> plain advice (fake powershell.exe returns what Windows would).
  process.env.PATH = `${FAKE}:${process.env.PATH}`;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.FAKE_JSON = '{"ok":false,"status":"WiFiDeviceOff","error":""}';
  let msg = await h.hotspot.start().then(() => 'no error', (e) => e.message);
  check('2  WiFiDeviceOff -> tells you to turn Wi-Fi on + Dell LAN/WLAN hint', /Wi-Fi is turned off/.test(msg) && /LAN\/WLAN Switching/.test(msg), msg.slice(0, 70) + '…');
  let all = true;
  for (const code of Object.keys(h.WIN_STATUS)) {
    process.env.FAKE_JSON = JSON.stringify({ ok: false, status: code, error: '' });
    const m = await h.hotspot.start().then(() => '', (e) => e.message);
    if (m !== h.WIN_STATUS[code]) all = false;
  }
  check('3  every Windows tethering status code has a plain-English message', all, `${Object.keys(h.WIN_STATUS).length} codes`);
  process.env.FAKE_JSON = '{"ok":true,"ssid":"BeamKXTP"}';
  const ok = await h.hotspot.start();
  check('4  successful start returns name + 10-digit password', /^Beam[A-Z]{4}$/.test(ok.ssid) && /^\d{10}$/.test(ok.password), `${ok.ssid} / ${ok.password}`);

  // 5. Real PowerShell runs the real script; WinRT is missing on Linux so it must FAIL,
  //    and that failure must come back as clean JSON, not CLIXML.
  if (PWSH) {
    delete process.env.FAKE_JSON;
    msg = await h.hotspot.start().then(() => 'no error', (e) => e.message);
    check('5  real PowerShell: failure arrives as a clean sentence, no XML', msg !== 'no error' && !/CLIXML|<Objs|x000D/.test(msg), `"${msg.slice(0, 90)}"`);
  } else console.log('SKIP 5  (PowerShell 7 "pwsh" not installed)');

  // 6. Every generated script parses without syntax errors.
  const scripts = [];
  for (const [name, fn] of [['start', () => h.hotspot.start()], ['status', () => h.hotspot.status()], ['stop', () => h.hotspot.stop()]]) {
    process.env.FAKE_JSON = '{"ok":true}';
    await fn().catch(() => {});
    scripts.push([name, Buffer.from(fs.readFileSync(path.join(FAKE, 'last.b64'), 'utf8').trim(), 'base64').toString('utf16le')]);
  }
  let parseErrs = [];
  for (const [name, src] of PWSH ? scripts : []) {
    const file = path.join(FAKE, 's.ps1');
    fs.writeFileSync(file, src);
    const out = execFileSync(PWSH, ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("${file}",[ref]$null,[ref]$e); $e.Count; $e | % { $_.Message }`]).toString().trim();
    if (out.split('\n')[0] !== '0') parseErrs.push(`${name}: ${out}`);
  }
  if (PWSH) check('6  start/status/stop PowerShell scripts parse cleanly', !parseErrs.length, parseErrs.join('; ') || 'start, status, stop');
  else console.log('SKIP 6  (PowerShell 7 "pwsh" not installed)');
  Object.defineProperty(process, 'platform', { value: 'linux' });

  // 7. Scan parsers on realistic tool output.
  const mac = JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{ _name: 'en0',
    spairport_current_network_information: { _name: 'HomeWiFi', spairport_network_channel: '36' },
    spairport_airport_other_local_wireless_networks: [{ _name: 'Beam-EHBE', spairport_network_channel: '149 (5GHz, 80MHz)' }, { _name: 'Neighbour 5G' }] }] }] });
  const macList = h.parseMacScan(mac);
  const netsh = 'Interface name : Wi-Fi\r\nThere are 3 networks currently visible.\r\n\r\nSSID 1 : HomeWiFi\r\n    Network type            : Infrastructure\r\n\r\nSSID 2 : Beam-EHBE\r\n    Authentication          : WPA2-Personal\r\n\r\nSSID 3 : \r\n';
  const winList = h.parseNetshScan(netsh);
  check('7  macOS system_profiler scan parsed', ['HomeWiFi', 'Beam-EHBE', 'Neighbour 5G'].every((n) => macList.includes(n)), macList.join(', '));
  check('8  Windows netsh scan parsed (hidden network skipped)', JSON.stringify(winList) === '["HomeWiFi","Beam-EHBE"]', winList.join(', '));

  // 9. The user's exact typo is forgiven; ambiguity is not guessed.
  const m1 = h.matchSsid('Beam - EHBE', ['HomeWiFi', 'Beam-EHBE']);
  const m2 = h.matchSsid('beam ehbe', ['Beam-EHBE', 'Beam_EHBE']);
  check('9  "Beam - EHBE" matches the real "Beam-EHBE"; ambiguous names are refused', m1 === 'Beam-EHBE' && m2 === null, `${m1} / ${m2}`);

  // 10. Generated names avoid look-alikes and separators.
  let clean = true;
  for (let i = 0; i < 2000; i++) { const c = h.randomCredentials(); if (!/^Beam[ACDEFHJKMNPRTUVWXY]{4}$/.test(c.ssid) || !/^\d{10}$/.test(c.password)) clean = false; }
  check('10 2,000 generated names: no spaces, hyphens, O/0 or I/1 look-alikes', clean);

  // 11-14: the macOS 14.4+ case from the user's Mac: every name comes back "<redacted>".
  const LOG = path.join(FAKE, 'networksetup.log');
  const redacted = JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{ _name: 'en0',
    spairport_current_network_information: { _name: '<redacted>' },
    spairport_airport_other_local_wireless_networks: [{ _name: '<redacted>' }, { _name: '<redacted>' }, { _name: '<redacted>' }] }] }] });
  fs.writeFileSync(path.join(FAKE, 'redacted.json'), redacted);
  fs.writeFileSync(path.join(FAKE, 'system_profiler'), `#!/bin/sh\ncat "${FAKE}/redacted.json"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(FAKE, 'networksetup'), `#!/bin/sh
if [ "$1" = "-listallhardwareports" ]; then printf 'Hardware Port: Wi-Fi\\nDevice: en0\\nEthernet Address: aa\\n'; exit 0; fi
echo "$@" >> "${LOG}"
`, { mode: 0o755 });
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const sc = await h.hotspot.scan();
  check('11 macOS redacted scan: "<redacted>" entries dropped, flagged as hidden', sc.networks.length === 0 && sc.hidden === true, JSON.stringify(sc));
  let joined = await h.hotspot.join('BeamYKJY', '6027932382').then((r) => r.ssid, (e) => `ERROR ${e.message}`);
  let logged = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim() : '';
  check('12 join is attempted even though macOS hid every name (v1.2 refused here)', joined === 'BeamYKJY' && logged === '-setairportnetwork en0 BeamYKJY 6027932382', logged || joined);
  fs.rmSync(LOG, { force: true });
  joined = await h.hotspot.join('beam - ykjy', '602 793 2382').then((r) => r.ssid, (e) => `ERROR ${e.message}`);
  logged = fs.readFileSync(LOG, 'utf8').trim();
  check('13 sloppy typing "beam - ykjy" / "602 793 2382" is tidied to the real name and password', logged === '-setairportnetwork en0 BeamYKJY 6027932382', logged);
  fs.rmSync(LOG, { force: true });
  joined = await h.hotspot.join('HomeWiFi', 'secret pass 1').then((r) => r.ssid, (e) => `ERROR ${e.message}`);
  logged = fs.readFileSync(LOG, 'utf8').trim();
  check('14 non-Beam networks are passed through untouched (spaces in password kept)', logged === '-setairportnetwork en0 HomeWiFi secret pass 1', logged);

  // 15. 2.4 GHz fallback script: stops first, sets band 1, keeps name/password, parses.
  Object.defineProperty(process, 'platform', { value: 'win32' });
  process.env.FAKE_JSON = '{"ok":true,"ssid":"BeamYKJY"}';
  const r24 = await h.hotspot.start('2.4', { ssid: 'BeamYKJY', password: '6027932382' });
  const src24 = Buffer.from(fs.readFileSync(path.join(FAKE, 'last.b64'), 'utf8').trim(), 'base64').toString('utf16le');
  let parsed = 'not checked (no pwsh)';
  if (PWSH) {
    fs.writeFileSync(path.join(FAKE, 'b.ps1'), src24);
    parsed = execFileSync(PWSH, ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile("${path.join(FAKE, 'b.ps1')}",[ref]$null,[ref]$e); $e.Count`]).toString().trim() === '0' ? 'parses' : 'PARSE ERROR';
  }
  check('15 "Switch to 2.4 GHz": same name+password, Band = 1, restarts cleanly', r24.ssid === 'BeamYKJY' && r24.password === '6027932382' && r24.band === '2.4'
    && /\$cfg\.Band = 1/.test(src24) && /StopTetheringAsync/.test(src24) && parsed !== 'PARSE ERROR', parsed);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  delete process.env.FAKE_JSON;

  fs.rmSync(FAKE, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
