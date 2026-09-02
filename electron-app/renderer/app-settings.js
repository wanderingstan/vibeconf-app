// app-settings.js — renderer for the App Settings window (#381). Machine-wide
// config shared across all profiles. Uses the SAME IPC the panel uses, and the
// scoped store routes app-level keys to the shared config, so there's no new
// persistence path here.

const api = window.electronAPI;

// #628 — a typed value is LOST if the window is closed while the field still
// has focus.
//
// Text inputs commit on 'change', and 'change' fires only on blur or Enter. Hit
// ⌘W (or the red button) straight after typing and the edit never reaches the
// store — silently, with the window animating shut as if it had been saved.
// Checkboxes are unaffected: their 'change' fires on the click itself.
//
// Committing on every keystroke is NOT the fix. Several of these prefs are
// pattern-validated (websiteUrl must match ^(|https?://.+)$), so a half-typed
// "http://exa" is a value the store is right to reject — and would either log
// noise on every character or, worse, land.
//
// So: remember what is unsaved, and flush it when the window is closing. Main
// holds the close until we answer (see appSettingsWindow.on('close')).
const _pending = new Map();

function markPending(key, read) { _pending.set(key, read); }
function commitNow(key, value) { _pending.delete(key); return api.invoke('set-config', key, value); }

api.on('flush-settings', async () => {
  try {
    for (const [key, read] of _pending) {
      // The TTS key does not go through set-config; it has its own handler.
      if (key === '__ttsApiKey') api.send('update-tts-config', { apiKey: read() });
      else await api.invoke('set-config', key, read());
    }
    _pending.clear();
  } catch { /* never trap the window open on a failed write */ }
  api.send('settings-flushed');
});

// --- User (vibeconferencing.com) login: same check-auth / login / logout IPCs
// the panel uses (#366/#381 — moved here as an app-level credential). ---
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
// The API key is the worst field to lose — it is pasted, long, and secret, so
// there is nothing to retype from. Same pending/flush treatment, via its own
// channel rather than set-config.
ttsInput.addEventListener('input', () => _pending.set('__ttsApiKey', () => ttsInput.value.trim()));
ttsInput.addEventListener('change', () => {
  _pending.delete('__ttsApiKey');
  // main re-broadcasts 'tts-grant-changed' after processing this (paste or
  // clear), which repaints the gift offer below — no need to do it here too.
  api.send('update-tts-config', { apiKey: ttsInput.value.trim() });
});

// --- EXPERIMENT: OpenAI realtime key. Plain set-config, with none of the
// validation round trip the ElevenLabs field has: there is no cheap "is this
// key good" probe that does not open a billable session, so a bad key surfaces
// as a failed session on the next join, reported via realtime-status.
const realtimeInput = document.getElementById('realtimeApiKey');
const realtimeKeyProblem = document.getElementById('realtimeKeyProblem');
if (realtimeInput) {
  api.invoke('get-config', ['realtimeApiKey']).then((c) => {
    if (c && c.realtimeApiKey) realtimeInput.value = c.realtimeApiKey;
    paintRealtimeKey();
  }).catch(() => { /* non-fatal */ });

  // A key that does not start with sk- is nearly always a paste that lost its
  // first character. Said here, at the moment of typing, because the only other
  // place it shows up is an "Incorrect API key" 401 mid-call, which reads as a
  // dead key rather than a mistyped one.
  function paintRealtimeKey() {
    if (!realtimeKeyProblem) return;
    const v = realtimeInput.value.trim();
    const bad = v && !v.startsWith('sk-');
    realtimeKeyProblem.textContent = bad
      ? 'That does not start with "sk-" (' + v.length + ' characters). A character was ' +
        'probably lost on paste; try pasting it again.'
      : '';
    realtimeKeyProblem.style.display = bad ? '' : 'none';
  }

  // Saving only on 'change' loses the key entirely if the window is closed
  // straight after typing, because 'change' needs a blur or Enter first. That
  // happened on the very first real use. Debounced 'input' saves as you type;
  // 'change' and pagehide flush immediately so nothing is left pending.
  let saveTimer = null;
  const save = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    api.invoke('set-config', 'realtimeApiKey', realtimeInput.value.trim())
      .catch(() => { /* non-fatal */ });
  };
  realtimeInput.addEventListener('input', () => {
    paintRealtimeKey();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  });
  realtimeInput.addEventListener('change', save);
  window.addEventListener('pagehide', () => { if (saveTimer) save(); });
}

// --- #273: gifted ElevenLabs key. Stateless by design — no accepted/declined
// flag to get stuck: whether to offer or auto-fill is derived fresh, every
// time, from comparing the CURRENT key to the grant's key. Two rules:
//   1. Current key differs from the gift (including "no key at all") → show
//      a button to apply it. Always available, never permanently dismissed —
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
      ? "You've been gifted a voice key — use it instead?"
      : "You've been gifted a voice key — zero setup, ready to speak.";
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
// (accept, or a manual paste that now matches/differs) — never auto-fills,
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
// own — unlike ttsKeyProblem, there's nothing ongoing to keep showing once the
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
          // they are not equal — recommended vs experimental vs bring-your-own —
          // the label has to say so, or the UI misrepresents what is supported.
          o.value = opt; o.textContent = (f.enumLabels && f.enumLabels[opt]) || opt;
          input.appendChild(o);
        }
        input.value = vals[f.key] != null ? vals[f.key] : (f.default != null ? f.default : '');
        input.addEventListener('input',  () => markPending(f.key, () => input.value));
        input.addEventListener('change', () => commitNow(f.key, input.value));
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = vals[f.key] != null ? vals[f.key] : '';
        input.addEventListener('input',  () => markPending(f.key, () => input.value.trim()));
        input.addEventListener('change', () => commitNow(f.key, input.value.trim()));
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
