// bot-parent-link.js — a bot's end of the channel to the app window that
// started it (#301). The other end is bot-children.js.
//
// Only a bot the app spawned has this channel (process.send exists); a bot
// opened any other way gets null and carries on exactly as before.
//
//   app → bot   { type: 'quit', reason }      stop now (reaper, app quitting)
//   bot → app   { type: 'hello', pid, port }  up, and listening on this port
//   bot → app   { type: 'duplicate' }         this bot was already running elsewhere;
//                                             this copy is quitting, as it should
//   bot → app   { type: 'select' }            "show me" (a notification click, a
//                                             second launch, a join flow)
//
// When the app goes away (quit, crash, kill -9), the channel closes and the bot
// hears 'disconnect'. An idle bot then quits too; a bot in a call finishes the
// call first, because walking out of a live meeting is the one thing worse
// than an orphan. Either way it never lingers with no UI.
//
// Pure of Electron: process, quit and the call-state getter are injected.

function connectToParent({ proc = process, log = console, onQuit, isInCall, pollMs = 5000 } = {}) {
  if (typeof proc.send !== 'function') return null;

  // The app reads our stdout/stderr through pipes. Once it is gone a write to
  // them fails with EPIPE, and an unhandled stream error would crash a bot
  // that is meant to finish its call. Writes after that point just vanish.
  for (const s of [proc.stdout, proc.stderr]) {
    if (s && typeof s.on === 'function') s.on('error', () => {});
  }

  let parentGone = false;

  proc.on('message', (msg) => {
    if (msg && msg.type === 'quit') {
      try { onQuit(`the app window asked it to stop (child channel: ${msg.reason || 'no reason given'})`); }
      catch (err) { log.warn('[electron] parent-link quit failed:', err.message); }
    }
  });

  proc.on('disconnect', () => {
    parentGone = true;
    if (!isInCall()) {
      onQuit('the app window that started it went away (parent channel closed)');
      return;
    }
    console.log('[electron] the app window went away mid-call; finishing the call, then quitting');
    const timer = setInterval(() => {
      if (isInCall()) return;
      clearInterval(timer);
      onQuit('the app window went away; quit after the call ended');
    }, pollMs);
    if (timer.unref) timer.unref();
  });

  function post(msg) {
    if (parentGone || !proc.connected) return false;
    try { proc.send(msg); return true; } catch { return false; }
  }

  return {
    hello: (port) => post({ type: 'hello', pid: proc.pid, port }),
    // True when the request reached the app; false means show your own window.
    select: () => post({ type: 'select' }),
    duplicate: () => post({ type: 'duplicate' }),
    connected: () => !parentGone && !!proc.connected,
  };
}

module.exports = { connectToParent };
