// preload-panel.js — Preload for the control panel window.
// Exposes IPC methods that panel.js uses instead of chrome.* APIs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Send messages to main process
  // VARIADIC. It forwarded only the first argument, so any send with two
  // payloads silently lost the second: `api.send('join-meet', url, {
  // onboardingCall: true })` arrived in main as (url, undefined), and the
  // guided setup ran an ordinary /join-call. Nothing errored — the bot joined
  // and behaved normally, just not as a setup call.
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),

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

// Emoji graphics (#316) are read in MAIN, via the 'emoji-data-uri' IPC, not
// here. This preload is SANDBOXED (panelView doesn't set sandbox:false the way
// createMeetView does), so its `require` resolves only Electron's small
// allowlist — a relative path like './emoji-assets.js' throws. Reading the file
// main-side keeps the panel sandboxed instead of relaxing it for a file read.
