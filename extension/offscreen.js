// offscreen.js — Captures tab audio via chrome.tabCapture for STT.
// Runs in an offscreen document (hidden extension page with full API access).
//
// Flow:
//   1. Background sends 'start-capture' with streamId
//   2. We get the MediaStream via getUserMedia with tabCapture constraints
//   3. Record audio in chunks with MediaRecorder
//   4. Send chunks to background for STT processing

let mediaRecorder = null;
let audioStream = null;
let isCapturing = false;

// How often to send audio chunks for transcription (ms)
const CHUNK_INTERVAL = 5000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'start-capture') {
    startCapture(message.streamId);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'stop-capture') {
    stopCapture();
    sendResponse({ ok: true });
    return;
  }
});

async function startCapture(streamId) {
  if (isCapturing) {
    console.log('[offscreen] Already capturing');
    return;
  }

  try {
    // Get the tab's audio stream using the tabCapture stream ID
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    console.log('[offscreen] Got tab audio stream:',
      audioStream.getAudioTracks().length, 'audio track(s)');

    // Start recording
    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: 'audio/webm;codecs=opus',
    });

    mediaRecorder.ondataavailable = async (event) => {
      if (event.data.size > 0) {
        // Convert to base64 and send to background for STT
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          chrome.runtime.sendMessage({
            action: 'transcribe',
            audioBase64: base64,
            source: 'tabCapture',
          });
        };
        reader.readAsDataURL(event.data);
      }
    };

    mediaRecorder.start(CHUNK_INTERVAL);
    isCapturing = true;
    console.log('[offscreen] Recording tab audio, chunk interval:', CHUNK_INTERVAL, 'ms');
  } catch (err) {
    console.error('[offscreen] Failed to start capture:', err);
  }
}

function stopCapture() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioStream) {
    audioStream.getTracks().forEach(t => t.stop());
    audioStream = null;
  }
  isCapturing = false;
  console.log('[offscreen] Capture stopped');
}
