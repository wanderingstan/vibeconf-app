// call-recording-window.js — small helper windows that capture the LIVE
// rendered content of a webContents WE control as a MediaStream, for call
// recording. Two capture tracks reuse this exact same mechanism:
//   - 'video': the bot's own Meet view (meetView) — VISIBLE control window
//     with an elapsed-time/Stop-button status UI, active for the whole
//     recording.
//   - 'share': the bot's own whiteboard-window share (whiteboardWindow) — a
//     HIDDEN capture window with no UI, active only while a whiteboard share
//     is live (see main.js's onShareWhiteboard/onStopSharing wiring).
//
// WHY A SEPARATE WINDOW, NOT THE SOURCE'S OWN getDisplayMedia(): for the Meet
// view specifically, Meet's own getDisplayMedia() is reserved for actually
// presenting to the room — it lights up a "presenting" indicator for every
// participant. Silently recording for debugging must not do that, so THIS
// window has its own session/partition and calls getDisplayMedia() from ITS
// page instead, never from the source page.
//
// THE CAPTURE TRICK: this session's setDisplayMediaRequestHandler answers
// every request with `{ video: targetWebContents.mainFrame }` — the exact
// mechanism main.js's configureMeetSession already uses for the HIDDEN
// whiteboard window (see main.js, setDisplayMediaRequestHandler,
// ~4041-4160): handing Chromium a WebFrameMain directly produces a live,
// continuous MediaStream of that frame's rendered content, with no OS
// permission needed and no on-screen presence required from the SOURCE (it
// can be fully covered by other windows, even occluded/hidden, and this still
// works because it's a frame capture, not a screen capture).
//
// SCOPE (why 'share' only covers the whiteboard, not every share): this only
// works for shares of a webContents WE control — the whiteboard BrowserWindow
// is ours, so whiteboardWindow.webContents.mainFrame is directly available.
// Full-screen share and share_tab (an external Chrome tab) do NOT get this
// treatment: there is no webContents of ours behind either of those, which is
// exactly why they already go through OS-level desktopCapturer instead. That
// gap is real and not something this module can close.
//
// NO USER-GESTURE WORKAROUND NEEDED: Electron's setDisplayMediaRequestHandler
// intercepts getDisplayMedia() before Chromium's native gesture-gated picker
// UI would ever run, so the page's own script can call it directly on load —
// same as how the existing whiteboard-share flow gets away with a scripted
// .click() triggering getDisplayMedia() today.
//
// Because capture here is just "create a window, get a stream, run
// MediaRecorder" — nothing baked into the source webContents at creation time
// — the 'video' track can start/stop at ANY point during a live call, and the
// 'share' track naturally starts/stops with each individual share.

const { BrowserWindow, session, screen } = require('electron');
const path = require('path');

const WIDTH = 300;
const HEIGHT = 96;

// How long to wait for a capture window's renderer to flush its final
// MediaRecorder chunk and ack after being told to stop, before main gives up
// and closes the window anyway. Generous but bounded — call teardown must
// never hang on this.
const STOP_ACK_TIMEOUT_MS = 5000;

// Low-level, reusable: create a capture window that streams
// targetWebContents' live frame out as `trackName` chunks.
//
//   targetWebContents — the webContents to capture (meetView.webContents or
//     whiteboardWindow.webContents). Must be a webContents WE control (see
//     SCOPE above).
//   trackName — the track name main.js will call activeRecording.chunk(...)
//     with (e.g. 'video', 'share'). Passed to the renderer via the loaded
//     page's query string so it tags every chunk it sends correctly.
//   partition — this window's OWN session partition. Must be distinct from
//     the source's partition (Meet/whiteboard) so it never inherits THEIR
//     display-media handler.
//   visible — true for a real status window (elapsed time + Stop button,
//     e.g. the 'video' track); false for a background capture with no UI
//     (e.g. 'share') — the window is created but never shown.
//   title — window title, only meaningful when visible.
//
// Throws if targetWebContents isn't available. Callers are expected to catch
// this and degrade gracefully (fall back to not capturing that track) rather
// than let a capture-window failure break the recording or the share itself.
function createFrameCaptureWindow(targetWebContents, { trackName, partition, visible = true, title = 'Recording…' } = {}) {
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    throw new Error(`no target webContents to capture for track "${trackName}"`);
  }
  if (!trackName || !partition) {
    throw new Error('createFrameCaptureWindow requires trackName and partition');
  }

  const sess = session.fromPartition(partition);

  // Every request on this session answers with the SAME thing — unlike
  // configureMeetSession's handler (which juggles full-screen share, external
  // tabs, and the whiteboard), each of these sessions exists for exactly one
  // purpose: hand back this one target's live frame.
  sess.setDisplayMediaRequestHandler((_request, callback) => {
    if (!targetWebContents || targetWebContents.isDestroyed()) {
      console.warn(`[call-recording-window] display-media request for "${trackName}" but the source is gone — denying`);
      callback({});
      return;
    }
    callback({ video: targetWebContents.mainFrame });
  });

  // Auto-grant the permissions getDisplayMedia() itself checks — there is no
  // human present to click a picker for this window.
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'display-capture'].includes(permission));
  });
  sess.setPermissionCheckHandler((_wc, permission) => ['media', 'display-capture'].includes(permission));

  let x, y;
  if (visible) {
    try {
      const area = screen.getPrimaryDisplay().workArea;
      x = area.x + area.width - WIDTH - 16;
      y = area.y + area.height - HEIGHT - 16;
    } catch { /* screen module unavailable in some test/headless contexts — let Electron center it */ }
  }

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: visible,
    skipTaskbar: true,
    title,
    show: false, // visible windows show() themselves on ready-to-show; hidden ones never do
    backgroundColor: '#202124',
    webPreferences: {
      preload: path.join(__dirname, 'preload-call-recording.js'),
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      // Must keep the getDisplayMedia() stream + MediaRecorder running even
      // while this window is occluded, minimized, or (for 'share') never
      // shown at all — this is exactly the "never throttle the call view"
      // reasoning meetView itself uses.
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'call-recording-window.html'), {
    search: `track=${encodeURIComponent(trackName)}&controls=${visible ? '1' : '0'}`,
  });
  if (visible) {
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
  }
  return win;
}

// Tell a capture window's renderer to stop its MediaRecorder and wait
// (bounded) for it to flush the final chunk and ack, THEN close the window.
// Closing early would truncate the last ~1s of that track, so this is
// deliberately not just win.close().
//
// Resolves once the window is gone (or was already gone/never created).
// Never rejects — a stuck or already-dead renderer just means we give up
// after the timeout and close anyway.
function stopFrameCaptureWindow(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn('[call-recording-window] stop ack timed out — closing anyway');
      finish();
    }, STOP_ACK_TIMEOUT_MS);
    try {
      win.webContents.ipc.once('frame-capture-stopped', () => {
        clearTimeout(timer);
        finish();
      });
    } catch { /* webContents already gone */ }
    win.once('closed', () => { clearTimeout(timer); finish(); });
    try {
      win.webContents.send('frame-capture-stop');
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

// --- Thin, named wrappers for the two capture tracks main.js actually uses ---

// In-memory only (no persist: prefix) — neither window's session needs to
// survive a restart, and keeping them OFF the Meet/whiteboard partition is
// the whole point: they must never inherit the SOURCE's own display-media
// handler.
const VIDEO_PARTITION = 'call-recording';
const SHARE_PARTITION = 'call-recording-share';

// The bot's own Meet view — visible status window (elapsed time + Stop
// button), active for the whole recording. See main.js's
// startCallRecording()/stopCallRecording().
function createCallRecordingWindow(meetView) {
  return createFrameCaptureWindow(meetView && meetView.webContents, {
    trackName: 'video',
    partition: VIDEO_PARTITION,
    visible: true,
    title: 'Recording call…',
  });
}

// The bot's own whiteboard-window share — hidden, no UI, active only while a
// share is live. See main.js's onShareWhiteboard/onStopSharing wiring.
function createShareCaptureWindow(whiteboardWindow) {
  return createFrameCaptureWindow(whiteboardWindow && whiteboardWindow.webContents, {
    trackName: 'share',
    partition: SHARE_PARTITION,
    visible: false,
    title: 'Recording share…',
  });
}

module.exports = {
  createFrameCaptureWindow,
  stopFrameCaptureWindow,
  createCallRecordingWindow,
  createShareCaptureWindow,
  STOP_ACK_TIMEOUT_MS,
};
