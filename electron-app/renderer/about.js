// about.js — fills in the About window's version lines.
//
// Kept out of about.html as a separate file to match the other renderers here
// (panel.js, app-settings.js, onboarding.js) rather than for any technical
// reason — the script is tiny.

const api = window.electronAPI;

// "Version 0.7.0-beta66" in the packaged app; a dev build says so explicitly,
// because a version number alone can't tell you whether you're looking at the
// installed app or a `pnpm dev` run out of the repo — and that is exactly the
// question an About box gets opened to answer during support.
api.invoke('get-app-version').then((info) => {
  const el = document.getElementById('version');
  if (!info || !info.version) {
    el.textContent = 'Version unknown';
    el.classList.add('unknown');
    return;
  }
  el.textContent = 'Version ' + info.version + (info.packaged ? '' : ' (development build)');

  // The product line, straight from package.json's description. Rendered here
  // rather than written into about.html so there is exactly one place to edit
  // the wording; if the manifest ever lacks one, the line simply stays empty
  // rather than showing a stale phrase.
  if (info.description) document.getElementById('tagline').textContent = info.description;
}).catch(() => {
  const el = document.getElementById('version');
  el.textContent = 'Version unknown';
  el.classList.add('unknown');
});

// Runtime versions come straight from the preload — no IPC needed.
const v = (api && api.versions) || {};
if (v.electron || v.chrome || v.node) {
  document.getElementById('runtime').textContent =
    `Electron ${v.electron} · Chromium ${v.chrome} · Node ${v.node}`;
}
