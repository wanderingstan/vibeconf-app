// sync-client.js — Syncs transcripts between the Chrome extension and
// vibeconferencing.com's /api/sync endpoint.
//
// Two-way sync:
//   1. Posts other participants' transcripts to the backend
//   2. Polls for the bot's own transcript entries and speaks them via TTS
//
// The room ID is the Google Meet code (e.g., "abc-defg-hij").

class SyncClient {
  // 5 consecutive failed polls (~5s) before we call the board unreadable.
  static READ_FAILURE_THRESHOLD = 5;

  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://vibeconferencing.com';
    this.botName = config.botName || 'AI Assistant';
    this.roomId = config.roomId || null;
    this.lastPollTime = null; // ISO timestamp for incremental polling
    this.isFirstPoll = true; // skip speaking on first poll (catches up history)
    this.pollInterval = null;
    this.pollIntervalMs = config.pollIntervalMs || 1000;
    this.isPolling = false;
    this.onBotSpeech = config.onBotSpeech || null; // callback(text)
    this.onWhiteboardUpdate = config.onWhiteboardUpdate || null; // callback(whiteboard)
    // The room's presence list, as the sync server sees it. This is the only
    // roster that spans app instances: every bot posts its own presence to the
    // website, but each bot's LOCAL members list is written solely by posts to
    // its own local server, so it never contains a peer. Without this the
    // barge-in check cannot tell a bot interrupter from a human one and yields
    // to other bots as if they were people. callback(members)
    this.onMembers = config.onMembers || null;
    // #221: called when room-state reads start or stop failing.
    // callback({ healthy, status, consecutive })
    this.onReadHealthChange = config.onReadHealthChange || null;
    this.lastWhiteboardVersion = null;
    this.postedTranscripts = new Set(); // dedup by text+timestamp
    this.spokenEntryIds = new Set(); // track entries we've already spoken
    this.getAuthCookie = config.getAuthCookie || null; // async () => "cookie_value" or null
  }

  updateConfig(config) {
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.botName) this.botName = config.botName;
    if (config.roomId && config.roomId !== this.roomId) {
      this.roomId = config.roomId;
      this.lastWhiteboardVersion = null;
    }
    if (config.onBotSpeech) this.onBotSpeech = config.onBotSpeech;
    if (config.onWhiteboardUpdate) this.onWhiteboardUpdate = config.onWhiteboardUpdate;
    if (config.onMembers) this.onMembers = config.onMembers;
    if (config.onReadHealthChange) this.onReadHealthChange = config.onReadHealthChange;
  }

  // Extract Meet code from a Google Meet URL
  static extractMeetCode(url) {
    const match = url.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
    return match ? match[1] : null;
  }

  // Create a room on vibeconferencing.com for this Meet code
  async ensureRoom() {
    if (!this.roomId) {
      console.error('[sync] No room ID set');
      return false;
    }

    try {
      const headers = { 'Content-Type': 'application/json' };
      // In Electron, pass the auth cookie for room creation
      if (this.getAuthCookie) {
        const cookie = await this.getAuthCookie();
        if (cookie) headers['Cookie'] = `vc_session=${cookie}`;
      }
      const resp = await fetch(`${this.baseUrl}/api/rooms/create`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ roomId: this.roomId }),
      });

      if (resp.ok) {
        console.log('[sync] Room created:', this.roomId);
        return true;
      }

      const data = await resp.json().catch(() => ({}));

      // Room already exists — that's fine
      if (resp.status === 409 || data.error?.includes('already exists')) {
        console.log('[sync] Room already exists:', this.roomId);
        return true;
      }

      // Auth required
      if (resp.status === 401) {
        console.warn('[sync] Not authenticated. User needs to log in to', this.baseUrl);
        return false;
      }

      console.error('[sync] Failed to create room:', resp.status, data);
      return false;
    } catch (err) {
      console.error('[sync] Network error creating room:', err.message);
      return false;
    }
  }

  // Post transcripts from other participants to the backend
  async postTranscripts(transcripts) {
    if (!this.roomId || !transcripts.length) return;

    // Filter out transcripts we've already posted and bot's own speech
    const newTranscripts = transcripts.filter(t => {
      const key = `${t.speaker}:${t.text}:${t.timestamp}`;
      if (this.postedTranscripts.has(key)) return false;
      if (t.speaker === this.botName) return false;
      this.postedTranscripts.add(key);
      return true;
    });

    if (newTranscripts.length === 0) return;

    // Group transcripts by speaker and POST each with the speaker as sender
    const bySpeaker = {};
    for (const t of newTranscripts) {
      if (!bySpeaker[t.speaker]) bySpeaker[t.speaker] = [];
      bySpeaker[t.speaker].push({ text: t.text });
    }

    for (const [speaker, entries] of Object.entries(bySpeaker)) {
      try {
        const resp = await fetch(`${this.baseUrl}/api/sync/${this.roomId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sender: speaker,
            role: 'member',
            transcript: entries,
          }),
        });

        if (resp.ok) {
          console.log('[sync] Posted', entries.length, 'transcript(s) from', speaker);
        } else if (resp.status !== 404) {
          console.error('[sync] Failed to post transcripts:', resp.status);
        }
      } catch (err) {
        console.error('[sync] Network error posting transcripts:', err.message);
      }
    }

    // Trim dedup set to prevent memory growth
    if (this.postedTranscripts.size > 500) {
      const arr = Array.from(this.postedTranscripts);
      this.postedTranscripts = new Set(arr.slice(-250));
    }
  }

  // Poll for new transcript entries from the bot (i.e., what the bot should say)
  async poll() {
    if (!this.roomId) return;

    try {
      const sinceParam = this.lastPollTime ? `?since=${this.lastPollTime}` : '';
      const resp = await fetch(`${this.baseUrl}/api/sync/${this.roomId}${sinceParam}`);

      if (!resp.ok) {
        if (resp.status !== 404) {
          console.error('[sync] Poll failed:', resp.status);
          // #221: this poll reads the SAME room state the whiteboard viewer
          // reads. When it fails, nobody in the room can see the board — and on
          // Aug 1 that went on for a whole call while this line logged to a
          // console nobody was watching. Escalate instead.
          this._noteReadFailure(resp.status);
        }
        return;
      }
      this._noteReadSuccess();

      const data = await resp.json();
      this.lastPollTime = data.asOf;

      const whiteboard = data.whiteboard;
      if (whiteboard && typeof whiteboard.version === 'number') {
        const versionChanged = this.lastWhiteboardVersion === null ||
          whiteboard.version > this.lastWhiteboardVersion;
        this.lastWhiteboardVersion = whiteboard.version;
        if (versionChanged && this.onWhiteboardUpdate) {
          this.onWhiteboardUpdate(whiteboard);
        }
      }

      // Presence rides along on the poll we are already making — no new
      // endpoint and no new timer. Dispatched BEFORE the first-poll bail-out
      // below: that early return exists to avoid speaking stale transcript
      // entries, and it must not also cost us the roster.
      if (Array.isArray(data.members) && this.onMembers) {
        this.onMembers(data.members);
      }

      // First poll: just capture the timestamp, don't speak old entries
      if (this.isFirstPoll) {
        this.isFirstPoll = false;
        const count = (data.transcript?.entries || []).length;
        console.log('[sync] First poll: skipping', count, 'existing entries, synced to', data.asOf);
        return;
      }

      const allEntries = data.transcript?.entries || [];
      if (allEntries.length > 0) {
        console.log('[sync] Poll received', allEntries.length, 'transcript(s):',
          allEntries.map(e => `[${e.participantName}] "${e.text?.slice(0, 40)}"`).join(' | '));
      }

      // Look for bot transcript entries we haven't spoken yet.
      // The bot's agent posts entries with participantName === botName.
      // We skip entries we've already spoken (tracked by ID).
      const botEntries = allEntries.filter(entry => {
        if (entry.participantName !== this.botName) return false;
        if (entry.role !== 'bot') return false; // only speak bot-role entries
        if (this.spokenEntryIds.has(entry.id)) return false;
        this.spokenEntryIds.add(entry.id);
        return true;
      });

      if (botEntries.length > 0) {
        console.log('[sync] Found', botEntries.length, 'bot speech entry(ies) to speak');
        if (this.onBotSpeech) {
          for (const entry of botEntries) {
            console.log('[sync] >>> Speaking:', entry.text?.slice(0, 80), entry.voice ? `(voice: ${entry.voice})` : '');
            this.onBotSpeech(entry.text, entry.voice);
          }
        } else {
          console.warn('[sync] onBotSpeech callback not set!');
        }
      }
    } catch (err) {
      console.error('[sync] Poll error:', err.message);
    }
  }

  // Start polling for bot responses
  // Reads are healthy until proven otherwise, and it takes a RUN of failures to
  // count: at a 1s poll a single blip is meaningless, and crying wolf mid-call is
  // its own harm. 5 consecutive ≈ 5s of genuine unavailability.
  //
  // 404 never reaches here — that is "room gone / not signed in", which has its
  // own handling and is not an outage.
  _noteReadFailure(status) {
    this._readFailures = (this._readFailures || 0) + 1;
    if (this._readFailures < SyncClient.READ_FAILURE_THRESHOLD) return;
    if (this.readHealthy === false) return;   // already reported; don't repeat
    this.readHealthy = false;
    if (this.onReadHealthChange) {
      this.onReadHealthChange({ healthy: false, status, consecutive: this._readFailures });
    }
  }

  _noteReadSuccess() {
    this._readFailures = 0;
    if (this.readHealthy === false && this.onReadHealthChange) {
      this.onReadHealthChange({ healthy: true, status: 200, consecutive: 0 });
    }
    this.readHealthy = true;
  }

  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;
    console.log('[sync] Starting poll loop for room:', this.roomId);

    // Do an initial poll
    this.poll();

    this.pollInterval = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  stopPolling() {
    this.isPolling = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('[sync] Stopped polling');
  }
}

if (typeof globalThis !== 'undefined') {
  globalThis.SyncClient = SyncClient;
}
