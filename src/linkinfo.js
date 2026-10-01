// What is this computer's Wi-Fi link actually capable of? Reads band, channel, link rate
// and signal from the OS, plus advice. Real throughput comes from the speed test.
'use strict';
const { execFile } = require('child_process');

const run = (cmd, args, timeout = 20000) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 << 20 }, (e, out, err) => {
    if (!e) return resolve(String(out));
    e.output = `${out || ''}\n${err || ''}`; // netsh explains itself on stdout even when it fails
    reject(e);
  }));

// Windows 11 (recent updates) blocks `netsh wlan` unless location access is on. This
// fallback reads the link rate without that permission; band/channel stay unknown.
async function windowsAdapterRate() {
  const { powershell } = require('./hotspot');
  const r = await powershell(`
$a = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' -and ($_.PhysicalMediaType -match '802\.11' -or $_.InterfaceDescription -match 'Wi-?Fi|Wireless|WLAN|802\.11') } | Select-Object -First 1
if ($null -eq $a) { [pscustomobject]@{ ok = $true; connected = $false } | ConvertTo-Json -Compress; return }
[pscustomobject]@{ ok = $true; connected = $true; adapter = $a.InterfaceDescription; rx = [double]$a.ReceiveLinkSpeed; tx = [double]$a.TransmitLinkSpeed } | ConvertTo-Json -Compress`);
  if (!r.connected) return { connected: false };
  const rate = Math.round(Math.min(r.rx || r.tx, r.tx || r.rx) / 1e6) || null;
  return { connected: true, adapter: r.adapter, rateMbps: rate, band: null, channel: null };
}

const LOCATION_TIP = 'Windows hides the Wi-Fi band and channel unless location access is on: Settings → Privacy & security → Location → turn on "Location services" and "Let desktop apps access your location". Then this shows full details.';

/** Parse `netsh wlan show interfaces` (Windows). */
function parseNetshInterfaces(text) {
  const get = (label) => { const m = String(text).match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'mi')); return m ? m[1].trim() : null; };
  if (!/connected/i.test(get('State') || '')) return { connected: false };
  const channel = Number(get('Channel')) || null;
  const bandText = get('Band');
  const band = bandText ? (/6/.test(bandText) && !/2\.4/.test(bandText) ? '6' : /5/.test(bandText) ? '5' : '2.4') : channel ? (channel <= 14 ? '2.4' : '5') : null;
  const rx = Number(get('Receive rate \\(Mbps\\)')), tx = Number(get('Transmit rate \\(Mbps\\)'));
  return {
    connected: true, adapter: get('Description'), standard: get('Radio type'), band, channel,
    rateMbps: Math.round(Math.min(rx || tx || 0, tx || rx || 0)) || null,
    signal: get('Signal'),
  };
}

/** Parse `system_profiler SPAirPortDataType -json` (macOS). Names may be redacted; rates aren't. */
function parseMacAirport(jsonText) {
  const data = JSON.parse(jsonText);
  const ifaces = (data.SPAirPortDataType || []).flatMap((x) => x.spairport_airport_interfaces || []);
  for (const i of ifaces) {
    const cur = i.spairport_current_network_information;
    if (!cur) continue;
    const ch = String(cur.spairport_network_channel || '');
    const channel = Number(ch.split(' ')[0]) || null;
    const band = /6GHz/i.test(ch) ? '6' : /5GHz/i.test(ch) ? '5' : /2GHz|2\.4/i.test(ch) ? '2.4' : channel ? (channel <= 14 ? '2.4' : '5') : null;
    const width = (ch.match(/(\d+)MHz/) || [])[1];
    return {
      connected: true, standard: cur.spairport_network_phymode || null, band, channel,
      width: width ? Number(width) : null, rateMbps: Number(cur.spairport_network_rate) || null,
      signal: cur.spairport_signal_noise || null,
    };
  }
  return { connected: false };
}

/**
 * Realistic file-transfer ceiling for a Wi-Fi link. Real TCP throughput on Wi-Fi is
 * roughly 50-60% of the link rate for one hop; through a router each byte crosses the
 * air twice, so it halves again.
 */
function estimate(info) {
  if (!info?.connected || !info.rateMbps) return null;
  const oneHop = (info.rateMbps * 0.55) / 8;
  return { directMBps: Math.round(oneHop), viaRouterMBps: Math.round(oneHop / 2) };
}

function advice(info) {
  const tips = [];
  if (!info?.connected) return tips;
  if (info.band === '2.4') tips.push('This link is on 2.4 GHz, the slow, crowded band. Connecting both computers to the router\'s 5 GHz network is usually several times faster. Many routers (Xiaomi/Redmi, TP-Link, Jio) merge both bands under one name; split them in the router settings to choose 5 GHz.');
  if (info.rateMbps && info.rateMbps < 200) tips.push(`Link rate is only ${info.rateMbps} Mbps: weak signal, distance, or an old Wi-Fi standard. Move the computers closer together.`);
  return tips;
}

async function linkInfo() {
  let info = { connected: false };
  const extraTips = [];
  try {
    if (process.platform === 'win32') {
      try {
        info = parseNetshInterfaces(await run('netsh', ['wlan', 'show', 'interfaces']));
      } catch (e) {
        if (!/location/i.test(e.output || '')) throw e;
        info = await windowsAdapterRate();
        info.limited = true;
        extraTips.push(LOCATION_TIP);
      }
    } else if (process.platform === 'darwin') info = parseMacAirport(await run('system_profiler', ['SPAirPortDataType', '-json'], 30000));
    else return { supported: false };
  } catch (e) { return { supported: true, error: (e.output || e.message || '').trim().split(/\r?\n/).find(Boolean) || e.message }; }
  // No speed estimate: momentary link rates proved too unreliable (estimated ~4 MB/s,
  // measured 14.4). The built-in speed test gives the real number.
  return { supported: true, ...info, tips: [...advice(info), ...extraTips] };
}

module.exports = { linkInfo, parseNetshInterfaces, parseMacAirport, estimate, advice };
