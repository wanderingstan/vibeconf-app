// host-ipc.js: the message channel between a call page and its host.
//
// A provider that talks to the host directly (Meet's, today) gets the channel
// here instead of requiring 'electron', so the library has no Electron
// dependency outside hosts/electron. The host sets it before it loads the
// provider: the Electron host passes ipcRenderer, which is the interface the
// channel follows (on, send, invoke). A Playwright host (Phase 4) passes an
// object with the same three methods over its own binding.

let channel = null;

function setHostIpc(ipc) { channel = ipc; }

function hostIpc() {
  if (!channel) throw new Error('No host channel: call setHostIpc() before loading a provider');
  return channel;
}

module.exports = { setHostIpc, hostIpc };
