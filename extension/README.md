# Bots in Calls — Chrome Extension POC

A Manifest V3 Chrome extension that lets an AI bot join a Google Meet call as a virtual participant. Other people on the call see the bot as another person with a camera, microphone, and the ability to share a whiteboard via screen share.

## How It Works

The extension overrides browser media APIs at the JavaScript level to provide virtual devices:

- **Virtual Camera**: Renders a bot avatar (initials, animated pulse) to an offscreen `<canvas>`, returns `canvas.captureStream()` from the `getUserMedia` override.
- **Virtual Microphone**: Web Audio API pipeline (`MediaStreamAudioDestinationNode`) that accepts TTS audio (MP3/WAV `ArrayBuffer`) and outputs it as a microphone track.
- **Permissions**: Overrides `navigator.permissions.query()` and `enumerateDevices()` so Meet sees camera/mic as available and granted.
- **Auto-Join**: Content script detects the pre-join screen, fills in the bot's guest name, and clicks "Join" automatically.
- **Screen Share**: Opens a whiteboard tab and automates clicking Meet's "Share screen" button; user selects the tab from Chrome's picker.

The approach was inspired by [GIF-Cam](../), a 2020 Chrome extension that created a virtual camera for video calls by intercepting `getUserMedia` and returning a canvas stream with GIF overlays.

## Setup

1. Open `chrome://extensions` in a **guest Chrome profile** (not signed into Google — see Known Issues)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this `extension/` directory
4. Open a Google Meet link in the same profile
5. The bot auto-joins as a guest. Use the extension popup for controls.

## Extension Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest. Content scripts target `meet.google.com/*` |
| `page-inject.js` | Runs in MAIN world at `document_start`. Patches `getUserMedia`, `getDisplayMedia`, `permissions.query`, `enumerateDevices`. Contains `VirtualCamera`, `VirtualMic`, and `Whiteboard` classes |
| `content-script.js` | Runs in ISOLATED world. Handles Meet DOM automation (name entry, join, share screen) and message bridge between extension and page |
| `background.js` | Service worker. Routes messages between popup and content scripts. Manages whiteboard tab |
| `popup.html/js/css` | Extension popup UI: bot name, join, screen share, speech test, speaking animation |
| `whiteboard.html` | Standalone whiteboard page (for local testing — see Screen Share section) |
| `test-speech.mp3` | macOS `say` command output for testing the virtual mic pipeline |

## What Works

All tested in a **guest (unsigned) Chrome profile**:

| Feature | Status | Notes |
|---------|--------|-------|
| Virtual camera | Working | Bot avatar visible to other participants. Animated gradient background + initials circle. Resolution adapts to what Meet requests (typically 1280x720 @ 30fps) |
| Virtual microphone | Working | MP3 audio plays through to other participants. Tested with macOS `say` TTS output |
| Auto-join as guest | Working | Extension detects pre-join screen, fills name, clicks "Join now" / "Ask to join" |
| Permissions override | Working | Meet shows mic/camera as available and granted |
| Screen share (tab) | Working | Semi-automated: extension opens whiteboard tab, clicks "Share screen", user picks tab from Chrome's picker |
| Speaking animation | Working | Avatar pulses when bot is "speaking", controllable via popup |

## What Doesn't Work (and Why)

### `getDisplayMedia` canvas override (Option 1)
We tried returning a `canvas.captureStream()` from the `getDisplayMedia` override. Meet accepts the stream at the JS level but **rejects it at the WebRTC layer** (`DisconnectedError, StartupCode = 219`). Meet validates display streams more deeply than camera streams — likely checking for `displaySurface` metadata, `CaptureController` integration, and audio tracks that a real `getDisplayMedia` stream would have.

### `chrome-extension://` URLs for screen sharing
Sharing a tab with a `chrome-extension://` URL **poisons Meet's screen sharing for the entire session**. Not just that attempt — ALL subsequent share attempts fail until the page is reloaded. The whiteboard must be hosted on a real HTTPS domain.

### Signed-in Google account profiles
When the Chrome profile is signed into a Google Account, the virtual camera and microphone **do not work**. Meet bypasses our `getUserMedia` override — likely because it caches a reference to the original `getUserMedia` during its own early initialization (before `document_start` scripts run), or it uses a different media acquisition path for authenticated users. The override IS patched (verified by calling `getUserMedia` manually in console), but Meet doesn't call it.

### Pure tone audio
Meet's noise suppression filters out pure sine waves. The virtual mic needs speech-like audio (e.g., from ElevenLabs TTS) to get through. Sawtooth waves with formant filters also get suppressed.

### Meet "camera blocked" detection
Meet has a heuristic that detects dark/low-variance video frames and shows "Camera might be blocked." The virtual camera needs a bright, animated background (not just a dark avatar on black) to avoid triggering this.

## Architecture Decisions

### Why Chrome Extension (not Electron)?
Both approaches ultimately involve Chrome/Chromium. The extension is faster to iterate on, cross-platform by default, and easier to side-load with Puppeteer for server-side bots. An Electron wrapper can be added later for an "app" feel and to access `desktopCapturer.getSources()` (bypasses Chrome's tab picker dialog entirely).

### Why `world: "MAIN"` (not script injection)?
Manifest V3 supports `"world": "MAIN"` for content scripts, which runs them directly in the page's JavaScript context. This is cleaner than the MV2 approach of injecting a `<script>` tag (which the original GIF-Cam used). It ensures the `getUserMedia` patch is in place before Meet's code runs.

### Why `setInterval` + AudioContext timer?
Canvas `captureStream()` pauses when the tab is in the background (Chrome throttles `requestAnimationFrame`). The AudioContext oscillator trick (from GIF-Cam) keeps the render loop ticking. We start with `setInterval` (works without user gesture) and upgrade to AudioContext after the first click.

### Why guest profile?
Meet's media acquisition path differs between guest and authenticated users. Guest profiles reliably hit our `getUserMedia` override. For production deployment (Puppeteer/headless), a guest profile is also simpler — no Google account management needed.

## Audio Capture & Speech Recognition

The extension hooks `RTCPeerConnection` to intercept individual participant audio streams as Meet creates them. This enables:

### Per-participant audio capture
Each remote participant's audio arrives as a separate `MediaStreamTrack` via the `track` event on `RTCPeerConnection`. We wrap each in a `ParticipantAudio` object that:
- Connects to an `AnalyserNode` for real-time audio level monitoring
- Detects speech vs. silence using RMS level thresholds
- Records audio via `MediaRecorder` during speech segments (ready for external STT)

### Speaker-attributed transcription (DOM + Web Speech API)
Two-layer approach for knowing who said what:

1. **DOM-based speaker tracking** — Observes Meet's People pane for speaking indicator animations. Each participant's indicator element (`jsname="QgSmzd"`) rotates CSS classes when speaking. We detect the animation rate (2+ class changes in 2 seconds = speaking). This gives us **real participant names** and **reliable voice activity detection** — using Meet's own VAD.

2. **Web Speech API** — Runs on the mixed tab audio to produce transcripts. When a transcript arrives, we correlate its timestamp against the DOM speaking log to attribute it to whoever was speaking during that window.

This approach works well for single-speaker segments. Overlapping speech may be attributed to the dominant speaker. The bot's own speech is correctly attributed when its indicator animates.

### Current STT limitations
- Web Speech API listens to the default microphone, not arbitrary streams — so we can't do per-participant STT in the browser
- Recognition quality depends on Meet's audio processing (noise suppression, echo cancellation)
- Bot's own TTS gets partially recognized (lossy after round-tripping through WebRTC), but this doesn't matter since we already know what the bot said

### Production STT upgrade path
Each `ParticipantAudio` already records speech segments as `audio/webm;codecs=opus` blobs via `MediaRecorder`. These are ready to be sent individually to external STT APIs for per-participant transcription:
- **Whisper API** — POST blob as a file upload
- **Deepgram** — WebSocket streaming (real-time)
- **ElevenLabs STT** — REST API
- **Google Cloud STT** — gRPC streaming

This would replace the Web Speech API with accurate per-participant transcription. The `RTCPeerConnection` hook and `MediaRecorder` plumbing are already in place — the upgrade is a backend integration, not a browser-side change.

## Text-to-Speech (TTS)

### Current state
The bot can play audio through Meet's microphone via `VirtualMic.playAudio(arrayBuffer)`. For testing, we use a pre-generated MP3 file created with macOS `say` command. There is **no dynamic TTS in the browser**.

### Why not browser `speechSynthesis`?
The Web Speech API's `speechSynthesis` outputs directly to the system speakers. There is no way to get a `MediaStream` or `ArrayBuffer` from it — it cannot be routed into our virtual microphone pipeline.

### Production TTS path
Call an external TTS API from a backend service, receive audio bytes, and pipe them through the existing `playAudio()` method:

```
LLM response text → TTS API → audio ArrayBuffer → VirtualMic.playAudio() → Meet hears bot speak
```

Compatible TTS services:
- **ElevenLabs** — high-quality voices, streaming support
- **OpenAI TTS** — `tts-1` / `tts-1-hd` models
- **Google Cloud TTS** — WaveNet/Neural2 voices
- **Amazon Polly** — Neural voices

The browser-side audio pipeline is complete. The upgrade is purely a backend integration: fetch audio bytes from a TTS API and pass them to `playAudio()` as an `ArrayBuffer`.

### Debugging
From the Chrome console on the Meet tab:
```js
// See all captured participants
window.__botsInCallsAudioCapture.participants

// See recent transcripts
window.__botsInCallsTranscription.getRecentTranscripts()

// Start/stop speech recognition manually
window.__botsInCallsTranscription.startListening()
window.__botsInCallsTranscription.stopListening()
```

## Next Steps

1. **Test audio capture** — Verify RTCPeerConnection hook captures individual participant streams in a live call. Check popup's Audio Capture section for level meters.
2. **Test speaker-attributed STT** — Click "Start Listening" in popup, speak from the main profile, verify transcripts appear with correct speaker attribution.
3. **Backend AI integration** — Wire up: capture audio → STT (Whisper/Deepgram) → LLM (Claude) → TTS (ElevenLabs) → `VirtualMic.playAudio()`.
4. **Hosted whiteboard** — Add a `/whiteboard` route to vibeconferencing.vercel.app (chrome-extension:// URLs break Meet's screen sharing).
5. **Electron wrapper investigation** — Would solve the screen share picker issue (`desktopCapturer`) and the signed-in profile issue.
6. **Puppeteer/headless deployment** — Run the bot server-side with `--load-extension` for production use.
