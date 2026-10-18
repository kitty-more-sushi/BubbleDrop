'use strict';
// Small bridge for things a web page cannot do on its own: real paths of dropped files,
// title-bar colours and taskbar attention.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bd', {
  electron: true,
  pathsFor: (files) => files.map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }),
  setTheme: (t) => ipcRenderer.send('theme', t),
  attention: () => ipcRenderer.send('attention'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
});
