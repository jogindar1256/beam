// Resume-state format: new split format, and transfers interrupted under v1.4.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Incoming, Layout, bits } = require('../src/transfer');
const results = [];
const check = (n, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${note ? `  |  ${note}` : ''}`); };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-state-'));
  const files = Array.from({ length: 9000 }, (_, i) => ({ path: `photos/IMG_${i}.jpg`, size: 800000, mtime: 1 }));
  const L = new Layout(files);
  const have = bits.make(L.total); for (let g = 0; g < 3000; g++) bits.set(have, g);

  // v1.4 format: everything, bitmap included, in one JSON file
  fs.writeFileSync(path.join(dir, 'aaa.json'), JSON.stringify({ id: 'aaa', peerId: 'p', total: L.total, block: L.block, files, targets: files.map((f) => `/x/${f.path}`), have: have.toString('base64') }));
  const old = await Incoming.loadState(dir, 'aaa');
  check('1  transfer interrupted under v1.4 still loads after upgrading', bits.count(bits.from64(old.have, L.total), 0, L.total) === 3000, '3000 blocks recovered');

  // new format: manifest once + small bitmap file
  const inc = new Incoming({ id: 'bbb', files, block: L.block, saveDir: path.join(dir, 'save'), stateDir: dir, peerId: 'p' });
  inc.targets = files.map((f) => path.join(dir, 'save', f.path));
  await inc.saveManifest();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) await inc.saveState(have);
  const msPerCheckpoint = Number(process.hrtime.bigint() - t0) / 1e6 / 50;
  const st = await Incoming.loadState(dir, 'bbb');
  const manifestKB = fs.statSync(path.join(dir, 'bbb.json')).size / 1024, haveB = fs.statSync(path.join(dir, 'bbb.have')).size;
  check('2  new format round-trips', st.files.length === 9000 && bits.count(bits.from64(st.have, L.total), 0, L.total) === 3000);
  check('3  a checkpoint now writes ~1 KB, not the whole file list', haveB < 2048, `manifest ${manifestKB.toFixed(0)} KB written once; checkpoint ${haveB} bytes, ${msPerCheckpoint.toFixed(2)} ms`);
  // 4. Out of file handles: opening waits and retries instead of failing.
  const { openRetry } = require('../src/transfer');
  let calls = 0;
  const flaky = async () => { if (++calls <= 5) { const e = new Error('EMFILE: too many open files'); e.code = 'EMFILE'; throw e; } return 'handle'; };
  const got = await openRetry('x', 'r', flaky);
  check('4  EMFILE (too many open files) -> waits and retries, then succeeds', got === 'handle' && calls === 6, `succeeded on attempt ${calls}`);
  let other = await openRetry('x', 'r', async () => { const e = new Error('nope'); e.code = 'EACCES'; throw e; }).then(() => 'opened', (e) => e.code);
  check('5  other errors (e.g. permission denied) still fail immediately', other === 'EACCES');

  // 6. Running out of handles no longer crashes the agent via the address lookup.
  const os2 = require('os');
  const real = os2.networkInterfaces;
  os2.networkInterfaces = () => { const e = new Error('uv_interface_addresses returned Unknown system error 24'); e.code = 'ERR_SYSTEM_ERROR'; throw e; };
  delete require.cache[require.resolve('../src/core')];
  const { localAddresses } = require('../src/core');
  let survived; try { survived = Array.isArray(localAddresses()); } catch { survived = false; }
  os2.networkInterfaces = real;
  check('6  "system error 24" in the address lookup no longer crashes Beam', survived);

  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
