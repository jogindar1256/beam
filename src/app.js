// Starts a complete Beam agent (transfer server, discovery, control panel).
// Shared by the command-line launcher (main.js) and the desktop app (electron/main.js).
'use strict';
const os = require('os');
const path = require('path');
const { Agent } = require('./core');
const { Discovery } = require('./discovery');
const { startUi } = require('./http');

const VERSION = require('../package.json').version;

async function startBeam(opts = {}) {
  const env = process.env;
  const log = opts.log || console;
  const agent = new Agent({
    dataDir: opts.dataDir || env.BEAM_DATA || path.join(os.homedir(), '.beam'),
    tcpPort: Number(env.BEAM_PORT) || 45455,
    name: env.BEAM_NAME,
    saveDir: env.BEAM_SAVE_DIR,
  });
  agent.desktop = opts.desktop || null; // { update: {...} } shown by the UI when present
  await agent.listen();

  const discovery = new Discovery({
    getMe: () => agent.me,
    udpPort: Number(env.BEAM_UDP_PORT) || 45454,
    extraTargets: (env.BEAM_ANNOUNCE || '').split(',').filter(Boolean),
  });
  discovery.on('peer', (p) => agent.notePeer(p));
  discovery.on('warning', (m) => log.warn(`Note: ${m}`));
  discovery.on('error', (e) => log.warn(`Automatic discovery is unavailable (${e.code || e.message}). Add the other computer by IP address instead.`));
  discovery.start();
  const tick = setInterval(() => agent.changed(), 3000); // lets vanished peers drop off the list

  const uiPort = Number(env.BEAM_UI_PORT) || 7070;
  const { url, port, server } = await startUi(agent, { uiPort, uiFile: path.join(__dirname, '..', 'ui', 'index.html') });

  /** True while any transfer is moving data: never restart or update then. */
  const busy = () => [...agent.transfers.values()].some((t) => ['connecting', 'pairing', 'waiting', 'sending', 'receiving', 'reconnecting'].includes(t.status));

  async function shutdown() {
    clearInterval(tick);
    discovery.stop();
    for (const [, a] of agent.active) a.ch.sock.destroy();
    await new Promise((r) => setTimeout(r, 500)); // let receivers checkpoint
    server.close();
    agent.server?.close();
  }

  return { agent, url, uiPort, port, busy, shutdown, version: VERSION };
}

module.exports = { startBeam, VERSION };
