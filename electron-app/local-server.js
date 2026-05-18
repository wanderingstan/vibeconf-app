// local-server.js — Local HTTP server for agent communication.
// Owns all room/transcript/whiteboard/call state for the Electron app flow;
// the MCP server talks to 127.0.0.1:7865 and never hits the public website.

const http = require('http');
const { URL } = require('url');
const prefsSchema = require('./preferences-schema.js');

const DEFAULT_PORT = 7865;

class LocalServer {
  constructor({ port, onBotSpeech, onWhiteboardUpdate, onLeaveCall, onShareWhiteboard, onStopSharing, onLoadUrl, onJoinCall, onBotStateChange, onModeChange, onCallStatusChange, onAnyoneSpeakingChange, onParticipantsFirstSeen, onAvatarEmojiOverride, getPref, setPref, applyPref } = {}) {
    this.port = port || DEFAULT_PORT;
    this.onBotSpeech = onBotSpeech || (() => {});
    this.onWhiteboardUpdate = onWhiteboardUpdate || (() => {});
    this.onLeaveCall = onLeaveCall || (() => {});
    this.onShareWhiteboard = onShareWhiteboard || (() => {});
    this.onStopSharing = onStopSharing || (() => {});
    this.onJoinCall = onJoinCall || (() => {});
    this.onLoadUrl = onLoadUrl || (() => {});
    this.onBotStateChange = onBotStateChange || (() => {}); // 'idle' | 'listening' | 'thinking' | 'speaking'
    this.onModeChange = onModeChange || (() => {});        // 'active' | 'passive' | 'silent'
    this.onCallStatusChange = onCallStatusChange || (() => {}); // 'idle' | 'joining' | 'waiting-to-be-admitted' | 'in-call' | 'left'
    this.onAnyoneSpeakingChange = onAnyoneSpeakingChange || (() => {}); // boolean
    this.onParticipantsFirstSeen = onParticipantsFirstSeen || (() => {}); // fires once per call when DOMSpeakerTracker first reports participants
    this.onAvatarEmojiOverride = onAvatarEmojiOverride || (() => {}); // ({idle?, listening?}) — null/undefined for that key means reset

    // Pending bot speech — queued when speak() is called before the bot is
    // actually admitted to the call. Flushed in setCallStatus when status
    // becomes 'in-call'. Without this, audio plays through the virtual mic
    // before Meet has connected our stream and goes into the void.
    this.pendingBotSpeech = []; // [{ text, voice }]

    // Preference plumbing (whitelist defined in preferences-schema.js).
    // getPref reads from the persistent store; setPref writes; applyPref runs
    // any side-effect needed to make the change live (e.g. reload TTS config).
    this.getPref = getPref || (() => undefined);
    this.setPref = setPref || (() => {});
    this.applyPref = applyPref || (() => {});
    this.botState = 'idle';

    // Mode is persistent user-controlled behavior; distinct from transient botState.
    //   active  — responds freely (ack on every pause, speaks its thoughts)
    //   passive — silent until its name is mentioned
    //   silent  — listens for its name but never speaks; can still act (whiteboard, tools)
    this.mode = 'active';

    // Room state (single room — the active call)
    this.roomId = null;
    this.transcripts = [];       // { id, participantName, role, text, isFinal, timestamp, voice? }
    this.whiteboard = { content: '', version: 0, lastModified: null, lastEditor: null };
    this.members = [];
    this.maxTranscripts = 500;

    // Call status tracking
    this.callStatus = 'idle';    // idle, joining, waiting-to-be-admitted, in-call, left
    this.sharing = false;
    this.errors = [];            // recent errors (max 10)

    // State exposed to agents
    this.detectedMeetUrls = [];  // Meet URLs found in browser tabs (when not in a call)
    this.participants = [];      // [{ name, speaking }] from DOM speaker tracker
    this.someoneElsePresenting = false;  // another participant is screen sharing
    this.presenterName = null;   // name of the person presenting (if any)

    // Real-time speaking state (from DOMSpeakerTracker, not captions)
    this.anyoneSpeaking = false;       // true if any participant is currently speaking
    this.lastSpeechStoppedAt = null;   // timestamp (ms) when last person stopped speaking

    // Long-poll waiters
    this.waiters = [];           // { resolve, since, bot, silence, timer }

    // macOS permission status, updated by main.js. Possible values match
    // systemPreferences.getMediaAccessStatus: 'not-determined', 'granted',
    // 'denied', 'restricted', 'unknown'. 'unknown' is also used on non-darwin.
    this.permissions = {
      screenRecording: 'unknown',
    };

    this.server = null;
  }

  setPermission(name, status) {
    if (this.permissions[name] === status) return;
    this.permissions[name] = status;
    console.log('[local-server] Permission', name + ':', status);
  }

  // -------------------------------------------------------------------------
  // Room management
  // -------------------------------------------------------------------------

  setRoom(roomId) {
    this.roomId = roomId;
    this.transcripts = [];
    this.whiteboard = { content: '', version: 0, lastModified: null, lastEditor: null };
    this.members = [];
    this.sharing = false;
    this.errors = [];
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.lastSpeechStoppedAt = null;
    this.resolveAllWaiters();
    // Use the setter so onCallStatusChange fires — the avatar uses this to
    // switch to 🫥 while joining.
    this.setCallStatus('joining');
  }

  clearRoom() {
    this.roomId = null;
    this.transcripts = [];
    this.members = [];
    this.sharing = false;
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.lastSpeechStoppedAt = null;
    this.resolveAllWaiters();
    this.setCallStatus('idle');
  }

  setCallStatus(status) {
    if (this.callStatus === status) return;
    this.callStatus = status;
    console.log('[local-server] Call status:', status);
    this.onCallStatusChange(status);

    // Drop pending speech if we never made it in (call failed / cleared).
    // Pending flush itself is gated on first-participants-seen, not in-call —
    // 'in-call' fires when Meet's UI is up, but the bot's mic track isn't
    // reliably connected to other participants until the people pane is
    // populated (a stronger 'fully wired up' signal). See _flushPendingBotSpeech.
    if (status === 'idle' || status === 'left') {
      if (this.pendingBotSpeech.length > 0) {
        console.log('[local-server] Dropping', this.pendingBotSpeech.length, 'unflushed bot speech entries (call ended)');
        this.pendingBotSpeech = [];
      }
    }
  }

  _flushPendingBotSpeech() {
    if (this.pendingBotSpeech.length === 0) return;
    console.log('[local-server] Flushing', this.pendingBotSpeech.length,
      'queued bot speech entries (now playing)');
    const queue = this.pendingBotSpeech;
    this.pendingBotSpeech = [];
    for (const { text, voice, emoji } of queue) {
      console.log('[local-server] Playing queued speech:', text.slice(0, 60));
      this._setBotState('speaking', { emoji });
      this.onBotSpeech(text, voice, emoji);
    }
  }

  setMode(mode) {
    const allowed = ['active', 'passive', 'silent'];
    if (!allowed.includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Must be one of ${allowed.join(', ')}`);
    }
    if (this.mode === mode) return;
    this.mode = mode;
    console.log('[local-server] Mode:', mode);
    this.onModeChange(mode);
    // Re-evaluate any pending waiters under the new mode
    this._checkWaiters();
  }

  setSharing(sharing) {
    this.sharing = sharing;
  }

  setDetectedMeetUrls(urls) {
    this.detectedMeetUrls = urls || [];
  }

  setParticipants(participants) {
    const wasEmpty = this.participants.length === 0;
    this.participants = participants || [];

    // First time we see non-empty participants — DOMSpeakerTracker is up and
    // reading the people pane successfully. Fires once per call. Used for
    // avatar engagement (flips hasEngaged via the set-engaged IPC).
    //
    // NOT used to flush deferred bot speech — that's gated on the captions-
    // ready signal, which fires later and is a stronger 'fully wired up'
    // marker. Flushing here meant the welcome played 5s before the user
    // could actually see/hear what the bot heard.
    if (wasEmpty && this.participants.length > 0) {
      this.onParticipantsFirstSeen();
    }

    // Update real-time speaking state from DOM speaker tracker. Exclude the
    // bot itself ('You' in Meet's people pane) — when the bot speaks via TTS,
    // Meet flags 'You' as speaking, which would otherwise trigger the 😐
    // hearing emoji and make the avatar look like it's reacting to itself.
    const wasSpeaking = this.anyoneSpeaking;
    this.anyoneSpeaking = this.participants.some(p => p.speaking && p.name !== 'You');

    if (wasSpeaking && !this.anyoneSpeaking) {
      // Speech just stopped — record when and check waiters
      this.lastSpeechStoppedAt = Date.now();
      this._checkWaiters();
      this.onAnyoneSpeakingChange(false);
    } else if (!wasSpeaking && this.anyoneSpeaking) {
      // Speech just started — cancel any pending silence timers
      for (const waiter of this.waiters) {
        if (waiter.silenceTimer) {
          clearTimeout(waiter.silenceTimer);
          waiter.silenceTimer = null;
        }
      }
      this.onAnyoneSpeakingChange(true);
    }
  }

  setSomeoneElsePresenting(presenting, presenterName) {
    this.someoneElsePresenting = !!presenting;
    this.presenterName = presenterName || null;
  }

  addError(message) {
    this.errors.push({ message, timestamp: new Date().toISOString() });
    if (this.errors.length > 10) this.errors.shift();
  }

  // -------------------------------------------------------------------------
  // Transcript management (called by Electron app when captions arrive)
  // -------------------------------------------------------------------------

  addTranscript(speaker, text, role = 'member', voice = undefined) {
    if (!this.roomId) return;

    const now = new Date().toISOString();
    const id = `${this.roomId}-tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      id,
      roomId: this.roomId,
      participantName: speaker,
      role,
      text,
      isFinal: true,
      timestamp: now,
    };
    if (voice) entry.voice = voice;

    this.transcripts.push(entry);

    // Trim to max
    if (this.transcripts.length > this.maxTranscripts) {
      this.transcripts = this.transcripts.slice(-this.maxTranscripts);
    }

    // Check long-poll waiters
    this._checkWaiters();
  }

  // -------------------------------------------------------------------------
  // Long-poll support
  // -------------------------------------------------------------------------

  _checkWaiters() {
    for (const waiter of this.waiters) {
      // Get entries since the waiter's timestamp, excluding bot if specified
      const entries = this._entriesSince(waiter.since, waiter.bot);
      if (entries.length === 0) continue;

      // If the bot's name was mentioned, resolve immediately — someone is talking to/about the bot
      if (waiter.bot) {
        const botNameLower = waiter.bot.toLowerCase();
        const mentioned = entries.some(e => e.text.toLowerCase().includes(botNameLower));
        if (mentioned) {
          this._resolveWaiter(waiter);
          continue;
        }
      }

      // In passive/silent modes, only resolve on name-mention (handled above).
      // Skip silence-based resolution so the bot doesn't chime in unprompted.
      if (this.mode === 'passive' || this.mode === 'silent') {
        if (waiter.silenceTimer) {
          clearTimeout(waiter.silenceTimer);
          waiter.silenceTimer = null;
        }
        continue;
      }

      // Use real-time speaking state from DOMSpeakerTracker (not caption timestamps)
      // If someone is actively speaking, don't resolve — cancel any silence timer
      if (this.anyoneSpeaking) {
        if (waiter.silenceTimer) {
          clearTimeout(waiter.silenceTimer);
          waiter.silenceTimer = null;
        }
        continue;
      }

      // Nobody is speaking — check if silence threshold has been met
      const silenceMs = waiter.silence * 1000;
      const silenceStart = this.lastSpeechStoppedAt || Date.now();
      const elapsed = Date.now() - silenceStart;

      if (elapsed >= silenceMs) {
        // Silence threshold already met — resolve immediately
        this._resolveWaiter(waiter);
      } else if (!waiter.silenceTimer) {
        // Start a silence timer for the remaining time
        const remaining = silenceMs - elapsed;
        waiter.silenceTimer = setTimeout(() => {
          waiter.silenceTimer = null;
          // Re-check: someone may have started speaking during the wait
          this._checkWaiters();
        }, remaining + 50);
      }
    }
  }

  _setBotState(state, extra, { force } = {}) {
    if (this.botState === state) return;
    // Don't downgrade thinking/speaking to listening just because a new
    // wait_for_speech showed up — the avatar should stay 🤔/😄 until that
    // turn naturally completes (tts-ended fires with force=true, or a fresh
    // 'thinking' from new user speech replaces it). Without this guard the
    // ack visibly flickered to 🙂 mid-acknowledgment whenever the agent
    // called wait_for_speech twice in a row.
    if (!force && (this.botState === 'speaking' || this.botState === 'thinking') && state === 'listening') return;
    this.botState = state;
    this.onBotStateChange(state, extra);
  }

  _resolveWaiter(waiter) {
    if (waiter.resolved) return;
    waiter.resolved = true;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.silenceTimer);
    const response = this._buildResponse(waiter.since, waiter.bot, waiter.startTime);

    // If there are actual transcript entries, the agent will now process them → thinking state.
    // Captions arrive as multiple progressively-growing entries for one utterance
    // (e.g. "Hi" → "Hi Jimmy" → "Hi Jimmy. How's it going?"), so naively joining
    // them inflates wordCount. Dedupe by keeping the longest text per consecutive
    // run of the same speaker — same logic the MCP server applies for the agent.
    // Note: we may already be in 'thinking' state from a previous turn that the
    // agent didn't speak to (it called wait_for_speech twice). Force the state
    // change so the ack handler still runs with the new wordCount.
    const entries = this._entriesSince(waiter.since, waiter.bot);
    if (entries.length > 0) {
      const deduped = [];
      for (const entry of entries) {
        const last = deduped[deduped.length - 1];
        if (last && last.participantName === entry.participantName) {
          if (entry.text.length >= last.text.length) {
            deduped[deduped.length - 1] = entry;
          }
        } else {
          deduped.push(entry);
        }
      }
      const wordCount = deduped
        .map(e => e.text.trim())
        .filter(Boolean)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean)
        .length;
      // Always fire the change callback with the new wordCount — even if state
      // is already 'thinking' from a previous turn — so the ack handler runs.
      // Without this, agent loops that call wait_for_speech twice in a row
      // skip the ack on the second resolution because the equal-state guard
      // in _setBotState short-circuits.
      this.botState = 'thinking';
      this.onBotStateChange('thinking', { wordCount });
    }

    waiter.resolve(response);
    this.waiters = this.waiters.filter(w => w !== waiter);
  }

  resolveAllWaiters() {
    for (const waiter of [...this.waiters]) {
      this._resolveWaiter(waiter);
    }
  }

  _entriesSince(since, botName) {
    let entries = this.transcripts;
    if (since) {
      const sinceTime = new Date(since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() > sinceTime);
    }
    if (botName) {
      entries = entries.filter(e => e.participantName !== botName);
    }
    return entries;
  }

  _buildResponse(since, botName, startTime) {
    const entries = this._entriesSince(since, botName);
    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

    return {
      success: true,
      roomId: this.roomId,
      asOf: new Date().toISOString(),
      waited: !!startTime,
      elapsed,
      transcript: {
        entries,
        count: entries.length,
      },
      whiteboard: {
        content: this.whiteboard.content,
        version: this.whiteboard.version,
        lastModified: this.whiteboard.lastModified,
        lastEditor: this.whiteboard.lastEditor,
        changed: false,
      },
      chat: { messages: [], count: 0 },
      members: this.members,
      participants: this.participants,
      detectedMeetUrls: this.detectedMeetUrls,
      status: {
        callStatus: this.callStatus,
        sharing: this.sharing,
        someoneElsePresenting: this.someoneElsePresenting,
        presenterName: this.presenterName,
        mode: this.mode,
        errors: this.errors,
        permissions: this.permissions,
      },
    };
  }

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch(err => {
          console.error('[local-server] Request error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[local-server] Listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Try next port
          this.port++;
          this.server.listen(this.port, '127.0.0.1');
        } else {
          reject(err);
        }
      });
    });
  }

  stop() {
    this.resolveAllWaiters();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async _handleRequest(req, res) {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathMatch = url.pathname.match(/^\/api\/sync\/([a-z]+-[a-z]+-[a-z]+)$/);

    // Room creation endpoint (for compatibility with sync-client.js)
    if (url.pathname === '/api/rooms/create' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Status endpoint — returns detected URLs and call state without a room ID
    if (url.pathname === '/api/sync/no-room' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        roomId: this.roomId,
        detectedMeetUrls: this.detectedMeetUrls,
        status: { callStatus: this.callStatus, mode: this.mode },
      }));
      return;
    }

    // Preferences endpoint — agent-visible whitelist with current values.
    // Excludes anything not in preferences-schema.js (API keys, auth, etc.).
    if (url.pathname === '/api/preferences' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        preferences: prefsSchema.describe(this.getPref),
      }));
      return;
    }

    if (url.pathname === '/api/preferences' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      const { key, value } = parsed || {};
      const result = prefsSchema.validate(key, value);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.error, key }));
        return;
      }
      try {
        this.setPref(key, result.value);
        this.applyPref(key, result.value);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, key }));
        return;
      }
      const spec = prefsSchema.PREFERENCES[key];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        key,
        value: result.value,
        requiresRestart: !!spec?.requiresRestart,
      }));
      return;
    }

    if (!pathMatch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    const roomId = pathMatch[1];

    // Accept requests for any room ID — set it as active if we don't have one
    if (!this.roomId) {
      this.roomId = roomId;
    }

    if (req.method === 'GET') {
      await this._handleGet(req, res, url, roomId);
    } else if (req.method === 'POST') {
      await this._handlePost(req, res, roomId);
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    }
  }

  async _handleGet(req, res, url, roomId) {
    const since = url.searchParams.get('since');
    const wait = parseInt(url.searchParams.get('wait') || '0', 10);
    const silence = parseInt(url.searchParams.get('silence') || '2', 10);
    const bot = url.searchParams.get('bot');

    // Non-blocking: return immediately
    if (!wait) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._buildResponse(since, bot)));
      return;
    }

    // Long-poll: wait for speech + silence
    const clampedWait = Math.min(55, Math.max(1, wait));
    const clampedSilence = Math.max(1, silence);

    // Check if there are already entries that satisfy the silence condition
    const existing = this._entriesSince(since, bot);
    if (existing.length > 0) {
      const lastEntry = existing[existing.length - 1];
      const lastTime = new Date(lastEntry.timestamp).getTime();
      if (Date.now() - lastTime >= clampedSilence * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this._buildResponse(since, bot, Date.now())));
        return;
      }
    }

    const startTime = Date.now();

    // Single-agent enforcement: if another agent is already long-polling, kick
    // them out. Two agents on one room means double speak() calls per utterance
    // and inflated wordCounts from overlapping `since` windows. The displaced
    // agent's wait_for_speech returns with { displaced: true } so its skill
    // can exit the conversation loop instead of fighting for the room.
    if (this.waiters.length > 0) {
      console.log('[local-server] New wait_for_speech displacing', this.waiters.length, 'existing waiter(s)');
      for (const old of [...this.waiters]) {
        if (old.resolved) continue;
        old.resolved = true;
        clearTimeout(old.timer);
        clearTimeout(old.silenceTimer);
        old.resolve({ success: true, displaced: true, asOf: new Date().toISOString(), transcript: { entries: [] } });
      }
      this.waiters = [];
    }

    const responsePromise = new Promise((resolve) => {
      const waiter = {
        resolve,
        since,
        bot,
        silence: clampedSilence,
        startTime,
        resolved: false,
        silenceTimer: null,
        timer: setTimeout(() => {
          this._resolveWaiter(waiter);
        }, clampedWait * 1000),
      };
      this.waiters.push(waiter);
      this._setBotState('listening');

      // If entries already exist but silence hasn't elapsed, start checking
      if (existing.length > 0) {
        this._checkWaiters();
      }
    });

    const result = await responsePromise;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async _handlePost(req, res, roomId) {
    const body = await this._readBody(req);
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      return;
    }

    if (!data.sender) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'sender is required' }));
      return;
    }

    const results = {};
    const now = new Date().toISOString();

    // Handle transcript entries (bot speech)
    if (data.transcript && Array.isArray(data.transcript)) {
      // In silent mode, suppress bot speech entirely — don't record or speak.
      // Agent learns its speech was suppressed via results.transcript.reason.
      if (data.role === 'bot' && this.mode === 'silent') {
        results.transcript = { ok: false, reason: 'mode-silent', sent: 0, entries: [] };
      } else {
        const entries = [];
        for (const t of data.transcript) {
          if (!t.text) continue;
          const id = `${roomId}-tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const entry = {
            id,
            roomId,
            participantName: data.sender,
            role: data.role || 'member',
            text: t.text,
            isFinal: true,
            timestamp: now,
          };
          if (t.voice) entry.voice = t.voice;
          this.transcripts.push(entry);
          entries.push(entry);

          // Trigger TTS for bot speech — but defer if we're not in the call
          // yet. The virtual mic stream isn't connected to Meet's other
          // participants until callStatus is 'in-call'; speaking earlier means
          // audio plays into the void. The transcript entry is recorded
          // immediately either way so order is preserved on flush.
          if (data.role === 'bot') {
            if (this.callStatus !== 'in-call') {
              console.log('[local-server] Queueing bot speech until in-call:', t.text.slice(0, 40));
              this.pendingBotSpeech.push({ text: t.text, voice: t.voice, emoji: t.emoji });
            } else {
              this._setBotState('speaking', { emoji: t.emoji });
              this.onBotSpeech(t.text, t.voice, t.emoji);
            }
          }
        }
        results.transcript = { ok: true, sent: entries.length, entries };
      }
    }

    // Handle whiteboard update
    if (data.whiteboard && typeof data.whiteboard.content === 'string') {
      this.whiteboard.content = data.whiteboard.content;
      this.whiteboard.version++;
      this.whiteboard.lastModified = now;
      this.whiteboard.lastEditor = data.sender;
      results.whiteboard = {
        ok: true,
        version: this.whiteboard.version,
        lastModified: now,
        lastEditor: data.sender,
      };
      this.onWhiteboardUpdate(data.whiteboard.content, data.sender);
    }

    // Handle join command — tell the app to join a Meet call
    if (data.meta?.action === 'join') {
      const meetCode = data.meta.meetCode || roomId;
      const botName = data.meta.botName;
      this.onJoinCall(meetCode, botName);
      results.join = { ok: true };
    }

    // Handle leave command
    if (data.meta?.action === 'leave') {
      this.onLeaveCall();
      results.leave = { ok: true };
    }

    // Handle share/stop whiteboard commands
    if (data.meta?.action === 'share-whiteboard') {
      this.onShareWhiteboard(data.meta.shareType || 'whiteboard');
      results.shareWhiteboard = { ok: true };
    }
    if (data.meta?.action === 'stop-sharing') {
      this.onStopSharing();
      results.stopSharing = { ok: true };
    }

    // Handle load-url command (load arbitrary URL in whiteboard window)
    if (data.meta?.action === 'load-url' && data.meta.url) {
      this.onLoadUrl(data.meta.url);
      results.loadUrl = { ok: true };
    }

    // Handle set-mode command — persistent bot behavior mode
    if (data.meta?.action === 'set-mode' && data.meta.mode) {
      try {
        this.setMode(data.meta.mode);
        results.setMode = { ok: true, mode: this.mode };
      } catch (err) {
        results.setMode = { ok: false, error: err.message };
      }
    }

    // Handle set-avatar-emoji command — agent overrides resting avatar
    // emojis to match conversation tone. Either field is optional;
    // empty-string clears the override (back to default).
    if (data.meta?.action === 'set-avatar-emoji') {
      const overrides = {};
      if (data.meta.idle !== undefined) overrides.idle = data.meta.idle || null;
      if (data.meta.listening !== undefined) overrides.listening = data.meta.listening || null;
      this.onAvatarEmojiOverride(overrides);
      results.setAvatarEmoji = { ok: true };
    }

    // Update presence
    this._upsertMember(data.sender, data.role || 'member', data.ownerName, data.displayName);

    // Trim transcripts
    if (this.transcripts.length > this.maxTranscripts) {
      this.transcripts = this.transcripts.slice(-this.maxTranscripts);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      roomId,
      asOf: now,
      results,
    }));
  }

  _upsertMember(name, role, ownerName, displayName) {
    const existing = this.members.find(m => m.name === name);
    if (existing) {
      existing.lastSeen = Date.now();
      if (role) existing.role = role;
    } else {
      this.members.push({
        name,
        displayName: displayName || name,
        role: role || 'member',
        lastSeen: Date.now(),
        ownerName: ownerName || undefined,
      });
    }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}

// Export for use in main.js (loaded via vm.runInThisContext)
globalThis.LocalServer = LocalServer;
