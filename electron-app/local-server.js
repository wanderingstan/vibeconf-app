// local-server.js — Local HTTP server for agent communication.
// Implements the same API shape as vibeconferencing.com/api/sync/:roomId
// so the MCP server can point to localhost with zero code changes.

const http = require('http');
const { URL } = require('url');

const DEFAULT_PORT = 7865;

class LocalServer {
  constructor({ port, onBotSpeech, onWhiteboardUpdate, onLeaveCall, onShareWhiteboard, onStopSharing } = {}) {
    this.port = port || DEFAULT_PORT;
    this.onBotSpeech = onBotSpeech || (() => {});
    this.onWhiteboardUpdate = onWhiteboardUpdate || (() => {});
    this.onLeaveCall = onLeaveCall || (() => {});
    this.onShareWhiteboard = onShareWhiteboard || (() => {});
    this.onStopSharing = onStopSharing || (() => {});

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

    // Long-poll waiters
    this.waiters = [];           // { resolve, since, bot, silence, timer }

    this.server = null;
  }

  // -------------------------------------------------------------------------
  // Room management
  // -------------------------------------------------------------------------

  setRoom(roomId) {
    this.roomId = roomId;
    this.transcripts = [];
    this.whiteboard = { content: '', version: 0, lastModified: null, lastEditor: null };
    this.members = [];
    this.callStatus = 'joining';
    this.sharing = false;
    this.errors = [];
    this.resolveAllWaiters();
  }

  clearRoom() {
    this.roomId = null;
    this.transcripts = [];
    this.members = [];
    this.callStatus = 'idle';
    this.sharing = false;
    this.resolveAllWaiters();
  }

  setCallStatus(status) {
    this.callStatus = status;
    console.log('[local-server] Call status:', status);
  }

  setSharing(sharing) {
    this.sharing = sharing;
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

      // Check silence: time since last entry must exceed silence threshold
      const lastEntry = entries[entries.length - 1];
      const lastTime = new Date(lastEntry.timestamp).getTime();
      const silenceMs = waiter.silence * 1000;
      const elapsed = Date.now() - lastTime;

      if (elapsed >= silenceMs) {
        // Silence threshold already met — resolve immediately
        this._resolveWaiter(waiter);
      } else {
        // Clear any existing timer and set a new one based on latest speech
        if (waiter.silenceTimer) clearTimeout(waiter.silenceTimer);
        const remaining = silenceMs - elapsed;
        waiter.silenceTimer = setTimeout(() => {
          waiter.silenceTimer = null;
          // Re-check: more speech may have arrived during the wait
          this._checkWaiters();
        }, remaining + 50);
      }
    }
  }

  _resolveWaiter(waiter) {
    if (waiter.resolved) return;
    waiter.resolved = true;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.silenceTimer);
    waiter.resolve(this._buildResponse(waiter.since, waiter.bot, waiter.startTime));
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
      status: {
        callStatus: this.callStatus,
        sharing: this.sharing,
        errors: this.errors,
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

        // Trigger TTS for bot speech
        if (data.role === 'bot') {
          this.onBotSpeech(t.text, t.voice);
        }
      }
      results.transcript = { ok: true, sent: entries.length, entries };
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

    // Handle leave command
    if (data.meta?.action === 'leave') {
      this.onLeaveCall();
      results.leave = { ok: true };
    }

    // Handle share/stop whiteboard commands
    if (data.meta?.action === 'share-whiteboard') {
      this.onShareWhiteboard();
      results.shareWhiteboard = { ok: true };
    }
    if (data.meta?.action === 'stop-sharing') {
      this.onStopSharing();
      results.stopSharing = { ok: true };
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
