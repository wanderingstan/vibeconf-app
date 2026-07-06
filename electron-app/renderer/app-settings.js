// app-settings.js — renderer for the App Settings window (#381). Machine-wide
// config shared across all profiles. Uses the SAME IPC the panel uses, and the
// scoped store routes app-level keys to the shared config, so there's no new
// persistence path here.

const api = window.electronAPI;

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
ttsInput.addEventListener('change', () => {
  api.send('update-tts-config', { apiKey: ttsInput.value.trim() });
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
      lbl.htmlFor = cb.id; lbl.textContent = f.key;
      rowc.appendChild(cb); rowc.appendChild(lbl);
      wrap.appendChild(rowc);
    } else {
      const lbl = document.createElement('label');
      lbl.htmlFor = `f_${f.key}`; lbl.textContent = f.key;
      wrap.appendChild(lbl);
      let input;
      if (f.enum && f.enum.length) {
        input = document.createElement('select');
        for (const opt of f.enum) {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
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
