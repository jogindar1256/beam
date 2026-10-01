// Hotspot control.
//
// Windows 10/11 can CREATE a hotspot (Mobile Hotspot / WinRT tethering API).
// macOS has NO public API to create one, so a Mac JOINS. Mac<->Mac: use a Thunderbolt
// cable. Windows<->Mac by cable: use Ethernet (USB-C-to-Ethernet adapter); a plain
// USB-C cable between a PC and a Mac does not create a network.
// Joining a hotspot disconnects that computer from its current Wi-Fi (one radio).
'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(cleanError(`${stderr || ''}\n${stdout || ''}`) || err.message);
        e.raw = `${stderr}${stdout}`;
        reject(e);
      } else resolve(stdout.toString());
    });
  });
}

/** Turn PowerShell CLIXML / multi-line noise into the one line a person needs. */
function cleanError(text) {
  let t = String(text);
  if (t.includes('#< CLIXML') || t.includes('<Objs')) {
    const errs = [...t.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
    t = (errs[0] || '').replace(/_x000D_|_x000A_|x000Dx000A|x000D|x000A/g, ' ');
  }
  t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const line = t.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !/^(At line|\+|CategoryInfo|FullyQualifiedErrorId)/.test(s));
  return (line || '').replace(/\s+/g, ' ').trim();
}

// Windows tethering status codes -> what the person should actually do.
const WIN_STATUS = {
  WiFiDeviceOff: 'Wi-Fi is turned off on this PC, so it cannot host a hotspot. Turn Wi-Fi on (click the network icon in the taskbar) and try again. '
    + 'If Wi-Fi switches itself off when a cable is plugged in, unplug the cable, or disable "LAN/WLAN Switching" in the BIOS (common on Dell laptops).',
  OperationInProgress: 'Windows is still switching the hotspot on or off. Wait 10 seconds and try again.',
  NetworkLimitedConnectivity: 'Windows will not start a hotspot on this connection. Connect this PC to any Wi-Fi or Ethernet network first, then try again.',
  EntitlementCheckFailure: 'Windows says this connection is not allowed to be shared. Connect to a different network, or start Mobile hotspot manually in Settings.',
  EntitlementCheckTimeout: 'Windows timed out checking whether this connection can be shared. Try again, or start Mobile hotspot manually in Settings.',
  MobileBroadbandDeviceOff: 'The connection Windows wants to share (mobile broadband) is off. Connect to Wi-Fi or Ethernet first.',
  BluetoothDeviceOff: 'Windows tried to share over Bluetooth, which is off. Start Mobile hotspot manually in Settings and choose Wi-Fi.',
  Unknown: 'Windows could not start the hotspot. Try Settings > Network & internet > Mobile hotspot manually; Beam works the same once the other computer joins.',
};

/** Run a PowerShell script that reports through one JSON line, never through the error stream. */
async function powershell(body) {
  const script = `$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
${body}
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded]);
  const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(cleanError(out) || 'PowerShell returned no result.');
  const res = JSON.parse(line);
  if (!res.ok) {
    const code = res.status && WIN_STATUS[res.status] ? res.status : null;
    const e = new Error(code ? WIN_STATUS[code] : cleanError(res.error) || 'Windows could not complete the hotspot operation.');
    e.status = res.status;
    throw e;
  }
  return res;
}

const WINRT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function AwaitOp($op, [Type]$t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
function AwaitAction($a) { $task = $asTaskAction.Invoke($null, @($a)); $task.Wait(-1) | Out-Null }
[Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime] | Out-Null
[Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime] | Out-Null
$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if ($null -eq $profile) { $profile = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() | Select-Object -First 1 }
if ($null -eq $profile) {
  [pscustomobject]@{ ok = $false; status = 'NetworkLimitedConnectivity'; error = 'no connection profile' } | ConvertTo-Json -Compress
  return
}
$mgr = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
`;

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// TetheringWiFiBand: 0 Auto, 1 = 2.4 GHz, 2 = 5 GHz
async function startWindows(ssid, pass, band = '5') {
  const bandValue = band === '2.4' ? 1 : 2;
  return powershell(`${WINRT}
if ($mgr.TetheringOperationalState.ToString() -eq 'On') {
  AwaitOp ($mgr.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) | Out-Null
}
$cfg = $mgr.GetCurrentAccessPointConfiguration()
$cfg.Ssid = ${psQuote(ssid)}
$cfg.Passphrase = ${psQuote(pass)}
try { $cfg.Band = ${bandValue} } catch {}   # band choice needs Windows 11; ignored on 10
AwaitAction ($mgr.ConfigureAccessPointAsync($cfg))
# Stop Windows from switching the hotspot off after ~5 idle minutes (Windows 11+).
try { [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::DisableNoConnectionsTimeout() } catch {}
if ($mgr.TetheringOperationalState.ToString() -ne 'On') {
  $r = AwaitOp ($mgr.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
  if ($r.Status.ToString() -ne 'Success') {
    [pscustomobject]@{ ok = $false; status = $r.Status.ToString(); error = [string]$r.AdditionalErrorMessage } | ConvertTo-Json -Compress
    return
  }
}
$cfg2 = $mgr.GetCurrentAccessPointConfiguration()
[pscustomobject]@{ ok = $true; ssid = $cfg2.Ssid } | ConvertTo-Json -Compress`);
}

async function statusWindows() {
  return powershell(`${WINRT}
$cfg = $mgr.GetCurrentAccessPointConfiguration()
[pscustomobject]@{ ok = $true; state = $mgr.TetheringOperationalState.ToString(); clients = [int]$mgr.ClientCount; ssid = $cfg.Ssid } | ConvertTo-Json -Compress`);
}

async function stopWindows() {
  return powershell(`${WINRT}
$r = AwaitOp ($mgr.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress`);
}

// ---------------------------------------------------------------- scanning (joining side)
/** Parse `system_profiler SPAirPortDataType -json` (macOS 12+). */
function parseMacScan(jsonText) {
  const names = new Set();
  const walk = (node, key = '') => {
    if (Array.isArray(node)) { for (const x of node) walk(x, key); return; }
    if (!node || typeof node !== 'object') return;
    if (/other_local_wireless_networks|current_network_information/.test(key) && typeof node._name === 'string') names.add(node._name);
    for (const [k, v] of Object.entries(node)) walk(v, k);
  };
  walk(JSON.parse(jsonText));
  return [...names];
}
// macOS 14.4+ replaces network names with "<redacted>" for apps without Location access.
const isRedacted = (n) => !n || /^<redacted>$/i.test(String(n).trim());
/** Parse `netsh wlan show networks` (the "SSID n : name" lines are not localized). */
function parseNetshScan(text) {
  return [...String(text).matchAll(/^\s*SSID\s+\d+\s*:\s?(.*)$/gm)].map((m) => m[1].trim()).filter(Boolean);
}
function parseNmcliScan(text) {
  return String(text).split(/\r?\n/).map((s) => s.replace(/\\:/g, ':').trim()).filter(Boolean);
}

/** Returns { networks, hidden }. hidden: the OS withheld some or all names. */
async function scan() {
  let list = [];
  if (process.platform === 'darwin') list = parseMacScan(await run('system_profiler', ['SPAirPortDataType', '-json'], 30000));
  else if (process.platform === 'win32') list = parseNetshScan(await run('netsh', ['wlan', 'show', 'networks']));
  else list = parseNmcliScan(await run('nmcli', ['-t', '-f', 'SSID', 'dev', 'wifi', 'list', '--rescan', 'yes'], 30000));
  const hidden = list.some(isRedacted);
  return { networks: [...new Set(list.filter((n) => !isRedacted(n)))], hidden };
}

const norm = (s) => String(s).toLowerCase().replace(/[\s\-_.]/g, '');
/** Match what the person typed to a network that really exists ("Beam - EHBE" -> "Beam-EHBE"). */
function matchSsid(typed, available) {
  if (available.includes(typed)) return typed;
  const n = norm(typed);
  const hits = available.filter((a) => norm(a) === n);
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------- joining
function xmlEscape(s) { return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]); }

async function joinWindows(ssid, pass) {
  const hex = Buffer.from(ssid, 'utf8').toString('hex').toUpperCase();
  const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(ssid)}</name>
  <SSIDConfig><SSID><hex>${hex}</hex><name>${xmlEscape(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType><connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(pass)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`;
  const file = path.join(os.tmpdir(), `beam-wlan-${crypto.randomBytes(4).toString('hex')}.xml`);
  fs.writeFileSync(file, xml, { mode: 0o600 });
  try {
    await run('netsh', ['wlan', 'add', 'profile', `filename=${file}`, 'user=current']);
    await run('netsh', ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`]);
  } finally { fs.rmSync(file, { force: true }); }
}

async function macWifiDevice() {
  const out = await run('networksetup', ['-listallhardwareports']);
  const m = out.match(/Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/);
  if (!m) throw new Error('No Wi-Fi adapter found on this Mac.');
  return m[1];
}

async function joinMac(ssid, pass) {
  const dev = await macWifiDevice();
  // networksetup prints errors to stdout and still exits 0.
  const out = await run('networksetup', ['-setairportnetwork', dev, ssid, pass], 45000);
  if (/could not find network/i.test(out)) throw new Error(`The Mac cannot see "${ssid}". Check the hotspot is still on (the PC shows its status), then scan again.`);
  if (/failed|error|incorrect|could not/i.test(out)) throw new Error(`The Mac could not join "${ssid}": ${out.trim()}. Check the password.`);
}

async function joinLinux(ssid, pass) {
  await run('nmcli', ['device', 'wifi', 'connect', ssid, 'password', pass], 45000);
}

// Names and passwords chosen so they can't be misread or mistyped: no spaces, no
// hyphens, no look-alike characters. The password is 10 digits.
function randomCredentials() {
  const letters = 'ACDEFHJKMNPRTUVWXY';
  const pick = (alphabet, n) => Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join('');
  return { ssid: `Beam${pick(letters, 4)}`, password: pick('0123456789', 10) };
}

let lastStatus = null;
const hotspot = {
  capabilities() {
    return {
      canCreate: process.platform === 'win32',
      canJoin: ['win32', 'darwin', 'linux'].includes(process.platform),
      note: process.platform === 'darwin'
        ? 'A Mac can join a hotspot but cannot create one automatically (macOS has no API for it). Start the hotspot on the Windows PC, or use a cable: Ethernet for PC↔Mac, Thunderbolt for Mac↔Mac.'
        : process.platform === 'win32' ? '' : 'Creating a hotspot is only automated on Windows.',
    };
  },
  async start(band = '5', keep = null) {
    if (process.platform !== 'win32') throw new Error(hotspot.capabilities().note);
    const cred = keep || randomCredentials(); // switching band keeps the same name/password
    const r = await startWindows(cred.ssid, cred.password, band === '2.4' ? '2.4' : '5');
    lastStatus = { state: 'On', clients: 0, ssid: r.ssid || cred.ssid };
    return { ...cred, ssid: r.ssid || cred.ssid, band: band === '2.4' ? '2.4' : '5' };
  },
  async status() {
    if (process.platform !== 'win32') return null;
    lastStatus = await statusWindows();
    return lastStatus;
  },
  async stop() { if (process.platform === 'win32') await stopWindows(); lastStatus = null; },
  scan,
  async join(ssidTyped, pass) {
    const ssid0 = String(ssidTyped || '').trim();
    pass = String(pass || '');
    if (!ssid0) throw new Error('Enter the hotspot name, or press "Scan" and pick it.');
    // Beam's own passwords are digits only; strip spaces people add while typing.
    if (/^beam/i.test(norm(ssid0))) pass = pass.replace(/\s+/g, '');
    if (pass.length < 8) throw new Error('The password must be at least 8 characters.');
    let ssid = ssid0;
    let seen = null;
    try { seen = await scan(); } catch {}
    if (seen) {
      const m = matchSsid(ssid0, seen.networks);
      if (m) ssid = m;
      else if (seen.hidden) {
        // Names are hidden by the OS: can't verify, so use what was typed, tidied up.
        if (/^beam/i.test(norm(ssid0))) ssid = ssid0.replace(/[\s\-_.]/g, '').replace(/^beam/i, 'Beam').replace(/^(Beam)(.*)$/, (_, b, r) => b + r.toUpperCase());
      } else {
        const beams = seen.networks.filter((s) => /^beam/i.test(s));
        throw new Error(beams.length
          ? `"${ssid0}" is not in range, but these Beam hotspots are: ${beams.join(', ')}.`
          : `No network called "${ssid0}" is in range. Check the hotspot is on (the PC shows its status), keep the computers within a few metres, then press Scan.`);
      }
    }
    if (process.platform === 'win32') await joinWindows(ssid, pass);
    else if (process.platform === 'darwin') await joinMac(ssid, pass);
    else await joinLinux(ssid, pass);
    return { ssid };
  },
};

module.exports = { powershell, hotspot, randomCredentials, cleanError, isRedacted, parseMacScan, parseNetshScan, matchSsid, WIN_STATUS, _scripts: { WINRT, startWindows, statusWindows } };
