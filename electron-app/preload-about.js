// preload-about.js — preload for the About window.
//
// Same minimal contextBridge surface as preload-app-settings.js, plus the
// runtime versions. Those come from process.versions HERE rather than over IPC:
// the preload can read them directly, and an About box that needs a round trip
// to render its own contents is a round trip for nothing.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
