// api/chat-feed.js: turns "there's something unread" plus reads into one `chat`
// event per message. Platforms differ in what a read costs (Meet swaps its side
// panel, pausing speech tracking), so nothing runs until someone listens, and
// unread signals that arrive close together share one read.

const RETRY_MS = 3000;
const MAX_RETRIES = 3;

class ChatFeed {
  /**
   * @param {object} o
   * @param {() => Promise<object[]>} o.read   reads chat; also how every other read should reach ingest()
   * @param {(msg: object) => boolean} o.isOwn  a message from the bot itself
   * @param {(msg: object) => void} o.onMessage
   * @param {number} [o.coalesceMs=500]
   */
  constructor({ read, isOwn, onMessage, coalesceMs = 500 }) {
    this.read = read;
    this.isOwn = isOwn;
    this.onMessage = onMessage;
    this.coalesceMs = coalesceMs;
    this.seen = new Set();
    this.started = false;
    this.stopped = false;
    this.running = null;
    this.pending = false;
    this.retries = 0;
    this.timer = null;
    this.unreadWhileStarting = false;
  }

  /** What's in the chat now is history: mark it seen without firing. */
  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    try {
      for (const m of await this.read()) this.seen.add(m.id);
    } catch (e) {
      console.warn('[calls] reading chat history failed:', e.message);
    }
    this.ready = true;
    if (this.unreadWhileStarting) this.onUnread();
  }

  /** Fire for anything new in `messages`; safe to call with any read's result. */
  ingest(messages) {
    if (!this.ready || this.stopped) return;
    for (const m of messages || []) {
      if (m.id == null || this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      if (!this.isOwn(m)) this.onMessage({ id: m.id, sender: m.sender || '', text: m.text || '' });
    }
  }

  onUnread() {
    if (this.stopped) return;
    if (!this.ready) { this.unreadWhileStarting = true; return; }
    if (this.running) { this.pending = true; return; }
    this.running = this._drain().finally(() => { this.running = null; });
  }

  async _drain() {
    do {
      await new Promise((r) => { this.timer = setTimeout(r, this.coalesceMs); });
      if (this.stopped) return;
      this.pending = false; // this read covers whatever arrived during the wait
      try {
        this.ingest(await this.read());
        this.retries = 0;
      } catch (e) {
        // A failed read has consumed nothing, but the unread flag only fires on
        // a change, so nothing would ever ask again.
        if (this.retries++ < MAX_RETRIES) {
          console.warn('[calls] reading chat failed, will retry:', e.message);
          await new Promise((r) => { this.timer = setTimeout(r, RETRY_MS); });
          this.pending = true;
        } else {
          console.warn('[calls] reading chat failed, waiting for the next message:', e.message);
          this.retries = 0;
        }
      }
    } while (this.pending && !this.stopped);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}

module.exports = { ChatFeed };
