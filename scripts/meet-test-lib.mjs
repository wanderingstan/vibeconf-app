// meet-test-lib.mjs — HTTP driver for automated multi-bot Meet testing.
//
// The bots are driven entirely through each app instance's local-server HTTP API
// (the same surface the MCP tools wrap). This lib lets a deterministic test
// SCRIPT drive a bot identically to how a Claude agent would — no agent, no
// tokens, repeatable timing, and every call timestamped for latency/stall
// metrics. The Electron app still does all the real Meet work (join, captions,
// TTS, screen-share, scraping); we just replace the non-deterministic brain.
//
// Assumes the bot app instances are ALREADY running on their ports (launch them
// with scripts/launch-test-call.command or `pnpm dev -- --profile=… --local-port=…`).
// Launching and driving are deliberately separate concerns.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_VERSIONS = { app: 'test-harness', mcp: '0.1.0' };

// The speech clip the app bundles (same file the troubleshooting "Play Test
// Audio File" button plays): "Hello everyone. I am an AI assistant joining this
// meeting. Can you hear me clearly?" Absolute path so the app can read it over
// the play-audio HTTP path (harness + app share the machine).
export const TEST_SPEECH_PATH = path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'electron-app', 'test-speech.mp3');

// Shared event log across all bots — the timeline the report is built from.
export const events = [];
function log(bot, action, { ms, ok = true, note = '', meta = null } = {}) {
  const e = { t: Date.now(), bot, action, ms, ok, note, meta };
  events.push(e);
  const tag = ok ? '✅' : '❌';
  console.log(`${tag} [${bot}] ${action}${ms != null ? ` ${ms}ms` : ''}${note ? ` — ${note}` : ''}`);
  return e;
}

function syncBody(name, payload = {}) {
  return JSON.stringify({ sender: name, role: 'bot', ownerName: name, versions: MCP_VERSIONS, ...payload });
}

export class Bot {
  constructor(name, port, room) {
    this.name = name;
    this.port = port;
    this.room = room;
    this.base = `http://127.0.0.1:${port}`;
    this.since = null; // advances as we observe speech, for wait_for_speech windows
  }

  async _post(path, body) {
    const started = Date.now();
    const resp = await fetch(`${this.base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const data = await resp.json().catch(() => ({}));
    return { data, ms: Date.now() - started, status: resp.status };
  }

  async _sync(payload) { return this._post(`/api/sync/${this.room}`, syncBody(this.name, payload)); }

  // --- actions (mirror the MCP tools) ---

  async join() {
    // force:true — a test deliberately reuses the same room + bot names, so a
    // prior run can leave this name stuck in room presence (TTL ~10min). Without
    // force, the join is refused as a name-collision and the app never navigates
    // to the meet (stays on Meet home → everything cascade-fails). Forcing past
    // our own stale presence is correct for the harness. (Production has a real,
    // separate bug here: a bot can't reclaim its own name on rejoin/restart.)
    const { data, ms } = await this._sync({ meta: { action: 'join', meetCode: this.room, botName: this.name, force: true } });
    const ok = !!data?.results?.join?.ok || data?.success !== false;
    log(this.name, 'join', { ms, ok, note: ok ? '' : JSON.stringify(data).slice(0, 120) });
    return ok;
  }

  // Wait until the bot is actually in the call and it's live before the
  // conversation starts. A real participant doesn't start talking the instant
  // they click join — admission + call-UI load take ~8s, and speaking before the
  // room is up means the opening line is emitted into a void (and a concurrent
  // listener's first wait_for_speech times out on speech that wasn't heard yet —
  // a false "heard-nothing" stall). So gate on callStatus === 'in-call' — a
  // reliable signal reached ~8s after join — then a short settle for Meet's
  // caption pipeline to come online (captions themselves lag speech by only
  // ~4-5s once live; this is NOT a 30s cold-start — that earlier reading was just
  // both bots sitting idle in warm-up while nobody spoke). Capped so a bot that
  // never reaches in-call still proceeds. Env: VIBECONF_WARMUP_MAX_MS / _SETTLE_MS.
  async warmUp({ maxMs = Number(process.env.VIBECONF_WARMUP_MAX_MS) || 20000,
                settleMs = Number(process.env.VIBECONF_WARMUP_SETTLE_MS) || 5000 } = {}) {
    const t0 = Date.now();
    let inCall = false;
    while (Date.now() - t0 < maxMs) {
      try { inCall = (await this.status()).callStatus === 'in-call'; } catch { /* app not ready yet — retry */ }
      if (inCall) break;
      await sleep(1000);
    }
    await sleep(settleMs); // let the caption pipeline come online after admission
    const waited = Date.now() - t0;
    log(this.name, 'warmUp', { ms: waited, ok: true,
      note: inCall ? `in-call after ${waited - settleMs}ms (+${settleMs}ms settle)` : `not in-call in ${maxMs}ms — proceeding` });
    return { inCall, waitedMs: waited };
  }

  async speak(text, { emoji, voice } = {}) {
    const { data, ms } = await this._sync({ transcript: [{ text, ...(voice ? { voice } : {}), ...(emoji ? { emoji } : {}) }] });
    const reason = data?.results?.transcript?.reason;
    log(this.name, 'speak', { ms, ok: reason !== 'mode-silent', note: reason || `"${text.slice(0, 40)}"` });
    return data;
  }

  async updateWhiteboard(content) {
    const { data, ms } = await this._sync({ whiteboard: { content } });
    log(this.name, 'updateWhiteboard', { ms, ok: data?.success !== false, note: `v${data?.results?.whiteboard?.version ?? '?'}` });
    return data;
  }

  async shareWhiteboard({ sustainMs = 4000 } = {}) {
    const started = Date.now();
    await this._sync({ meta: { action: 'share-whiteboard', shareType: 'whiteboard' } });
    // The POST only ENQUEUES the share; the actual "Present now" click happens
    // async in the app and can fail without the POST erroring. Verify the bot is
    // really sharing before calling it a success — otherwise a silent share
    // failure (guest can't present in Meet; "no video stream" on a Slack huddle)
    // is reported green.
    //
    // Two phases — and the second matters: status.sharing can flip true for a
    // beat and then COLLAPSE (Slack's present flow flickered self-presenting
    // true→false in ~2s with "Video was requested, but no video stream was
    // provided"). A one-shot "saw true once" check passes on that flicker — a
    // false pass. So require sharing to first engage, then STAY up for sustainMs.
    let sharing = false;
    for (let i = 0; i < 20 && !sharing; i++) { // phase 1: wait up to ~6s to engage
      await sleep(300);
      try { sharing = !!(await this.status()).sharing; } catch { /* retry */ }
    }
    let sustained = sharing, droppedAfterMs = null;
    if (sharing) { // phase 2: it must HOLD, not flicker
      const holdUntil = Date.now() + sustainMs;
      while (Date.now() < holdUntil) {
        await sleep(400);
        let still = sharing;
        try { still = !!(await this.status()).sharing; } catch { /* treat as unknown, keep prior */ }
        if (!still) { sustained = false; droppedAfterMs = Date.now() - started; break; }
      }
    }
    const ms = Date.now() - started;
    const ok = sustained;
    log(this.name, 'shareWhiteboard', {
      ms, ok,
      note: !sharing ? 'NOT sharing after 6s — present never engaged (guest can\'t present? no video stream?)'
        : !sustained ? `engaged then COLLAPSED after ~${droppedAfterMs}ms — share did not hold (flicker / no video stream)`
          : `sharing held for ${sustainMs}ms`,
    });
    return { sharing: sustained, engaged: sharing, sustained, droppedAfterMs };
  }

  async stopSharing() {
    const { data, ms } = await this._sync({ meta: { action: 'stop-sharing' } });
    log(this.name, 'stopSharing', { ms, ok: data?.success !== false });
    return data;
  }

  // Play arbitrary audio into the call via the bot's virtual mic — the exact
  // play-audio HTTP path the play_audio MCP tool uses (url / local path / inline
  // base64). The app treats it as speaking so it won't talk over it.
  async playAudio({ url, path: filePath, audioData, emoji } = {}) {
    const { data, ms } = await this._sync({ meta: { action: 'play-audio', url, path: filePath, audioData, emoji } });
    const ok = data?.results?.playAudio?.ok === true || data?.success !== false;
    log(this.name, 'playAudio', { ms, ok, note: url || filePath || '(inline)' });
    return data;
  }

  // Play the bundled speech clip (TEST_SPEECH_PATH). Used to prove that arbitrary
  // played audio reaches the OTHER bots as detectable, transcribable speech.
  async playTestSpeech() { return this.playAudio({ path: TEST_SPEECH_PATH, emoji: '🔊' }); }

  async setBackground(svg) { return this.setPref('avatarBackgroundSvg', svg); }
  async setAvatarEmoji(emoji) {
    const { data, ms } = await this._sync({ meta: { action: 'set-avatar-emoji', idle: emoji } });
    log(this.name, 'setAvatarEmoji', { ms, ok: data?.success !== false, note: emoji });
    return data;
  }

  async setPref(key, value) {
    const { data, ms, status } = await this._post('/api/preferences', JSON.stringify({ key, value }));
    log(this.name, `setPref:${key}`, { ms, ok: status === 200 && data?.success !== false, note: data?.error || '' });
    return data;
  }

  // Long-poll. Returns { spoke, transcript, timedOut, ms }. Also a STALL probe:
  // a timeout while others are clearly talking = the group wait_for_speech bug.
  async waitForSpeech({ wait = 20, silence = 2 } = {}) {
    const sinceParam = this.since ? `&since=${encodeURIComponent(this.since)}` : '';
    const url = `${this.base}/api/sync/${this.room}?wait=${wait}&silence=${silence}&bot=${encodeURIComponent(this.name)}${sinceParam}`;
    const started = Date.now();
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    const ms = Date.now() - started;
    const entries = (data?.transcript?.entries || []).filter((e) => e.participantName !== this.name);
    if (data?.asOf) this.since = data.asOf;
    const timedOut = entries.length === 0;
    // On a timeout, grab captionsOn now so the report can tell a genuinely-quiet
    // room (not a failure) from a DEAF bot (real stall). The window [start,end]
    // lets the report check whether another bot was actually speaking — a timeout
    // that overlaps someone else's speech is the group silence-resolution bug.
    let captionsOn = null;
    if (timedOut) { try { captionsOn = (await this.status()).captionsOn; } catch { /* ignore */ } }
    const chatWake = !!data?.chatWake; // woken by a new chat message (quiet room)
    log(this.name, 'waitForSpeech', {
      ms, ok: true,
      note: chatWake
        ? `chat-wake (${ms}ms)`
        : timedOut
          ? `timeout (${ms}ms)${captionsOn === false ? ' — DEAF (captions off)' : ''}`
          : `heard ${entries.length}: "${(entries[entries.length - 1].text || '').slice(0, 40)}"`,
      meta: timedOut ? { timedOut: true, captionsOn, windowStart: started, windowEnd: started + ms } : { timedOut: false },
    });
    return { spoke: !timedOut, transcript: entries, timedOut, ms, chatWake };
  }

  // GET the call-state snapshot — for stall / deaf assertions between steps.
  async status() {
    const resp = await fetch(`${this.base}/api/sync/${this.room}`);
    const data = await resp.json().catch(() => ({}));
    return {
      callStatus: data?.status?.callStatus,
      captionsOn: data?.status?.captionsOn,
      botState: data?.status?.botState,
      sharing: data?.status?.sharing,
      participants: data?.status?.participants || data?.participants || [],
    };
  }

  // --- screenshot (what the bot sees in the call) ---

  // Capture the bot's call view to a PNG on disk; returns { path, ok }. Building
  // block for share-verification (screenshot → vision-check a nonce is visible).
  async screenshot() {
    const { data, ms } = await this._post('/api/call-screenshot', JSON.stringify({}));
    const ok = !!data?.path && data?.success !== false;
    log(this.name, 'screenshot', { ms, ok, note: ok ? data.path.split('/').pop() : (data?.error || 'no path') });
    return { path: data?.path || null, ok };
  }

  // Detection status (no-room): Meet URLs + any Slack huddle the app found in
  // browser tabs. Used by the detection test.
  async detected() {
    const resp = await fetch(`${this.base}/api/sync/no-room`);
    const data = await resp.json().catch(() => ({}));
    return { meetUrls: data?.detectedMeetUrls || [], slackHuddleUrl: data?.detectedSlackHuddleUrl || null };
  }

  // --- chat (Meet text chat) ---

  async sendChat(text) {
    const { data, ms } = await this._post('/api/chat', JSON.stringify({ action: 'send', text }));
    log(this.name, 'sendChat', { ms, ok: data?.success !== false, note: data?.error || `"${text.slice(0, 40)}"` });
    return data;
  }

  async readChat() {
    const { data, ms } = await this._post('/api/chat', JSON.stringify({ action: 'read' }));
    const msgs = Array.isArray(data?.messages) ? data.messages : [];
    log(this.name, 'readChat', { ms, ok: data?.success !== false, note: data?.error || `${msgs.length} msg(s)` });
    return msgs;
  }

  // Read chat and assert a substring is present — verifies cross-bot delivery
  // (e.g. this bot can SEE what another bot posted). Logs ok=false if absent.
  //
  // Cross-bot messages don't land instantly: the other bot may still be posting,
  // or the chat pane's history hasn't finished hydrating, when we first read.
  // So poll a few times before declaring a miss instead of reading once. Tune
  // via opts.attempts / opts.intervalMs.
  async expectChatContains(needle, { attempts = 5, intervalMs = 1500 } = {}) {
    let lastCount = 0;
    for (let i = 0; i < attempts; i++) {
      const msgs = await this.readChat();
      lastCount = msgs.length;
      const hay = msgs.map((m) => (typeof m === 'string' ? m : `${m.sender || ''} ${m.text || m.message || ''}`)).join('\n');
      if (hay.includes(needle)) {
        log(this.name, 'expectChatContains', { ok: true, note: `found "${needle}"${i ? ` after ${i + 1} reads` : ''}` });
        return true;
      }
      if (i < attempts - 1) await sleep(intervalMs);
    }
    log(this.name, 'expectChatContains', { ok: false, note: `MISSING "${needle}" in ${lastCount} msg(s) after ${attempts} reads` });
    return false;
  }

  async leave() {
    const { data, ms } = await this._sync({ meta: { action: 'leave' } });
    log(this.name, 'leave', { ms, ok: data?.success !== false });
    return data;
  }

  // Reachability check before a run.
  async ping() {
    try {
      const resp = await fetch(`${this.base}/api/sync/no-room`, { signal: AbortSignal.timeout(2500) });
      return resp.ok;
    } catch { return false; }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Record a custom assertion into the shared event log so report()'s fail count
// (and the run's exit code) includes it. ok=false marks a failed step.
export function record(bot, action, ok, note = '') {
  return log(bot, action, { ok, note });
}

// --- report: latency percentiles per action, stalls, cross-bot overlap ---
export function report() {
  const byAction = new Map();
  for (const e of events) {
    if (e.ms == null) continue;
    if (!byAction.has(e.action)) byAction.set(e.action, []);
    byAction.get(e.action).push(e.ms);
  }
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

  console.log('\n' + '─'.repeat(72));
  console.log('LATENCY (ms) by action:');
  for (const [action, arr] of byAction) {
    console.log(`  ${action.padEnd(22)} n=${String(arr.length).padStart(3)}  p50=${pct(arr, 50)}  p95=${pct(arr, 95)}  max=${Math.max(...arr)}`);
  }

  const fails = events.filter((e) => !e.ok);
  const speaks = events.filter((e) => e.action === 'speak').sort((a, b) => a.t - b.t);
  const timeouts = events.filter((e) => e.action === 'waitForSpeech' && e.meta?.timedOut);

  // A timeout is only a REAL STALL if the bot should have heard something:
  //  (a) captions were OFF  → deaf bot, or
  //  (b) ANOTHER bot's speech was actually CAPTIONED inside this wait window →
  //      heard-nothing-despite-speech = the group silence-resolution bug (#248).
  // A timeout in a genuinely quiet room (captions on, nobody else speaking) is
  // expected, not a failure — so it doesn't gate the run.
  //
  // Crucial: a speak event's timestamp (s.t) is the HTTP-ACCEPT time — when TTS was
  // queued — which precedes audible playback + Meet captioning by ~1-3s (synth +
  // playback + caption lag). Gating overlap on s.t therefore false-positives: a wait
  // window that overlaps a speak-accept but CLOSES before that speech is captioned
  // never had a chance to hear it. So gate on caption-ARRIVAL time (s.t + lag), not
  // accept time — only count it if the caption would have landed inside the window.
  const CAPTION_LAG_MS = Number(process.env.VIBECONF_CAPTION_LAG_MS) || 2500;
  const realStalls = timeouts.filter((e) => {
    if (e.meta?.captionsOn === false) return true;
    const { windowStart, windowEnd } = e.meta || {};
    return speaks.some((s) => {
      if (s.bot === e.bot) return false;
      const captionAt = s.t + CAPTION_LAG_MS; // when that speech becomes captioned
      return captionAt >= windowStart && captionAt <= windowEnd;
    });
  });

  // Cross-bot speak overlap: informational only. Incidental coincidence in
  // concurrent scripts isn't lockstep — true lockstep needs a dedicated scenario
  // (two bots told to answer the SAME prompt). So we report it, but it does NOT
  // gate the run.
  let overlaps = 0;
  for (let i = 1; i < speaks.length; i++) {
    if (speaks[i].bot !== speaks[i - 1].bot && speaks[i].t - speaks[i - 1].t < 1200) overlaps++;
  }

  // ANSI so failures are visually unmissable in the terminal (a plain "⚠" was
  // easy to scan past). Bold-red for stalls/fails, kept off when not a TTY.
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const red = (s) => (useColor ? `\x1b[1;31m${s}\x1b[0m` : s);
  console.log('\nSIGNALS:');
  console.log(`  wait_for_speech timeouts: ${timeouts.length} (${realStalls.length} real stall${realStalls.length === 1 ? '' : 's'}, rest were quiet-room)`);
  if (realStalls.length) console.log(red(`    🔴 REAL STALLS: ${realStalls.map((e) => `${e.bot}${e.meta?.captionsOn === false ? '(deaf)' : '(heard-nothing)'}`).join(', ')}`));
  console.log(`  ${fails.length ? red('🔴') : '✅'} failed steps:          ${fails.length ? red(fails.length + ' — ' + fails.map((f) => `${f.bot}/${f.action}`).join(', ')) : 0}`);
  console.log(`  cross-bot speak overlaps (<1.2s): ${overlaps} (informational — not a failure; use a dedicated lockstep scenario to test for real)`);
  console.log('─'.repeat(72));
  // Bottom-line verdict: gates on real stalls + failed steps (matches the exit code).
  const passed = fails.length === 0 && realStalls.length === 0;
  console.log(passed ? '✅ PASS — all steps green' : red(`🔴 FAIL — ${fails.length} failed step(s), ${realStalls.length} real stall(s)`));
  console.log('─'.repeat(72));
  // Gate on real stalls + failures only. Overlaps and quiet-room timeouts don't fail.
  return { stalls: realStalls.length, timeouts: timeouts.length, fails: fails.length, overlaps };
}
