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
// Login opens vibeconferencing.com in a browser; the app receives the token
// asynchronously when the user finishes. So a single check right after the
// click is too early — poll until signed in (and re-check on window focus, for
// when the user completes login and switches back to this window).
let authPollTimer = null;
function stopAuthPoll() { if (authPollTimer) { clearInterval(authPollTimer); authPollTimer = null; } }
async function loadAuth() {
  let auth;
  try { auth = await api.invoke('check-auth'); } catch { auth = null; }
  const signedIn = !!(auth && (auth.signedIn || auth.email || auth.ok));
  $('authStatus').textContent = signedIn
    ? `Signed in${auth.email ? ' as ' + auth.email : ''}. ✓`
    : 'Not signed in — the whiteboard is disabled until you sign in.';
  $('signInBtn').style.display = signedIn ? 'none' : '';
  $('signOutBtn').style.display = signedIn ? '' : 'none';
  if (signedIn) stopAuthPoll();
}
$('signInBtn').addEventListener('click', async () => {
  try { await api.invoke('login'); } catch {}
  stopAuthPoll();
  let tries = 0;
  authPollTimer = setInterval(async () => { tries += 1; await loadAuth(); if (tries > 60) stopAuthPoll(); }, 2000);
});
$('signOutBtn').addEventListener('click', async () => { try { await api.invoke('logout'); } catch {} setTimeout(loadAuth, 500); });
window.addEventListener('focus', () => { if (steps[i] === 'signin') loadAuth(); });

// ── logging consent ──────────────────────────────────────────────────────
// Highlight the chosen button via a `.selected` class — never by adding/removing
// `.btn`, which also carries `flex:1` (removing it made the buttons different widths).
function paintLog(v) {
  $('logState').textContent = v === true ? 'Logging is ON.' : v === false ? 'Logging is OFF.' : 'Not set.';
  $('logYes').classList.toggle('selected', v === true);
  $('logNo').classList.toggle('selected', v === false);
}
$('logYes').addEventListener('click', async () => { await api.invoke('set-config', 'remoteLogging', true); paintLog(true); });
$('logNo').addEventListener('click', async () => { await api.invoke('set-config', 'remoteLogging', false); paintLog(false); });

// ── voice picker ───────────────────────────────────────────────────────────
// Mirrors the panel's unified picker: merge macOS + ElevenLabs + Voicebox into
// one dropdown, value = "mac:<name>" / "el:<id>" / "vb:<id>". Persist via
// update-tts-config (same as the panel) and audition through the local speakers
// via synth-voice-sample (NOT play-speech-test — that only plays into a live call).
let savedVoiceCfg = null;
async function populateVoices(cfg) {
  const sel = $('voiceSelect');
  if (!sel) return;
  const apiKey = ($('elKey').value || '').trim();
  const [macos, voicebox, eleven] = await Promise.all([
    api.invoke('list-macos-voices').catch(() => []),
    api.invoke('list-voicebox-profiles').catch(() => []),
    apiKey ? api.invoke('list-elevenlabs-voices', apiKey).catch(() => []) : Promise.resolve([]),
  ]);
  let selected = sel.value;
  if (cfg) {
    const p = cfg.ttsProvider || ''; const vb = cfg.voiceboxProfileId || '';
    const el = cfg.ttsVoiceId || ''; const mac = cfg.macosVoice || 'Samantha';
    if (p === 'voicebox' && vb) selected = 'vb:' + vb;
    else if (p === 'elevenlabs' && el) selected = 'el:' + el;
    else if (p === 'macos-say') selected = 'mac:' + mac;
    else if (el && apiKey) selected = 'el:' + el;
    else selected = 'mac:' + mac;
  }
  sel.innerHTML = '';
  const addGroup = (label, items) => {
    if (!items.length) return;
    const og = document.createElement('optgroup'); og.label = label;
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.value; o.textContent = it.text;
      if (it.engine) o.dataset.engine = it.engine;
      if (it.value === selected) o.selected = true;
      og.appendChild(o);
    }
    sel.appendChild(og);
  };
  addGroup('Voicebox (local)', (Array.isArray(voicebox) ? voicebox : []).map((p) => ({
    value: 'vb:' + p.id,
    text: `${p.name} (${p.preset_engine || p.default_engine || 'engine'})`,
    engine: p.preset_engine || p.default_engine || '',
  })));
  addGroup('ElevenLabs', (Array.isArray(eleven) ? eleven : []).map((v) => ({
    value: 'el:' + v.id,
    text: v.category && v.category !== 'premade' ? `${v.name} · ${v.category}` : v.name,
  })));
  const macList = Array.isArray(macos) ? macos : [];
  const tierOf = (n) => (/\(Premium\)/i.test(n) ? 0 : /\(Enhanced\)/i.test(n) ? 1 : 2);
  const white = (n) => ['Samantha', 'Karen'].some((w) => n === w || n.startsWith(w + ' '));
  addGroup('Built-in (macOS)', macList
    .filter((v) => tierOf(v.name) < 2 || white(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));
  addGroup('Other built-in (lower quality)', macList
    .filter((v) => tierOf(v.name) === 2 && !white(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));
  if (!sel.options.length) sel.innerHTML = '<option value="mac:Samantha">Samantha (default)</option>';
}

function voiceSampleText() {
  const o = $('voiceSelect').selectedOptions[0];
  const name = (o ? o.textContent : '').replace(/\s*[·(].*$/, '').trim();
  return `Hello, my name is ${name || 'your voice assistant'}.`;
}
function currentVoiceOpts(extra) {
  const val = $('voiceSelect').value || '';
  const sep = val.indexOf(':'); const kind = val.slice(0, sep); const id = val.slice(sep + 1);
  if (kind === 'vb') {
    const engine = $('voiceSelect').selectedOptions[0]?.dataset.engine || 'kokoro';
    return { provider: 'voicebox', voiceboxProfileId: id, voiceboxEngine: engine, ...extra };
  }
  if (kind === 'el') return { provider: 'elevenlabs', voiceId: id, ...extra };
  return { provider: 'macos-say', macosVoice: id, ...extra };
}
let _sample = null;
async function previewSelectedVoice() {
  try {
    if (_sample) { try { _sample.pause(); } catch {} _sample = null; }
    const r = await api.invoke('synth-voice-sample', currentVoiceOpts({ text: voiceSampleText() }));
    if (r?.ok && r.dataUrl) { _sample = new Audio(r.dataUrl); _sample.play().catch(() => {}); }
  } catch {}
}
function persistSelectedVoice() {
  // voiceboxProfileId:'' clears any prior Voicebox pick so providers don't fight.
  const opts = currentVoiceOpts({});
  if (opts.provider !== 'voicebox') opts.voiceboxProfileId = '';
  api.send('update-tts-config', opts);
}
$('voiceSelect').addEventListener('change', () => { persistSelectedVoice(); previewSelectedVoice(); });
$('previewVoice').addEventListener('click', previewSelectedVoice);
$('previewVoice2').addEventListener('click', previewSelectedVoice);
// Re-list voices (unlocks ElevenLabs voices) once a key is entered; persist the
// key first so the audition path (synth-voice-sample reads the stored key) works.
$('elKey').addEventListener('change', async () => {
  const key = ($('elKey').value || '').trim();
  try { await api.invoke('set-config', 'ttsApiKey', key); } catch {}
  populateVoices();
});
$('getKeyLink').addEventListener('click', (e) => { e.preventDefault(); api.invoke('onboarding:open-url', 'https://elevenlabs.io/app/settings/api-keys'); });

// ── initial load ─────────────────────────────────────────────────────────
(async () => {
  try {
    savedVoiceCfg = await api.invoke('get-config', ['botName', 'ttsApiKey', 'remoteLogging', 'ttsProvider', 'ttsVoiceId', 'macosVoice', 'voiceboxProfileId']);
    if (savedVoiceCfg) {
      $('botName').value = savedVoiceCfg.botName || '';
      $('elKey').value = savedVoiceCfg.ttsApiKey || '';
      paintLog(savedVoiceCfg.remoteLogging);
    }
  } catch (e) { console.warn('initial load failed', e); }
  populateVoices(savedVoiceCfg);
  render();
})();
