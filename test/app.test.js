// Desktop app test: launches the real Electron app (needs a display; on Linux CI use
// xvfb-run) and drives it alongside a command-line Beam acting as the other computer.
'use strict';
const { _electron } = require('playwright-core');
const { spawn } = require('child_process');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-app-'));
const results = [];
const check = (n, ok, note = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${note ? `  |  ${note}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extraArgs = process.getuid?.() === 0 ? ['--no-sandbox'] : []; // Chromium refuses to sandbox as root (CI containers)
const appEnv = { ...process.env, BEAM_DATA: path.join(T, 'app'), BEAM_NAME: 'DeskApp', BEAM_SAVE_DIR: path.join(T, 'app-recv'), BEAM_PORT: '46601', BEAM_UI_PORT: '47601', BEAM_UDP_PORT: '48601', BEAM_ANNOUNCE: '127.0.0.1:48602' };

function req(a, method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: a.ui, method, path: p, headers: { 'x-beam-token': a.token || '', 'content-type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(raw ? s : JSON.parse(s)));
    });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}
async function until(fn, ms = 30000, label = '') { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error(`timeout: ${label}`); }

let cli, electronApp;
// Calls into the app's main process. The test tool's link can drop a reply while the
// app's process is saturated (one-core CI box + a full-speed transfer): "Resulting
// promise was garbage collected". Every call here except the quit trigger (114, which has
// its own outcome check) is safe to repeat, so retry those up to twice.
async function ev(line, fn, arg) {
  for (let attempt = 0; ; attempt++) {
    try { return await electronApp.evaluate(fn, arg); }
    catch (e) {
      if (line !== 114 && attempt < 2 && /garbage collected/.test(e.message)) { await sleep(300); continue; }
      e.message = `[evaluate at test line ${line}] ${e.message}`;
      throw e;
    }
  }
}
(async () => {
  // The "other computer": command-line Beam
  cli = spawn(process.execPath, [path.join(ROOT_DIR, 'src', 'main.js'), '--no-open'], {
    env: { ...process.env, BEAM_DATA: path.join(T, 'cli'), BEAM_NAME: 'OtherPC', BEAM_SAVE_DIR: path.join(T, 'cli-recv'), BEAM_PORT: '46602', BEAM_UI_PORT: '47602', BEAM_UDP_PORT: '48602', BEAM_ANNOUNCE: '127.0.0.1:48601' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const B = { ui: 47602 };
  await new Promise((r) => cli.stdout.on('data', (d) => String(d).includes('Control panel') && r()));
  B.token = (await req(B, 'GET', '/', null, true)).match(/const TOKEN = '(\w+)'/)[1];

  // 1. The desktop app starts and shows its version
  electronApp = await _electron.launch({ args: [...extraArgs, ROOT_DIR], env: appEnv, timeout: 60000 });
  const page = await electronApp.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  const ver = require('../package.json').version;
  await page.locator('#me-name', { hasText: `Beam ${ver}` }).waitFor({ timeout: 30000 });
  check(`1  desktop app starts and shows "Beam ${ver}"`, true, await page.textContent('#me-name'));

  // 2. Locked down: page has no Node access; only the two bridge functions exist
  const sec = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: Object.keys(window.beamDesktop || {}).sort().join(',') }));
  check('2  page has no Node access; only the narrow bridge', sec.require === 'undefined' && sec.process === 'undefined' && sec.bridge === 'installUpdate,pick,pickSaveFolder,platform', JSON.stringify(sec));

  // 4. Native file picker (dialog stubbed: no human to click it)
  const f1 = path.join(T, 'video.bin');
  fs.writeFileSync(f1, crypto.randomBytes(30e6));
  const dirPick = path.join(T, 'album'); fs.mkdirSync(dirPick);
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dirPick, `p${i}.jpg`), crypto.randomBytes(200000));
  await ev(59, ({ dialog }, paths) => { dialog.showOpenDialog = async (_w, o) => ({ canceled: false, filePaths: o.properties.includes('openDirectory') ? [paths[1]] : [paths[0]] }); }, [f1, dirPick]);
  await page.locator('#native-pick').waitFor();
  await page.click('#btn-pick-files');
  await page.click('#btn-pick-folder');
  const summary = await page.textContent('#picked');
  check('4  native "Choose files / Choose folder" pickers feed the send list', /1 file\(s\) \(28\.6 MB\) and 1 folder/.test(summary), summary);

  // 13. Save folder: Browse opens the system folder picker (stubbed) and is saved at once
  const saveTo = path.join(T, 'My Beam Inbox');
  fs.mkdirSync(saveTo);
  await ev(0, ({ dialog }, p) => { global.__saveDialog = null; const orig = dialog.showOpenDialog; dialog.showOpenDialog = async (w, o) => { if (o.buttonLabel === 'Save files here') { global.__saveDialog = o; return { canceled: false, filePaths: [p] }; } return orig(w, o); }; }, saveTo);
  await page.click('#btn-browse-save');
  await page.locator('#save-msg.okc').waitFor({ timeout: 10000 });
  const usedNative = await ev(0, () => !!global.__saveDialog && global.__saveDialog.properties.includes('createDirectory'));
  const savedDir = await page.inputValue('#set-save');
  check('13 Browse… uses the system folder picker (with "New Folder") and saves the choice', usedNative && savedDir === saveTo && await page.locator('#dirpick').isHidden(), savedDir);

  // 5. Older-version device gets a warning badge (beacon without a version = pre-2.0)
  const sock = dgram.createSocket('udp4');
  const beacon = Buffer.from(JSON.stringify({ app: 'beam', v: 1, id: 'old-pc-1', name: 'OldLaptop', os: 'win32', port: 46999 }));
  for (let i = 0; i < 3; i++) { sock.send(beacon, 48601, '127.0.0.1'); await sleep(200); }
  sock.close();
  await page.locator('.device', { hasText: 'OldLaptop' }).waitFor({ timeout: 10000 });
  const oldTxt = await page.locator('.device', { hasText: 'OldLaptop' }).textContent();
  const newTxt = await page.locator('.device', { hasText: 'OtherPC' }).textContent();
  check('5  pre-2.0 device flagged "update it"; same-version device not flagged', /update it/.test(oldTxt) && !/update/.test(newTxt), `${oldTxt.trim()} / ${newTxt.trim()}`);

  // 6. Full transfer from the desktop app, pairing confirmed on both sides
  await page.locator('.device', { hasText: 'OtherPC' }).click();
  await page.click('#btn-send');
  await page.locator('.prompt', { hasText: 'Pair with' }).waitFor({ timeout: 15000 });
  await page.locator('.prompt button.primary').click();
  await until(async () => { const s = await req(B, 'GET', '/api/state'); for (const p of s.prompts) await req(B, 'POST', `/api/prompt/${p.id}`, { ok: true }); return s.prompts.some((p) => p.kind === 'offer'); }, 20000, 'offer at B');
  await page.locator('#transfers .transfer', { hasText: 'Done' }).waitFor({ timeout: 60000 });
  const got = fs.readFileSync(path.join(T, 'cli-recv', 'video.bin'));
  const okHash = crypto.createHash('sha256').update(got).digest('hex') === crypto.createHash('sha256').update(fs.readFileSync(f1)).digest('hex');
  const albumOk = fs.readdirSync(path.join(T, 'cli-recv', 'album')).length === 5;
  check('6  transfer from the desktop app arrives intact (file + folder)', okHash && albumOk);

  // 7. Closing the window keeps Beam running (tray), and it comes back
  await ev(89, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await sleep(500);
  const hidden = await ev(91, ({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].isVisible());
  const stillServing = (await req({ ui: 47601, token: await page.evaluate(() => TOKEN) }, 'GET', '/api/state')).me.name === 'DeskApp';
  check('7  closing the window hides it; Beam keeps running in the tray', hidden && stillServing);

  // 8. A second launch exits and brings the first window back
  // Plain process, no test tool attached: it should hand off to the running app and exit.
  const second = spawn(require('electron'), [...extraArgs, ROOT_DIR], { env: appEnv, stdio: 'ignore' });
  const secondExited = await new Promise((r) => { second.on('exit', () => r(true)); setTimeout(() => { second.kill('SIGKILL'); r(false); }, 15000); });
  await sleep(500);
  const visibleAgain = await ev(100, ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
  check('8  second launch exits; the running app shows its window instead', !!secondExited && visibleAgain);

  // 9. Quitting during a transfer asks first (dialog stubbed to answer "Keep running")
  const big = path.join(T, 'big.bin');
  { const fd = fs.openSync(big, 'w'); const c = crypto.randomBytes(20e6); for (let i = 0; i < 20; i++) fs.writeSync(fd, c); fs.closeSync(fd); } // 400 MB without one huge allocation

  await ev(107, ({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); global.__asked = 0; dialog.showMessageBox = async () => { global.__asked++; return { response: 0 }; }; }, big);

  await page.click('#btn-pick-files');
  await page.click('#btn-send');
  await until(async () => { const s = await req(B, 'GET', '/api/state'); for (const p of s.prompts) await req(B, 'POST', `/api/prompt/${p.id}`, { ok: true }); return s.transfers.some((t) => t.status === 'receiving'); }, 20000, 'big transfer started');


  // Ask the app to quit. The test tool sometimes loses its own REPLY to this one call
  // ("Resulting promise was garbage collected", ~1 in 10 runs) even though the quit
  // request ran. Tolerate exactly that, then check the OUTCOME: the app asked once and
  // is still running. If the tool's link were really broken, the next call fails.
  let toolFlaked = false;
  try { await ev(114, ({ app }) => { setTimeout(() => app.quit(), 300); }); }
  catch (e) { if (!/garbage collected/.test(e.message)) throw e; toolFlaked = true; }
  await sleep(1500);

  const asked = await ev(117, () => global.__asked);
  check('9  quitting mid-transfer asks first; "Keep running" keeps the transfer going', asked === 1, `asked ${asked} time(s), app still running${toolFlaked ? ' (test tool dropped its reply; outcome verified directly)' : ''}`);
  await page.locator('#transfers .transfer', { hasText: 'Done' }).nth(0).waitFor({ timeout: 120000 });
  await until(async () => (await req(B, 'GET', '/api/state')).transfers.filter((t) => t.status === 'done').length >= 2, 120000, 'big done');

  // 10. Navigation away is blocked; external links go to the real browser instead
  await ev(123, ({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; });
  await page.evaluate(() => { location.href = 'https://example.com/phish'; });
  await sleep(800);
  const stayed = new URL(page.url()).host === '127.0.0.1:47601';
  const opened = await ev(127, () => global.__opened);
  check('10 window cannot be navigated to another site; link opens in the browser instead', stayed && opened[0] === 'https://example.com/phish', `still on ${new URL(page.url()).host}`);

  // 11. No JavaScript errors in the app window throughout
  check('11 no JavaScript errors in the app window', errs.length === 0, errs.join(' | ') || 'none');

  // 12. Quit when idle: no question asked, the app exits
  const exited = new Promise((r) => electronApp.process().on('exit', () => r(true)));
  await ev(135, ({ app }) => { setTimeout(() => app.quit(), 300); }).catch(() => {});
  check('12 quitting when idle exits cleanly without asking', await Promise.race([exited, sleep(10000).then(() => false)]));

  cli.kill('SIGKILL');
  fs.rmSync(T, { recursive: true, force: true });
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('ERROR', e.message);
  cli?.kill('SIGKILL');
  // Force-kill: a stuck app would hold Beam's single-instance lock and break the next run.
  try { electronApp?.process().kill('SIGKILL'); } catch {}
  try { await electronApp?.close(); } catch {}
  fs.rmSync(T, { recursive: true, force: true });
  process.exit(1);
});
