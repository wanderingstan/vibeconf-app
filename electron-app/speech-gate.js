// speech-gate.js — cut a live audio stream into speech segments for STT (#850).
//
// The on-device engine (Whistle, #845) invents phrases on near-silence ("Thank
// you.", "Vielen Dank.") and answers short isolated bursts with filler, so it
// must only ever be handed real speech. These are the "gating v2" rules that
// fixed that in the #845 benchmark, made streaming:
//
//   threshold  = max(MIN_RMS, 15% of the stream's own loud-speech level), where
//                the loud level is the 95th-percentile frame RMS over the last
//                30 s. Relative, because call slots are digitally silent between
//                talkers, so a noise-floor threshold collapses to its minimum
//                (gating v1, which made things worse).
//   segment    = >= 0.8 s long AND >= 40% speech frames, 0.3 s padding each
//                side, gaps shorter than 0.6 s bridged (one utterance, not many).
//
// Streaming additions: while a segment is open it is offered for a partial
// transcript every PARTIAL_EVERY_MS (so the bot sees words while someone is
// still talking, like a live caption), and it is closed at MAX_SEGMENT_MS
// (inside the model's 30 s attention window).
//
// Pure: no I/O, no timers. Feed it Int16 or Float32 chunks with their capture
// time; it calls back with Float32 audio at 16 kHz. One gate per stream.

const RATE = 16000;
const FRAME = 320;                 // 20 ms
const MIN_RMS = 0.01;
const REL_THRESHOLD = 0.15;
const LEVEL_WINDOW_FRAMES = 1500;  // 30 s of frames for the loud-level percentile
const MIN_SEGMENT_MS = 800;
const MIN_SPEECH_RATIO = 0.4;
const PAD_MS = 300;
const GAP_MS = 600;
const PARTIAL_EVERY_MS = 1500;
const MAX_SEGMENT_MS = 25000;

const msToSamples = (ms) => Math.round((ms / 1000) * RATE);

function percentile(values, p) {
  if (!values.length) return 0;
  const s = Float32Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

class SpeechGate {
  /**
   * @param {object} cb
   * @param {(seg: {audio: Float32Array, startAt: number}) => void} [cb.onPartial]
   * @param {(seg: {audio: Float32Array, startAt: number, endAt: number}) => void} [cb.onFinal]
   */
  constructor({ onPartial = () => {}, onFinal = () => {} } = {}) {
    this.onPartial = onPartial;
    this.onFinal = onFinal;
    this._levels = [];            // recent frame RMS values (speech level estimate)
    this._loud = 0;
    this._pre = [];               // pre-roll frames (Float32Array) for padding
    this._frames = null;          // open segment's frames
    this._speechFrames = 0;
    this._silentRun = 0;          // consecutive sub-threshold frames in an open segment
    this._startAt = 0;
    this._lastPartialLen = 0;
    this._pending = new Float32Array(0); // leftover samples < one frame
    this._clock = 0;              // capture time of the next sample, ms
  }

  threshold() { return Math.max(MIN_RMS, REL_THRESHOLD * this._loud); }
  isOpen() { return !!this._frames; }

  /** Feed a chunk. `at` = capture time (ms) of its first sample. */
  push(chunk, at) {
    const f = chunk instanceof Float32Array ? chunk : Float32Array.from(chunk, (v) => v / 32768);
    if (Number.isFinite(at)) this._clock = at - (this._pending.length / RATE) * 1000;
    const all = new Float32Array(this._pending.length + f.length);
    all.set(this._pending, 0);
    all.set(f, this._pending.length);
    let i = 0;
    for (; i + FRAME <= all.length; i += FRAME) this._frame(all.subarray(i, i + FRAME).slice());
    this._pending = all.slice(i);
  }

  /** End of stream (track gone, call over): close whatever is open. */
  flush() { if (this._frames) this._close(); }

  _frame(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const at = this._clock;
    this._clock += (FRAME / RATE) * 1000;

    // Loud level from frames that are at least audible, so long silences
    // don't drag the percentile (and the threshold) down to nothing.
    if (rms >= MIN_RMS) {
      this._levels.push(rms);
      if (this._levels.length > LEVEL_WINDOW_FRAMES) this._levels.shift();
      if (this._levels.length % 25 === 0 || this._levels.length < 25) this._loud = percentile(this._levels, 0.95);
    }
    const speech = rms >= this.threshold();
    const padFrames = Math.round(msToSamples(PAD_MS) / FRAME);

    if (!this._frames) {
      this._pre.push(frame);
      if (this._pre.length > padFrames) this._pre.shift();
      if (!speech) return;
      this._frames = [...this._pre];
      this._startAt = at - this._pre.length * (FRAME / RATE) * 1000 + (FRAME / RATE) * 1000;
      this._pre = [];
      this._speechFrames = 1;
      this._silentRun = 0;
      this._lastPartialLen = 0;
      return;
    }

    this._frames.push(frame);
    if (speech) { this._speechFrames++; this._silentRun = 0; } else { this._silentRun++; }

    const samples = this._frames.length * FRAME;
    const gapFrames = Math.round(msToSamples(GAP_MS) / FRAME);
    if (this._silentRun >= gapFrames || samples >= msToSamples(MAX_SEGMENT_MS)) {
      // Keep PAD_MS of the trailing silence, drop the rest of the gap.
      const drop = Math.max(0, this._silentRun - padFrames);
      if (drop) this._frames.splice(this._frames.length - drop, drop);
      this._close();
      return;
    }
    if (samples - this._lastPartialLen >= msToSamples(PARTIAL_EVERY_MS) && this._acceptable()) {
      this._lastPartialLen = samples;
      this.onPartial({ audio: this._audio(), startAt: this._startAt });
    }
  }

  _acceptable() {
    const n = this._frames.length;
    return n * FRAME >= msToSamples(MIN_SEGMENT_MS) && this._speechFrames / n >= MIN_SPEECH_RATIO;
  }

  _audio() {
    const out = new Float32Array(this._frames.length * FRAME);
    this._frames.forEach((fr, k) => out.set(fr, k * FRAME));
    return out;
  }

  _close() {
    const ok = this._acceptable();
    const audio = ok ? this._audio() : null;
    const startAt = this._startAt;
    const endAt = startAt + (this._frames.length * FRAME / RATE) * 1000;
    this._frames = null;
    this._speechFrames = 0;
    this._silentRun = 0;
    if (ok) this.onFinal({ audio, startAt, endAt });
  }
}

module.exports = {
  SpeechGate,
  RATE,
  MIN_RMS,
  REL_THRESHOLD,
  MIN_SEGMENT_MS,
  MIN_SPEECH_RATIO,
  GAP_MS,
  PARTIAL_EVERY_MS,
  MAX_SEGMENT_MS,
};
