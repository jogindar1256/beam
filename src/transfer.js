const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const BLOCK = 4 * 1024 * 1024;

const bits = {
  get(buf, i) {
    return (buf[i >> 3] & (1 << (i & 7))) !== 0;
  },

  set(buf, i) {
    buf[i >> 3] |= 1 << (i & 7);
  },

  count(buf) {
    let n = 0;

    for (const byte of buf) {
      let x = byte;

      while (x) {
        x &= x - 1;
        n++;
      }
    }

    return n;
  },
};

class Layout {
  constructor(files = []) {
    this.files = files;
  }

  get totalBytes() {
    return this.files.reduce((n, f) => n + Number(f.size || 0), 0);
  }

  get count() {
    return this.files.length;
  }

  blocksFor(file) {
    return Math.ceil(Number(file.size || 0) / BLOCK);
  }

  totalBlocks() {
    return this.files.reduce(
      (n, f) => n + this.blocksFor(f),
      0
    );
  }
}

class Incoming {
  constructor(root, id, layout) {
    this.root = root;
    this.id = id;
    this.layout = layout;

    this.dataDir = path.join(root, "data");
    this.incomingDir = path.join(this.dataDir, "incoming");

    this.stateFile = path.join(
      this.incomingDir,
      `${id}.json`
    );

    this.haveFile = path.join(
      this.incomingDir,
      `${id}.have`
    );

    this.have = Buffer.alloc(
      Math.ceil(layout.totalBlocks() / 8)
    );

    this.fds = new Map();
    this.bytes = 0;
    this.count = 0;
    this.fileLeft = new Map();

    this.dirty = false;
    this.madeDirs = new Set();
    this.unsynced = [];
    this.finishing = new Set();

    // Prevent multiple checkpoint() calls from running at
    // the same time. A checkpoint may contain datasync(),
    // which can take a while for large files.
    this.checkpointPromise = null;

    this.ended = false;
  }

  static async loadState(root, id) {
    const incomingDir = path.join(root, "data", "incoming");

    const stateFile = path.join(
      incomingDir,
      `${id}.json`
    );

    const haveFile = path.join(
      incomingDir,
      `${id}.have`
    );

    try {
      const raw = await fsp.readFile(stateFile, "utf8");
      const manifest = JSON.parse(raw);

      const have = await fsp
        .readFile(haveFile)
        .catch(() => Buffer.alloc(0));

      return {
        manifest,
        have,
      };
    } catch {
      return null;
    }
  }

  async prepare() {
    await fsp.mkdir(this.incomingDir, {
      recursive: true,
    });

    const existing = await Incoming.loadState(
      this.root,
      this.id
    );

    if (existing) {
      this.have = Buffer.from(existing.have);

      if (this.have.length < Math.ceil(this.layout.totalBlocks() / 8)) {
        const next = Buffer.alloc(
          Math.ceil(this.layout.totalBlocks() / 8)
        );

        this.have.copy(next);
        this.have = next;
      }
    }

    this.bytes = 0;
    this.count = 0;

    this.fileLeft.clear();

    for (const file of this.layout.files) {
      const blocks = this.layout.blocksFor(file);

      let completed = 0;

      for (let i = 0; i < blocks; i++) {
        const globalBlock = this.globalBlock(file, i);

        if (bits.get(this.have, globalBlock)) {
          const start = i * BLOCK;
          const end = Math.min(
            Number(file.size),
            start + BLOCK
          );

          completed += end - start;
          this.bytes += end - start;
        }
      }

      this.fileLeft.set(
        file.path,
        Number(file.size) - completed
      );
    }

    await this.saveManifest();

    // Always make sure the durable checkpoint file exists
    // immediately after preparing the incoming transfer.
    await this.saveState(this.have);
  }

  globalBlock(file, blockIndex) {
    let offset = 0;

    for (const f of this.layout.files) {
      if (f.path === file.path) {
        return offset + blockIndex;
      }

      offset += this.layout.blocksFor(f);
    }

    return blockIndex;
  }

  filePath(file) {
    return path.join(
      this.incomingDir,
      `${this.id}.beampart`,
      file.path
    );
  }

  finalPath(file) {
    return path.join(
      this.root,
      file.path
    );
  }

  async ensureParent(filePath) {
    const parent = path.dirname(filePath);

    if (this.madeDirs.has(parent)) {
      return;
    }

    await fsp.mkdir(parent, {
      recursive: true,
    });

    this.madeDirs.add(parent);
  }

  async getFd(file) {
    if (this.fds.has(file.path)) {
      return this.fds.get(file.path);
    }

    const promise = (async () => {
      const partRoot = path.join(
        this.incomingDir,
        `${this.id}.beampart`
      );

      const target = path.join(
        partRoot,
        file.path
      );

      await this.ensureParent(target);

      const handle = await fsp.open(
        target,
        "w+"
      );

      await handle.truncate(
        Number(file.size)
      );

      return handle;
    })();

    this.fds.set(file.path, promise);

    return promise;
  }

  async onBlock(file, blockIndex, data) {
    if (this.ended) {
      return;
    }

    const globalBlock = this.globalBlock(
      file,
      blockIndex
    );

    if (bits.get(this.have, globalBlock)) {
      return;
    }

    const fd = await this.getFd(file);

    const position = blockIndex * BLOCK;

    await fd.write(
      data,
      0,
      data.length,
      position
    );

    bits.set(
      this.have,
      globalBlock
    );

    this.bytes += data.length;
    this.count++;

    this.fileLeft.set(
      file.path,
      Math.max(
        0,
        Number(this.fileLeft.get(file.path) || 0) -
          data.length
      )
    );

    this.dirty = true;

    if (
      this.fileLeft.get(file.path) === 0
    ) {
      await this.finishFile(file);
    }
  }

  async finishFile(file) {
    if (this.finishing.has(file.path)) {
      return;
    }

    const fdPromise = this.fds.get(file.path);

    if (!fdPromise) {
      return;
    }

    this.finishing.add(file.path);

    try {
      const fd = await fdPromise;

      // Make the file data durable before renaming it.
      if (
        Number(file.size) >= 64 * 1024 * 1024
      ) {
        await fd.datasync().catch(() => {});
      }

      await fd.close().catch(() => {});

      this.fds.delete(file.path);

      const partRoot = path.join(
        this.incomingDir,
        `${this.id}.beampart`
      );

      const source = path.join(
        partRoot,
        file.path
      );

      const target = this.finalPath(file);

      await this.ensureParent(target);

      await fsp.rename(
        source,
        target
      );

      this.unsynced.push(file.path);
    } finally {
      this.finishing.delete(file.path);
    }
  }

  async syncFinished() {
    if (!this.unsynced.length) {
      return;
    }

    this.unsynced.length = 0;
  }

  /*
   * Durable checkpoint.
   *
   * Important:
   * - Only one checkpoint may run at once.
   * - Snapshot the bitmap before doing slow filesystem work.
   * - Wait for active file handles to become durable.
   * - Wait for files being finalized.
   * - Persist the bitmap after the data is durable.
   */
  async checkpoint() {
    if (this.checkpointPromise) {
      return this.checkpointPromise;
    }

    if (!this.dirty || this.ended) {
      return;
    }

    this.checkpointPromise = (async () => {
      try {
        this.dirty = false;

        const snapshot = Buffer.from(
          this.have
        );

        await Promise.all(
          [...this.fds.values()].map(
            (p) =>
              p
                .then((h) => h.datasync())
                .catch(() => {})
          )
        );

        await Promise.allSettled(
          [...this.finishing]
        );

        await this.syncFinished();

        // Do not write a checkpoint after finalize()
        // has started.
        if (!this.ended) {
          await this.saveState(
            snapshot
          );
        }
      } finally {
        this.checkpointPromise = null;
      }
    })();

    return this.checkpointPromise;
  }

  async saveManifest() {
    const manifest = {
      id: this.id,
      files: this.layout.files,
      totalBytes: this.layout.totalBytes,
      totalBlocks: this.layout.totalBlocks(),
    };

    const tmp = `${this.stateFile}.tmp`;

    await fsp.writeFile(
      tmp,
      JSON.stringify(manifest)
    );

    await fsp.rename(
      tmp,
      this.stateFile
    );
  }

  async saveState(bm) {
    if (this.ended) {
      return;
    }

    const tmp = `${this.haveFile}.tmp`;

    await fsp.writeFile(
      tmp,
      bm
    );

    await fsp.rename(
      tmp,
      this.haveFile
    );
  }

  complete() {
    return (
      bits.count(this.have) >=
      this.layout.totalBlocks()
    );
  }

  async finalize() {
    for (
      const f of [...this.fds.keys()]
    ) {
      await this.finishFile(f).catch(
        () => {}
      );
    }

    await this.syncFinished();

    // If a checkpoint is already running,
    // wait for it to finish before removing
    // the checkpoint files.
    if (this.checkpointPromise) {
      await this.checkpointPromise.catch(
        () => {}
      );
    }

    // Blocks may have arrived while the previous
    // checkpoint was running. Persist them before
    // final cleanup.
    if (
      this.dirty &&
      !this.ended
    ) {
      await this.checkpoint().catch(
        () => {}
      );
    }

    this.ended = true;

    await fsp.unlink(
      this.stateFile
    ).catch(() => {});

    await fsp.unlink(
      this.haveFile
    ).catch(() => {});

    await fsp.rm(
      path.join(
        this.incomingDir,
        `${this.id}.beampart`
      ),
      {
        recursive: true,
        force: true,
      }
    );
  }
}

module.exports = {
  BLOCK,
  bits,
  Layout,
  Incoming,
};