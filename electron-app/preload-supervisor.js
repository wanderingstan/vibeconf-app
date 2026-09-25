// preload-supervisor.js — preload for the supervisor window (#301).
// The over-bot view: the fleet, what's coming up, and launching a bot. Same
// minimal contextBridge surface as preload-app-settings.js / preload-panel.js.

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
