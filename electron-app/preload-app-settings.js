// preload-app-settings.js — preload for the App Settings window (#381).
// Machine-wide (app-level) config, shared by every profile on this Mac. Same
// minimal contextBridge surface as preload-panel.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
