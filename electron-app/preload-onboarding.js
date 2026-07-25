// preload-onboarding.js — preload for the first-run setup wizard window.
// Same minimal contextBridge surface as preload-app-settings.js: the renderer
// calls IPC by name (get-config/set-config, check-auth/login, play-speech-test,
// and the onboarding:* handlers in main.js).

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
