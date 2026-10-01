#!/usr/bin/env node
// Beam agent entry point.
//   node src/main.js            start and open the control panel in your browser
//   node src/main.js --no-open  start without opening a browser
// Environment: BEAM_DATA, BEAM_PORT (TCP, default 45455), BEAM_UI_PORT (default 7070),
//   BEAM_UDP_PORT (default 45454), BEAM_NAME, BEAM_SAVE_DIR, BEAM_ANNOUNCE ("host:udpPort,..."),
//   BEAM_DEBUG=1 for full error details. Every port falls back automatically if blocked.
'use strict';
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const http = require('http');
const { startBeam } = require('./app');

async function main() {
  const env = process.env;
  const uiPort = Number(env.BEAM_UI_PORT) || 7070;

  // Double-clicked the launcher twice? Reuse the running copy instead of starting another.
  const running = await findRunningBeam(uiPort);
  if (running) {
    console.log(`Beam is already running: ${running}`);
    if (!process.argv.includes('--no-open')) openBrowser(running);
    return;
  }

  const { agent, url, port, shutdown: stop } = await startBeam();
  const addrs = agent.me.addresses.map((a) => a.address).join(', ') || 'no network';
  console.log(`Beam ${require('../package.json').version} is running as "${agent.settings.name}"`);
  console.log(`  Control panel: ${url}`);
  if (port !== uiPort) console.log(`    (port ${uiPort} is blocked or busy on this computer, so ${port} is used instead)`);
  console.log(`  Receiving on port ${agent.tcpPort} (${addrs})`);
  if (agent.tcpPort !== agent.preferredTcpPort) console.log(`    (port ${agent.preferredTcpPort} is blocked or busy; if you add this computer by IP elsewhere, use port ${agent.tcpPort})`);
  console.log(`  Saving to: ${agent.settings.saveDir}`);
  console.log('Keep this window open while transferring. Close it to stop Beam.');
  if (!process.argv.includes('--no-open')) openBrowser(url);

  const shutdown = async () => { await stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Returns the URL of a Beam control panel already running on this computer, if any. */
function findRunningBeam(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      res.on('end', () => resolve(/<title>Beam<\/title>/.test(body) ? `http://127.0.0.1:${port}/` : null));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, () => {});
}

main().catch((e) => {
  const hint = {
    EACCES: 'Windows or a firewall blocked every port Beam tried. Try restarting the computer, or run: netsh interface ipv4 show excludedportrange protocol=tcp',
    EPERM: 'The operating system refused permission. Check antivirus or firewall software.',
  }[e.code];
  console.error(`
Beam could not start: ${e.message}`);
  if (hint) console.error(hint);
  if (process.env.BEAM_DEBUG) console.error(e);
  process.exitCode = 1;
});
