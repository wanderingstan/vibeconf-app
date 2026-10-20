// preload-panel-relay.js — the bot panel, hosted in the supervisor's window (#301 one-window spike).
//
// The same electronAPI surface as preload-panel.js, so panel.js runs unchanged,
// but it talks to whichever bot the supervisor has selected rather than to this
// process. invoke/send go to the supervisor's main process, which forwards them
// to that bot's /api/panel/* (panel-relay.js) with the bot's token; the bot's
// pushes come back as ordinary messages on this webContents, so `on` is plain
// ipcRenderer.on.
//
// Keep the surface in step with preload-panel.js: a method the panel calls that
// is missing here fails only in the hosted panel.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, ...args) => ipcRenderer.send('relay:send', channel, args),

  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  invoke: (channel, ...args) => ipcRenderer.invoke('relay:invoke', channel, args),

  // Synchronous IPC cannot cross a process boundary on the main thread's
  // schedule. Nothing in panel.js calls this today; answer "unknown" rather
  // than block.
  getMeetStatus: () => null,

  joinMeet: (url) => ipcRenderer.send('relay:send', 'join-meet', [url]),

  copyToClipboard: (text) => ipcRenderer.send('relay:copy', String(text || '')),

  // This panel is shown inside the app's window, which has its own account
  // line, so the panel leaves out the app-level bits it repeats.
  hosted: true,
});
