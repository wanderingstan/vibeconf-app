// onboarding.js — renderer for the first-run setup wizard. The pure step/permission
// model lives in electron-app/onboarding-flow.js and is surfaced over IPC
// (onboarding:*); config reads/writes reuse get-config/set-config; sign-in reuses
// check-auth/login/logout; voice preview reuses play-speech-test.
const api = window.electronAPI;

// Mirrors DEFAULT_BOT_NAME in electron-app/preferences-schema.js. The renderer
// can't require() it, so a test pins the two together — if they drift, the
// wizard silently stops suggesting names again.
const DEFAULT_BOT_NAME = 'Unnamed bot';

const steps = [...document.querySelectorAll('section[data-step]')].map((s) => s.dataset.step);
const TITLE = {
  welcome: 'Welcome', permissions: 'Permissions', signin: 'Sign in',
  logging: 'Call logging', voice: 'Voice', bot: 'Your bot', claude: 'Claude Code', done: 'All set',
};
// claude is skippable (you CAN finish without it, but the bot won't run until it's
// installed) — the step says so; signin/voice are the other optional steps.
const SKIPPABLE = new Set(['signin', 'voice', 'claude']);
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
  if (step === 'bot') loadEmojiSet();
  if (step === 'claude') loadClaude();
}

async function saveCurrent() {
  // Whatever is on screen is the choice. Also stops the wheel rewriting a field
  // the user has navigated away from.
  stopSpin();
  const step = steps[i];
  try {
    if (step === 'voice') {
      await api.invoke('set-config', 'ttsApiKey', ($('elKey').value || '').trim());
      // '' is a real choice ("Don't change it"), so this is set unconditionally
      // rather than guarded by truthiness the way botName is.
      await api.invoke('set-config', 'captionLanguage', $('captionLanguage').value);
    }
    if (step === 'bot') {
      const name = ($('botName').value || '').trim();
      if (name) await api.invoke('set-config', 'botName', name);
      const emojiSet = $('emojiSet').value;
      if (emojiSet) await api.invoke('set-config', 'emojiSet', emojiSet);
    }
  } catch (e) { console.warn('save failed', e); }
}

async function go(delta) {
  await saveCurrent();
  i = Math.max(0, Math.min(steps.length - 1, i + delta));
  render();
}

$('nextBtn').addEventListener('click', async () => {
  // Moving off the Claude step without Claude Code is the one way to finish this
  // wizard and still have nothing that works — the app is a bot host, and without
  // an agent driving it there is nothing to drive. Say so once, rather than
  // letting it be discovered later as "the app is broken".
  //
  // Next only, not Skip: Skip is the deliberate "I know, I have another agent"
  // escape hatch, and warning on it would just train people to dismiss warnings.
  if (steps[i] === 'claude' && !claudeIsGreen) {
    const proceed = await api.invoke('onboarding:confirm-skip-claude', { installed: claudeState.installed });
    if (!proceed) return;
  }
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
  // check-auth returns { authenticated, user: { email, name } } (see /api/auth/me).
  const signedIn = !!(auth && auth.authenticated);
  const who = auth?.user?.email || auth?.user?.name || '';
  $('authStatus').textContent = signedIn
    ? `Signed in${who ? ' as ' + who : ''}. ✓`
    : 'Not signed in. The whiteboard is disabled until you sign in.';
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

// ── emoji set (chosen alongside the bot name) ──────────────────────────────
async function loadEmojiSet() {
  try {
    const cur = await api.invoke('get-config', 'emojiSet');
    const val = (cur && typeof cur === 'object') ? cur.emojiSet : cur;
    if (val) $('emojiSet').value = val;
  } catch { /* leave default */ }
}

// ── Claude Code (install + sign-in via the /claude-ready feedback loop) ─────
let claudeIsGreen = false;
let claudeState = { installed: false, ready: false };
function paintClaude(st) {
  if (st.ready) claudeIsGreen = true;
  claudeState = { installed: !!st.installed, ready: !!st.ready };
  const status = $('claudeStatus'), installRow = $('claudeInstallRow'), verifyRow = $('claudeVerifyRow');
  if (st.ready) {
    status.textContent = 'Ready ✓ — Claude Code is installed and signed in.';
    status.style.color = '#137333';
    installRow.style.display = 'none'; verifyRow.style.display = 'none';
  } else if (st.installed) {
    status.textContent = 'Installed. Sign in with your Claude subscription to finish.';
    status.style.color = '';
    installRow.style.display = 'none'; verifyRow.style.display = '';
  } else {
    status.textContent = 'Not installed yet.';
    status.style.color = '';
    installRow.style.display = ''; verifyRow.style.display = 'none';
  }
}
async function loadClaude() {
  let st = { installed: false, ready: false };
  try { st = await api.invoke('onboarding:claude-status'); } catch { /* noop */ }
  paintClaude(st);
  // If it's installed but not confirmed yet, silently verify your sign-in in the
  // background (headless `claude -p`) — turns green with no click if you're signed in.
  // The "Sign in & verify" button stays put in case you're not (needs interactive /login).
  if (st.installed && !st.ready) {
    $('claudeStatus').textContent = 'Installed — checking your Claude sign-in…';
    let r = null;
    try { r = await api.invoke('onboarding:auto-verify-claude'); } catch { /* noop */ }
    // If the background check was started, give its hook a moment to ping; if it hasn't
    // greened by then you're likely not signed in — revert to the "Sign in & verify" prompt.
    if (r && r.started) {
      setTimeout(() => { if (steps[i] === 'claude' && !claudeIsGreen) paintClaude({ installed: true, ready: false }); }, 20000);
    } else if (!claudeIsGreen) {
      paintClaude({ installed: true, ready: false });
    }
  }
}
$('claudeInstallBtn').addEventListener('click', async () => { await api.invoke('onboarding:install-claude'); });
$('claudeCopyLink').addEventListener('click', async (e) => { e.preventDefault(); await api.invoke('onboarding:copy-install-command'); e.target.textContent = 'copied ✓'; });
$('claudeVerifyBtn').addEventListener('click', async () => { await api.invoke('onboarding:verify-claude'); });
// The launched session's SessionStart hook pings /claude-ready → main emits 'claude-ready'.
api.on('claude-ready', () => { if (steps[i] === 'claude') paintClaude({ installed: true, ready: true }); });
// Re-check when returning from the Terminal (install finished / signed in).
window.addEventListener('focus', () => { if (steps[i] === 'claude') loadClaude(); });

// ── voice picker ───────────────────────────────────────────────────────────
// Mirrors the panel's unified picker: merge the OS's built-in voices (`say` on
// macOS, SAPI on Windows) + ElevenLabs + Voicebox into
// one dropdown, value = "mac:<name>" / "el:<id>" / "vb:<id>". Persist via
// update-tts-config (same as the panel) and audition through the local speakers
// via synth-voice-sample (NOT play-speech-test — that only plays into a live call).
let savedVoiceCfg = null;
async function populateVoices(cfg) {
  const sel = $('voiceSelect');
  if (!sel) return;
  const apiKey = ($('elKey').value || '').trim();
  const [systemResult, voicebox, elevenResult] = await Promise.all([
    api.invoke('list-system-voices').catch(() => ({ platform: '', voices: [] })),
    api.invoke('list-voicebox-profiles').catch(() => []),
    apiKey
      ? api.invoke('list-elevenlabs-voices', apiKey).catch(() => ({ voices: [], error: null }))
      : Promise.resolve({ voices: [], error: null }),
  ]);
  // A scoped key missing `voices_read` lists nothing while TTS still works —
  // say so here, or the wizard silently looks like the key didn't take.
  const eleven = elevenResult?.voices || [];
  const elErr = $('elVoiceError');
  if (elErr) {
    elErr.textContent = elevenResult?.error ? '⚠ ' + elevenResult.error.message : '';
    elErr.style.display = elevenResult?.error ? 'block' : 'none';
  }
  let selected = sel.value;
  if (cfg) {
    const p = cfg.ttsProvider || ''; const vb = cfg.voiceboxProfileId || '';
    const el = cfg.ttsVoiceId || ''; const mac = cfg.macosVoice || 'Daniel';
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
  const sysList = Array.isArray(systemResult?.voices) ? systemResult.voices : [];
  const osName = systemResult?.platform === 'win32' ? 'Windows'
    : systemResult?.platform === 'darwin' ? 'macOS' : 'system';
  // main tiers them (0 Premium / 1 Enhanced-or-SAPI / 2 plain); the regex is the
  // fallback for the shape older builds returned.
  const tierOf = (v) => (v.tier != null ? v.tier : /\(Premium\)/i.test(v.name) ? 0 : /\(Enhanced\)/i.test(v.name) ? 1 : 2);
  // Keep in sync with WHITELISTED_MACOS_STANDARD in panel.js / mcp-server/server.js.
  const white = (n) => ['Daniel', 'Samantha', 'Karen'].some((w) => n === w || n.startsWith(w + ' '));
  addGroup(`Built-in (${osName})`, sysList
    .filter((v) => tierOf(v) < 2 || white(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));
  addGroup('Other built-in (lower quality)', sysList
    .filter((v) => tierOf(v) === 2 && !white(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));
  if (!sel.options.length) sel.innerHTML = '<option value="mac:Daniel">Daniel (default)</option>';
}

function voiceSampleText() {
  const o = $('voiceSelect').selectedOptions[0];
  // ElevenLabs names read like "Brian - Deep, Resonant and Comforting". EL speaks
  // the dash as a hyphen (no pause), so turn a space-delimited dash into ". " —
  // a sentence break between the name and its description.
  const name = (o ? o.textContent : '')
    .replace(/\s*[·(].*$/, '')
    .replace(/\s+[-–—]+\s+/g, '. ')
    .trim();
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
// Same convention as the preferences panel: picking a voice persists it AND
// auditions it immediately — no separate "play" button.
$('voiceSelect').addEventListener('change', () => { persistSelectedVoice(); previewSelectedVoice(); });
// Re-list voices (unlocks ElevenLabs voices) once a key is entered; persist the
// key first so the audition path (synth-voice-sample reads the stored key) works.
$('elKey').addEventListener('change', async () => {
  const key = ($('elKey').value || '').trim();
  try { await api.invoke('set-config', 'ttsApiKey', key); } catch {}
  populateVoices();
});
$('getKeyLink').addEventListener('click', (e) => { e.preventDefault(); api.invoke('onboarding:open-url', 'https://elevenlabs.io/app/settings/api-keys'); });
$('voiceboxLink').addEventListener('click', (e) => { e.preventDefault(); api.invoke('onboarding:open-url', 'https://github.com/jamiepine/voicebox'); });

// A suggested name for a brand-new bot. Main picks it — it knows which names are
// already in use, and two wizards open at once must not land on the same one.
// Falls back to empty rather than blocking the wizard if the call fails: the old
// behaviour, which is worse but still usable.
async function suggestName(exclude = []) {
  try {
    const r = await api.invoke('onboarding:suggest-bot-name', { exclude });
    return (r && r.name) || '';
  } catch { return ''; }
}

async function suggestNames(count, exclude = []) {
  try {
    const r = await api.invoke('onboarding:suggest-bot-name', { exclude, count });
    return (r && r.names) || [];
  } catch { return []; }
}

// ── Name spinner ─────────────────────────────────────────────────────────
// Spin/Stop, like a game show wheel. Naming a bot is the one genuinely playful
// moment in an otherwise administrative wizard, so it is worth the few lines.
//
// Stop keeps EXACTLY the name on screen — no deceleration, no settling on a
// different one. A wheel that coasts past what you were looking at when you hit
// the button is infuriating, and here it would also mean the button lied about
// what you were choosing.
// 180ms (~5.5/sec) is TUNED, not arbitrary. The goal is a wheel you can almost
// but not quite stop on a name you liked.
//
// Simple visual reaction time is ~250ms: see a name, decide, click. At 180ms
// roughly one and a half names pass while you react, so you land just past your
// target — near enough to feel like skill, far enough to stay a game. Tried at
// 220ms first and it was too catchable.
//
// Both directions ruin it. Much faster (100ms) and 2–3 names pass before the
// click registers, so it is pure chance and the names blur unread. Much slower
// (400ms+) and anyone can hit exactly the one they want, which makes the button
// a slow dropdown. Resist "fixing" this to feel snappier or fairer.
const SPIN_MS = 180;
const SPIN_BATCH = 120;     // names per spin — long enough that a spin rarely runs out
let spinTimer = null;
let spinNames = [];
let spinIdx = 0;

function spinning() { return spinTimer !== null; }

// Paint one name into the overlay, restarting the animation each time.
//
// The span is REPLACED rather than having its text changed: re-triggering a CSS
// animation on a live element needs a reflow hack, and at this rate any missed
// restart shows as a name that appears without moving.
function rollTo(name) {
  const roll = $('botNameRoll');
  if (!roll) return;
  const span = document.createElement('span');
  span.textContent = name;
  roll.replaceChildren(span);
}

function stopSpin() {
  if (!spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = null;
  $('botNameWrap')?.classList.remove('spinning');
  $('botNameRoll')?.replaceChildren();
  const btn = $('botNameShuffle');
  if (btn) { btn.textContent = 'Spin'; btn.title = 'Spin for a name'; }
}

async function startSpin() {
  const btn = $('botNameShuffle');
  if (!btn) return;
  btn.disabled = true;
  try {
    // One batch per spin, cycled locally — an IPC round trip per frame would
    // make the wheel stutter.
    const names = await suggestNames(SPIN_BATCH, [$('botName').value]);
    if (!names.length) return;                 // nothing to spin; leave the field alone
    spinNames = names;
    spinIdx = 0;
    btn.textContent = 'Stop';
    btn.title = 'Keep the name showing';
    // The animation has to finish within one tick or names would overlap.
    $('botNameRoll')?.style.setProperty('--roll-ms', `${SPIN_MS}ms`);
    $('botNameWrap')?.classList.add('spinning');

    const tick = () => {
      const name = spinNames[spinIdx % spinNames.length];
      // The real input is updated too, under the overlay — so Stop is just
      // "hide the overlay", with no chance of the field and the visible name
      // disagreeing about what was chosen.
      $('botName').value = name;
      rollTo(name);
      spinIdx++;
    };
    tick();                              // paint immediately; don't wait a tick to start
    spinTimer = setInterval(tick, SPIN_MS);
  } finally {
    btn.disabled = false;
  }
}

$('botNameShuffle')?.addEventListener('click', () => {
  if (spinning()) { stopSpin(); $('botName').focus(); return; }
  startSpin();
});

// Typing beats spinning — otherwise the wheel overwrites what someone has begun
// to type, which feels like the app fighting them.
$('botName')?.addEventListener('focus', stopSpin);
$('botName')?.addEventListener('keydown', stopSpin);

// ── initial load ─────────────────────────────────────────────────────────
(async () => {
  try {
    savedVoiceCfg = await api.invoke('get-config', ['botName', 'ttsApiKey', 'remoteLogging', 'ttsProvider', 'ttsVoiceId', 'macosVoice', 'voiceboxProfileId', 'captionLanguage']);
    if (savedVoiceCfg) {
      // Pre-fill a suggestion when this bot has no name yet, so the field is
      // never empty. An empty field is what produced "Unnamed bot" on someone's
      // Meet tile: saveCurrent() only writes a non-blank name, so skipping the
      // step fell through to the schema default (#187).
      //
      // "no name yet" CANNOT be tested with `|| suggestName()`. get-config fills
      // unset prefs with their schema default, so botName comes back as the
      // string 'Unnamed bot' rather than undefined — always truthy, so the
      // suggestion never ran and every fresh profile pre-filled with the exact
      // name this feature exists to avoid. Compare against the default instead.
      const saved = (savedVoiceCfg.botName || '').trim();
      const unnamed = !saved || saved === DEFAULT_BOT_NAME;
      $('botName').value = unnamed ? await suggestName() : saved;
      if ($('captionLanguage')) $('captionLanguage').value = savedVoiceCfg.captionLanguage || '';
      $('elKey').value = savedVoiceCfg.ttsApiKey || '';
      paintLog(savedVoiceCfg.remoteLogging);
    }
  } catch (e) { console.warn('initial load failed', e); }
  populateVoices(savedVoiceCfg);
  render();
})();
