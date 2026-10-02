// Beam desktop app (Electron). Runs the same agent as the command-line version, inside
// a real app: window, tray/menu-bar icon, native file pickers, start at login,
// notifications, and automatic updates that never interrupt a transfer.
'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  dialog,
  ipcMain,
  shell,
  nativeImage,
  Notification,
} = require('electron');

const fs = require('fs');
const path = require('path');
const { startBeam } = require('../src/app');

let win = null;
let tray = null;
let beam = null;
let quitting = false;

const startHidden = process.argv.includes('--hidden');

/*
 * Keep Electron's single-instance lock in the same data directory
 * that Beam itself uses.
 *
 * This is important because the desktop test starts the first Electron
 * process through Playwright and starts the second process directly.
 * Both processes must therefore use exactly the same Electron userData
 * directory for requestSingleInstanceLock() to work reliably.
 */
const beamDataDir =
  process.env.BEAM_DATA || path.join(require('os').homedir(), '.beam');

try {
  fs.mkdirSync(beamDataDir, { recursive: true });
  app.setPath('userData', beamDataDir);
} catch {
  // If the configured data directory cannot be used,
  // Electron will continue with its default userData path.
}

/*
 * One copy per computer/data directory:
 * a second launch brings the first window forward.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Beam could not start', e.message);
    app.exit(1);
  });
}

async function boot() {
  beam = await startBeam({
    desktop: {
      update: null,
      app: true,
    },
  });

  createWindow();
  createTray();
  watchForCompletedTransfers();
  setupUpdates();

  if (process.platform === 'darwin' && !startHidden) {
    app.dock?.show();
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 880,
    minWidth: 720,
    minHeight: 560,
    title: 'Beam',
    show: false,
    backgroundColor: '#E9EDF2',
    icon: path.join(__dirname, 'icons', 'icon.png'),

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const origin = new URL(beam.url).origin;

  // The window only ever shows Beam's own local page;
  // links open in the normal browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin) {
      e.preventDefault();
      openExternal(url);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return {
      action: 'deny',
    };
  });

  win.loadURL(beam.url);

  win.once('ready-to-show', () => {
    if (!startHidden) {
      win.show();
    }
  });

  // Closing the window keeps Beam running in the tray/menu bar
  // so transfers continue.
  win.on('close', (e) => {
    if (quitting) return;

    e.preventDefault();
    win.hide();

    if (process.platform === 'darwin') {
      app.dock?.hide();
    } else if (!app.__toldAboutTray) {
      app.__toldAboutTray = true;

      notify(
        'Beam is still running',
        'It keeps receiving in the background. Quit from the tray icon.'
      );
    }
  });
}

function openExternal(url) {
  if (/^https?:\/\//.test(url)) {
    shell.openExternal(url);
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;

  if (process.platform === 'darwin') {
    app.dock?.show();
  }

  if (win.isMinimized()) {
    win.restore();
  }

  /*
   * show() is important here because Test 7 intentionally hides
   * the existing window before Test 8 starts the second instance.
   *
   * moveTop() and focus() make the handoff reliable under Xvfb/Linux
   * as well as macOS.
   */
  win.show();
  win.moveTop();
  win.focus();
}

function createTray() {
  const file =
    process.platform === 'darwin'
      ? 'trayTemplate.png'
      : 'tray.png';

  const img = nativeImage.createFromPath(
    path.join(__dirname, 'icons', file)
  );

  if (process.platform === 'darwin') {
    img.setTemplateImage(true);
  }

  tray = new Tray(img);
  tray.setToolTip('Beam');

  const rebuild = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Beam',
          click: showWindow,
        },

        {
          type: 'separator',
        },

        {
          label: 'Start Beam when I log in',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,

          click: (item) => {
            app.setLoginItemSettings({
              openAtLogin: item.checked,
              args: ['--hidden'],
              openAsHidden: true,
            });
          },
        },

        {
          type: 'separator',
        },

        {
          label: 'Quit Beam',
          click: () => quit(),
        },
      ])
    );
  };

  rebuild();

  tray.on('click', showWindow);
}

async function quit() {
  if (beam?.busy()) {
    const { response } = await dialog.showMessageBox(
      win?.isVisible() ? win : null,
      {
        type: 'warning',
        buttons: ['Keep running', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,

        message: 'A transfer is in progress.',

        detail:
          'If you quit now it stops, and continues from where it left off next time both computers run Beam.',
      }
    );

    if (response !== 1) {
      return;
    }
  }

  quitting = true;

  await beam?.shutdown();

  app.quit();
}

app.on('before-quit', (e) => {
  if (!quitting) {
    e.preventDefault();
    quit();
  }
});

app.on('activate', showWindow);

// Stay alive in the tray.
app.on('window-all-closed', () => {});

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({
      title,
      body,
      silent: false,
    }).show();
  }
}

// Tell the person when files arrive while the window is hidden.
function watchForCompletedTransfers() {
  const seen = new Map();

  beam.agent.on('update', () => {
    for (const t of beam.agent.transfers.values()) {
      const prev = seen.get(t.id);

      seen.set(t.id, t.status);

      if (
        prev &&
        prev !== 'done' &&
        t.status === 'done' &&
        !win?.isFocused()
      ) {
        notify(
          t.direction === 'in'
            ? `Received from ${t.peerName}`
            : `Sent to ${t.peerName}`,

          `${t.count} file(s), ${(t.totalBytes / 1e9).toFixed(2)} GB${
            t.direction === 'in'
              ? ` saved in ${t.saveDir}`
              : ''
          }`
        );
      }
    }
  });
}

// ---- native pickers and updates, only for Beam's own page

function fromBeam(event) {
  try {
    return (
      new URL(event.senderFrame.url).origin ===
      new URL(beam.url).origin
    );
  } catch {
    return false;
  }
}

ipcMain.handle('beam:pick', async (event, kind) => {
  if (!fromBeam(event)) {
    throw new Error('not allowed');
  }

  const r = await dialog.showOpenDialog(win, {
    title:
      kind === 'folder'
        ? 'Choose folders to send'
        : 'Choose files to send',

    properties:
      kind === 'folder'
        ? ['openDirectory', 'multiSelections']
        : ['openFile', 'multiSelections'],
  });

  if (r.canceled) {
    return [];
  }

  return r.filePaths.map((p) => {
    let st = null;

    try {
      st = fs.statSync(p);
    } catch {}

    return {
      path: p,
      name: path.basename(p),
      dir: !!st?.isDirectory(),
      size: st && st.isFile() ? st.size : 0,
    };
  });
});

ipcMain.handle(
  'beam:pick-save-folder',
  async (event, current) => {
    if (!fromBeam(event)) {
      throw new Error('not allowed');
    }

    const r = await dialog.showOpenDialog(win, {
      title: 'Where should Beam save received files?',

      buttonLabel: 'Save files here',

      defaultPath:
        current && fs.existsSync(current)
          ? current
          : app.getPath('downloads'),

      properties: [
        'openDirectory',
        'createDirectory',
        'promptToCreate',
      ],
    });

    return r.canceled ? null : r.filePaths[0];
  }
);

ipcMain.handle(
  'beam:install-update',
  async (event) => {
    if (!fromBeam(event)) {
      throw new Error('not allowed');
    }

    if (beam.busy()) {
      throw new Error(
        'A transfer is running. The update installs once it has finished.'
      );
    }

    quitting = true;

    await beam.shutdown();

    require('electron-updater').autoUpdater.quitAndInstall();
  }
);

// ---- automatic updates (GitHub Releases),
// installed only between transfers

function setupUpdates() {
  if (!app.isPackaged || process.env.BEAM_NO_UPDATES) {
    return;
  }

  let autoUpdater;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }

  const set = (update) => {
    beam.agent.desktop.update = update;
    beam.agent.changed();
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (i) => {
    set({
      state: 'downloading',
      version: i.version,
      percent: 0,
    });
  });

  autoUpdater.on('download-progress', (p) => {
    set({
      ...beam.agent.desktop.update,
      state: 'downloading',
      percent: Math.round(p.percent),
    });
  });

  autoUpdater.on('update-downloaded', (i) => {
    set({
      state: 'ready',
      version: i.version,
    });

    notify(
      `Beam ${i.version} is ready`,
      'It installs the next time Beam restarts, never during a transfer.'
    );
  });

  autoUpdater.on('error', (e) => {
    set({
      state: 'error',
      error: String(e.message || e).split('\n')[0],
    });
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(() => {});
  };

  check();

  setInterval(check, 6 * 60 * 60 * 1000);
}