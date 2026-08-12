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
  // 'Brains' rather than 'Claude Code' (#231): the step now asks which agent
  // drives the bot, and naming it after one of the three answers made the other
  // two look like afterthoughts. The step KEY stays 'claude' — it is referenced
  // by SKIPPABLE, the skip-confirm and the section's data-step.
  logging: 'Call logging', voice: 'Voice key', claude: 'Brains', done: 'All set',
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
  if (step === 'claude') { loadClaude(); loadAgentBackend(); }
  if (step === 'voice') loadVoiceGift();
}

// #231: which agent drives bots on this machine. Only 'claude' makes the app
// responsible for launching it, and only then do the install / sign-in warnings
// apply — so the rest of this step is irrelevant to anyone who answers otherwise.
const AGENT_BACKEND_HINT = {
  claude: '',
  codex: 'The app will add its MCP server to Codex. Restart Codex after setup; the app won\u2019t launch it for you or ask about Claude Code.',
  other: 'Anything that speaks MCP can drive a bot. The app will give you the connection details instead of managing an agent, and won\u2019t ask about Claude Code again.',
};

function paintAgentBackendHint() {
  const sel = $('agentBackend');
  const hint = $('agentBackendHint');
  if (!sel || !hint) return;
  hint.textContent = AGENT_BACKEND_HINT[sel.value] || '';
  // HIDDEN, not dimmed. Dimming still shows someone an install button for a
  // product they just said they aren't using, and invites a click that would do
  // the wrong thing. loadClaude() manages the rows INSIDE this block, so hiding
  // the wrapper leaves that logic untouched.
  const setup = $('claudeSetup');
  if (setup) setup.style.display = sel.value === 'claude' ? '' : 'none';
}

async function loadAgentBackend() {
  try {
    const cfg = await api.invoke('get-config', ['agentBackend']);
    const sel = $('agentBackend');
    if (sel && cfg?.agentBackend) sel.value = cfg.agentBackend;
  } catch { /* leave the default selected */ }
  paintAgentBackendHint();
}
$('agentBackend')?.addEventListener('change', paintAgentBackendHint);

async function saveCurrent() {
  // Whatever is on screen is the choice.
  const step = steps[i];
  try {
    if (step === 'voice') {
      await api.invoke('set-config', 'ttsApiKey', ($('elKey').value || '').trim());
      // '' is a real choice ("Don't change it"), so this is set unconditionally.
      await api.invoke('set-config', 'captionLanguage', $('captionLanguage').value);
    }
    if (step === 'claude') {
      const backend = $('agentBackend')?.value;
      if (backend) await api.invoke('set-config', 'agentBackend', backend);
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
  //
  // #231: nor does it apply once someone has SAID they use something else. The
  // warning's premise is "you will have nothing driving your bot" — which is
  // simply false for a Codex or LM Studio user, and telling them otherwise is
  // how a warning becomes noise. Skip used to be the only way to express this;
  // now it can be stated, so it is honoured here.
  const backendSel = $('agentBackend');
  const appManagesAgent = !backendSel || backendSel.value === 'claude';
  if (steps[i] === 'claude' && !claudeIsGreen && appManagesAgent) {
    const proceed = await api.invoke('onboarding:confirm-skip-claude', { installed: claudeState.installed });
    if (!proceed) return;
  }
  if (i === steps.length - 1) { await saveCurrent(); await api.invoke('onboarding:finish'); return; }
  await go(1);
});
$('backBtn').addEventListener('click', () => go(-1));
$('skipBtn').addEventListener('click', () => go(1));

// Finish the wizard exactly as "Finish" does (saves + closes + shows the main
// window), then immediately start the guided call instead of leaving the user
// at an idle panel with just the /join-call instructions.
$('runSetupCallBtn')?.addEventListener('click', async () => {
  await saveCurrent();
  await api.invoke('onboarding:finish');
  await api.invoke('create-and-join-meet', { onboardingCall: true });
});

// ── permissions ──────────────────────────────────────────────────────────
async function loadPermissions() {
  const list = $('permList');
  let state;
  try { state = await api.invoke('onboarding:get-permissions'); } catch { list.textContent = 'Could not read permissions.'; return; }
  list.innerHTML = '';
  // Both remaining permissions are macOS-only, so everywhere else this list is
  // empty. An empty step reads as a broken page; say so instead.
  if (!state.rows.length) {
    list.innerHTML = '<div class="hint">Nothing to grant on this system &mdash; the permissions this step covers are macOS-only.</div>';
    return;
  }
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

// ── ElevenLabs key ───────────────────────────────────────────────────────
// The key is a credential, not something spoken, so it stays a wizard field;
// picking the actual voice now happens live in the guided onboarding call.
// Persist via update-tts-config (same as the panel and App Settings), not a
// bare set-config, so a key typed here also gets verified, announced, and
// marked ttsApiKeySource:'byo' — without that mark, pasting your OWN key over
// a gifted one here would leave it looking gifted, and logging out would wipe
// a key you actually typed yourself (see clearGiftedTtsKey in main.js).
let savedVoiceCfg = null;
$('elKey').addEventListener('change', () => {
  api.send('update-tts-config', { apiKey: ($('elKey').value || '').trim() });
  // Repaint immediately from the already-fetched grant (no need to re-fetch —
  // a local edit doesn't change what the SERVER granted, only whether it
  // matches). A live clear stays empty rather than auto-refilling; see the
  // note on paintElKeyGift below.
  paintElKeyGift(lastTtsGrant, ($('elKey').value || '').trim());
});
// #273: same stateless rule as App Settings (see the note above applyGrant in
// main.js) — an empty field is filled in automatically the moment this STEP
// is shown (not on a live edit, so clearing the field to type your own key
// isn't fought); a field holding something else gets a one-click offer.
// Signin comes before this step in the wizard, so by the time someone reaches
// it they're either signed in (a grant may exist) or skipped signin (no grant
// — this just quietly does nothing).
let lastTtsGrant = null;
function paintElKeyGift(grant, currentKey) {
  const isGiftActive = !!grant?.granted && currentKey === grant.apiKey;
  const notice = $('elKeyGiftedNotice');
  if (notice) notice.style.display = isGiftActive ? '' : 'none';
  const section = $('elKeyGiftSection');
  if (!section) return;
  const offerable = !!grant?.granted && !isGiftActive;
  section.style.display = offerable ? '' : 'none';
  if (offerable) {
    $('elKeyGiftDesc').textContent = currentKey
      ? "You've been gifted a voice key — use it instead?"
      : "You've been gifted a voice key — zero setup, ready to speak.";
    $('elKeyGiftBtn').textContent = currentKey ? 'Use gifted key' : 'Use it';
  }
}
async function loadVoiceGift() {
  try {
    const { grant } = await api.invoke('get-tts-grant');
    lastTtsGrant = grant;
    let currentKey = ($('elKey').value || '').trim();
    if (grant?.granted && !currentKey) {
      const r = await api.invoke('accept-tts-grant');
      if (r?.ok) {
        const cfg = await api.invoke('get-config', ['ttsApiKey']);
        currentKey = cfg?.ttsApiKey || '';
        $('elKey').value = currentKey;
      }
    }
    paintElKeyGift(grant, currentKey);
  } catch { /* non-fatal */ }
}
$('elKeyGiftBtn')?.addEventListener('click', async () => {
  const btn = $('elKeyGiftBtn');
  btn.disabled = true;
  try {
    const r = await api.invoke('accept-tts-grant');
    if (r?.ok) {
      const cfg = await api.invoke('get-config', ['ttsApiKey']);
      $('elKey').value = cfg?.ttsApiKey || '';
      paintElKeyGift(lastTtsGrant, $('elKey').value);
    }
  } finally {
    btn.disabled = false;
  }
});
$('getKeyLink').addEventListener('click', (e) => { e.preventDefault(); api.invoke('onboarding:open-url', 'https://elevenlabs.io/app/settings/api-keys'); });
$('keyPermissionsLink')?.addEventListener('click', (e) => { e.preventDefault(); api.invoke('onboarding:open-url', 'https://vibeconferencing.com/onboarding/elevenlabs-key-setup'); });

// A suggested name for a brand-new bot, picked at random from the same pool the
// old in-wizard name spinner drew from. Main picks it — it knows which names
// are already in use, and two wizards open at once must not land on the same
// one. There's no UI step for this anymore (the guided onboarding call is where
// naming now happens live), but a bot still needs SOME name to show on its Meet
// tile before that call runs, so one is chosen silently rather than left as the
// schema default "Unnamed bot".
async function suggestName(exclude = []) {
  try {
    const r = await api.invoke('onboarding:suggest-bot-name', { exclude });
    return (r && r.name) || '';
  } catch { return ''; }
}

// ── initial load ─────────────────────────────────────────────────────────
(async () => {
  try {
    savedVoiceCfg = await api.invoke('get-config', ['botName', 'ttsApiKey', 'remoteLogging', 'captionLanguage']);
    if (savedVoiceCfg) {
      // Silently name the bot if it has none yet, so it isn't stuck as "Unnamed
      // bot" until the guided call runs (which is optional — "Finish" alone
      // still works). "no name yet" CANNOT be tested with `saved || suggestName()`:
      // get-config fills unset prefs with their schema default, so botName comes
      // back as the string 'Unnamed bot' rather than undefined — always truthy.
      // Compare against the default instead.
      const saved = (savedVoiceCfg.botName || '').trim();
      const unnamed = !saved || saved === DEFAULT_BOT_NAME;
      if (unnamed) {
        const name = await suggestName();
        if (name) await api.invoke('set-config', 'botName', name);
      }
      // No empty option to fall back to anymore (#see the wizard's captionLanguage
      // note) — an unset preference defaults the picker to English rather than
      // landing on nothing selected.
      if ($('captionLanguage')) $('captionLanguage').value = savedVoiceCfg.captionLanguage || 'en-US';
      $('elKey').value = savedVoiceCfg.ttsApiKey || '';
      paintLog(savedVoiceCfg.remoteLogging);
    }
  } catch (e) { console.warn('initial load failed', e); }
  render();
})();
