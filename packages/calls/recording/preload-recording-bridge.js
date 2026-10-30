// preload-recording-bridge.js — call recording plumbing for any provider preload
// that runs page-inject.js (#814).
//
// Recording audio happens in the page (page-inject's callRecorder); main owns
// the decision and the files. Two hops connect them, and until #814 only the
// Meet provider had either, so on Slack and Zoom a
// recording came out as silent video:
//   main → page:  'trigger-record' IPC → start-recording / stop-recording
//   page → main:  record-chunk / record-stopped / record-name /
//                 record-speaker-event / record-started → the call-record-*
//                 IPC channels main.js consumes (call-recorder.js)
//
// Every platform's preload installs it, Meet's included (Meet also clamps its
// status banner while recording, on the same trigger-record command).

// Pure: which IPC channel (if any) a page message is forwarded on.
const PAGE_TO_MAIN = {
  'record-chunk': 'call-record-chunk',
  'record-stopped': 'call-record-stopped',
  'record-name': 'call-record-name',
  'record-speaker-event': 'call-record-speaker',
};

function installRecordingBridge(ipcRenderer, { tag = '[recording]' } = {}) {
  ipcRenderer.on('trigger-record', (_event, { recording, room, startedAt, botName } = {}) => {
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: recording ? 'start-recording' : 'stop-recording',
      payload: { room, startedAt, botName },
    }, '*');
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.__botsInCalls) return;
    const { action, payload } = event.data;
    const channel = PAGE_TO_MAIN[action];
    if (channel) {
      try { ipcRenderer.send(channel, action === 'record-chunk' ? payload : (payload || {})); } catch { /* main gone */ }
    } else if (action === 'record-started') {
      try { ipcRenderer.send('page-inject-log', `${tag} [call-record] renderer started recording (room ${payload?.room || '?'})`); } catch { /* main gone */ }
    }
  });
}

module.exports = { installRecordingBridge, PAGE_TO_MAIN };
