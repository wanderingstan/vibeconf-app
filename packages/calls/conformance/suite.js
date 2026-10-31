// conformance/suite.js: the same end-to-end checks for every provider on
// every host (Phase 4 of the calls library).
//
// Two bots join one call. Then, for each capability the platform has:
//   join      both bots are in the call
//   roster    each bot's participant list shows the other
//   hear      a clip one bot plays reaches the other as captions, both ways
//   chatEvent each bot gets the other's message once as a `chat` event, and not its own
//   chat      each bot reads the message the other posted
//   share     one bot shares, the platform reports it, and it stops cleanly
//   leave     both bots leave
// A capability the platform lacks (providerCapabilities) or the host can't do
// yet (bot.hostCapabilities) is SKIPPED, not failed, and says why.
//
// The suite never touches a browser itself. It drives two ConformanceBots, so
// the Electron host (the app, over its HTTP API) and the Playwright host are
// checked by the same code. A ConformanceBot is:
//
//   name                      the name it joins as
//   hostCapabilities          optional { share: false, … } for host gaps
//   join(url)                 → resolves once in the call (throws if not)
//   participants()            → [name, …] as the bot sees the roster
//   startListening()          heard() reports only what comes after this
//   heard(test, timeoutMs)    → the text heard once test(text) passes, or null
//   playClip(file)            play an audio file into the call
//   sendChat(text)
//   chatContains(needle, timeoutMs) → boolean
//   chatEvents                optional: true if the bot has the `chat` event, with
//     startChatEvents() and chatEventsMatching(needle) → [{ text, at }]
//   chatResent                optional: true once a send was retried, so it may have posted twice
//   share()                   → boolean, the platform reports the bot sharing
//   stopShare()               → boolean, sharing cleared
//   leave()                   → boolean, out of the call
//   snapshot()                optional: a screenshot path, for a failed join

const path = require('path');
const { providerCapabilities } = require('../core/call-provider');
const { platformFromUrl } = require('../core/call-target');

// The clip and what it says: "Hello, everyone! I am an AI assistant joining
// this meeting." Hearing passes on any two of these words, which survives a
// caption engine's usual slips without passing on unrelated speech.
const CLIP_PATH = path.join(__dirname, 'hello-clip.mp3');
const CLIP_WORDS = ['hello', 'everyone', 'assistant', 'joining', 'meeting'];
const heardClip = (text) => CLIP_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(text)).length >= 2;

/**
 * @param {object} o
 * @param {string} o.url            the call both bots join
 * @param {object[]} o.bots         two ConformanceBots
 * @param {(r: {step, bot, status, note}) => void} [o.onResult]
 * @param {number} [o.hearTimeoutMs=45000]
 * @returns {Promise<{ results, failed: number }>}
 */
async function runConformance({ url, bots, onResult = () => {}, hearTimeoutMs = 45000 }) {
  const target = platformFromUrl(url);
  if (!target.ok) throw new Error(target.error);
  const caps = providerCapabilities(target.provider);
  const [a, b] = bots;
  const results = [];
  const record = (step, bot, status, note = '') => {
    const r = { step, bot: bot ? bot.name : '-', status, note };
    results.push(r);
    onResult(r);
    return status === 'pass';
  };
  const hostLacks = (cap) => bots.find((bot) => bot.hostCapabilities && bot.hostCapabilities[cap] === false);
  // true when the step should run; otherwise records why it's skipped.
  const can = (step, cap) => {
    if (!caps[cap]) { record(step, null, 'skip', `${target.provider} has no ${cap}`); return false; }
    const h = hostLacks(cap);
    if (h) { record(step, h, 'skip', `${cap} not supported on this host yet`); return false; }
    return true;
  };
  const step = async (name, bot, fn) => {
    try {
      const out = await fn();
      return record(name, bot, out.ok ? 'pass' : 'fail', out.note || '');
    } catch (err) {
      return record(name, bot, 'fail', err.message);
    }
  };

  // join: one at a time; two bots hitting a lobby at the same instant is not
  // what this tests, and Zoom's guest captcha is rate-sensitive.
  for (const bot of bots) {
    const ok = await step('join', bot, async () => { await bot.join(url); return { ok: true }; });
    if (!ok) {
      if (bot.snapshot) { try { record('join', bot, 'info', 'screenshot: ' + await bot.snapshot()); } catch { /* best effort */ } }
      return finish();
    }
  }

  try {
    // roster
    for (const [me, other] of [[a, b], [b, a]]) {
      await step('roster', me, async () => {
        const deadline = Date.now() + 30000;
        let names = [];
        while (Date.now() < deadline) {
          names = await me.participants();
          if (names.some((n) => n.toLowerCase().includes(other.name.toLowerCase()))) return { ok: true, note: names.join(', ') };
          await sleep(2000);
        }
        return { ok: false, note: `${other.name} missing from [${names.join(', ')}]` };
      });
    }

    // hear
    if (can('hear', 'captions')) {
      for (const [speaker, listener] of [[a, b], [b, a]]) {
        await step('hear', listener, async () => {
          await listener.startListening();
          await speaker.playClip(CLIP_PATH);
          const text = await listener.heard(heardClip, hearTimeoutMs);
          return text
            ? { ok: true, note: `heard ${speaker.name}: "${text.slice(0, 70)}"` }
            : { ok: false, note: `heard nothing of ${speaker.name}'s clip in ${hearTimeoutMs / 1000}s` };
        });
        await sleep(3000); // let the clip's captions settle before the next one
      }
    }

    // chat
    if (can('chat', 'chat')) {
      const stamp = Date.now().toString(36);
      const nonce = (bot) => `conformance-${bot.name}-${stamp}`;
      // Before anything reads chat, since a read reports new messages itself and
      // this is to prove the unread path.
      const listening = bots.filter((bot) => bot.startChatEvents);
      for (const bot of listening) {
        if (bot.chatEvents) await bot.startChatEvents();
        else record('chatEvent', bot, 'skip', `no chat event on ${target.provider}`);
      }
      // One message at a time, so the first receiver hasn't touched its chat:
      // sending opens the chat on Meet, which would hide the path being tested.
      for (const [me, other] of [[a, b], [b, a]]) {
        await other.sendChat(nonce(other));
        const sentAt = Date.now();
        if (!me.startChatEvents || !me.chatEvents) continue;
        await step('chatEvent', me, async () => {
          const deadline = Date.now() + 30000;
          while (!me.chatEventsMatching(nonce(other)).length && Date.now() < deadline) await sleep(250);
          const first = me.chatEventsMatching(nonce(other))[0];
          if (!first) return { ok: false, note: `no event for ${other.name}'s message in 30s` };
          await sleep(5000); // long enough for a duplicate to show up
          const count = me.chatEventsMatching(nonce(other)).length;
          const once = count === 1 || (count === 2 && other.chatResent);
          const own = other.chatEventsMatching(nonce(other)).length;
          return {
            ok: once && !own,
            note: `${count} event(s) for ${other.name}'s message after ${((first.at - sentAt) / 1000).toFixed(1)}s, ${own} for ${other.name}'s own copy`,
          };
        });
      }
      for (const [me, other] of [[a, b], [b, a]]) {
        await step('chat', me, async () => {
          const ok = await me.chatContains(nonce(other), 20000);
          return { ok, note: ok ? `read ${other.name}'s message` : `${other.name}'s message never arrived` };
        });
      }
    }

    // share
    if (can('share', 'share')) {
      const shared = await step('share', a, async () => ({ ok: await a.share() }));
      if (shared) await step('shareStop', a, async () => ({ ok: await a.stopShare() }));
    }
  } finally {
    for (const bot of bots) await step('leave', bot, async () => ({ ok: await bot.leave() }));
  }
  return finish();

  function finish() {
    return { results, failed: results.filter((r) => r.status === 'fail').length };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { runConformance, CLIP_PATH, CLIP_WORDS, heardClip };
