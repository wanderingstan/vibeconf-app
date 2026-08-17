// audio-devices.js — what this machine is listening and speaking through.
//
// WHY THIS EXISTS (#422/#378). When a person listens on SPEAKERS, the bot's own
// voice comes back through their microphone, Meet animates THEIR speaking
// indicator, and the bot reads its own echo as that person interrupting — then
// cuts itself off mid-sentence. That is the failure #378 disabled the fast
// speaking signal for, and the echo guard in #421 defends against.
//
// It cannot be studied from recordings. Replayed audio is injected into a
// virtual microphone and never crosses a speaker-to-microphone path, so the
// failure is structurally absent from every replay we can produce. The only
// source is real calls where someone was on speakers — and until now, whether
// they were was written down by hand, if at all.
//
// So the app records it: one line at join, one at leave.
//
// SAMPLED AT BOTH ENDS ON PURPOSE. Devices change mid-call. Measured on
// 2026-08-17, one machine reported built-in speakers and then external
// headphones eight minutes later — an echo-prone call that would have looked
// safe, or the reverse, from a single reading. When the two disagree, that
// disagreement is the interesting fact.
//
// READ IT AS A PROXY, NOT AS TRUTH. Three honest limits, repeated in the logged
// line itself so nobody over-trusts it months later:
//   - Google Meet has its OWN device picker (Settings > Audio) which can differ
//     from the OS default reported here.
//   - This describes the machine the BOT runs on. If the operator is in the call
//     from a phone or another laptop, or the bot runs headless, it describes
//     nobody in the call.
//   - macOS only. Elsewhere this is a no-op rather than a wrong answer.

const { execFile } = require('child_process');

// Wired headphones report the SAME `builtin` transport as the internal
// speakers, so transport alone cannot tell them apart — the name is what
// separates them.
const HEADPHONE_NAME_RE = /head(phone|set)|airpod|earbud|earphone|beats|wh-\d|qc\s?\d/i;
// ...and a name is likewise the only thing separating a USB speakerphone from a
// USB headset.
const SPEAKER_NAME_RE = /speaker|speak\s?\d|soundbar|dock|display|monitor|studio/i;

// Does sound leaving the output have an acoustic path back into the microphone?
//
// Three answers, and the third one matters: TRUE for anything radiating into
// the room, FALSE for anything worn on the head, and NULL when the device does
// not say. "Jabra Evolve2 65" is a headset and "Jabra Speak 510" is a
// speakerphone; both arrive over USB and neither name declares which. Guessing
// TRUE there would mark a headphones-only call as echo-prone evidence, and
// guessing FALSE would hide a real echo case — so it stays unknown, and the
// human answer given in the call is what decides.
function hasEchoPath(output) {
  if (!output || !output.name) return null;
  const name = output.name;
  const transport = output.transport || '';
  if (HEADPHONE_NAME_RE.test(name)) return false;
  if (SPEAKER_NAME_RE.test(name)) return true;
  // Built-in output that is not headphones is the internal speaker; a monitor
  // over HDMI/DisplayPort radiates too.
  if (/builtin|hdmi|displayport/i.test(transport)) return true;
  return null;                                       // external and unlabelled
}

// Pull the two default devices out of `system_profiler SPAudioDataType -json`.
// Exported separately from the spawn so it can be tested against fixtures
// without a Mac in the loop.
function parseAudioDevices(json) {
  let data;
  try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  const items = (data && data.SPAudioDataType && data.SPAudioDataType[0]
    && data.SPAudioDataType[0]._items) || [];
  const pick = (key) => {
    const found = items.find((it) => it && it[key]);
    if (!found) return null;
    return {
      name: found._name || '(unnamed)',
      transport: String(found.coreaudio_device_transport || '')
        .replace(/^coreaudio_device_(type|transport)_/, '') || 'unknown',
    };
  };
  const output = pick('coreaudio_default_audio_output_device');
  const input = pick('coreaudio_default_audio_input_device');
  if (!output && !input) return null;
  return { output, input, echoPath: hasEchoPath(output) };
}

const dev = (d) => (d ? `${d.name} (${d.transport})` : 'none');

// The log line. Deliberately carries its own caveat: a bare "echo path LIKELY"
// read a year from now would look like a measurement rather than a guess about
// one machine's OS defaults.
function formatAudioDevices(parsed, phase) {
  if (!parsed) return null;
  const verdict = parsed.echoPath === null ? 'unknown'
    : parsed.echoPath ? 'LIKELY' : 'unlikely';
  return `🎧 [audio-devices] ${phase}: out=${dev(parsed.output)} in=${dev(parsed.input)}`
    + ` — echo path ${verdict} (OS default on this machine; Meet may use different devices)`;
}

// Sample the current defaults. Resolves null on any failure or non-macOS host —
// this is diagnostics, and diagnostics must never be the reason a call is late
// or an error is thrown.
function sampleAudioDevices({ timeoutMs = 4000, platform = process.platform } = {}) {
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile('system_profiler', ['SPAudioDataType', '-json'],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : parseAudioDevices(stdout)));
    } catch { resolve(null); }
  });
}

module.exports = { parseAudioDevices, formatAudioDevices, sampleAudioDevices, hasEchoPath };
