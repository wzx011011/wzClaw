'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  switchMode: (mode) => ipcRenderer.invoke('switch-mode', mode),
  petMenu: (x, y) => ipcRenderer.invoke('pet-menu', x, y),
  pickCwd: () => ipcRenderer.invoke('pick-cwd'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  onEvent: (cb) => ipcRenderer.on('companion-ev', (_e, ev) => cb(ev)),
});
