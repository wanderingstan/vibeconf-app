// preload-stt-bridge.js — carry the page's speech-to-text tap to main (#850).
//
// page-inject.js's sttTap posts 'stt-audio' messages (16 kHz Int16 PCM chunks,
// plus 'attached'/'detached' events per remote stream); main's AudioTranscription
// (caption-source.js) listens on the STT_AUDIO_CHANNEL IPC channel. Start/stop
// go the other way as ordinary 'extension-message' actions ('start-stt-tap' /
// 'stop-stt-tap'), which every provider preload already forwards to the page.
//
// Installed by every preload that runs page-inject (a test fails if one doesn't),
// the same rule as preload-recording-bridge.js.

const STT_AUDIO_CHANNEL = 'stt-audio'; // must match caption-source.js

function installSttBridge(ipcRenderer) {
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.__botsInCalls) return;
    if (event.data.action !== 'stt-audio') return;
    const p = event.data.payload;
    if (!p || !p.stream) return;
    try { ipcRenderer.send(STT_AUDIO_CHANNEL, p); } catch { /* main gone */ }
  });
}

module.exports = { installSttBridge, STT_AUDIO_CHANNEL };
