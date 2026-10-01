// The only bridge between Beam's page and the operating system: two narrow functions.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('beamDesktop', {
  pick: (kind) => ipcRenderer.invoke('beam:pick', kind === 'folder' ? 'folder' : 'files'),
  installUpdate: () => ipcRenderer.invoke('beam:install-update'),
  pickSaveFolder: (current) => ipcRenderer.invoke('beam:pick-save-folder', typeof current === 'string' ? current : ''),
  platform: process.platform,
});
