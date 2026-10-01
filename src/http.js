// Local control panel: http://127.0.0.1:<uiPort>. Bound to localhost only.
// Every API call needs a per-launch secret token (embedded in the page), and the Host
// header must be localhost: this blocks other websites (CSRF / DNS rebinding) and other
// devices on the network from driving the agent or browsing your disk.
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { hotspot } = require('./hotspot');
const { listenWithFallback } = require('./ports');
const { linkInfo } = require('./linkinfo');

function startUi(agent, { uiPort, uiFile }) {
  const token = crypto.randomBytes(24).toString('hex');
  const clients = new Set();
  let hotspotState = null;
  let pollTimer = null;
  // While our hotspot is up, keep its live status (on/off, devices connected) on screen.
  const pollHotspot = () => {
    clearTimeout(pollTimer);
    if (!hotspotState) return;
    pollTimer = setTimeout(async () => {
      try {
        const st = await hotspot.status();
        if (hotspotState && st) { Object.assign(hotspotState, { state: st.state, clients: st.clients, checked: Date.now() }); agent.changed(); }
      } catch (e) { if (hotspotState) { hotspotState.statusError = e.message; agent.changed(); } }
      pollHotspot();
    }, 6000);
  };

  agent.on('update', () => {
    const data = `data: ${JSON.stringify({ ...agent.snapshot(), hotspot: hotspotState, hotspotCaps: hotspot.capabilities() })}\n\n`;
    for (const res of clients) res.write(data);
  });

  let allowedHosts = new Set(); // filled in once we know which port we actually got

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      if (!allowedHosts.has(req.headers.host)) return send(403, { error: 'forbidden host' });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        const html = (await fsp.readFile(uiFile, 'utf8')).replace('__BEAM_TOKEN__', token);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
        return res.end(html);
      }
      const given = req.headers['x-beam-token'] || url.searchParams.get('token');
      if (!given || given.length !== token.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))) return send(401, { error: 'bad token' });

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ ...agent.snapshot(), hotspot: hotspotState, hotspotCaps: hotspot.capabilities() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clients.delete(res); clearInterval(ping); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(200, { ...agent.snapshot(), hotspot: hotspotState, hotspotCaps: hotspot.capabilities() });
      if (req.method === 'GET' && url.pathname === '/api/link') return send(200, await linkInfo());
      if (req.method === 'GET' && url.pathname === '/api/fs') return send(200, await listDir(url.searchParams.get('path')));
      if (req.method !== 'POST') return send(404, { error: 'not found' });

      const body = await readBody(req);
      const m = url.pathname.match(/^\/api\/(\w+)(?:\/([\w-]+))?(?:\/(\w+))?$/);
      if (!m) return send(404, { error: 'not found' });
      const [, what, id, action] = m;

      switch (what) {
        case 'send': {
          const target = body.peerId ? agent.peers.get(body.peerId) : { host: body.host, port: Number(body.port) || 45455, name: body.host };
          if (!target?.host) return send(400, { error: 'Pick a device first.' });
          if (!Array.isArray(body.paths) || !body.paths.length) return send(400, { error: 'Pick files or folders first.' });
          return send(200, { id: await agent.send(target, body.paths) });
        }
        case 'speedtest': {
          const target = agent.peers.get(body.peerId);
          if (!target) return send(400, { error: 'Pick a device first.' });
          return send(200, await agent.speedTest(target, Math.min(20, Math.max(3, Number(body.seconds) || 8))));
        }
        case 'prompt': return send(200, { ok: agent.answer(id, body.ok) });
        case 'transfer':
          if (action === 'cancel') return send(200, { ok: agent.cancel(id) });
          if (action === 'retry') return send(200, { id: await agent.retry(id) });
          if (action === 'dismiss') { agent.transfers.delete(id); agent.changed(); return send(200, { ok: true }); }
          break;
        case 'settings':
          try { await agent.saveSettings(body); } catch (e) { return send(400, { error: e.message }); }
          return send(200, { ok: true, settings: agent.settings });
        case 'peer': {
          if (!body.host) return send(400, { error: 'Enter an IP address.' });
          const port = Number(body.port) || 45455;
          agent.notePeer({ id: `manual-${body.host}-${port}`, name: body.host, host: body.host, port, os: '', manual: true });
          return send(200, { ok: true });
        }
        case 'trusted': agent.forget(id); return send(200, { ok: true });
        case 'hotspot':
          if (id === 'start') {
            const keep = body.band && hotspotState ? { ssid: hotspotState.ssid, password: hotspotState.password } : null;
            hotspotState = { ...(await hotspot.start(body.band, keep)), state: 'On', clients: 0, checked: Date.now() };
            agent.changed(); pollHotspot(); return send(200, hotspotState);
          }
          if (id === 'stop') { await hotspot.stop(); hotspotState = null; agent.changed(); return send(200, { ok: true }); }
          if (id === 'join') return send(200, await hotspot.join(body.ssid, body.password));
          if (id === 'scan') { const r = await hotspot.scan(); return send(200, { hidden: r.hidden, networks: r.networks.sort((a, b) => (/^beam/i.test(b) - /^beam/i.test(a)) || a.localeCompare(b)) }); }
          break;
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: e.message });
    }
  });
  return listenWithFallback(server, '127.0.0.1', uiPort).then((port) => {
    allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    server.on('error', (e) => console.error(`Control panel error: ${e.message}`));
    return { server, port, url: `http://127.0.0.1:${port}/` };
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1 << 20) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
}

async function listDir(p) {
  if (!p) {
    const home = os.homedir();
    const places = [
      { name: 'Home', path: home }, { name: 'Desktop', path: path.join(home, 'Desktop') },
      { name: 'Documents', path: path.join(home, 'Documents') }, { name: 'Downloads', path: path.join(home, 'Downloads') },
      { name: 'Pictures', path: path.join(home, 'Pictures') }, { name: 'Movies / Videos', path: path.join(home, process.platform === 'darwin' ? 'Movies' : 'Videos') },
    ].filter((x) => fs.existsSync(x.path));
    if (process.platform === 'win32') {
      for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${L}:\\`)) places.push({ name: `Drive ${L}:`, path: `${L}:\\` });
    } else if (process.platform === 'darwin') {
      for (const v of fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes') : []) places.push({ name: v, path: path.join('/Volumes', v) });
    } else places.push({ name: 'Computer', path: '/' });
    return { path: null, parent: null, places, entries: [] };
  }
  const abs = path.resolve(p);
  const entries = [];
  for (const d of await fsp.readdir(abs, { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name.endsWith('.beampart')) continue;
    const full = path.join(abs, d.name);
    if (d.isDirectory()) entries.push({ name: d.name, path: full, dir: true });
    else if (d.isFile()) {
      const st = await fsp.stat(full).catch(() => null);
      if (st) entries.push({ name: d.name, path: full, dir: false, size: st.size });
    }
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? '' : parent, entries };
}

module.exports = { startUi };
