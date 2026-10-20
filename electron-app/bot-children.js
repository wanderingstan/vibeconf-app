// bot-children.js — the app window's own bots, as its child processes (#301).
//
// Each bot is still its own process (crash isolation: a wedged Meet page or a
// GPU fault takes down one bot, never the app or the others). What changed is
// who its PARENT is. Bots used to be launched detached (`open -n`), so macOS
// re-parented them to launchd and the app window knew them only by probing
// ports: it could not see one exit, or why, or read a word it logged. On
// 2026-10-19 a bot in a live call quit four times and nothing could say who
// stopped it.
//
// Now the app spawns each bot itself with a private channel (Node's 'ipc'
// stdio), which gives it:
//   • the bot's exit, with exit code or signal, the moment it happens, plus the
//     last lines it printed, so no exit is ever anonymous;
//   • the bot's stdout/stderr, line by line, in the app's own log;
//   • a channel to say "quit (because …)" and hear "show me" back, with no
//     port or token involved;
//   • ownership by PID: one child per profile, never a duplicate.
// And the bot can see the app go: its end of the channel closes (see
// bot-parent-link.js), so it never lives on as an invisible orphan.
//
// Bots NOT started here (the test fleet, a bot opened by hand, one left over
// from an earlier app) are still found by port scanning, as before.
//
// Pure of Electron: `spawn` is injected, so the tests drive a fake child.

const TAIL_LINES = 40;

function createBotChildren({ spawn, log = console, onExit = null, onMessage = null, now = Date.now } = {}) {
  const children = new Map(); // profile -> entry

  function start(name, cmd, argv, { env } = {}) {
    const existing = children.get(name);
    if (existing && !existing.exited) return { ok: true, pid: existing.pid, already: true };

    let child;
    try {
      child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const entry = {
      name, child, pid: child.pid || null, startedAt: now(),
      port: null, tail: [], quitReason: null, exited: false, code: null, signal: null,
    };
    children.set(name, entry);
    log.log(`[supervisor] started bot "${name}" as child pid ${entry.pid}`);

    // Line-buffer each stream: a chunk can end mid-line, and a half line under
    // the wrong prefix is worse than none.
    for (const [stream, label] of [[child.stdout, ''], [child.stderr, ' err']]) {
      if (!stream) continue;
      let partial = '';
      stream.setEncoding && stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = (partial + chunk).split('\n');
        partial = lines.pop();
        for (const line of lines) emitLine(entry, label, line);
      });
      stream.on('end', () => { if (partial) emitLine(entry, label, partial); partial = ''; });
      stream.on('error', () => { /* the pipe went with the child; 'exit' reports it */ });
    }

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello' && Number(msg.port)) entry.port = Number(msg.port);
      // Its single-instance lock found this bot already running (one we did not
      // start, say, still finishing a call). Quitting is the right thing.
      if (msg.type === 'duplicate' && !entry.quitReason) entry.quitReason = 'it was already running in another process';
      if (onMessage) {
        try { onMessage(name, msg); } catch (err) { log.warn(`[supervisor] bot "${name}" message handler threw:`, err.message); }
      }
    });

    child.on('error', (err) => {
      // A spawn that never ran (bad path, no permission) emits only 'error'.
      log.error(`[supervisor] bot "${name}" (pid ${entry.pid}) process error:`, err.message);
      if (!entry.pid) finish(entry, null, null, `could not start: ${err.message}`);
    });

    child.on('exit', (code, signal) => finish(entry, code, signal));
    return { ok: true, pid: entry.pid };
  }

  function emitLine(entry, label, line) {
    if (!line) return;
    entry.tail.push(line);
    if (entry.tail.length > TAIL_LINES) entry.tail.shift();
    log.log(`[bot:${entry.name}${label}] ${line}`);
  }

  function finish(entry, code, signal, error = null) {
    if (entry.exited) return;
    entry.exited = true;
    entry.code = code;
    entry.signal = signal;
    if (children.get(entry.name) === entry) children.delete(entry.name);
    const ranFor = Math.round((now() - entry.startedAt) / 1000);
    const how = error || (signal ? `killed by ${signal}` : `exit code ${code}`);
    const expected = !!entry.quitReason;
    const info = { name: entry.name, pid: entry.pid, code, signal, error, expected, reason: entry.quitReason, ranForSec: ranFor, tail: entry.tail.slice(-10) };
    if (expected) {
      log.log(`[supervisor] bot "${entry.name}" (pid ${entry.pid}) stopped as asked (${entry.quitReason}): ${how}, after ${ranFor}s`);
    } else {
      // Nobody here asked it to go. Say so loudly, with its last words: this is
      // the line that was missing on 2026-10-19.
      log.warn(`[supervisor] bot "${entry.name}" (pid ${entry.pid}) EXITED on its own: ${how}, after ${ranFor}s. Last lines:\n`
        + (entry.tail.slice(-10).map((l) => `    ${l}`).join('\n') || '    (nothing printed)'));
    }
    if (onExit) {
      try { onExit(info); } catch (err) { log.warn('[supervisor] onExit threw:', err.message); }
    }
  }

  // Ask one child to quit, over the channel, and wait for it to go. If it does
  // not within timeoutMs, SIGTERM (Electron turns that into an ordinary quit,
  // so its own shutdown still runs). Resolves true once it has exited.
  function quit(name, reason, timeoutMs = 3000) {
    const entry = children.get(name);
    if (!entry || entry.exited) return Promise.resolve(false);
    if (!entry.quitReason) entry.quitReason = reason || 'asked by the app';
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      entry.child.once('exit', () => settle(true));
      const timer = setTimeout(() => {
        log.warn(`[supervisor] bot "${name}" (pid ${entry.pid}) did not quit within ${timeoutMs}ms; sending SIGTERM`);
        try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
        // Give the signal a moment, then report what is known.
        setTimeout(() => settle(entry.exited), 1000);
      }, timeoutMs);
      try {
        if (entry.child.connected) entry.child.send({ type: 'quit', reason: entry.quitReason });
        else entry.child.kill('SIGTERM');
      } catch {
        try { entry.child.kill('SIGTERM'); } catch { /* gone */ }
      }
    });
  }

  function send(name, msg) {
    const entry = children.get(name);
    if (!entry || entry.exited || !entry.child.connected) return false;
    try { entry.child.send(msg); return true; } catch { return false; }
  }

  return {
    start,
    quit,
    send,
    has: (name) => children.has(name),
    get: (name) => {
      const e = children.get(name);
      return e ? { name: e.name, pid: e.pid, port: e.port, startedAt: e.startedAt } : null;
    },
    nameForPort: (port) => {
      for (const e of children.values()) if (e.port === Number(port)) return e.name;
      return null;
    },
    names: () => [...children.keys()],
    quitAll: (reason, timeoutMs) => Promise.allSettled([...children.keys()].map((n) => quit(n, reason, timeoutMs))),
  };
}

module.exports = { createBotChildren, TAIL_LINES };
