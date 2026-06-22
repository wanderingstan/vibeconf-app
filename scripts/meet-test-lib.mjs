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

const MCP_VERSIONS = { app: 'test-harness', mcp: '0.1.0' };

// Shared event log across all bots — the timeline the report is built from.
export const events = [];
function log(bot, action, { ms, ok = true, note = '' } = {}) {
  const e = { t: Date.now(), bot, action, ms, ok, note };
  events.push(e);
  const tag = ok ? '·' : '✗';
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
    const { data, ms } = await this._sync({ meta: { action: 'join', meetCode: this.room, botName: this.name } });
    const ok = !!data?.results?.join?.ok || data?.success !== false;
    log(this.name, 'join', { ms, ok, note: ok ? '' : JSON.stringify(data).slice(0, 120) });
    return ok;
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

  async shareWhiteboard() {
    const { data, ms } = await this._sync({ meta: { action: 'share-whiteboard', shareType: 'whiteboard' } });
    log(this.name, 'shareWhiteboard', { ms, ok: data?.success !== false });
    return data;
  }

  async stopSharing() {
    const { data, ms } = await this._sync({ meta: { action: 'stop-sharing' } });
    log(this.name, 'stopSharing', { ms, ok: data?.success !== false });
    return data;
  }

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
    log(this.name, 'waitForSpeech', {
      ms, ok: true,
      note: timedOut ? `timeout (${ms}ms)` : `heard ${entries.length}: "${(entries[entries.length - 1].text || '').slice(0, 40)}"`,
    });
    return { spoke: !timedOut, transcript: entries, timedOut, ms };
  }

  // GET the call-state snapshot — for stall / deaf assertions between steps.
  async status() {
    const resp = await fetch(`${this.base}/api/sync/${this.room}`);
    const data = await resp.json().catch(() => ({}));
    return {
      callStatus: data?.status?.callStatus,
      captionsOn: data?.status?.captionsOn,
      botState: data?.status?.botState,
      participants: data?.status?.participants || data?.participants || [],
    };
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

  const stalls = events.filter((e) => e.action === 'waitForSpeech' && /timeout/.test(e.note));
  const fails = events.filter((e) => !e.ok);
  // Cross-bot speak overlap: two bots' speak events within 1.2s = lockstep risk.
  const speaks = events.filter((e) => e.action === 'speak').sort((a, b) => a.t - b.t);
  let overlaps = 0;
  for (let i = 1; i < speaks.length; i++) {
    if (speaks[i].bot !== speaks[i - 1].bot && speaks[i].t - speaks[i - 1].t < 1200) overlaps++;
  }

  console.log('\nSIGNALS:');
  console.log(`  wait_for_speech timeouts: ${stalls.length}`);
  console.log(`  failed steps:             ${fails.length}${fails.length ? ' — ' + fails.map((f) => `${f.bot}/${f.action}`).join(', ') : ''}`);
  console.log(`  cross-bot speak overlaps (<1.2s): ${overlaps}${overlaps ? '  ⚠ possible lockstep' : ''}`);
  console.log('─'.repeat(72));
  return { stalls: stalls.length, fails: fails.length, overlaps };
}
