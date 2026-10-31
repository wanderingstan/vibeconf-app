// api/call.js: the public Call, a thin layer over a host's internal call. Its
// names are the semver promise; CALL_EVENTS and the provider methods underneath
// stay free to change.

const fs = require('fs');
const { EventEmitter } = require('events');
const { CALL_EVENTS, providerCapabilities } = require('../core/call-provider');
const { ChatFeed } = require('./chat-feed');
const { CaptionStream, TurnAligner } = require('./captions');
const { UnsupportedError, MutedError } = require('./errors');

// Slack has no unread signal, and reading its chat hides its captions, so
// polling for messages would keep making the bot deaf.
const NO_CHAT_EVENTS = new Set(['slack']);
const POSITIONAL_TURN_IDS = new Set(['slack', 'teams']);

/** The call state a provider's status line means, or null for no change. */
function stateFromStatus(status) {
  const s = String(status || '');
  if (/^Waiting to be admitted/.test(s)) return 'lobby';
  if (/^In call|^Participating/.test(s)) return 'in-call';
  if (/^Call ended/.test(s)) return 'left';
  if (/^Error: removed/.test(s)) return 'removed';
  if (/^Error:/.test(s)) return 'error';
  if (/^(?:Joining|Loading)/.test(s)) return 'joining';
  return null;
}

const normalizeParticipant = (p) => (typeof p === 'string'
  ? { name: p, speaking: false, isSelf: false }
  : { name: p.name, speaking: !!p.speaking, isSelf: !!p.isSelf });

class Call extends EventEmitter {
  /**
   * @param {object} inner   the host's call (on/off, setMicMuted, readChat, …)
   * @param {object} o
   * @param {string} o.platform
   * @param {string} o.name             the bot's display name
   * @param {object} [o.hostCapabilities]  what the host can't do, e.g. { share: false }
   * @param {() => Promise} [o.closeHost]  set when join() created the host
   * @param {string} [o.state]          a state seen before this Call existed
   */
  constructor(inner, { platform, name, hostCapabilities = {}, closeHost = null, state = 'in-call' }) {
    super();
    this._inner = inner;
    this._closeHost = closeHost;
    this._name = name;
    this.platform = platform;
    this.state = state;
    const caps = providerCapabilities(platform);
    const can = (cap) => !!caps[cap] && hostCapabilities[cap] !== false;
    this.capabilities = Object.freeze({
      captions: can('captions'),
      chat: can('chat'),
      chatEvents: can('chat') && !NO_CHAT_EVENTS.has(platform),
      share: can('share'),
      camera: can('video') && hostCapabilities.camera !== false,
    });

    this._mutedByCaller = false;
    this._speech = Promise.resolve();
    this._playing = null;
    this._chatQueue = Promise.resolve();
    this._ownSends = [];
    this._left = false;

    this._captions = new CaptionStream((turn) => this.emit('caption', turn));
    const aligner = POSITIONAL_TURN_IDS.has(platform) ? new TurnAligner() : null;
    this._feed = new ChatFeed({
      read: () => this._readChatQueued(),
      isOwn: (m) => this._isOwnMessage(m),
      onMessage: (m) => this.emit('chat', m),
    });
    // The feed costs reads, so it only runs for someone listening.
    this.on('newListener', (event) => {
      if (event === 'chat' && this.capabilities.chatEvents) this._feed.start();
    });

    this._listeners = [
      [CALL_EVENTS.captionTurns, ({ turns } = {}) => this._captions.update(aligner ? aligner.align(turns) : turns)],
      [CALL_EVENTS.participantsUpdated, (list) => this.emit('participants', (list || []).map(normalizeParticipant))],
      [CALL_EVENTS.speakingChanged, ({ name: who, speaking } = {}) => this.emit('speaking', { name: who, speaking: !!speaking })],
      [CALL_EVENTS.chatUnread, ({ unread } = {}) => { if (unread) this._feed.onUnread(); }],
      [CALL_EVENTS.someonePresenting, ({ presenting, presenterName } = {}) => this.emit('share', { presenter: presenterName || null, active: !!presenting })],
      [CALL_EVENTS.captionStall, () => this.emit('stall', { what: 'captions' })],
      [CALL_EVENTS.ttsEnded, () => this._onPlaybackEnded()],
      [CALL_EVENTS.statusUpdate, (s) => { const st = stateFromStatus(s); if (st) this._setState(st); }],
    ];
    for (const [channel, fn] of this._listeners) inner.on(channel, fn);
    if (inner.mediaPage && inner.mediaPage.on) inner.mediaPage.on('close', () => this._finish());

    this.mic = { setMuted: (muted) => this._setMuted(muted) };
    this.camera = { setOn: (on) => this._setCamera(on) };
    this.chat = { read: () => this._readChat(), send: (text) => this._sendChat(text) };
    this.share = { start: (source) => this._startShare(source), stop: () => this._stopShare() };
  }

  _setState(state) {
    if (state === this.state || this._left) return;
    this.state = state;
    this.emit('state', state);
    if (state === 'left' || state === 'removed') this._finish(state);
  }

  // Speaking ------------------------------------------------------------------

  /**
   * Play a clip through the bot's mic, after any clip already playing. Opens the
   * mic, unless the caller muted it, which rejects with MutedError.
   * @param {string|Buffer} source  a file path or the bytes of an mp3 or wav
   * @returns {Promise<{ done: Promise<{cancelled: boolean}>, cancel: () => Promise<void> }>}
   */
  async speak(source) {
    if (this._mutedByCaller) throw new MutedError();
    if (this._left) throw new Error('This call has ended');
    const audioData = (Buffer.isBuffer(source) ? source : fs.readFileSync(source)).toString('base64');
    const item = { cancelled: false, started: false };
    item.done = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
    item.done.catch(() => {}); // a caller needn't await it
    this._speech = this._speech.then(async () => {
      if (item.cancelled) return;
      if (this._mutedByCaller) { item.reject(new MutedError()); return; }
      if (this._left) { item.reject(new Error('This call has ended')); return; }
      try {
        await this._inner.setMicMuted(false);
        item.started = true;
        this._playing = item;
        await this._inner.speak({ audioData });
        await item.done;
      } catch (e) {
        item.reject(e);
      } finally {
        this._playing = null;
      }
    }).catch(() => {});
    return {
      done: item.done,
      cancel: async () => {
        if (item.cancelled) return;
        item.cancelled = true;
        if (!item.started) { item.resolve({ cancelled: true }); return; }
        await this._inner.stopSpeaking('cancelled');
        // Audio still being decoded has no playback to end, so no tts-ended comes.
        const timer = setTimeout(() => item.resolve({ cancelled: true }), 2000);
        if (timer.unref) timer.unref();
      },
    };
  }

  _onPlaybackEnded() {
    if (this._playing) this._playing.resolve({ cancelled: this._playing.cancelled });
  }

  async _setMuted(muted) {
    this._mutedByCaller = !!muted;
    await this._inner.setMicMuted(!!muted);
  }

  async _setCamera(on) {
    if (!this.capabilities.camera) throw new UnsupportedError(`No camera on ${this.platform} with this host`);
    await this._inner.setCameraOn(!!on);
  }

  // Chat ------------------------------------------------------------------------

  // One chat operation at a time: on Meet each one drives the same side panel.
  _queueChat(fn) {
    const run = this._chatQueue.then(fn);
    this._chatQueue = run.catch(() => {});
    return run;
  }

  _readChatQueued() {
    return this._queueChat(async () => {
      const list = (await this._inner.readChat()) || [];
      return list.map(({ id, sender, text, self }) => ({ id, sender: sender || '', text: text || '', self: !!self }));
    });
  }

  async _readChat() {
    if (!this.capabilities.chat) throw new UnsupportedError(`No chat on ${this.platform}`);
    const messages = await this._readChatQueued();
    // A read clears the platform's unread flag, so its news has to reach `chat`.
    this._feed.ingest(messages);
    return messages.map(({ id, sender, text }) => ({ id, sender, text }));
  }

  async _sendChat(text) {
    if (!this.capabilities.chat) throw new UnsupportedError(`No chat on ${this.platform}`);
    this._ownSends.push(text);
    const ok = await this._queueChat(() => this._inner.sendChat(text));
    if (!ok) {
      this._ownSends.splice(this._ownSends.indexOf(text), 1);
      throw new Error("The platform didn't confirm the chat message");
    }
    // Sending opens the chat, which clears any unread badge before it can be
    // noticed (seen live on Meet), so a message just received has no other signal.
    this._feed.onUnread();
  }

  // Only Zoom marks the bot's own messages, and Meet's sender label for them isn't
  // the bot's name, so what this Call sent is recognized by its text too.
  _isOwnMessage(m) {
    if (m.self || m.sender === this._name || m.sender === 'You') return true;
    const i = this._ownSends.indexOf(m.text);
    if (i === -1) return false;
    this._ownSends.splice(i, 1);
    return true;
  }

  // The rest ----------------------------------------------------------------------

  async participants() {
    return ((await this._inner.getParticipants()) || []).map(normalizeParticipant);
  }

  async _startShare(source) {
    if (!this.capabilities.share) throw new UnsupportedError(`Sharing isn't available on ${this.platform} with this host`);
    return this._inner.startShare(source);
  }

  async _stopShare() {
    if (!this.capabilities.share) throw new UnsupportedError(`Sharing isn't available on ${this.platform} with this host`);
    return this._inner.stopShare();
  }

  screenshot() { return this._inner.screenshot(); }

  /** Leave the call; also closes the browser if join() opened it. */
  async leave() {
    if (this._left) return;
    try { await this._inner.leave(); } catch { /* page already gone */ }
    this._finish();
    if (this._closeHost) {
      const close = this._closeHost;
      this._closeHost = null;
      await close();
    }
  }

  _finish(state = 'left') {
    if (this._left) return;
    this._left = true;
    this._feed.stop();
    this._captions.end();
    for (const [channel, fn] of this._listeners) this._inner.off(channel, fn);
    if (this._playing) this._playing.resolve({ cancelled: true });
    if (this.state !== state) { this.state = state; this.emit('state', state); }
  }
}

module.exports = { Call, stateFromStatus, normalizeParticipant };
