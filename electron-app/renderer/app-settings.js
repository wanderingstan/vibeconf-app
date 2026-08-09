// app-settings.js: renderer for the App Settings window (#381). Machine-wide
// config shared across all profiles. Uses the SAME IPC the panel uses, and the
// scoped store routes app-level keys to the shared config, so there's no new
// persistence path here.

const api = window.electronAPI;

// --- User (vibeconferencing.com) login: same check-auth / login / logout IPCs
// the panel uses (#366/#381, moved here as an app-level credential). ---
const userStatus = document.getElementById('userStatus');
const userSignInBtn = document.getElementById('userSignInBtn');
const userSignOutBtn = document.getElementById('userSignOutBtn');
async function refreshUser() {
  try {
    const data = await api.invoke('check-auth');
    const signedIn = !!data?.authenticated;
    const who = data?.user?.email || data?.user?.name || 'signed in';
    userStatus.textContent = signedIn ? `✓ Signed in as ${who}` : '⚠ Not signed in';
    userStatus.style.color = signedIn ? '#81c995' : '#fdd663';
    userSignInBtn.style.display = signedIn ? 'none' : 'inline-block';
    userSignOutBtn.style.display = signedIn ? 'inline-block' : 'none';
  } catch {
    userStatus.textContent = 'Auth check failed';
    userStatus.style.color = '#f28b82';
  }
}
userSignInBtn.addEventListener('click', async () => {
  userSignInBtn.disabled = true; userSignInBtn.textContent = 'Opening…';
  try { await api.invoke('login'); } catch { /* ignore */ }
  setTimeout(() => { userSignInBtn.disabled = false; userSignInBtn.textContent = 'Sign in with Google'; refreshUser(); }, 3000);
});
userSignOutBtn.addEventListener('click', async () => {
  try { await api.invoke('logout'); } catch { /* ignore */ }
  refreshUser();
});
api.on('auth-changed', () => refreshUser());
refreshUser();

// --- ElevenLabs key: reuse update-tts-config (keeps TTS + STT in sync, mirrors
// the panel's Text-to-Speech field exactly). ---
const ttsInput = document.getElementById('ttsApiKey');
api.invoke('get-config', ['ttsApiKey']).then((c) => { if (c && c.ttsApiKey) ttsInput.value = c.ttsApiKey; });
ttsInput.addEventListener('change', () => {
  // main re-broadcasts 'tts-grant-changed' after processing this (paste or
  // clear), which repaints the gift offer below, so no need to do it here too.
  api.send('update-tts-config', { apiKey: ttsInput.value.trim() });
});

// --- #273: gifted ElevenLabs key. Stateless by design: no accepted/declined
// flag to get stuck: whether to offer or auto-fill is derived fresh, every
// time, from comparing the CURRENT key to the grant's key. Two rules:
//   1. Current key differs from the gift (including "no key at all") → show
//      a button to apply it. Always available, never permanently dismissed,
//      typing your own key is how you say no; there's nothing else to click.
//   2. The field is EMPTY specifically at the moment this pane is DISPLAYED
//      (initial load or regaining focus, not a live edit mid-session) → fill
//      it in automatically and say so. A live clear (rule 1) stays empty on
//      purpose, so clearing the field to type your own key doesn't fight you.
const giftSection = document.getElementById('giftSection');
const giftDesc = document.getElementById('giftDesc');
const giftAcceptBtn = document.getElementById('giftAcceptBtn');
const ttsGiftedNotice = document.getElementById('ttsGiftedNotice');
function paintGift(grant, currentKey) {
  const isGiftActive = !!grant?.granted && currentKey === grant.apiKey;
  if (ttsGiftedNotice) ttsGiftedNotice.style.display = isGiftActive ? '' : 'none';
  if (!giftSection) return;
  const offerable = !!grant?.granted && !isGiftActive;
  giftSection.style.display = offerable ? '' : 'none';
  if (offerable && giftDesc) {
    giftDesc.textContent = currentKey
      ? "You've been gifted a voice key. Use it instead?"
      : "You've been gifted a voice key: zero setup, ready to speak.";
    giftAcceptBtn.textContent = currentKey ? 'Use gifted key' : 'Use it';
  }
}
async function refreshGift({ fillIfEmpty = false } = {}) {
  try {
    const { grant } = await api.invoke('get-tts-grant');
    let cfg = await api.invoke('get-config', ['ttsApiKey']);
    let currentKey = (cfg && cfg.ttsApiKey) || '';
    if (fillIfEmpty && grant?.granted && !currentKey) {
      await api.invoke('accept-tts-grant');
      cfg = await api.invoke('get-config', ['ttsApiKey']);
      currentKey = (cfg && cfg.ttsApiKey) || '';
    }
    if (ttsInput.value !== currentKey) ttsInput.value = currentKey;
    paintGift(grant, currentKey);
  } catch { /* non-fatal */ }
}
giftAcceptBtn?.addEventListener('click', async () => {
  giftAcceptBtn.disabled = true;
  try { await api.invoke('accept-tts-grant'); await refreshGift(); }
  finally { giftAcceptBtn.disabled = false; }
});
// main broadcasts this after any change to the grant or the applied key
// (accept, or a manual paste that now matches/differs). It never auto-fills,
// since only a genuine "pane just displayed" moment should do that.
api.on('tts-grant-changed', () => refreshGift());
window.addEventListener('focus', () => refreshGift({ fillIfEmpty: true }));
refreshGift({ fillIfEmpty: true });

// A stored key that no longer authenticates is invisible otherwise: every
// ElevenLabs call fails, the bot quietly falls back to a system voice, and the
// only symptom is "it won't let me pick an ElevenLabs voice" somewhere else
// entirely. main does the classifying (one copy of the rule); this just paints.
const ttsKeyProblemEl = document.getElementById('ttsKeyProblem');
function paintKeyProblem(status) {
  if (!ttsKeyProblemEl) return;
  const msg = status?.keyProblem?.message;
  ttsKeyProblemEl.textContent = msg || '';
  ttsKeyProblemEl.style.display = msg ? '' : 'none';
}
api.invoke('get-voice-status').then(paintKeyProblem).catch(() => {});
// Re-check when the window regains focus: the usual fix is pasting a new key,
// and it is re-validated at the next startup, so this keeps a stale warning from
// sitting there after the problem is gone.
window.addEventListener('focus', () => {
  api.invoke('get-voice-status').then(paintKeyProblem).catch(() => {});
});
// Pasting a key triggers a check against ElevenLabs; main broadcasts when it has
// an answer. Without this the verdict would only appear on the next focus or
// restart, which is exactly the delay that made a dead key hard to attribute.
api.on('voice-status-changed', () => {
  api.invoke('get-voice-status').then(paintKeyProblem).catch(() => {});
});

// The spoken confirmation (panel.js) is the primary signal; this is the paired
// visual for whoever's looking at THIS window when it happens. Fades on its
// own. Unlike ttsKeyProblem, there's nothing ongoing to keep showing once the
// person has seen it.
const ttsKeyValidatedEl = document.getElementById('ttsKeyValidated');
api.on('elevenlabs-key-validated', () => {
  if (!ttsKeyValidatedEl) return;
  ttsKeyValidatedEl.style.display = '';
  clearTimeout(ttsKeyValidatedEl._hideTimer);
  ttsKeyValidatedEl._hideTimer = setTimeout(() => { ttsKeyValidatedEl.style.display = 'none'; }, 6000);
});

// Open the "get a key" link in the real browser instead of navigating this window.
document.getElementById('ttsKeyLink').addEventListener('click', (e) => {
  e.preventDefault();
  api.send('open-external-url', e.currentTarget.href);
});

// --- Schema-driven app-level prefs (scope:'app'). ---
api.invoke('get-app-settings-schema').then(async (fields) => {
  const section = document.getElementById('schemaSection');
  const host = document.getElementById('schemaFields');
  if (!fields || !fields.length) { section.style.display = 'none'; return; }

  const vals = await api.invoke('get-config', fields.map((f) => f.key));

  for (const f of fields) {
    const wrap = document.createElement('div');

    if (f.type === 'boolean') {
      const rowc = document.createElement('div');
      rowc.className = 'row-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = `f_${f.key}`; cb.checked = !!vals[f.key];
      cb.addEventListener('change', () => api.invoke('set-config', f.key, cb.checked));
      const lbl = document.createElement('label');
      lbl.htmlFor = cb.id; lbl.textContent = f.label || f.key;
      rowc.appendChild(cb); rowc.appendChild(lbl);
      wrap.appendChild(rowc);
    } else {
      const lbl = document.createElement('label');
      lbl.htmlFor = `f_${f.key}`; lbl.textContent = f.label || f.key;
      wrap.appendChild(lbl);
      let input;
      if (f.enum && f.enum.length) {
        input = document.createElement('select');
        for (const opt of f.enum) {
          const o = document.createElement('option');
          // #231: a raw enum value presents every option as an equal peer. When
          // they are not equal (recommended vs experimental vs bring-your-own),
          // the label has to say so, or the UI misrepresents what is supported.
          o.value = opt; o.textContent = (f.enumLabels && f.enumLabels[opt]) || opt;
          input.appendChild(o);
        }
        input.value = vals[f.key] != null ? vals[f.key] : (f.default != null ? f.default : '');
        input.addEventListener('change', () => api.invoke('set-config', f.key, input.value));
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = vals[f.key] != null ? vals[f.key] : '';
        input.addEventListener('change', () => api.invoke('set-config', f.key, input.value.trim()));
      }
      input.id = `f_${f.key}`;
      wrap.appendChild(input);
    }

    if (f.description) {
      const d = document.createElement('div');
      d.className = 'desc';
      d.textContent = f.description + (f.requiresRestart ? ' (requires restart)' : '');
      wrap.appendChild(d);
    }
    host.appendChild(wrap);
  }
});
