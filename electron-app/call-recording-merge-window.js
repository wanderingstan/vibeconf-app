// call-recording-merge-window.js — a small "Preparing recording…" status
// window shown while runPostRecordingMerges() (main.js) runs the ffmpeg
// merge step, detached from stopCallRecording since #388.
//
// WHY: by the time the merge starts, BOTH capture windows (call-recording-
// window.js's 'video' and 'share' tracks) have already stopped and closed —
// so there is otherwise zero UI feedback while ffmpeg re-encodes, which can
// take a while and pin a CPU core. Without this, a user just sees their fans
// spin up for no visible reason. This window fills that gap: it isn't a
// capture window at all (no getDisplayMedia, no session/partition dance,
// no MediaRecorder) — just a status label and a Cancel button, shown for the
// duration of the merge(s) and then closed.
//
// Reuses preload-call-recording.js's generic send/on contextBridge surface —
// this window doesn't need anything beyond "send a cancel request, nothing
// else" so a dedicated preload would be pure duplication.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIDTH = 300;
const HEIGHT = 88;

// Same bottom-right corner the 'video' status window used — a user who was
// just watching that window disappear when recording stopped will naturally
// look there again for what happens next.
function createMergeProgressWindow() {
  let x, y;
  try {
    const area = screen.getPrimaryDisplay().workArea;
    x = area.x + area.width - WIDTH - 16;
    y = area.y + area.height - HEIGHT - 16;
  } catch { /* screen module unavailable in some test/headless contexts — let Electron center it */ }

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: 'Preparing recording…',
    show: false,
    backgroundColor: '#202124',
    webPreferences: {
      preload: path.join(__dirname, 'preload-call-recording.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'call-recording-merge-window.html'));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  return win;
}

// No stop handshake needed (unlike stopFrameCaptureWindow) — this window
// never had a MediaRecorder chunk that could be truncated by closing early,
// so a plain close is safe and immediate.
function closeMergeProgressWindow(win) {
  try { if (win && !win.isDestroyed()) win.close(); } catch { /* already gone */ }
}

module.exports = { createMergeProgressWindow, closeMergeProgressWindow };
