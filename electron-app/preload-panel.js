// preload-panel.js — Preload for the control panel window.
// Exposes IPC methods that panel.js uses instead of chrome.* APIs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send messages to main process
  send: (channel, data) => ipcRenderer.send(channel, data),

  // Listen for messages from main process
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Request/response to main process
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // Convenience: get Meet window status synchronously
  getMeetStatus: () => ipcRenderer.sendSync('get-meet-status'),

  // Convenience: join a Meet call
  joinMeet: (url) => ipcRenderer.send('join-meet', url),

  // Convenience: copy to clipboard
  copyToClipboard: (text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
  },
});
