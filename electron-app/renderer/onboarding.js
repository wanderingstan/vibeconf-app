// onboarding.js — renderer for the first-run setup wizard. The pure step/permission
// model lives in electron-app/onboarding-flow.js and is surfaced over IPC
// (onboarding:*); config reads/writes reuse get-config/set-config; sign-in reuses
// check-auth/login/logout; voice preview reuses play-speech-test.
const api = window.electronAPI;

const steps = [...document.querySelectorAll('section[data-step]')].map((s) => s.dataset.step);
const TITLE = {
  welcome: 'Welcome', permissions: 'Permissions', signin: 'Sign in',
  logging: 'Call logging', voice: 'Voice', bot: 'Your bot', done: 'All set',
};
const SKIPPABLE = new Set(['signin', 'voice']);
let i = 0;

const $ = (id) => document.getElementById(id);
const dots = $('dots');
steps.forEach(() => { const d = document.createElement('span'); dots.appendChild(d); });

function render() {
  const step = steps[i];
  document.querySelectorAll('section[data-step]').forEach((s) => s.classList.toggle('active', s.dataset.step === step));
  $('stepTitle').textContent = TITLE[step] || '';
  [...dots.children].forEach((d, n) => { d.className = n < i ? 'done' : n === i ? 'active' : ''; });
  $('backBtn').style.visibility = i === 0 ? 'hidden' : 'visible';
  $('skipBtn').style.display = SKIPPABLE.has(step) ? '' : 'none';
  $('nextBtn').textContent = i === steps.length - 1 ? 'Finish' : 'Next';
  if (step === 'permissions') loadPermissions();
  if (step === 'signin') loadAuth();
}

async function saveCurrent() {
  const step = steps[i];
  try {
    if (step === 'voice') await api.invoke('set-config', 'ttsApiKey', ($('elKey').value || '').trim());
    if (step === 'bot') {
      const name = ($('botName').value || '').trim();
      if (name) await api.invoke('set-config', 'botName', name);
    }
  } catch (e) { console.warn('save failed', e); }
}

async function go(delta) {
  await saveCurrent();
  i = Math.max(0, Math.min(steps.length - 1, i + delta));
  render();
}

$('nextBtn').addEventListener('click', async () => {
  if (i === steps.length - 1) { await saveCurrent(); await api.invoke('onboarding:finish'); return; }
  await go(1);
});
$('backBtn').addEventListener('click', () => go(-1));
$('skipBtn').addEventListener('click', () => go(1));

// ── permissions ──────────────────────────────────────────────────────────
async function loadPermissions() {
  const list = $('permList');
  let state;
  try { state = await api.invoke('onboarding:get-permissions'); } catch { list.textContent = 'Could not read permissions.'; return; }
  list.innerHTML = '';
  for (const p of state.rows) {
    const row = document.createElement('div'); row.className = 'prow';
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.innerHTML = `<div class="name">${p.label}<span class="${p.required ? 'req' : 'opt'}">${p.required ? 'required' : 'optional'}</span></div><div class="why">${p.why}</div>`;
    const right = document.createElement('div');
    if (p.granted) {
      right.innerHTML = '<span class="status ok">✓ Granted</span>';
    } else if (p.needsSystemSettings) {
      const b = document.createElement('button'); b.className = 'btn ghost'; b.textContent = 'Open System Settings';
      b.onclick = () => api.invoke('onboarding:open-system-settings', p.key);
      right.appendChild(b);
    } else {
      const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Grant';
      b.onclick = async () => { b.disabled = true; b.textContent = '…'; await api.invoke('onboarding:request-permission', p.key); loadPermissions(); };
      right.appendChild(b);
    }
    row.appendChild(meta); row.appendChild(right); list.appendChild(row);
  }
}

// ── sign-in ──────────────────────────────────────────────────────────────
async function loadAuth() {
  let auth;
  try { auth = await api.invoke('check-auth'); } catch { auth = null; }
  const signedIn = !!(auth && (auth.signedIn || auth.email || auth.ok));
  $('authStatus').textContent = signedIn
    ? `Signed in${auth.email ? ' as ' + auth.email : ''}. ✓`
    : 'Not signed in — the whiteboard is disabled until you sign in.';
  $('signInBtn').style.display = signedIn ? 'none' : '';
  $('signOutBtn').style.display = signedIn ? '' : 'none';
}
$('signInBtn').addEventListener('click', async () => { try { await api.invoke('login'); } catch {} setTimeout(loadAuth, 1500); });
$('signOutBtn').addEventListener('click', async () => { try { await api.invoke('logout'); } catch {} setTimeout(loadAuth, 500); });

// ── logging consent ──────────────────────────────────────────────────────
function paintLog(v) {
  $('logState').textContent = v === true ? 'Logging is ON.' : v === false ? 'Logging is OFF.' : 'Not set.';
  $('logYes').classList.toggle('btn', v !== true); $('logNo').classList.toggle('btn', v !== false);
}
$('logYes').addEventListener('click', async () => { await api.invoke('set-config', 'remoteLogging', true); paintLog(true); });
$('logNo').addEventListener('click', async () => { await api.invoke('set-config', 'remoteLogging', false); paintLog(false); });

// ── voice / bot ──────────────────────────────────────────────────────────
$('getKeyLink').addEventListener('click', (e) => { e.preventDefault(); api.invoke('onboarding:open-url', 'https://elevenlabs.io/app/settings/api-keys'); });
$('previewVoice').addEventListener('click', () => api.send('play-speech-test'));

// ── initial load ─────────────────────────────────────────────────────────
(async () => {
  try {
    const cfg = await api.invoke('get-config', ['botName', 'ttsApiKey', 'remoteLogging']);
    if (cfg) {
      $('botName').value = cfg.botName || '';
      $('elKey').value = cfg.ttsApiKey || '';
      paintLog(cfg.remoteLogging);
    }
  } catch (e) { console.warn('initial load failed', e); }
  render();
})();
