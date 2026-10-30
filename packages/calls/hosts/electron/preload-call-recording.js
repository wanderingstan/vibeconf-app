// preload-call-recording.js — preload for the small "recording in progress"
// control window (call-recording-window.js). Same minimal contextBridge
// surface as preload-app-settings.js / preload-panel.js: this window's own
// page drives getDisplayMedia()+MediaRecorder and just needs a way to talk to
// main over a few named channels.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
