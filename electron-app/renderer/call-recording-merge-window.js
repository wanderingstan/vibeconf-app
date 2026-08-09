// call-recording-merge-window.js (renderer): the "Preparing recording…"
// status window's own script. No capture logic at all (see the .js/.html
// pair's header comments). It just reflects whatever status main pushes and
// relays a Cancel click back.

(() => {
  const label = document.getElementById('label');
  const note = document.getElementById('note');
  const cancelBtn = document.getElementById('cancelBtn');

  // Main pushes a short label as each merge stage starts (e.g. "Preparing
  // recording…" then, if a whiteboard share happened, "Preparing share
  // recording…"), see call-recording-merge-window.js (main process) /
  // main.js's stopCallRecording. Optional: the window still makes sense with
  // its default HTML text if this never fires (e.g. a single quick merge).
  window.electronAPI.on('merge-status', (payload) => {
    if (payload && payload.label) label.textContent = payload.label;
  });

  cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    note.textContent = 'The raw recording files are kept; only the combined video is skipped.';
    window.electronAPI.send('merge-cancel-requested');
  });
})();
