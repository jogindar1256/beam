// LAN discovery: every device broadcasts a small UDP beacon every 2 s on each network
// interface (including a hotspot's). No server, no internet needed.
// Networks with "client isolation" (hotels, offices, some public Wi-Fi) block this AND
// block the transfer itself; use a hotspot or a cable there.
'use strict';
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');
const { RETRYABLE } = require('./ports');

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  let ifaces = {};
  try { ifaces = os.networkInterfaces(); } catch { return [...out]; } // EMFILE: try again next beacon
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

class Discovery extends EventEmitter {
  constructor({ getMe, udpPort = 45454, extraTargets = [] }) {
    super();
    this.getMe = getMe;
    this.udpPort = udpPort;
    this.extraTargets = extraTargets; // ["host:port"] for networks where broadcast is filtered
  }

  start() { this.bind(this.udpPort); }

  bind(port) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('message', (buf, rinfo) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      const me = this.getMe();
      if (m.app !== 'beam' || m.v !== 1 || m.id === me.id || typeof m.id !== 'string') return;
      if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
      this.emit('peer', { id: m.id.slice(0, 32), name: String(m.name || 'Unknown').slice(0, 64), os: String(m.os || '').slice(0, 16), host: rinfo.address, port: m.port,
        version: /^\d+\.\d+\.\d+$/.test(m.ver) ? m.ver : null }); // null = older than 2.0, which didn't send it
      // A peer that couldn't get the standard discovery port never hears broadcasts.
      // Answer it directly on the port it announced from, so discovery still works both ways.
      if (rinfo.port !== this.udpPort && !m.reply) this.sendTo(rinfo.address, rinfo.port, true);
    });
    sock.once('error', (e) => {
      if (port !== 0 && RETRYABLE.has(e.code)) {
        try { sock.close(); } catch {}
        this.emit('warning', `Discovery port ${port} is blocked on this computer (${e.code}); using a fallback port. Other devices will still find this one.`);
        this.bind(0);
      } else this.emit('error', e);
    });
    sock.bind(port, () => {
      sock.on('error', (e) => this.emit('error', e));
      sock.setBroadcast(true);
      this.announce();
      clearInterval(this.timer);
      this.timer = setInterval(() => this.announce(), 2000);
    });
  }

  message(reply = false) {
    const me = this.getMe();
    return Buffer.from(JSON.stringify({ app: 'beam', v: 1, id: me.id, name: me.name, os: me.os, port: me.port, ver: me.version, ...(reply ? { reply: true } : {}) }));
  }

  sendTo(host, port, reply = false) { try { this.sock.send(this.message(reply), port, host, () => {}); } catch {} }

  announce() {
    for (const addr of broadcastAddresses()) this.sendTo(addr, this.udpPort);
    for (const t of this.extraTargets) {
      const [host, port] = t.split(':');
      this.sendTo(host, Number(port) || this.udpPort);
    }
  }

  stop() { clearInterval(this.timer); try { this.sock.close(); } catch {} }
}

module.exports = { Discovery };
