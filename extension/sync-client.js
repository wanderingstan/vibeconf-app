// sync-client.js — Syncs transcripts between the Chrome extension and
// vibeconferencing.com's /api/sync endpoint.
//
// Two-way sync:
//   1. Posts other participants' transcripts to the backend
//   2. Polls for the bot's own transcript entries and speaks them via TTS
//
// The room ID is the Google Meet code (e.g., "abc-defg-hij").

class SyncClient {
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
    this.postedTranscripts = new Set(); // dedup by text+timestamp
    this.spokenEntryIds = new Set(); // track entries we've already spoken
    this.getAuthCookie = config.getAuthCookie || null; // async () => "cookie_value" or null
  }

  updateConfig(config) {
    if (config.baseUrl) this.baseUrl = config.baseUrl;
    if (config.botName) this.botName = config.botName;
    if (config.roomId) this.roomId = config.roomId;
    if (config.onBotSpeech) this.onBotSpeech = config.onBotSpeech;
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
        }
        return;
      }

      const data = await resp.json();
      this.lastPollTime = data.asOf;

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
