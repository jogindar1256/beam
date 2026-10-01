// Transfer engine: block layout, sender scheduling, receiver disk writes and resume state.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const BLOCK = 4 * 1024 * 1024;

/**
 * open() that waits instead of failing when the system is out of file handles
 * (EMFILE/ENFILE). Windows allows ~8,000 per program, macOS 256 by default, and other
 * programs can eat into the system-wide pool. Handles free up quickly, so retry.
 */
async function openRetry(file, flags, opener = fsp.open) {
  for (let attempt = 0; ; attempt++) {
    try { return await opener(file, flags); }
    catch (e) {
      if (!['EMFILE', 'ENFILE'].includes(e.code) || attempt >= 100) throw e;
      await new Promise((r) => setTimeout(r, Math.min(25 * (attempt + 1), 250)));
    }
  }
}

// Control frame types
const T = {
  INFO: 1, PAIR_OK: 2, PAIR_NO: 3,
  OFFER: 10, ACCEPT: 11, DECLINE: 12, END: 13, MISSING: 14, COMPLETE: 15, PROGRESS: 16, CANCEL: 17,
  SPEEDTEST: 18, SPEEDRESULT: 19, PING: 21,
  BLOCK: 20,
};

class Layout {
  constructor(files, block = BLOCK) {
    this.files = files;
    this.block = block;
    this.start = [0];
    this.totalBytes = 0;
    for (const f of files) {
      this.start.push(this.start[this.start.length - 1] + Math.ceil(f.size / block));
      this.totalBytes += f.size;
    }
    this.total = this.start[this.start.length - 1];
  }
  blocks(f) { return this.start[f + 1] - this.start[f]; }
  locate(g) {
    let lo = 0, hi = this.files.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.start[mid] <= g) lo = mid; else hi = mid - 1; }
    while (this.start[lo + 1] <= g) lo++;
    return [lo, g - this.start[lo]];
  }
  len(g) { const [f, b] = this.locate(g); return Math.min(this.block, this.files[f].size - b * this.block); }
}

const bits = {
  make: (n) => Buffer.alloc(Math.ceil(n / 8)),
  get: (bm, i) => (bm[i >> 3] >> (i & 7)) & 1,
  set: (bm, i) => { bm[i >> 3] |= 1 << (i & 7); },
  clear: (bm, i) => { bm[i >> 3] &= ~(1 << (i & 7)); },
  count(bm, from, to) { let c = 0; for (let i = from; i < to; i++) c += bits.get(bm, i); return c; },
  from64: (s, n) => { const b = bits.make(n); Buffer.from(s, 'base64').copy(b); return b; },
};
const bytesIn = (L, bm) => { let s = 0; for (let g = 0; g < L.total; g++) if (bits.get(bm, g)) s += L.len(g); return s; };

/** Make a path from an untrusted peer safe to create under the save folder. */
function safeRelative(p) {
  const parts = String(p).split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '_'))
    .map((s) => (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s) ? `_${s}` : s));
  return parts.length ? parts.join(path.sep) : 'file';
}

/** Expand selected files/folders into [{abs, path(relative, '/'-separated), size, mtime}]. */
async function expandSelection(paths) {
  const out = [];
  async function walk(abs, rel) {
    const st = await fsp.lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const name of (await fsp.readdir(abs)).sort()) await walk(path.join(abs, name), `${rel}/${name}`);
    } else if (st.isFile()) out.push({ abs, path: rel, size: st.size, mtime: Math.floor(st.mtimeMs) });
  }
  for (const p of paths) await walk(path.resolve(p), path.basename(path.resolve(p)));
  return out;
}

function transferId(files, senderPub) {
  const h = crypto.createHash('sha256');
  h.update(senderPub);
  h.update(JSON.stringify(files.map((f) => [f.path, f.size, f.mtime])));
  return h.digest('hex').slice(0, 32);
}

// ================================================================== Receiver side
class Incoming {
  constructor({ id, files, block, saveDir, stateDir, peerId }) {
    this.id = id;
    this.L = new Layout(files, block);
    this.files = files;
    this.saveDir = saveDir;
    this.stateFile = path.join(stateDir, `${id}.json`);   // manifest: written once
    this.haveFile = path.join(stateDir, `${id}.have`);    // bitmap: rewritten at checkpoints
    this.peerId = peerId;
    this.fds = new Map();
    this.pending = new Set();
    this.recvCount = new Map(); // data connection index -> frames received
    this.closedConns = new Set();
    this.waiters = [];
    this.dirty = false;
    this.madeDirs = new Set();
    this.unsynced = [];        // finished small files not yet forced to disk
  }

  static async loadState(stateDir, id) {
    let st;
    try { st = JSON.parse(await fsp.readFile(path.join(stateDir, `${id}.json`), 'utf8')); } catch { return null; }
    if (!st.have) { // v1.5+: bitmap lives in its own small file (older versions embedded it)
      const bm = await fsp.readFile(path.join(stateDir, `${id}.have`)).catch(() => null);
      st.have = (bm || Buffer.alloc(0)).toString('base64');
    }
    return st;
  }

  /** A free name for a file that differs from what's already there: "name (1).ext". */
  async uniqueTarget(rel, taken) {
    let target = path.join(this.saveDir, rel);
    const { dir, name, ext } = path.parse(target);
    for (let i = 1; ; i++) {
      const exists = await fsp.access(target).then(() => true, () => false);
      if (!exists && !taken.has(target)) return target;
      target = path.join(dir, `${name} (${i})${ext}`);
    }
  }

  /** Decide targets, check disk space, verify resumable state. Returns the bitmap to send. */
  async prepare(state) {
    const L = this.L;
    if (state && state.peerId === this.peerId && state.total === L.total) {
      this.targets = state.targets;
      this.have = bits.from64(state.have, L.total);
      for (let f = 0; f < L.files.length; f++) {
        const t = this.targets[f];
        const n = L.blocks(f);
        const c = bits.count(this.have, L.start[f], L.start[f + 1]);
        if (c === n && n > 0) {
          const ok = await fsp.stat(t).then((s) => s.size === L.files[f].size, () => false);
          if (!ok) for (let g = L.start[f]; g < L.start[f + 1]; g++) bits.clear(this.have, g);
        } else if (c > 0) {
          const ok = await fsp.stat(`${t}.beampart`).then((s) => s.size === L.files[f].size, () => false);
          if (!ok) for (let g = L.start[f]; g < L.start[f + 1]; g++) bits.clear(this.have, g);
        }
      }
    } else {
      const taken = new Set();
      this.targets = [];
      this.have = bits.make(L.total);
      this.skipped = 0;
      for (let f = 0; f < this.files.length; f++) {
        const file = this.files[f];
        const plain = path.join(this.saveDir, safeRelative(file.path));
        const st = await fsp.stat(plain).catch(() => null);
        // Same size and same modified time: it's the file we already delivered. Skip it
        // instead of saving another copy (the quick check rsync uses; Beam sets the
        // modified time on every received file). 2 s tolerance for FAT/exFAT drives.
        if (st?.isFile() && st.size === file.size && (!file.mtime || Math.abs(st.mtimeMs - file.mtime) < 2000) && !taken.has(plain)) {
          this.targets.push(plain);
          taken.add(plain);
          for (let g = L.start[f]; g < L.start[f + 1]; g++) bits.set(this.have, g);
          this.skipped++;
          continue;
        }
        // A .beampart with no resume record is a leftover from an old crash: ours to replace.
        if (!st) await fsp.rm(`${plain}.beampart`, { force: true }).catch(() => {});
        const t = st ? await this.uniqueTarget(safeRelative(file.path), taken) : plain; // different file there: keep both
        taken.add(t);
        this.targets.push(t);
      }
    }
    this.bytes = bytesIn(L, this.have);
    this.count = bits.count(this.have, 0, L.total);
    this.fileLeft = L.files.map((_, f) => L.blocks(f) - bits.count(this.have, L.start[f], L.start[f + 1]));

    const need = L.totalBytes - this.bytes;
    await fsp.mkdir(this.saveDir, { recursive: true });
    if (fs.statfs) {
      const st = await fsp.statfs(this.saveDir);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free < need + 64 * 1024 * 1024) {
        const e = new Error(`Not enough disk space: ${need} bytes needed, ${free} free`);
        e.code = 'ENOSPC_PRECHECK';
        throw e;
      }
    }
    // Empty files have no blocks: create them now.
    for (let f = 0; f < L.files.length; f++) {
      if (L.files[f].size === 0) {
        await fsp.mkdir(path.dirname(this.targets[f]), { recursive: true });
        const exists = await fsp.stat(this.targets[f]).then((x) => x.isFile() && x.size === 0, () => false);
        if (!exists) await fsp.writeFile(this.targets[f], '');
      }
    }
    await this.saveManifest();
    await this.saveState(this.have);
    return this.have;
  }

  /** One open per file even when parallel connections race for it: cache the promise. */
  fdFor(f) {
    let p = this.fds.get(f);
    if (!p) {
      p = (async () => {
        const part = `${this.targets[f]}.beampart`;
        const dir = path.dirname(part);
        if (!this.madeDirs.has(dir)) { await fsp.mkdir(dir, { recursive: true }); this.madeDirs.add(dir); }
        // One syscall instead of check-then-open: reuse a partial file if one exists.
        let h, fresh = false;
        try { h = await openRetry(part, 'r+'); } catch (e) { if (e.code !== 'ENOENT') throw e; h = await openRetry(part, 'w+'); fresh = true; }
        // Pre-size multi-block files (resume checks rely on it); single-block files skip it.
        if (fresh && this.L.blocks(f) > 1) await h.truncate(this.L.files[f].size);
        return h;
      })();
      this.fds.set(f, p);
    }
    return p;
  }

  /** Handle one BLOCK frame from data connection idx. */
  async onBlock(idx, payload) {
    this.recvCount.set(idx, (this.recvCount.get(idx) || 0) + 1);
    try {
      const L = this.L;
      const g = Number(payload.readBigUInt64BE(0));
      const data = payload.subarray(8);
      if (g >= L.total || data.length !== L.len(g)) throw new Error(`invalid block ${g}`);
      if (bits.get(this.have, g) || this.pending.has(g)) return;
      this.pending.add(g);
      try {
        const [f, b] = L.locate(g);
        const h = await this.fdFor(f);
        let off = 0;
        while (off < data.length) {
          const { bytesWritten } = await h.write(data, off, data.length - off, b * L.block + off);
          off += bytesWritten;
        }
        bits.set(this.have, g);
        this.count++;
        this.bytes += data.length;
        this.dirty = true;
        // The block stays "pending" until its file is flushed, renamed and recorded, so the
        // transfer can't be declared complete while the last file is still a .beampart.
        if (--this.fileLeft[f] === 0) await this.finishFile(f);
      } finally {
        this.pending.delete(g);
      }
    } finally {
      this.notify();
    }
  }

  async finishFile(f) {
    const p = this.fds.get(f);
    this.fds.delete(f);
    if (p) {
      const h = await p;
      // Big files: flush now (cost is tiny relative to their size). Small files: flush
      // later in parallel batches; forcing thousands of tiny files to disk one by one,
      // in the transfer's critical path, was the main cost for photo/code folders.
      if (this.L.files[f].size > 8 * 1024 * 1024) await h.datasync();
      else this.unsynced.push(this.targets[f]);
      await h.close();
    }
    await fsp.rename(`${this.targets[f]}.beampart`, this.targets[f]);
    const mt = this.files[f].mtime;
    if (mt) await fsp.utimes(this.targets[f], new Date(), new Date(mt)).catch(() => {});
    // Recorded at the next checkpoint (every 2 s). Rewriting state per file made folders
    // with thousands of small files crawl: the cost grew with the square of the file count.
  }

  /** Force finished small files to disk, 32 at a time in parallel. */
  async syncFinished() {
    const list = this.unsynced.splice(0);
    for (let i = 0; i < list.length; i += 32) {
      await Promise.all(list.slice(i, i + 32).map(async (t) => {
        const h = await openRetry(t, 'r+').catch(() => null); // write access: Windows needs it to flush
        if (h) { await h.datasync().catch(() => {}); await h.close().catch(() => {}); }
      }));
    }
  }

  /** Flush data to disk first, then record it: state never claims more than the disk has. */
  async checkpoint() {
    if (!this.dirty) return;
    this.dirty = false;
    const snapshot = Buffer.from(this.have);
    await Promise.all([...this.fds.values()].map((p) => p.then((h) => h.datasync()).catch(() => {})));
    await this.syncFinished(); // everything in the snapshot is now really on disk
    await this.saveState(snapshot);
  }

  async saveManifest() {
    if (this.ended) return;
    const L = this.L;
    await fsp.mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = `${this.stateFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({
      id: this.id, peerId: this.peerId, total: L.total, block: L.block,
      files: this.files, targets: this.targets, created: Date.now(),
    }));
    await fsp.rename(tmp, this.stateFile);
  }

  /** Small and cheap: just the bitmap of blocks known to be on disk. */
  async saveState(bm) {
    if (this.ended) return; // never resurrect state after the transfer finished
    const tmp = `${this.haveFile}.tmp`;
    await fsp.writeFile(tmp, bm);
    await fsp.rename(tmp, this.haveFile);
  }

  notify() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }

  /** Wait until every data connection has delivered what the sender says it sent. */
  async settle(sent, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    const ready = () => Object.entries(sent).every(([i, n]) => this.closedConns.has(Number(i)) || (this.recvCount.get(Number(i)) || 0) >= n)
      && this.pending.size === 0;
    while (!ready() && Date.now() < deadline) {
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 200); });
    }
  }

  complete() { return this.count === this.L.total; }

  async finalize() {
    for (const f of [...this.fds.keys()]) await this.finishFile(f).catch(() => {});
    await this.syncFinished(); // "Done" means on disk, not just in the OS cache
    this.ended = true;
    await fsp.unlink(this.stateFile).catch(() => {});
    await fsp.unlink(this.haveFile).catch(() => {});
  }

  async suspend() {
    await this.checkpoint().catch(() => {});
    this.dirty = true;
    await this.checkpoint().catch(() => {});
    for (const p of this.fds.values()) await p.then((h) => h.close()).catch(() => {});
    this.fds.clear();
  }
}

// ================================================================== Sender side
class Outgoing {
  constructor(files, block = BLOCK) {
    this.files = files; // [{abs, path, size, mtime}]
    this.L = new Layout(files, block);
    this.fds = new Map();
    this.users = new Map();     // file -> reads in progress
    this.lastRead = new Set();  // files whose last block has been read
    this.queue = [];
    this.qi = 0;
  }
  setHave(have) {
    this.have = have;
    this.queue = [];
    for (let g = 0; g < this.L.total; g++) if (!bits.get(have, g)) this.queue.push(g);
    this.qi = 0;
  }
  next() { return this.qi < this.queue.length ? this.queue[this.qi++] : null; }
  async fd(f) {
    let p = this.fds.get(f);
    if (!p) { p = openRetry(this.files[f].abs, 'r'); this.fds.set(f, p); this.lastRead.delete(f); }
    return p;
  }
  /** Read block g into a buffer prefixed with its 8-byte index. */
  async read(g) {
    const [f, b] = this.L.locate(g);
    const len = this.L.len(g);
    const buf = Buffer.allocUnsafe(8 + len);
    buf.writeBigUInt64BE(BigInt(g), 0);
    this.users.set(f, (this.users.get(f) || 0) + 1);
    try {
      const h = await this.fd(f);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await h.read(buf, 8 + off, len - off, b * this.L.block + off);
        if (!bytesRead) throw new Error(`${this.files[f].path} got shorter while sending`);
        off += bytesRead;
      }
      if (b === this.L.blocks(f) - 1) this.lastRead.add(f);
    } finally {
      // Close as soon as the file's last block is read and nobody else is reading it.
      // Holding thousands open hits the OS limit (macOS allows 256 by default).
      const n = this.users.get(f) - 1;
      if (n) this.users.set(f, n);
      else {
        this.users.delete(f);
        if (this.lastRead.has(f)) {
          const p = this.fds.get(f);
          this.fds.delete(f);
          this.lastRead.delete(f);
          if (p) p.then((h) => h.close()).catch(() => {});
        }
      }
    }
    return buf;
  }
  async close() { for (const p of this.fds.values()) (await p.catch(() => null))?.close().catch(() => {}); this.fds.clear(); }
}

module.exports = { openRetry, BLOCK, T, Layout, bits, bytesIn, safeRelative, expandSelection, transferId, Incoming, Outgoing };
