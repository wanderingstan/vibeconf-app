# Realtime voice in the app (experiment)

A first draft of putting OpenAI's realtime speech-to-speech model in the bot's
voice seat, instead of the caption → Claude → ElevenLabs loop.

Off by default. Per bot. Nothing changes for any bot that does not turn it on.

Follows the standalone prototype in `experiments/realtime-voice/` (PR #607).
That page is still the place to try the ideas quickly; this is the same
mechanics wired to real call audio.

## Turning it on

Per bot, because preferences are stored per profile:

```
realtimeVoice     true          # the switch
realtimeVoiceName "cedar"       # optional, OpenAI voice name
realtimeModel     "gpt-realtime" # optional, hidden in Settings
```

The key is **not** a preference, because `preferences-schema.js` is the
agent-visible whitelist and keys are what it exists to exclude. Put it in the
same `config.json`, next to `ttsApiKey`:

```
realtimeApiKey    "sk-..."      # an ordinary OpenAI key; OPENAI_API_KEY also works
```

## How the audio is wired

Both halves already existed in `page-inject.js` and nowhere else, which is why
the session lives in the page rather than in main:

```
  other people ──▶ Meet RTCPeerConnection ──▶ AudioCaptureManager.participants
                                                        │
                                              mixed into one track
                                                        ▼
  main: mint ephemeral secret ─────────────▶  RealtimeVoice (page)  ◀──▶ OpenAI
                                                        │              (WebRTC)
                                              model audio track
                                                        ▼
                                        VirtualMic.destination ──▶ Meet mic
                                                        └──▶ mic.analyser (lip-sync)
```

Routing audio through main would mean encode → IPC → decode, twice, for nothing.
The avatar lip-syncs for free because the model audio taps `mic.analyser`
exactly the way normal TTS playback does.

The API key never reaches the page. Main mints a roughly 60 second ephemeral
client secret and sends only that.

## Three things that will bite whoever picks this up

**The RTCPeerConnection hook.** `AudioCaptureManager` replaces
`window.RTCPeerConnection` globally to capture participants. A peer connection
opened naively in this page gets captured too, so the bot's own voice would be
filed as a call participant and fed into recording and STT. The native
constructor is now stashed at `window.__vibeconfNativeRTCPeerConnection`, and
`RealtimeVoice` uses it.

**Participant sources must never touch `mic.destination`.** They are summed into
a separate `mixDest` for upload. Connecting them to the mic destination would
publish the whole room back into the bot's own mic.

**A remote WebRTC track feeding only an AudioContext stays silent in Chromium.**
It needs a media element consuming it, so there is a muted `Audio` element
holding the stream. Without it the graph looks correct and no audio flows, which
is indistinguishable from the model never speaking.

## What is deliberately not done

- **No Claude.** The realtime model is alone: no repo access, no tools, no
  back channel. The seam design (silent injection, floor control, staleness,
  supersession) is prototyped in `experiments/realtime-voice/` and none of it is
  ported. This draft is about proving the audio path.
- **The normal speech path is not disabled.** If an agent is also driving this
  bot, both could try to talk. Today that means running a realtime bot as a
  dedicated bot. A proper gate on `speakText` is the next obvious commit.
- **Mid-call participant tracks are polled**, every 3s, because
  `AudioCaptureManager` emits no events. Fine for a draft, not for shipping.
- **Slack is untouched.** The capture hook is disabled there
  (`__vibeconf_disableAudioCapture`), so there is no participant mix to send.

## Cost

Realtime bills per minute of audio in **both** directions for as long as the
session is open, including while nobody is talking. A bot idling in a long
meeting is a meter running. `stopRealtimeVoice` fires on leave and on teardown;
if you add another exit path, add it there too.

## Status reporting

`RealtimeVoice` posts to `vibeconf-realtime-status`, forwarded by
`google-meet-provider.js` to main, which logs it and raises `broadcastError` on
a refused session or a lost peer connection. Without this a failed session is
invisible unless somebody has the page console open, which for a bot on a call
is nobody.
