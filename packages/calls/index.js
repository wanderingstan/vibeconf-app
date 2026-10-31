// @vibeconferencing/calls: put a bot in a call.
//
//   const { join } = require('@vibeconferencing/calls');
//   const call = await join(link, { name: 'Ada (AI)', profile: './profiles/ada' });
//   call.on('caption', (turn) => console.log(turn.speaker, turn.text));
//   call.on('chat', (msg) => console.log(msg.sender, msg.text));
//   await call.speak('./hello.mp3');
//   await call.leave();

const { platformFromUrl } = require('./core/call-target');
const { CALL_EVENTS } = require('./core/call-provider');
const { Call, stateFromStatus } = require('./api/call');
const { JoinError, UnsupportedError, MutedError, codeFromStatus, isProfileInUse, classifyJoinFailure, joinError } = require('./api/errors');

const platforms = Object.freeze(['meet', 'zoom', 'teams', 'slack']);

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The join was aborted'), { name: 'AbortError' });
}

/**
 * Join a call. Resolves with a Call once the bot is in it, rejects with a
 * JoinError otherwise.
 * @param {string} url  a Google Meet, Zoom or Teams link, or a Slack channel (its huddle)
 * @param {object} options
 * @param {string} options.name       the name people in the call see
 * @param {string} [options.profile]  browser profile folder; required without `host`
 * @param {'guest'|'account'} [options.identity='guest']  'account' for a signed-in profile
 * @param {object} [options.host]     a host from playwrightHost(), kept open after the call
 * @param {number} [options.timeoutMs=120000]  includes time waiting in a lobby
 * @param {AbortSignal} [options.signal]
 * @param {(state: string) => void} [options.onState]  state changes during the join, before a Call exists
 */
async function join(url, { name, profile, identity = 'guest', host, timeoutMs = 120000, signal, onState } = {}) {
  if (!name) throw new TypeError('join: `name` is required, the name people in the call see');
  if (!host && !profile) throw new TypeError('join: `profile` is required without `host`');
  const target = platformFromUrl(url);
  if (!target.ok) throw new UnsupportedError(target.error);
  if (!platforms.includes(target.provider)) throw new UnsupportedError(`join() doesn't support ${target.provider} yet`);
  if (signal && signal.aborted) throw abortError(signal);

  const { launchPlaywrightHost } = require('./hosts/playwright');
  let owned = false;
  if (!host) {
    try {
      host = await launchPlaywrightHost({ userDataDir: profile });
    } catch (err) {
      if (isProfileInUse(err)) throw joinError('already-running', { cause: err });
      throw err;
    }
    owned = true;
  }

  let inner = null;
  let state = 'joining';
  const statuses = [];
  let settle;
  const failed = new Promise((_, reject) => { settle = reject; });
  failed.catch(() => {});
  const onAbort = () => settle(abortError(signal));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const noteStatus = (s) => {
    statuses.push(String(s));
    const code = codeFromStatus(s);
    if (code) settle(joinError(code, { detail: String(s).replace(/^Error:\s*/, '') }));
    const next = stateFromStatus(s);
    if (next && next !== state) {
      state = next;
      if (onState) { try { onState(state); } catch { /* the caller's problem */ } }
    }
  };
  if (onState) { try { onState(state); } catch { /* the caller's problem */ } }

  try {
    await Promise.race([
      failed,
      host.join(target.url, {
        botName: name,
        mode: identity,
        timeoutMs,
        onCall: (c) => { inner = c; c.on(CALL_EVENTS.statusUpdate, noteStatus); },
      }),
    ]);
  } catch (err) {
    const failure = err instanceof JoinError || (signal && signal.aborted) ? err : await describeFailure(inner, statuses, err);
    if (owned) await host.close().catch(() => {});
    throw failure;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (inner) inner.off(CALL_EVENTS.statusUpdate, noteStatus);
  }

  return new Call(inner, {
    platform: target.provider,
    name,
    hostCapabilities: host.capabilities,
    closeHost: owned ? () => host.close() : null,
    state: 'in-call',
  });
}

// A join ran out of time: say why, from what the page last showed.
async function describeFailure(inner, statuses, cause) {
  const page = inner && inner.page;
  const look = { statuses, url: '', text: '' };
  let screenshot = null;
  if (page) {
    try {
      look.url = page.url();
      look.text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      screenshot = await page.screenshot();
    } catch { /* page gone */ }
  }
  return joinError(classifyJoinFailure(look), { screenshot, cause });
}

module.exports = { join, JoinError, UnsupportedError, MutedError, platforms };
