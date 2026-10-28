// panel-relay.js — drive this bot's panel from another process (#301, one-window spike).
//
// The one-window app: the supervisor owns the only window, a sidebar of bots
// plus the selected bot's panel. Each bot stays its own process (crash
// isolation, docs/multi-bot-architecture.md), so the panel shown in the
// supervisor's window cannot talk to its bot over Electron IPC, which only
// reaches the process that owns the renderer.
//
// Rather than rewrite the panel's ~100 call sites against an HTTP API, this
// carries the panel's three IPC primitives across processes unchanged:
//
//   invoke(channel, ...args)  → POST /api/panel/invoke → the bot's own ipcMain.handle handler
//   send(channel, ...args)    → POST /api/panel/send   → the bot's own ipcMain.on listeners
//   on(channel, cb)           ← GET  /api/panel/events (SSE) ← every webContents.send to the panel
//
// So panel.js and main.js's 149 handlers stay as they are; the supervisor runs
// the same panel.html with a preload that routes through here.
//
// Two hooks make it work, both installed once:
//   • ipcMain.handle is wrapped so registered handlers are recorded. Electron
//     keeps them private; ipcMain.on listeners are public (listeners()).
//   • The panel's webContents.send is teed, so everything the bot pushes to its
//     own panel (direct sends and broadcastToRenderers alike) reaches relay
//     subscribers too.
//
// Relayed calls present the bot's REAL panel webContents as event.sender, so a
// handler that checks or replies to its sender behaves exactly as it does for
// the bot's own window.
//
// Args and results cross as JSON. Electron IPC uses structured clone, which
// carries more (Buffers, Dates); nothing the panel sends today needs that, and
// a value that will not serialise fails loudly at the relay rather than
// arriving half-formed.

function createPanelRelay({ ipcMain, log = console, onQuit = null }) {
  const handlers = new Map();
  const realHandle = ipcMain.handle.bind(ipcMain);
  const realRemoveHandler = ipcMain.removeHandler.bind(ipcMain);
  ipcMain.handle = (channel, fn) => { handlers.set(channel, fn); return realHandle(channel, fn); };
  ipcMain.removeHandler = (channel) => { handlers.delete(channel); return realRemoveHandler(channel); };

  const subscribers = new Set();
  let panelWc = null;

  function fakeEvent() {
    return {
      sender: panelWc,
      senderFrame: panelWc ? panelWc.mainFrame : null,
      ports: [],
      returnValue: undefined,
      preventDefault() {},
      reply: (channel, ...args) => { try { panelWc && panelWc.send(channel, ...args); } catch { /* gone */ } },
    };
  }

  async function invoke(channel, args = []) {
    const fn = handlers.get(channel);
    if (!fn) {
      const err = new Error(`no handler for "${channel}"`);
      err.code = 'no-handler';
      throw err;
    }
    return fn(fakeEvent(), ...args);
  }

  function send(channel, args = []) {
    const listeners = ipcMain.listeners(channel);
    const event = fakeEvent();
    for (const l of listeners) {
      try { l(event, ...args); } catch (err) { log.warn(`[panel-relay] "${channel}" listener threw:`, err.message); }
    }
    return listeners.length;
  }

  function emit(channel, args) {
    if (!subscribers.size) return;
    let data;
    try { data = JSON.stringify({ channel, args }); } catch { return; } // unserialisable: the bot's own panel still got it
    for (const res of subscribers) {
      try { res.write(`data: ${data}\n\n`); } catch { /* subscriber went away; 'close' removes it */ }
    }
  }

  // Tee the panel's webContents.send. Called whenever the bot (re)creates its
  // panel view, so a rebuilt view keeps relaying.
  function attachPanel(wc) {
    if (!wc || wc.__panelRelayAttached) return;
    panelWc = wc;
    const realSend = wc.send.bind(wc);
    wc.send = (channel, ...args) => { realSend(channel, ...args); emit(channel, args); };
    wc.__panelRelayAttached = true;
  }

  // Routes, mounted by local-server AFTER its auth check: these drive the bot
  // as fully as its own window does, so they are exactly as private.
  async function handleRequest(req, res, url, readBody) {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    // "Can you be hosted?" The supervisor asks before putting this bot's panel
    // on its stage: a bot started by an older build has no /api/panel at all,
    // and loading the panel against it fails call by call.
    if (url.pathname === '/api/panel/ping' && req.method === 'GET') {
      json(200, { ok: true, relay: 1, handlers: handlers.size });
      return true;
    }

    // The app asking this bot to stop: the reaper (an idle bot) or the app
    // quitting (every bot). Answered first, then quit, so the caller is not
    // left waiting on a connection the quit tears down.
    if (url.pathname === '/api/panel/quit' && req.method === 'POST') {
      if (!onQuit) { json(404, { ok: false, error: 'quit not supported' }); return true; }
      json(200, { ok: true });
      // Who asked: the app says why in the body (reaper, app quitting).
      let why = null;
      try { why = (JSON.parse((await readBody(req)) || '{}') || {}).reason || null; } catch { /* no body */ }
      setTimeout(() => { try { onQuit(why); } catch (err) { log.warn('[panel-relay] quit failed:', err.message); } }, 50);
      return true;
    }

    if (url.pathname === '/api/panel/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      subscribers.add(res);
      // A comment line every 15s, so an idle stream is not mistaken for a dead
      // one by anything in between.
      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closing */ } }, 15_000);
      req.on('close', () => { clearInterval(beat); subscribers.delete(res); });
      return true;
    }

    if ((url.pathname === '/api/panel/invoke' || url.pathname === '/api/panel/send') && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { json(400, { ok: false, error: 'bad json' }); return true; }
      const channel = String(body.channel || '');
      const args = Array.isArray(body.args) ? body.args : [];
      if (!channel) { json(400, { ok: false, error: 'channel is required' }); return true; }
      if (url.pathname === '/api/panel/send') {
        json(200, { ok: true, listeners: send(channel, args) });
        return true;
      }
      try {
        const result = await invoke(channel, args);
        json(200, { ok: true, result: result === undefined ? null : result });
      } catch (err) {
        json(err.code === 'no-handler' ? 404 : 500, { ok: false, error: err.message, code: err.code || null });
      }
      return true;
    }
    return false;
  }

  // To the app window's copy of the panel only, not the bot's own hidden one.
  // For a prompt: shown in both, the hidden copy's would hold the bot's window
  // open with nobody able to answer it (⇧⌘L, 2026-10-28).
  const emitToRelay = (channel, args = []) => emit(channel, args);
  return { invoke, send, attachPanel, handleRequest, emitToRelay, subscriberCount: () => subscribers.size, handlerCount: () => handlers.size };
}

module.exports = { createPanelRelay };
