// Choosing where received files are saved: validation, the built-in folder browser
// (browser version) and a real transfer into the chosen folder.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-set-'));
const results = [], procs = [];
const check = (n, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${note ? `  |  ${note}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(name, n) {
  const dir = path.join(ROOT, name);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main.js'), '--no-open'], {
    env: { ...process.env, HOME: path.join(ROOT, 'home'), USERPROFILE: path.join(ROOT, 'home'), BEAM_DATA: path.join(dir, 'data'), BEAM_NAME: name, BEAM_SAVE_DIR: path.join(dir, 'recv'), BEAM_PORT: String(46900 + n), BEAM_UI_PORT: String(47900 + n), BEAM_UDP_PORT: String(48900 + n), BEAM_ANNOUNCE: `127.0.0.1:${48900 + (n === 1 ? 2 : 1)}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  const a = { ui: 47900 + n };
  return new Promise((res) => p.stdout.on('data', async (d) => {
    if (!String(d).includes('Control panel')) return;
    a.token = (await req(a, 'GET', '/', null, true)).match(/const TOKEN = '(\w+)'/)[1];
    res(a);
  }));
}
function req(a, method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: a.ui, method, path: p, agent: false, headers: { 'x-beam-token': a.token || '', 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => { if (raw) return resolve(s); const j = JSON.parse(s); j.__status = res.statusCode; resolve(j); });
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
const set = (a, dir) => req(a, 'POST', '/api/settings', { saveDir: dir });

(async () => {
  fs.mkdirSync(path.join(ROOT, 'home'), { recursive: true });
  const A = await start('Alpha', 1), B = await start('Bravo', 2);

  // 1-4: bad choices are refused with a clear reason; the old setting stays
  const before = (await req(B, 'GET', '/api/state')).settings.saveDir;
  const rel = await set(B, 'Downloads/Beam');
  const file = path.join(ROOT, 'a-file.txt'); fs.writeFileSync(file, 'x');
  const isFile = await set(B, file);
  const empty = await set(B, '   ');
  const after = (await req(B, 'GET', '/api/state')).settings.saveDir;
  check('1  relative path refused, with an example of a full path', rel.__status === 400 && /full folder path/.test(rel.error), rel.error);
  check('2  a file (not a folder) refused', isFile.__status === 400 && /is a file/.test(isFile.error), isFile.error);
  check('3  empty path refused', empty.__status === 400, empty.error);
  check('4  after refusals the previous folder is still in effect', before === after, after);

  // 5-6: good choices
  const fresh = path.join(ROOT, 'external drive', 'Beam inbox', '2026');
  const ok = await set(B, fresh);
  check('5  a folder that doesn\'t exist yet is created and accepted', ok.__status === 200 && fs.statSync(fresh).isDirectory() && ok.settings.saveDir === fresh, ok.settings?.saveDir);
  const tilde = await set(B, '~/Received');
  check('6  "~/Received" expands to the home folder', tilde.__status === 200 && tilde.settings.saveDir === path.join(ROOT, 'home', 'Received'), tilde.settings?.saveDir);

  // 7: a real transfer lands in the chosen folder (and the settings file kept it)
  await set(B, fresh);
  const src = path.join(ROOT, 'photo.bin'); fs.writeFileSync(src, crypto.randomBytes(3e6));
  let peer; for (let i = 0; i < 60 && !peer; i++) { await sleep(250); peer = (await req(A, 'GET', '/api/state')).peers.find((p) => p.name === 'Bravo'); }
  const r = await req(A, 'POST', '/api/send', { peerId: peer.id, paths: [src] });
  for (let i = 0; i < 150; i++) {
    await sleep(200);
    for (const a of [A, B]) for (const p of (await req(a, 'GET', '/api/state')).prompts) await req(a, 'POST', `/api/prompt/${p.id}`, { ok: true });
    if ((await req(A, 'GET', '/api/state')).transfers.find((t) => t.id === r.id)?.status === 'done') break;
  }
  const landed = fs.existsSync(path.join(fresh, 'photo.bin')) && crypto.createHash('sha256').update(fs.readFileSync(path.join(fresh, 'photo.bin'))).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
  const persisted = JSON.parse(fs.readFileSync(path.join(ROOT, 'Bravo', 'data', 'settings.json'), 'utf8')).saveDir === fresh;
  check('7  received file lands in the chosen folder; choice survives restart (saved to disk)', landed && persisted);

  // 8-9: browser version, built-in folder browser (real Chromium)
  const chromium = process.env.CHROMIUM_PATH || ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  if (chromium) {
    const { chromium: cr } = require('playwright-core');
    const browser = await cr.launch({ executablePath: chromium, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://127.0.0.1:${B.ui}/`);
    await page.locator('#set-save').waitFor();
    const target = path.join(ROOT, 'external drive', 'Beam inbox');
    await page.click('#btn-browse-save');
    await page.locator('#dirpick').waitFor({ state: 'visible' });
    await page.locator('#dirpick-path', { hasText: fresh }).waitFor();  // opens at the current folder
    await page.locator('#dirpick-list button', { hasText: 'Up' }).click(); // go up one level
    await page.locator('#dirpick-path', { hasText: target }).waitFor();
    await page.click('#dirpick-use');
    await page.locator('#save-msg.okc').waitFor();
    const shown = await page.inputValue('#set-save');
    const saved = (await req(B, 'GET', '/api/state')).settings.saveDir;
    check('8  Browse → built-in folder browser → "Save files here" sets the folder', shown === target && saved === target && await page.locator('#dirpick').isHidden(), saved);
    await page.fill('#set-save', file);
    await page.press('#set-save', 'Enter');
    await page.locator('#save-msg.err').waitFor();
    check('9  typing a bad path shows the reason inline; no JS errors', /is a file/.test(await page.textContent('#save-msg')) && errs.length === 0, await page.textContent('#save-msg'));
    await page.locator('section', { hasText: 'Settings' }).last().screenshot({ path: path.join(os.tmpdir(), 'beam-settings.png') });
    await browser.close();
  } else console.log('SKIP 8-9  (no Chromium found; set CHROMIUM_PATH)');

  procs.forEach((p) => p.kill('SIGKILL'));
  fs.rmSync(ROOT, { recursive: true, force: true });
  const bad = results.filter((x) => !x).length;
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERROR', e.message); procs.forEach((p) => p.kill('SIGKILL')); process.exit(1); });
