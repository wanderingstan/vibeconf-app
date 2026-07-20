// panel.js — Control panel for the Electron app.
// Adapted from popup.js — uses window.electronAPI instead of chrome.* APIs.

const api = window.electronAPI;

const joinBtn = document.getElementById('joinBtn');
const meetUrlInput = document.getElementById('meetUrl');
const connectedSection = document.getElementById('connectedSection');
const callUrlDisplay = document.getElementById('callUrlDisplay');
const copyCallUrlBtn = document.getElementById('copyCallUrlBtn');
// Copy the current call's URL for inviting others (#panel-cleanup).
copyCallUrlBtn?.addEventListener('click', async () => {
  const url = (callUrlDisplay && callUrlDisplay.textContent || '').trim();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    const prev = copyCallUrlBtn.textContent;
    copyCallUrlBtn.textContent = '✓';
    setTimeout(() => { copyCallUrlBtn.textContent = prev; }, 1200);
  } catch { /* clipboard unavailable */ }
});
const meetCodeInput = document.getElementById('meetCode');
const roomIdField = document.getElementById('roomIdField');
const roomLink = document.getElementById('roomLink');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const agentPromptText = document.getElementById('agentPromptText');
const transcriptArea = document.getElementById('transcriptArea');
const errorBar = document.getElementById('errorBar');
const rawCaptionText = document.getElementById('rawCaptionText');
const speakTextInput = document.getElementById('speakText');
const speakTextBtn = document.getElementById('speakTextBtn');
const speechBtn = document.getElementById('speechBtn');
const curlCommand = document.getElementById('curlCommand');
const copyCurlBtn = document.getElementById('copyCurlBtn');
const micWarn = document.getElementById('micPermissionWarning');
const shareWhiteboardBtn = document.getElementById('shareWhiteboardBtn');
const meetSignInBtn = document.getElementById('meetSignInBtn');
const meetSignOutBtn = document.getElementById('meetSignOutBtn');
const meetModeIndicator = document.getElementById('meetModeIndicator');
const slackSignInBtn = document.getElementById('slackSignInBtn');
const slackSignOutBtn = document.getElementById('slackSignOutBtn');

// Settings
const botNameInput = document.getElementById('botName');
const websiteUrlInput = document.getElementById('websiteUrl');
const ttsApiKeyInput = document.getElementById('ttsApiKey');
const ttsVoiceIdInput = document.getElementById('ttsVoiceId');
const unifiedVoiceSelect = document.getElementById('unifiedVoice'); // #340 merged picker
const refreshVoicesBtn = document.getElementById('refreshVoicesBtn');
const claudeWorkDirInput = document.getElementById('claudeWorkDir');
const claudeModelInput = document.getElementById('claudeModel');
const emojiSetInput = document.getElementById('emojiSet');
const dangerousModeInput = document.getElementById('dangerousMode');
const ackShortMinInput = document.getElementById('ackShortMin');
const ackLongMinInput = document.getElementById('ackLongMin');
const ackShortPhrasesInput = document.getElementById('ackShortPhrases');
const ackLongPhrasesInput = document.getElementById('ackLongPhrases');

let syncBaseUrl = 'http://127.0.0.1:7865';
let currentBotName = 'Jimmy';
let appProfileName = null; // app profile (stable heading identity, #282); null for the default instance
let inCall = false;

// ---------------------------------------------------------------------------
// Screen navigation
// ---------------------------------------------------------------------------

const mainScreen = document.getElementById('mainScreen');
const settingsScreen = document.getElementById('settingsScreen');
const troubleshootingScreen = document.getElementById('troubleshootingScreen');

function showScreen(screen) {
  mainScreen.style.display = 'none';
  settingsScreen.style.display = 'none';
  troubleshootingScreen.style.display = 'none';
  screen.style.display = 'block';
}

document.getElementById('openSettingsBtn').addEventListener('click', () => {
  showScreen(settingsScreen);
  // Re-read the signed-in account each time Settings opens — the Google account
  // chip renders async, so a single fetch at panel load often missed it.
  if (typeof refreshAccountEmail === 'function') refreshAccountEmail(lastMeetMode);
});
document.getElementById('backFromSettingsBtn').addEventListener('click', () => showScreen(mainScreen));
document.getElementById('openTroubleshootingBtn').addEventListener('click', () => showScreen(troubleshootingScreen));
document.getElementById('backFromTroubleshootingBtn').addEventListener('click', () => showScreen(mainScreen));

// ── #289 panel redesign: agent-card wiring ───────────────────────────────────
// ("⊕ Add calling platform" was here; removed until there's a 3rd platform to
// add — Meet + Slack are both fixed for now. #289.)

// Render the agent avatar's background SVG layer (the same `avatarBackgroundSvg`
// pref the bot can set via MCP). Empty/unset → keep the default CSS gradient.
const agentAvatarEl = document.getElementById('agentAvatar');
async function renderAgentAvatar() {
  if (!agentAvatarEl) return;
  let svg = '';
  try {
    const cfg = await api.invoke('get-config', ['avatarBackgroundSvg']);
    svg = (cfg && cfg.avatarBackgroundSvg) || '';
  } catch { /* ignore — fall back to gradient */ }
  let bg = agentAvatarEl.querySelector('.agent-avatar-bg');
  if (svg && svg.trim()) {
    if (!bg) {
      bg = document.createElement('div');
      bg.className = 'agent-avatar-bg';
      agentAvatarEl.insertBefore(bg, agentAvatarEl.firstChild);
    }
    bg.innerHTML = svg;
    // The tile is square; backgrounds are authored 16:9. `object-fit: cover` in
    // the stylesheet does nothing to an INLINE <svg> — only to replaced elements
    // — so the SVG was letterboxing on its default preserveAspectRatio ("meet").
    // Force the SVG-native spelling of cover. (See renderer/svg-cover.js.)
    coverFitFirstSvg(bg);
  } else if (bg) {
    bg.remove();
  }

  // Prefer a real snapshot of the virtual-camera feed (captured while in a call,
  // main-side) over the reconstructed background+emoji — it matches what
  // participants actually see, including Runway faces. Falls back to the
  // generated look when `profileIcon` is unset.
  try {
    const c = await api.invoke('get-config', ['profileIcon']);
    const dataUrl = c && c.profileIcon;
    let photo = agentAvatarEl.querySelector('.agent-avatar-photo');
    if (dataUrl) {
      if (!photo) {
        photo = document.createElement('img');
        photo.className = 'agent-avatar-photo';
        photo.alt = '';
        agentAvatarEl.appendChild(photo);
      }
      if (photo.getAttribute('src') !== dataUrl) photo.src = dataUrl;
    } else if (photo) {
      photo.remove();
    }
  } catch { /* keep the generated look */ }
}

// Connection dots reflect whether each calling platform is signed in. We read the
// status text the existing identity pollers already maintain (✓ = signed in) so we
// don't have to re-thread that state through every update path.
// The Meet dot follows the Meet identity row's ✓ (signed-in) text. The Slack
// dot is owned by refreshSlackIdentity (cookie-authoritative).
const connMeetDot = document.getElementById('connMeetDot');
function syncConnDots() {
  const meetTxt = (document.getElementById('botIdentityStatus')?.textContent || '').trim();
  if (connMeetDot) connMeetDot.classList.toggle('on', meetTxt.startsWith('✓'));
}
setInterval(syncConnDots, 1500);
renderAgentAvatar();
// Re-render periodically so a freshly-captured profileIcon (or a background/emoji
// change) shows without a panel reload. Cheap; the icon rarely changes.
setInterval(renderAgentAvatar, 60 * 1000);

// ---------------------------------------------------------------------------
// Call State debug view — live snapshot of the app's detectors
// ---------------------------------------------------------------------------

const callStateDebug = document.getElementById('callStateDebug');

function yesNo(v) { return v ? '🟢 yes' : '⚪️ no'; }

function agoLabel(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function ackLabel(ev) {
  if (!ev) return '(none yet)';
  const ago = agoLabel(ev.at);
  const phrase = ev.phrase ? JSON.stringify(ev.phrase) : 'SKIP';
  const latency = ev.latencyMs != null ? `${ev.latencyMs}ms` : '?';
  let sourceTag;
  switch (ev.source) {
    case 'llm':                   sourceTag = '🟢 llm'; break;
    case 'llm-fallback-builtin':  sourceTag = `🔴 llm→builtin (${ev.error || 'failed'})`; break;
    case 'builtin':               sourceTag = '⚪️ builtin'; break;
    default:                      sourceTag = ev.source || '?';
  }
  return `${phrase} · ${sourceTag} · ${latency} · ${ago}`;
}

function agentLoopHealth(s) {
  if (s.activeWaiters > 0) return `🟢 listening (${s.activeWaiters} waiter${s.activeWaiters > 1 ? 's' : ''})`;
  if (!s.lastWaitForSpeechAt) return '⚪️ no wait_for_speech yet — agent may not have started the loop';
  const idleSecs = Math.round((Date.now() - s.lastWaitForSpeechAt) / 1000);
  if (idleSecs < 5) return `🟡 between waits (${idleSecs}s)`;
  if (idleSecs < 60) return `🟡 idle ${idleSecs}s — agent may be processing or speaking`;
  return `🔴 stale ${agoLabel(s.lastWaitForSpeechAt)} — agent likely stopped the wait_for_speech loop`;
}

// Health thresholds for Claude's reaction time (ms). Tune freely — mirrored in
// the camera overlay's colorFor(). <3s snappy, 3–4s noticeable lag, >4s sluggish.
const PERF_GREEN_MS = 3000;
const PERF_YELLOW_MS = 4000;
function perfDot(ms) {
  if (ms == null) return '⚪';
  if (ms < PERF_GREEN_MS) return '🟢';
  if (ms <= PERF_YELLOW_MS) return '🟡';
  return '🔴';
}

// Claude's reaction time (resolve → first speak) — last + rolling avg/p90.
// This is mostly "how fast is Claude today", independent of our code, so it
// explains a lot of the day-to-day "the bot feels snappy/sluggish" swing. The
// dot reflects the LAST value (matches the headline number beside it); avg/p90
// give the sustained picture.
function responsePerfLabel(s) {
  const p = s.responsePerf;
  if (!p || !p.count) return '⚪ — (no response timed yet)';
  const secs = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`);
  return `${perfDot(p.last)} ${secs(p.last)} (avg ${secs(p.avg)} · p90 ${secs(p.p90)} · n=${p.count})`;
}

function renderCallState(s) {
  if (!s || !s.roomId) {
    callStateDebug.textContent = 'Not in a call.';
    return;
  }
  const parts = (s.participants || []).map(p => {
    const tags = [];
    if (p.isSelf) tags.push('self');
    if (p.isBot) tags.push('bot');
    const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
    return `    • ${p.name}${tagStr} ${p.speaking ? '🗣️ speaking' : '— quiet'}`;
  });
  const queued = s.pendingBotSpeech || [];
  const queuedLines = queued.length === 0
    ? ['    (empty)']
    : queued.map((e, i) => {
        const snippet = (e.text || '').replace(/\s+/g, ' ').slice(0, 80);
        const more = (e.text || '').length > 80 ? '…' : '';
        const tag = e.emoji ? ` ${e.emoji}` : '';
        return `    ${i + 1}.${tag} "${snippet}${more}"`;
      });
  // (workingMemory / stance display removed — the two-tier experiment that
  // maintained it is parked, so the fields were always empty noise.)
  callStateDebug.textContent = [
    `Call status:        ${s.callStatus || 'unknown'}`,
    `Bot state:          ${s.botState || 'unknown'}`,
    `Bot mode:           ${s.mode || 'unknown'}`,
    `Anyone speaking:    ${yesNo(s.anyoneSpeaking)}`,
    `Screen sharing:     ${yesNo(s.sharing)}${s.someoneElsePresenting ? ` (other: ${s.presenterName || 'someone'})` : ''}`,
    `Screen share URL:   ${s.screenShareUrl || '(none)'}`,
    `People pane open:   ${yesNo(s.peoplePaneOpen)}`,
    `Chat pane open:     ${yesNo(s.chatPaneOpen)}`,
    `Unread chat:        ${yesNo(s.chatUnread)}`,
    `Screen rec perm:    ${s.screenRecording || 'unknown'}`,
    `Agent loop:         ${agentLoopHealth(s)}`,
    `Last wait_for_speech: ${agoLabel(s.lastWaitForSpeechAt)}`,
    `Claude response:    ${responsePerfLabel(s)}`,
    `Last ack:           ${ackLabel(s.lastAckEvent)}`,
    `Queued speech (${queued.length}):`,
    ...queuedLines,
    `Participants (${(s.participants || []).length}):`,
    ...(parts.length ? parts : ['    (none detected)']),
    `Agent activity (${(s.agentLog || []).length}):`,
    ...((s.agentLog || []).length ? s.agentLog.map((l) => `    ${l}`) : ['    (no agent session)']),
  ].join('\n');
}

setInterval(async () => {
  if (troubleshootingScreen.style.display === 'none') return; // only poll when visible
  try {
    const s = await api.invoke('get-call-state');
    renderCallState(s);
  } catch { /* ignore */ }
}, 1000);

// Listen for menu bar "Settings" command
api.on('show-settings', () => showScreen(settingsScreen));

// Listen for agent-triggered leave
api.on('leave-requested', () => {
  api.send('leave-meet');
  exitCallState();
});

// ---------------------------------------------------------------------------
// Meet URL validation
// ---------------------------------------------------------------------------

function isValidMeetUrl(url) {
  return /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/.test(url);
}

// A Slack workspace/channel URL — joining it switches the app to the Slack
// provider at runtime and auto-joins that channel's huddle.
function isValidSlackUrl(url) {
  return /app\.slack\.com\/client\/[^/]+\/[^/?#]+/.test(url);
}

function isJoinableUrl(url) {
  if (isValidSlackUrl(url)) return true;
  return isValidMeetUrl(url.startsWith('http') ? url : 'https://meet.google.com/' + url);
}

function updateJoinBtnState() {
  const url = meetUrlInput.value.trim();
  joinBtn.disabled = !url || !isJoinableUrl(url);
}

meetUrlInput.addEventListener('input', updateJoinBtnState);

// ---------------------------------------------------------------------------
// App version
// ---------------------------------------------------------------------------

api.invoke('get-app-version').then((info) => {
  const el = document.getElementById('appVersion');
  if (!el || !info) return;
  // Tolerate both the old string return and the new {version, packaged} shape.
  const version = typeof info === 'string' ? info : info.version;
  const packaged = typeof info === 'object' ? info.packaged : true;
  if (!version) return;
  // Source builds get a "-dev" suffix so a bare version number always means the
  // released DMG. Disambiguates "is this the DMG or pnpm dev?" at a glance (#release).
  el.textContent = `v${version}${packaged ? '' : '-dev'}`;
  el.title = packaged
    ? 'Release build (installed .app / DMG).'
    : 'Running from SOURCE (pnpm dev) — not a released build. A clean version with no “-dev” means the installed DMG.';
}).catch(() => {});

// Prefill the URL field from whatever the app is already pointed at (e.g. a
// --meet-url CLI launch), so you can tell at a glance which call this instance
// is for. The live meet-detected event handles later programmatic joins; this
// covers the case where the URL was set before the panel finished loading.
api.invoke('get-call-state').then((s) => {
  if (s && s.currentMeetUrl && !inCall && !meetUrlInput.value.trim()) {
    meetUrlInput.value = s.currentMeetUrl;
    updateJoinBtnState();
  }
}).catch(() => {});

Promise.all([
  api.invoke('get-app-profile'),
  api.invoke('get-local-port').catch(() => null),
]).then(([profile, port]) => {
  appProfileName = profile || null; // the stable heading identity (#282)
  // The profile chip is gone (it duplicated the agent-card name). Fold the
  // profile + local-server port — the "which instance is this" debug detail —
  // into the profile-name header's tooltip instead (#289).
  const big = document.getElementById('botNameBig');
  if (big) {
    const baseTitle = big.getAttribute('title') || '';
    const detail = [
      profile ? `Bot: "${profile}" (launched with --profile=${profile}) — isolated storage with its own preferences and Google login.` : 'Default bot.',
      port ? `local-server port ${port}` : null,
    ].filter(Boolean).join('\n');
    big.title = baseTitle + '\n\n' + detail;
  }
  updateBotNameBig();
}).catch(() => {});

// --- Profile switcher (#282): Chrome-style list + launch/focus. -------------
const profileMenuBtn = document.getElementById('profileMenuBtn');
const profileMenu = document.getElementById('profileMenu');

function closeProfileMenu() { if (profileMenu) profileMenu.style.display = 'none'; }

// Electron renderers don't implement window.prompt (it silently returns null),
// so use a small in-DOM modal instead. Resolves to the trimmed string, or null
// on cancel/escape. Reused by "New profile" and the navigate-webview tool.
function inlinePrompt({ title, placeholder = '', initial = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#2a2d31;border:1px solid #5f6368;border-radius:10px;padding:16px;width:min(360px,86vw);box-shadow:0 10px 40px rgba(0,0,0,0.6)';
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'color:#e8eaed;font-size:13px;margin-bottom:10px;line-height:1.4';
    const input = document.createElement('input');
    input.type = 'text'; input.value = initial; input.placeholder = placeholder;
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#202124;border:1px solid #5f6368;border-radius:6px;color:#e8eaed;padding:8px;font-size:13px;outline:none';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:none;border:1px solid #5f6368;color:#9aa0a6;border-radius:18px;padding:6px 14px;cursor:pointer';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.style.cssText = 'background:#8ab4f8;border:none;color:#202124;border-radius:18px;padding:6px 14px;font-weight:600;cursor:pointer';
    const close = (val) => { overlay.remove(); resolve(val); };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(t); box.appendChild(input); box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus(); input.select();
  });
}

// Two-field (username + masked password) dialog for an HTTP Basic/Digest auth
// challenge the bot webview hit. Resolves {user, password} on submit, or null on
// cancel. Styled to match inlinePrompt.
function basicAuthPrompt({ host = '', realm = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#2a2d31;border:1px solid #5f6368;border-radius:10px;padding:16px;width:min(360px,86vw);box-shadow:0 10px 40px rgba(0,0,0,0.6)';
    const t = document.createElement('div');
    t.textContent = `Sign in to ${host || 'this site'}`;
    t.style.cssText = 'color:#e8eaed;font-size:13px;margin-bottom:4px';
    const sub = document.createElement('div');
    sub.textContent = realm ? `This site is password-protected (${realm}). It stays signed in for the rest of the session.` : 'This site is password-protected. It stays signed in for the rest of the session.';
    sub.style.cssText = 'color:#9aa0a6;font-size:11px;margin-bottom:10px;line-height:1.4';
    const mkInput = (type, ph) => {
      const el = document.createElement('input');
      el.type = type; el.placeholder = ph;
      el.style.cssText = 'width:100%;box-sizing:border-box;background:#202124;border:1px solid #5f6368;border-radius:6px;color:#e8eaed;padding:8px;font-size:13px;outline:none;margin-bottom:8px';
      return el;
    };
    const userIn = mkInput('text', 'Username');
    const passIn = mkInput('password', 'Password');
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:none;border:1px solid #5f6368;color:#9aa0a6;border-radius:18px;padding:6px 14px;cursor:pointer';
    const ok = document.createElement('button');
    ok.textContent = 'Sign in';
    ok.style.cssText = 'background:#8ab4f8;border:none;color:#202124;border-radius:18px;padding:6px 14px;font-weight:600;cursor:pointer';
    const close = (val) => { overlay.remove(); resolve(val); };
    const submit = () => { const u = userIn.value.trim(); close(u ? { user: u, password: passIn.value } : null); };
    cancel.onclick = () => close(null);
    ok.onclick = submit;
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
    userIn.addEventListener('keydown', onKey);
    passIn.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(t); box.appendChild(sub); box.appendChild(userIn); box.appendChild(passIn); box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    userIn.focus();
  });
}

// The bot webview hit an HTTP Basic/Digest challenge — prompt the operator and
// hand the result back to main (which calls Electron's login callback).
api.on('basic-auth-prompt', async ({ id, host, realm }) => {
  const creds = await basicAuthPrompt({ host, realm });
  api.send('basic-auth-result', { id, user: creds?.user || '', password: creds?.password || '' });
});

async function doSwitchProfile(name) {
  closeProfileMenu();
  const n = (name || '').trim();
  if (!n) return;
  try {
    const r = await api.invoke('switch-profile', n);
    if (r && r.ok === false) window.alert('Could not switch bot: ' + (r.error || 'unknown'));
  } catch (e) { window.alert('Could not switch bot: ' + e.message); }
}

// #379: additive path — open a profile in a SEPARATE new window, leaving THIS
// window (and any call it's in) untouched. Reached via ⌥-click in the switcher
// and File ▸ New Profile… (the latter works even in-call).
async function doOpenProfileWindow(name) {
  closeProfileMenu();
  const n = (name || '').trim();
  if (!n) return;
  try {
    const r = await api.invoke('open-profile-window', n);
    if (r && r.ok === false) window.alert('Could not open bot window: ' + (r.error || 'unknown'));
  } catch (e) { window.alert('Could not open bot window: ' + e.message); }
}

// Menu-bar "New Profile…" → prompt for a NEW profile name (a never-seen name
// creates the profile), then open it additively in its own window. This is the
// CREATE path — distinct from "New Window", which opens the Default profile.
api.on('new-profile-prompt', async () => {
  const name = await inlinePrompt({
    title: 'New bot name (letters, numbers, . _ - only):',
    placeholder: 'e.g. alice',
    okLabel: 'Create',
  });
  if (name) doOpenProfileWindow(name);
});

// Menu-bar "New Window" → open the next profile that isn't already running (the
// app is one-window-per-profile — same bot in two calls is #393). No prompt.
api.on('new-window', async () => {
  try {
    const r = await api.invoke('open-next-available-window');
    if (r && r.ok === false) {
      if (r.error === 'all-running') window.alert('Every bot is already open in a window.');
      else window.alert('Could not open window: ' + (r.error || 'unknown'));
    }
  } catch (e) { window.alert('Could not open window: ' + e.message); }
});

function renderProfileMenu(data) {
  if (!profileMenu) return;
  profileMenu.innerHTML = '';
  const profiles = (data && data.profiles) || [];
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No saved bots yet.';
    empty.style.cssText = 'padding:6px 8px;color:#9aa0a6';
    profileMenu.appendChild(empty);
  }
  for (const p of profiles) {
    const displayName = p.isDefault ? 'Default' : p.name;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:' + (p.isCurrent ? 'default' : 'pointer');
    if (!p.isCurrent) {
      row.onmouseenter = () => { row.style.background = '#3c4043'; };
      row.onmouseleave = () => { row.style.background = ''; };
      // Default click SWITCHES this window to that profile (#379). ⌥-click opens
      // it in a SEPARATE new window instead (additive, advanced).
      row.onclick = (e) => (e.altKey ? doOpenProfileWindow(p.name) : doSwitchProfile(p.name));
    }
    // Left marker: ✓ for the current profile (so "Default" reads clearly as a
    // profile and the active one is obvious), else a running/not-running dot.
    const mark = document.createElement('span');
    mark.style.cssText = 'width:14px;flex:0 0 auto;text-align:center';
    if (p.isCurrent) {
      mark.textContent = '✓'; mark.style.color = '#8ab4f8'; mark.title = 'current bot (this window)';
    } else {
      mark.textContent = '●'; mark.style.color = p.running ? '#81c995' : '#5f6368';
      mark.title = p.running ? `running on port ${p.port}` : 'not running';
    }
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0';
    const top = document.createElement('div');
    top.textContent = displayName;
    top.style.cssText = 'font-weight:600;color:#e8eaed;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const sub = document.createElement('div');
    // Prefer the most identifying remembered fact: bound account email, then the
    // remembered Meet/Slack display name, then the Bot Name default (#282).
    sub.textContent = p.meetAccountEmail || p.lastMeetName || p.lastSlackName || p.botName || '— no account bound —';
    sub.style.cssText = 'color:#9aa0a6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.appendChild(top); label.appendChild(sub);
    // Avatar thumbnail: the profile's captured virtual-camera snapshot when it
    // has one, else a neutral monogram circle so every row aligns. Mirrors the
    // main agent avatar (profileIcon), now per-profile in the switcher.
    const avatar = document.createElement('div');
    // Rounded SQUARE (not a circle) to match the main agent avatar and show more
    // of the background — the most customizable part of the icon (emojis all read
    // about the same). 6px ≈ the main avatar's 14px/54px proportion at 24px.
    avatar.style.cssText = 'width:24px;height:24px;flex:0 0 auto;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#3c4043;color:#9aa0a6;font-size:11px;font-weight:600';
    if (p.profileIcon) {
      const img = document.createElement('img');
      img.src = p.profileIcon;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover';
      avatar.appendChild(img);
    } else {
      avatar.textContent = (displayName || '?').trim().charAt(0).toUpperCase() || '?';
    }
    row.appendChild(mark); row.appendChild(avatar); row.appendChild(label);
    profileMenu.appendChild(row);
  }
  const add = document.createElement('div');
  add.textContent = '＋ New bot…';
  add.style.cssText = 'padding:6px 8px;margin-top:4px;border-top:1px solid #5f6368;color:#8ab4f8;cursor:pointer';
  add.onclick = async (e) => {
    const additive = e.altKey; // ⌥ → open the new profile in a separate window
    closeProfileMenu();
    const name = await inlinePrompt({ title: 'New bot name (letters, numbers, . _ - only):', placeholder: 'e.g. alice', okLabel: 'Create' });
    if (name) (additive ? doOpenProfileWindow(name) : doSwitchProfile(name));
  };
  profileMenu.appendChild(add);

  // #379: discoverability hint for the additive path.
  const hint = document.createElement('div');
  hint.textContent = '⌥-click a profile to open it in a new window instead';
  hint.style.cssText = 'padding:4px 8px 2px;color:#5f6368;font-size:10px';
  profileMenu.appendChild(hint);

  // Debugging help: reveal the profiles folder so the user can delete/rename
  // profile dirs directly (#282).
  const folder = document.createElement('div');
  folder.textContent = '📂 Open profiles folder';
  folder.style.cssText = 'padding:6px 8px;color:#9aa0a6;cursor:pointer';
  folder.onmouseenter = () => { folder.style.background = '#3c4043'; };
  folder.onmouseleave = () => { folder.style.background = ''; };
  folder.onclick = () => { closeProfileMenu(); api.invoke('open-profiles-folder').catch(() => {}); };
  profileMenu.appendChild(folder);

  // Reveal the session-log folder — quick path to past calls' logs (#292).
  const logs = document.createElement('div');
  logs.textContent = '📋 Open call logs folder';
  logs.style.cssText = 'padding:6px 8px;color:#9aa0a6;cursor:pointer';
  logs.onmouseenter = () => { logs.style.background = '#3c4043'; };
  logs.onmouseleave = () => { logs.style.background = ''; };
  logs.onclick = () => { closeProfileMenu(); api.invoke('open-logs-folder').catch(() => {}); };
  profileMenu.appendChild(logs);
}

// Cache the profile-switcher data so the menu opens INSTANTLY on click. With
// ~12 profiles, list-profiles reads every profile's config + icon and probes
// each running port, which made the first (cold) open lag. Prefetch at app load,
// render from cache on click, and refresh in the background so running-status /
// freshly-captured icons stay current.
let cachedProfiles = null;
async function refreshProfilesCache() {
  try {
    cachedProfiles = await api.invoke('list-profiles');
    if (profileMenu && profileMenu.style.display === 'block') renderProfileMenu(cachedProfiles);
  } catch {
    if (!cachedProfiles && profileMenu && profileMenu.style.display === 'block') {
      profileMenu.innerHTML = '<div style="padding:6px 8px;color:#f28b82">Failed to load profiles</div>';
    }
  }
}

if (profileMenuBtn && profileMenu) {
  refreshProfilesCache(); // warm the cache at load so the first open is instant
  profileMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Test the actually-open state (=== 'block'), NOT "!== 'none'": the menu
    // starts hidden via the CSS class, so the INLINE style.display is '' on the
    // first click — "!== 'none'" was true, so the first click closed-then-returned
    // (a no-op) and only the second click opened it.
    if (profileMenu.style.display === 'block') { closeProfileMenu(); return; }
    profileMenu.style.display = 'block';
    if (cachedProfiles) renderProfileMenu(cachedProfiles);           // instant from cache
    else profileMenu.innerHTML = '<div style="padding:6px 8px;color:#9aa0a6">Loading…</div>';
    refreshProfilesCache();                                          // refresh in the background (re-renders if still open)
  });
  document.addEventListener('click', (e) => {
    if (profileMenu.style.display === 'block' && !profileMenu.contains(e.target) && e.target !== profileMenuBtn) closeProfileMenu();
  });
}

// Per-category debug overlay (#overlay). Each checkbox id matches its store key,
// so a bare loop wires them all. Health defaults on; the noisier sections off.
api.invoke('get-overlay-flags').then((flags) => {
  for (const key of Object.keys(flags || {})) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.checked = !!flags[key];
    el.addEventListener('change', () => {
      api.invoke('set-overlay-flag', key, el.checked).catch(() => {});
    });
  }
}).catch(() => {});

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

// #381: onboarding banner — the ElevenLabs key is machine-wide and now lives in
// App Settings, so surface a deep-link when voice is off instead of burying the
// field. The key can be set in the separate App Settings window, so re-check when
// this window regains focus.
const appSettingsBanner = document.getElementById('appSettingsBanner');
function updateAppSettingsBanner(hasKey) {
  if (appSettingsBanner) appSettingsBanner.style.display = hasKey ? 'none' : 'flex';
}
document.getElementById('openAppSettingsFromBanner')?.addEventListener('click', () => api.invoke('open-app-settings'));
window.addEventListener('focus', () => {
  api.invoke('get-config', ['ttsApiKey']).then((c) => updateAppSettingsBanner(!!c?.ttsApiKey)).catch(() => {});
});

api.invoke('get-config', ['botName', 'websiteUrl', 'syncBaseUrl', 'ttsApiKey', 'ttsVoiceId', 'macosVoice', 'voiceboxProfileId', 'ttsProvider', 'claudeWorkDir', 'claudeModel', 'emojiSet', 'dangerousMode', 'ackShortMin', 'ackLongMin', 'ackShortPhrases', 'ackLongPhrases', 'lastMeetName', 'lastSlackName']).then((result) => {
  if (result?.botName) { botNameInput.value = result.botName; currentBotName = result.botName; }
  rememberedMeetName = result?.lastMeetName || null;   // #282 remembered names
  rememberedSlackName = result?.lastSlackName || null;
  refreshSlackIdentity();
  try { updateBotNameBig(); } catch { /* defined below; ignore on first paint */ }
  try { updateCallIdentity(); } catch { /* defined below */ }
  // Prefer the new websiteUrl key; fall back to legacy syncBaseUrl so users with
  // older configs still see their existing override populated in the field.
  const effectiveUrl = result?.websiteUrl || result?.syncBaseUrl || '';
  if (effectiveUrl) { websiteUrlInput.value = effectiveUrl; syncBaseUrl = effectiveUrl; }
  // #366/#381: the ElevenLabs key field moved to App Settings — no input here to
  // fill. The onboarding banner still reflects whether a key is configured.
  updateAppSettingsBanner(!!result?.ttsApiKey); // #381 onboarding banner
  if (result?.ttsVoiceId) ttsVoiceIdInput.value = result.ttsVoiceId;
  // #340: one unified picker merging macOS + ElevenLabs + Voicebox. Pre-selects
  // from the saved provider/voice; defaults to Samantha (tts.js's real default).
  populateUnifiedVoices(result);
  try { refreshVoiceStatus(); } catch { /* defined below; ignore if not yet */ }
  if (result?.claudeWorkDir) claudeWorkDirInput.value = result.claudeWorkDir;
  if (result?.claudeModel) claudeModelInput.value = result.claudeModel;
  if (emojiSetInput && result?.emojiSet) emojiSetInput.value = result.emojiSet;
  if (result?.dangerousMode) dangerousModeInput.checked = true;
  if (result?.ackShortMin != null) ackShortMinInput.value = result.ackShortMin;
  if (result?.ackLongMin != null) ackLongMinInput.value = result.ackLongMin;
  if (Array.isArray(result?.ackShortPhrases)) ackShortPhrasesInput.value = result.ackShortPhrases.join('\n');
  if (Array.isArray(result?.ackLongPhrases)) ackLongPhrasesInput.value = result.ackLongPhrases.join('\n');

  // Check auth status after config is loaded (so we know the server URL)
  checkAuthStatus();
});

// #366/#381: the user (vibeconferencing.com) login moved OUT of the profile
// Settings pane — it's app-level, so it lives in App Settings (⌘,). It also
// stays on the MAIN view's user row (always shown), which this handler drives.
const userIdStatus = document.getElementById('userIdStatus');
const userSignInMainBtn = document.getElementById('userSignInMainBtn');
const userSignOutMainBtn = document.getElementById('userSignOutMainBtn');

function setUserRow(signedIn, who) {
  if (userIdStatus) {
    userIdStatus.textContent = signedIn ? who : '⚠ not signed in';
    userIdStatus.style.color = signedIn ? '#81c995' : '#fdd663';
  }
  if (userSignInMainBtn) userSignInMainBtn.style.display = signedIn ? 'none' : 'inline-block';
  if (userSignOutMainBtn) userSignOutMainBtn.style.display = signedIn ? 'inline-block' : 'none';
}

async function checkAuthStatus() {
  try {
    const data = await api.invoke('check-auth');
    if (data?.authenticated) {
      setUserRow(true, data.user?.email || data.user?.name || 'signed in');
    } else {
      setUserRow(false);
    }
  } catch {
    setUserRow(false);
  }
}

userSignInMainBtn?.addEventListener('click', async () => {
  userSignInMainBtn.disabled = true;
  userSignInMainBtn.textContent = 'Opening…';
  try { await api.invoke('login'); } catch { /* ignore */ }
  setTimeout(() => { userSignInMainBtn.disabled = false; userSignInMainBtn.textContent = 'Sign in'; checkAuthStatus(); }, 3000);
});
userSignOutMainBtn?.addEventListener('click', async () => {
  try { await api.invoke('logout'); } catch { /* ignore */ }
  checkAuthStatus();
});

// Listen for auth changes (e.g. after Google login popup closes)
api.on('auth-changed', () => {
  checkAuthStatus();
});

// ---------------------------------------------------------------------------
// Meet detection — pre-fill the URL field
// ---------------------------------------------------------------------------

api.on('meet-detected', (data) => {
  if (data && data.url && !inCall) {
    meetUrlInput.value = data.url;
    updateJoinBtnState();
  }
});

// A Slack huddle detected in the browser (about:blank window + an app.slack.com
// workspace tab). Fill the URL so the user can Join it — joining switches to the
// Slack provider at runtime (no --provider flag).
api.on('slack-huddle-detected', (data) => {
  if (data && data.url && !inCall) {
    meetUrlInput.value = data.url;
    updateJoinBtnState();
  }
});

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------

function showError(message) {
  document.getElementById('errorText').textContent = message;
  errorBar.style.display = 'flex';
}

document.getElementById('errorClose').addEventListener('click', () => {
  errorBar.style.display = 'none';
});

// ---------------------------------------------------------------------------
// Join / Leave Meet
// ---------------------------------------------------------------------------

function enterCallState(meetCode) {
  inCall = true;
  // #379: mark the panel in-call so CSS can hide pre-call-only controls (the
  // profile switcher). A single body flag keeps room for the broader pre-call vs
  // in-call UI split (#289). Also close the switcher if it happened to be open.
  document.body.dataset.callState = 'in-call';
  closeProfileMenu();
  updateCallIdentity(); // light up the "appearing as" sub-line (#282)
  connectedSection.style.display = 'block';
  joinBtn.style.display = 'none';

  // Show which call the bot is actually in (read-only) — for confirming the
  // right room and copying the invite link. Prefer the joined URL; fall back
  // to reconstructing a Meet URL from the code.
  if (callUrlDisplay) {
    const joined = (meetUrlInput && meetUrlInput.value.trim()) || '';
    callUrlDisplay.textContent = joined || (meetCode ? `https://meet.google.com/${meetCode}` : '');
  }

  // Update troubleshooting section
  meetCodeInput.value = meetCode;
  roomIdField.style.display = 'block';
  const base = syncBaseUrl || 'http://127.0.0.1:7865';
  roomLink.href = `${base}/room/${meetCode}`;
  roomLink.style.display = 'block';
  updateCurlCommand(meetCode);
  updateAgentPrompt(meetCode);
}

function exitCallState() {
  inCall = false;
  callProvider = null;
  document.body.dataset.callState = 'idle'; // #379: pre-call controls return
  updateCallIdentity(); // back to "not in a call" (#282)
  connectedSection.style.display = 'none';
  joinBtn.style.display = '';
  joinBtn.textContent = 'Join Call';
  updateJoinBtnState();

  roomIdField.style.display = 'none';
  roomLink.style.display = 'none';
}

joinBtn.addEventListener('click', () => {
  let url = meetUrlInput.value.trim();
  if (!url) return;
  if (isValidSlackUrl(url)) {
    // Runtime provider switch: build the Slack surface + auto-join the huddle.
    api.send('join-detected-slack', { url });
  } else {
    if (!url.startsWith('http')) url = 'https://meet.google.com/' + url;
    api.joinMeet(url);
  }
  joinBtn.textContent = 'Joining...';
  joinBtn.disabled = true;

  // Don't eagerly call enterCallState here — wait for the 'call-status-changed'
  // IPC to fire with 'in-call'. Otherwise the Leave Call button appears
  // before we know whether admission succeeded.

  setTimeout(() => {
    if (!inCall) {
      joinBtn.style.display = '';
      joinBtn.textContent = 'Join Call';
      updateJoinBtnState();
    }
  }, 3000);
});

meetUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
});

// Open the baked-in default testing meet in the USER's own browser (so the
// operator joins as a human alongside the bot). The app's tab-detection then
// auto-fills the URL here, ready to send the bot in too. Eases testing.
const DEFAULT_MEET_URL = 'https://meet.google.com/paz-sqoa-npe';
const defaultMeetBtn = document.getElementById('defaultMeetBtn');
defaultMeetBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  api.send('open-external-url', DEFAULT_MEET_URL);
});

document.getElementById('leaveCallBtn').addEventListener('click', () => {
  api.send('leave-meet');
  exitCallState();
});

// ---------------------------------------------------------------------------
// Share Whiteboard
// ---------------------------------------------------------------------------

shareWhiteboardBtn.addEventListener('click', async () => {
  const meetCode = meetCodeInput.value;
  if (!meetCode) { showError('Join a call first'); return; }

  shareWhiteboardBtn.textContent = 'Starting share...';
  shareWhiteboardBtn.disabled = true;

  try {
    const result = await api.invoke('share-whiteboard', { meetCode });
    if (result?.error) showError(result.error);
  } catch (err) {
    showError('Failed to share: ' + err.message);
  }

  setTimeout(() => {
    shareWhiteboardBtn.textContent = 'Share Whiteboard';
  }, 3000);
});

// ---------------------------------------------------------------------------
// Bot Google identity — guest vs account mode (#170)
// ---------------------------------------------------------------------------

const meetAccountEmail = document.getElementById('meetAccountEmail');
// Show WHICH Google account the bot is actually signed in as — surfaces the gap
// that hid #250 (mode said "account" while the bot was silently logged out).
function refreshAccountEmail(mode) {
  if (!meetAccountEmail) return;
  if (mode !== 'account') { meetAccountEmail.style.display = 'none'; return; }
  meetAccountEmail.style.display = '';
  meetAccountEmail.textContent = 'Checking signed-in account…';
  meetAccountEmail.className = 'account-email';
  api.invoke('get-meet-account-email').then((r) => {
    if (r && r.signedIn && r.email) {
      meetAccountEmail.textContent = '✓ Signed in as ' + r.email;
      meetAccountEmail.className = 'account-email email-ok';
    } else if (r && r.signedIn) {
      // Auth cookies present but we couldn't read the email — signed in for sure.
      meetAccountEmail.textContent = '✓ Signed in to Google (could not read which account)';
      meetAccountEmail.className = 'account-email email-ok';
    } else {
      meetAccountEmail.textContent = '⚠ Mode is "account" but no Google session detected — the bot may not be signed in. If joins require admission, click "Sign in to Google as bot".';
      meetAccountEmail.className = 'account-email email-bad';
    }
  }).catch(() => {
    meetAccountEmail.textContent = '(could not read signed-in account)';
    meetAccountEmail.className = 'account-email';
  });
}

let lastMeetMode = 'guest';
function applyMeetMode(mode) {
  if (!meetModeIndicator) return;
  lastMeetMode = mode;
  meetModeIndicator.textContent = mode;
  if (mode === 'account') {
    meetSignInBtn.style.display = 'none';
    meetSignOutBtn.style.display = '';
  } else {
    meetSignInBtn.style.display = '';
    meetSignOutBtn.style.display = 'none';
  }
  // Bot Name only matters as a GUEST — a signed-in bot uses its Google account
  // name — so show the field only in guest mode (it lives in this section now).
  const botNameField = document.getElementById('botNameField');
  if (botNameField) botNameField.style.display = (mode === 'account') ? 'none' : '';
  refreshAccountEmail(mode);
  refreshBotIdentity(mode); // keep the main-view identity row in sync
  updateBotNameBig();
}

// Big glanceable heading = the STABLE identity so multiple app instances are
// easy to tell apart (#282): the app profile, or the Bot Name for the default
// (no-profile) instance. It does NOT swap to the account name — the live in-call
// name lives in the sub-line (updateCallIdentity) so the heading never lies.
const botNameBig = document.getElementById('botNameBig');
const botCallIdentity = document.getElementById('botCallIdentity');
let botAccountName = null;   // the bot's Google display name when signed in
let callProvider = null;     // 'meet' | 'slack' while in a call, else null
let rememberedMeetName = null;  // last Meet display name for this profile (#282)
let rememberedSlackName = null; // last Slack display name for this profile (#282)
function updateBotNameBig() {
  if (!botNameBig) return;
  // Stable slot identity: the profile name, or "Default" for the unnamed
  // instance (#282). The actual/remembered name lives in the sub-line below.
  botNameBig.textContent = appProfileName || 'Default';
}

// The "appearing as" sub-line: dim "not in a call" when idle; once in a call,
// the actual provider display name (Meet = Google account name, or the guest
// green-room name; Slack = the account name, remembered or placeholder — #283).
function updateCallIdentity() {
  if (!botCallIdentity) return;
  if (!inCall || !callProvider) {
    // Idle: just "not in a call". The remembered per-platform display names now
    // live in their own connection rows below (next to the Meet email / Slack
    // status), so we don't duplicate them under the profile name (#289).
    botCallIdentity.style.color = '#9aa0a6';
    botCallIdentity.textContent = 'not in a call';
    return;
  }
  let appearing;
  if (callProvider === 'slack') {
    // We don't read the live Slack account name yet (#283); show the remembered
    // one if we have it, else a neutral placeholder.
    appearing = rememberedSlackName || 'your Slack account name';
    botCallIdentity.textContent = `● in Slack as ${appearing}`;
  } else {
    appearing = (lastMeetMode === 'account' && botAccountName)
      ? botAccountName
      : (currentBotName || (botNameInput && botNameInput.value.trim()) || 'guest');
    botCallIdentity.textContent = `● in Meet as ${appearing}`;
  }
  botCallIdentity.style.color = '#81c995';
}

// --- Bot Meet identity on the MAIN view (so the auto-admit login isn't buried
// in Settings — the confusion behind people signing into the wrong session). ---
const botIdentityStatus = document.getElementById('botIdentityStatus');
const botSignInMainBtn = document.getElementById('botSignInMainBtn');
const botSignOutMainBtn = document.getElementById('botSignOutMainBtn');

async function refreshBotIdentity(mode) {
  if (!botIdentityStatus) return;
  const m = mode || lastMeetMode;
  if (m !== 'account') {
    // Guest mode: the bot appears under the Bot Name preference, so show it
    // inline with a quick "Change" link straight to Settings (focused on the
    // name field) — no hunting through the menu.
    botIdentityStatus.textContent = currentBotName ? `👤 Guest ‘${currentBotName}’ ` : '👤 Guest ';
    const change = document.createElement('a');
    change.textContent = 'Change';
    change.href = '#';
    change.style.color = '#8ab4f8';
    change.style.textDecoration = 'underline';
    change.style.fontSize = '0.9em';
    change.onclick = (e) => {
      e.preventDefault();
      showScreen(settingsScreen);
      if (botNameInput) { botNameInput.focus(); botNameInput.select(); }
    };
    botIdentityStatus.appendChild(change);
    botIdentityStatus.style.color = '#fdd663';
    if (botSignInMainBtn) botSignInMainBtn.style.display = 'inline-block';
    if (botSignOutMainBtn) botSignOutMainBtn.style.display = 'none';
    botAccountName = null; // guest → in-call name uses the Bot Name preference
    updateBotNameBig();
    updateCallIdentity();
    return;
  }
  if (botSignInMainBtn) botSignInMainBtn.style.display = 'none';
  if (botSignOutMainBtn) botSignOutMainBtn.style.display = 'inline-block';
  botIdentityStatus.textContent = '✓ Signed in (reading account…)';
  botIdentityStatus.style.color = '#81c995';
  try {
    const r = await api.invoke('get-meet-account-email');
    // Show the Meet display name (what appears in the participant list) next to
    // the account email — the identity lives here in the Meet row now (#289).
    if (r?.signedIn && r.email) botIdentityStatus.textContent = r.name ? `✓ ${r.name} · ${r.email}` : '✓ ' + r.email;
    else if (r?.signedIn) botIdentityStatus.textContent = '✓ Signed in (couldn\'t read which account)';
    else { botIdentityStatus.textContent = '⚠ Account mode but not signed in yet'; botIdentityStatus.style.color = '#fdd663'; }
    // In-call name: prefer the Google display name, fall back to the email's
    // local part, then (in updateCallIdentity) the Bot Name preference.
    botAccountName = r?.name || (r?.email ? r.email.split('@')[0] : null);
    if (r?.name) rememberedMeetName = r.name; // persist for the idle sub-line after the call (#282)
    updateBotNameBig();
    updateCallIdentity(); // refresh "in Meet as …" once the account name resolves
  } catch {
    // Scrape failed but the cookie says signed in — fall back to the remembered
    // Meet display name if we have one, else a neutral "Signed in".
    botIdentityStatus.textContent = rememberedMeetName ? `✓ ${rememberedMeetName}` : '✓ Signed in';
  }
}

// --- Bot Slack identity on the MAIN view (parity with Bot Meet identity). In a
// huddle the bot joins as its signed-in Slack ACCOUNT name. We don't read that
// live name from the huddle DOM yet (#283), so this is informational; once a
// remembered Slack name exists it's shown. No override preference anymore. ---
const botSlackIdentityStatus = document.getElementById('botSlackIdentityStatus');
const slackSignInMainBtn = document.getElementById('slackSignInMainBtn');
async function refreshSlackIdentity() {
  if (!botSlackIdentityStatus) return;
  // Cookie-authoritative connected check (get-slack-mode → the `d` session
  // cookie). We can't read WHICH workspace/user without the huddle DOM (#283),
  // so: signed in → show the remembered name if we have one, else just
  // "Signed in"; not signed in → "Not connected". The conn dot follows suit.
  let signedIn = false;
  try { signedIn = !!(await api.invoke('get-slack-mode'))?.signedIn; } catch { /* treat as unknown */ }
  if (signedIn) {
    botSlackIdentityStatus.textContent = rememberedSlackName ? `✓ ${rememberedSlackName}` : '✓ Signed in';
    botSlackIdentityStatus.style.color = '#81c995';
  } else {
    botSlackIdentityStatus.textContent = 'Not connected';
    botSlackIdentityStatus.style.color = '#9aa0a6';
  }
  const dot = document.getElementById('connSlackDot');
  if (dot) dot.classList.toggle('on', signedIn);
  // Main-view "Sign in" — shown only when NOT connected, matching Meet's
  // botSignInMainBtn and the vibeconferencing.com userSignInMainBtn (#289).
  if (slackSignInMainBtn) slackSignInMainBtn.style.display = signedIn ? 'none' : 'inline-block';
  // Sign-out only makes sense while signed in — hidden otherwise, matching
  // the Meet identity section's sign-out behavior.
  if (slackSignOutBtn) slackSignOutBtn.style.display = signedIn ? '' : 'none';
}
refreshSlackIdentity();

// Main-view Slack sign-in — parity with the Meet + vibeconferencing.com sign-in
// buttons on the profile box. Same slack-sign-in IPC as the Settings "Sign into
// Slack as bot" button.
slackSignInMainBtn?.addEventListener('click', async () => {
  slackSignInMainBtn.disabled = true;
  slackSignInMainBtn.textContent = 'Opening Slack…';
  try {
    await api.invoke('slack-sign-in');
  } catch (err) {
    showError('Slack sign-in failed: ' + err.message);
  }
  setTimeout(() => {
    slackSignInMainBtn.disabled = false;
    slackSignInMainBtn.textContent = 'Sign in';
    refreshSlackIdentity();
  }, 1500);
});

botSignInMainBtn?.addEventListener('click', async () => {
  botSignInMainBtn.disabled = true;
  botSignInMainBtn.textContent = 'Opening Google sign-in…';
  try { await api.invoke('meet-sign-in-as-bot'); applyMeetMode('account'); } catch { /* ignore */ }
  setTimeout(() => { botSignInMainBtn.disabled = false; botSignInMainBtn.textContent = 'Sign in as bot'; refreshBotIdentity('account'); }, 4000);
});
botSignOutMainBtn?.addEventListener('click', async () => {
  botSignOutMainBtn.disabled = true;
  try { await api.invoke('meet-sign-out-bot'); applyMeetMode('guest'); } catch { /* ignore */ }
  setTimeout(() => { botSignOutMainBtn.disabled = false; }, 1500);
});

// Keep the Bot Meet identity honest. AUTHORITATIVE: re-derive mode from the live
// cookies (get-meet-mode → isSignedInToGoogle) rather than trusting the
// optimistic event-driven flag, so the pane self-corrects once a Google sign-in
// completes regardless of event ordering. While still resolving the account
// email, retry the scrape.
//
// SKIPPED WHILE IN A CALL: identity is settled then, and refreshBotIdentity runs
// get-meet-account-email — a DOM scrape on the live meet page — which spams the
// meet console every 7s and is noise while debugging a call (Stan).
setInterval(() => {
  if (inCall) return;
  api.invoke('get-meet-mode').then((info) => {
    if (!info?.mode) return;
    if (info.mode !== lastMeetMode) {
      applyMeetMode(info.mode);            // mode changed (e.g. login just finished) → full refresh
    } else if (info.mode === 'account' && !botAccountName) {
      refreshBotIdentity('account');        // signed in but email not resolved yet → retry the scrape
    }
    // else: stable (guest, or account with email already shown) → just the cheap cookie read above
  }).catch(() => {});
  // Keep the Slack row honest too — same cheap cookie read (get-slack-mode).
  refreshSlackIdentity();
}, 7000);

// --- Bot vitals: fast-model reachability + voice mode -----------------------
// Read-only indicators so the bot's current capabilities are visible at a glance
// next to the identity rows. Fast model = the on-device (Apple) endpoint that
// powers triage/engagement; Voice = ElevenLabs (a voice ID is set) vs built-in.
const fastModelStatus = document.getElementById('fastModelStatus');
const voiceStatus = document.getElementById('voiceStatus');

const FAST_MODEL_DOWNLOAD_URL = 'https://github.com/gety-ai/apple-on-device-openai/releases';

// "✗ Not detected — Download now", where "Download now" opens the release page
// in the default browser (via the https-validated open-external-url IPC).
function showFastModelNotDetected(title) {
  fastModelStatus.textContent = '✗ Not detected — ';
  const dl = document.createElement('a');
  dl.textContent = 'Download now';
  dl.href = '#';
  dl.style.color = '#8ab4f8';
  dl.style.textDecoration = 'underline';
  dl.onclick = (e) => { e.preventDefault(); api.send('open-external-url', FAST_MODEL_DOWNLOAD_URL); };
  fastModelStatus.appendChild(dl);
  fastModelStatus.style.color = '#fdd663';
  fastModelStatus.title = title || '';
}

async function refreshFastModelStatus() {
  if (!fastModelStatus) return;
  try {
    const r = await api.invoke('get-fast-model-status');
    if (r?.ok) {
      fastModelStatus.textContent = `✓ Detected — ${r.model || 'model'}`;
      fastModelStatus.style.color = '#81c995';
      fastModelStatus.title = `Reachable at ${r.endpoint}`;
    } else {
      showFastModelNotDetected(r?.endpoint ? `No response from ${r.endpoint}${r.error ? ` (${r.error})` : ''}` : 'No endpoint configured');
    }
  } catch {
    showFastModelNotDetected();
  }
}

function refreshVoiceStatus() {
  if (!voiceStatus) return;
  // Reflect the unified picker's current selection (its value encodes provider).
  const val = (unifiedVoiceSelect?.value || '');
  const label = unifiedVoiceSelect?.selectedOptions?.[0]?.textContent || '';
  const customId = (ttsVoiceIdInput?.value || '').trim();
  if (val.startsWith('vb:')) {
    voiceStatus.textContent = `🔊 Voicebox: ${label}`;
    voiceStatus.style.color = '#81c995';
    voiceStatus.title = `Voicebox voice: ${label} (local, experimental)`;
  } else if (val.startsWith('el:')) {
    voiceStatus.textContent = `🔊 ElevenLabs: ${label}`;
    voiceStatus.style.color = '#81c995';
    voiceStatus.title = `ElevenLabs voice: ${label}`;
  } else if (customId) {
    voiceStatus.textContent = '🔊 ElevenLabs voice (custom ID)';
    voiceStatus.style.color = '#81c995';
    voiceStatus.title = `ElevenLabs custom voice ID: ${customId}`;
  } else {
    voiceStatus.textContent = label ? `🔈 ${label}` : '🔈 Built-in macOS voice';
    voiceStatus.style.color = '#9aa0a6';
    voiceStatus.title = 'Built-in macOS voice.';
  }
}

refreshFastModelStatus();
refreshVoiceStatus();
// Poll the fast model (cheap localhost ping); the voice line updates on edit too.
setInterval(refreshFastModelStatus, 7000);
ttsVoiceIdInput?.addEventListener('input', refreshVoiceStatus);

// Initial state on panel load.
api.invoke('get-meet-mode').then((info) => {
  if (info?.mode) applyMeetMode(info.mode);
}).catch(() => {});

// Stay in sync when sign-in/out changes identity. The event no longer carries
// the mode (single partition now — #282); re-query the authoritative state.
api.on('meet-mode-changed', () => {
  api.invoke('get-meet-mode').then((info) => { if (info?.mode) applyMeetMode(info.mode); }).catch(() => {});
});

// Advanced: "Navigate Webview…" (⌘⇧L) → prompt for a URL and drive the bot's
// embedded view there, so the operator can set up Slack/Google account state in
// the bot's own partition (#282).
api.on('navigate-webview-prompt', async (data) => {
  // Pre-fill the CURRENT webview URL (passed from main) so you can see where the
  // view actually landed — handy for debugging redirects/blank pages — and edit
  // from there. Falls back to https:// when there's no current URL.
  const current = (data && data.currentUrl) || '';
  const url = await inlinePrompt({
    title: 'Navigate the bot webview to URL (advanced — Slack/Google account setup):',
    initial: current || 'https://', okLabel: 'Go',
  });
  if (!url) return;
  api.invoke('navigate-webview', url).then((r) => {
    if (r && r.ok === false) window.alert('Could not navigate: ' + (r.error || 'unknown'));
  }).catch(() => {});
});

// --- Live caption feed: the "bot's-eye view" of exactly what captions the bot
// is receiving, mirroring the [caption-raw]/[heard] logs. Each tick main sends
// the full current turn snapshot; render the recent history with the still-
// growing (bottommost) turn marked LIVE, so you can compare it in real time
// against the bot's Meet view. ---
function renderCaptionFeed(turns) {
  if (!rawCaptionText || !Array.isArray(turns)) return;
  const recent = turns.slice(-12);
  rawCaptionText.innerHTML = recent.map((t) => {
    const live = t.isBottommost;
    const speaker = (t.speaker || '?').replace(/[<>&]/g, '');
    const text = (t.text || '').replace(/[<>&]/g, '');
    return `<div class="cap-line${live ? ' cap-live' : ''}">`
      + `<span class="cap-tag">${live ? 'LIVE' : 'settled'}</span> `
      + `<span class="cap-speaker">${speaker}:</span> ${text}</div>`;
  }).join('') || '<span class="helper-text">No captions yet.</span>';
  rawCaptionText.scrollTop = rawCaptionText.scrollHeight;
}
api.on('caption-feed', ({ turns }) => renderCaptionFeed(turns));

// Captions on/off (deaf signal) — a badge so a deaf bot is obvious at a glance.
function renderCaptionState(on) {
  const el = document.getElementById('captionStateBadge');
  if (!el) return;
  el.textContent = on ? '● captions ON' : '○ captions OFF — bot is DEAF';
  el.className = 'caption-badge ' + (on ? 'cap-on' : 'cap-off');
}
api.on('caption-state', ({ on }) => renderCaptionState(on));

// --- Pop the panel out into its own window (place it next to the bot's Meet). ---
const popoutPanelBtn = document.getElementById('popoutPanelBtn');
function applyPopoutLabel(poppedOut) {
  if (!popoutPanelBtn) return;
  popoutPanelBtn.textContent = poppedOut ? '⧉ Dock' : '⧉ Pop out';
}
if (popoutPanelBtn) {
  popoutPanelBtn.addEventListener('click', async () => {
    try {
      const res = await api.invoke('toggle-panel-popout');
      applyPopoutLabel(!!res?.poppedOut);
    } catch { /* ignore */ }
  });
  api.invoke('get-panel-popout').then((r) => applyPopoutLabel(!!r?.poppedOut)).catch(() => {});
}
// Main tells us when the state changes (incl. user closing the popout window).
api.on('panel-popout-changed', ({ poppedOut }) => applyPopoutLabel(!!poppedOut));

// Bot-view toggle: the Meet thumbnail docked below the panel ↔ its own large
// window. Label flips so the button always names what a click will DO.
const botViewToggleBtn = document.getElementById('botViewToggleBtn');
function applyBotViewLabel(state) {
  if (!botViewToggleBtn) return;
  const popped = state === 'popped';
  botViewToggleBtn.textContent = popped ? '⧉ Dock' : '⧉ Pop out';
  botViewToggleBtn.title = popped
    ? "Dock the bot's view back as a thumbnail below this panel"
    : "Pop the bot's view out into its own large window";
}
if (botViewToggleBtn) {
  botViewToggleBtn.addEventListener('click', async () => {
    try {
      const res = await api.invoke('toggle-bot-view');
      applyBotViewLabel(res?.state);
    } catch { /* ignore */ }
  });
  api.invoke('get-bot-view').then((r) => applyBotViewLabel(r?.state)).catch(() => {});
}
// Main tells us when it changes (incl. the user closing the popped-out window).
api.on('bot-view-changed', ({ state }) => applyBotViewLabel(state));

meetSignInBtn?.addEventListener('click', async () => {
  meetSignInBtn.disabled = true;
  meetSignInBtn.textContent = 'Switching to Google sign-in...';
  try {
    await api.invoke('meet-sign-in-as-bot');
  } catch (err) {
    showError('Sign-in swap failed: ' + err.message);
  }
  setTimeout(() => {
    meetSignInBtn.disabled = false;
    meetSignInBtn.textContent = 'Sign in to Google as bot';
  }, 1500);
});

meetSignOutBtn?.addEventListener('click', async () => {
  meetSignOutBtn.disabled = true;
  meetSignOutBtn.textContent = 'Clearing account session...';
  try {
    await api.invoke('meet-sign-out-bot');
  } catch (err) {
    showError('Sign-out failed: ' + err.message);
  }
  setTimeout(() => {
    meetSignOutBtn.disabled = false;
    meetSignOutBtn.textContent = 'Sign out (use as guest)';
  }, 1500);
});

// Slack identity (#285): open Slack in the bot's view to log in / out. The
// sign-out button only shows while signed in (refreshSlackIdentity's cookie
// check toggles it — same behavior as the Meet identity section).
slackSignInBtn?.addEventListener('click', async () => {
  slackSignInBtn.disabled = true;
  slackSignInBtn.textContent = 'Opening Slack…';
  try {
    await api.invoke('slack-sign-in');
  } catch (err) {
    showError('Slack sign-in failed: ' + err.message);
  }
  setTimeout(() => {
    slackSignInBtn.disabled = false;
    slackSignInBtn.textContent = 'Sign into Slack as bot';
    refreshSlackIdentity();
  }, 1500);
});

slackSignOutBtn?.addEventListener('click', async () => {
  slackSignOutBtn.disabled = true;
  slackSignOutBtn.textContent = 'Signing out of Slack…';
  try {
    await api.invoke('slack-sign-out');
  } catch (err) {
    showError('Slack sign-out failed: ' + err.message);
  }
  setTimeout(() => {
    slackSignOutBtn.disabled = false;
    slackSignOutBtn.textContent = 'Sign out of Slack';
    refreshSlackIdentity();
  }, 1500);
});

// ---------------------------------------------------------------------------
// Agent prompt
// ---------------------------------------------------------------------------

function generateAgentPrompt(meetCode) {
  const base = syncBaseUrl || 'http://127.0.0.1:7865';
  const endpoint = `${base}/api/sync/${meetCode}`;
  const botParam = encodeURIComponent(currentBotName);

  return `You are "${currentBotName}", an AI assistant participating in a Google Meet call.

## How to interact

**Wait for people to speak (long-poll, recommended):**
\`\`\`bash
curl -s "${endpoint}?since=TIMESTAMP&wait=55&silence=2&bot=${botParam}" | python3 -m json.tool
\`\`\`
This holds the connection open for up to 55 seconds and returns only when someone finishes speaking (2 seconds of silence detected). The \`bot\` parameter excludes your own entries. Use the \`asOf\` value from each response as the next \`since\` parameter.

First call: omit \`?since=\` and \`?wait=\` to get recent history and the initial \`asOf\` timestamp.

Transcript entries are in \`transcript.entries[]\`, each with \`participantName\` (who said it) and \`text\` (what they said).

**Say something in the call:**
\`\`\`bash
curl -s -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"${currentBotName}","role":"bot","ownerName":"${currentBotName}","transcript":[{"text":"Your message here"}]}'
\`\`\`
Your transcript text will be spoken aloud in the Meet call via text-to-speech.

**Update the whiteboard (shared screen):**
\`\`\`bash
curl -s -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"${currentBotName}","role":"bot","ownerName":"${currentBotName}","whiteboard":{"content":"# Your markdown here"}}'
\`\`\`

## Interaction loop

Your main loop should be:
1. GET with \`?wait=55&silence=2\` to block until someone speaks
2. Read the transcript entries in the response
3. Decide if you should respond
4. POST your response (spoken via TTS) and/or whiteboard update
5. Use \`asOf\` from the response as the next \`since\` value
6. Repeat from step 1

## Important notes
- \`ownerName\` is REQUIRED in every POST request
- \`sender\` must be exactly "${currentBotName}" for the extension to speak your responses
- Avoid exclamation marks and special characters in text — they can cause shell escaping issues with curl. Use periods instead.
- When using curl with single quotes, apostrophes in text will break the command. Use double quotes with escaped inner quotes, or avoid contractions.
- Do NOT use \`sleep\` between polls — the \`wait\` parameter handles blocking server-side
- Keep responses concise — they will be spoken aloud via TTS
- Use the whiteboard for structured content (notes, diagrams, action items)
`;
}

function updateAgentPrompt(meetCode) {
  agentPromptText.value = generateAgentPrompt(meetCode);
}

copyPromptBtn.addEventListener('click', () => {
  api.copyToClipboard(agentPromptText.value);
  copyPromptBtn.textContent = 'Copied!';
  setTimeout(() => { copyPromptBtn.textContent = 'Copy Agent Prompt'; }, 2000);
});

// ---------------------------------------------------------------------------
// Curl command
// ---------------------------------------------------------------------------

function updateCurlCommand(meetCode) {
  const base = syncBaseUrl || 'http://127.0.0.1:7865';
  curlCommand.textContent = `curl -X POST "${base}/api/sync/${meetCode}" -H "Content-Type: application/json" -d '{"sender":"${currentBotName}","role":"bot","ownerName":"${currentBotName}","transcript":[{"text":"Hello from curl test."}]}'`;
  copyCurlBtn.disabled = false;
}

copyCurlBtn.addEventListener('click', () => {
  api.copyToClipboard(curlCommand.textContent);
  copyCurlBtn.textContent = 'Copied!';
  setTimeout(() => { copyCurlBtn.textContent = 'Copy Curl Command'; }, 2000);
});

// ---------------------------------------------------------------------------
// DevTools
// ---------------------------------------------------------------------------

document.getElementById('devtoolsBtn').addEventListener('click', () => {
  api.send('open-devtools');
});

// ---------------------------------------------------------------------------
// TTS test buttons
// ---------------------------------------------------------------------------

speakTextBtn.addEventListener('click', () => {
  const text = speakTextInput.value.trim();
  if (!text) return;
  api.send('speak', text);
  speakTextBtn.textContent = 'Speaking...';
  setTimeout(() => { speakTextBtn.textContent = 'Speak using TTS'; }, 3000);
});

const simulateSpeechBtn = document.getElementById('simulateSpeechBtn');
const simulateText = document.getElementById('simulateText');
const simulateSpeaker = document.getElementById('simulateSpeaker');
const simulateSpeechStatus = document.getElementById('simulateSpeechStatus');

if (simulateSpeechBtn) {
  async function submitSimulatedSpeech() {
    const text = simulateText.value.trim();
    const speaker = simulateSpeaker.value.trim() || 'Test User';
    if (!text) {
      simulateSpeechStatus.textContent = 'Enter some text first.';
      simulateSpeechStatus.style.color = '#fdd663';
      simulateText.focus();
      return;
    }
    simulateSpeechBtn.disabled = true;
    simulateSpeechStatus.textContent = 'Sending…';
    simulateSpeechStatus.style.color = '#9aa0a6';
    try {
      const result = await api.invoke('simulate-speech', { text, speaker });
      if (result?.ok) {
        // Echo the submitted text back since it won't appear in any caption
        // feed the user can see. Truncate so the status line stays compact.
        const echo = text.length > 80 ? text.slice(0, 80) + '…' : text;
        simulateSpeechStatus.textContent = `Sent as ${speaker}: "${echo}"`;
        simulateSpeechStatus.style.color = '#81c995';
        simulateText.value = '';
      } else {
        simulateSpeechStatus.textContent = `Failed: ${result?.error || 'unknown'}`;
        simulateSpeechStatus.style.color = '#ea4335';
      }
    } catch (err) {
      simulateSpeechStatus.textContent = `Error: ${err.message}`;
      simulateSpeechStatus.style.color = '#ea4335';
    } finally {
      simulateSpeechBtn.disabled = false;
      // Refocus so the user is primed to type the next message immediately.
      simulateText.focus();
      setTimeout(() => { simulateSpeechStatus.textContent = ''; }, 6000);
    }
  }

  simulateSpeechBtn.addEventListener('click', submitSimulatedSpeech);

  // Enter submits, Shift-Enter inserts a newline (chat-app convention).
  simulateText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitSimulatedSpeech();
    }
  });
}

speakTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') speakTextBtn.click();
});

speechBtn.addEventListener('click', () => {
  api.send('play-speech-test');
  speechBtn.textContent = 'Playing...';
  setTimeout(() => { speechBtn.textContent = 'Play Test Audio File'; }, 2000);
});

// ---------------------------------------------------------------------------
// Settings handlers
// ---------------------------------------------------------------------------

botNameInput.addEventListener('change', () => {
  const name = botNameInput.value.trim() || 'Jimmy';
  currentBotName = name;
  api.invoke('set-config', 'botName', name);
  api.send('to-meet', { action: 'set-config', payload: { botName: name } });
  updateBotNameBig();
  updateCallIdentity(); // guest in-call name = Bot Name; keep it current
  refreshBotIdentity(); // keep the guest "👤 Guest 'Name'" line in sync
});

websiteUrlInput.addEventListener('change', () => {
  const url = websiteUrlInput.value.trim().replace(/\/+$/, '');
  syncBaseUrl = url || 'http://127.0.0.1:7865';
  // Write to the new key. Also clear the legacy syncBaseUrl so we don't end up
  // with two values diverging — getWebsiteUrl()'s resolution chain prefers
  // websiteUrl anyway, but cleaning legacy makes the precedence visible in
  // config.json. Restart required for the change to take effect (the URL is
  // captured at startup by sync/auth init paths).
  api.invoke('set-config', 'websiteUrl', url);
  api.invoke('set-config', 'syncBaseUrl', '');
  api.send('update-sync-config', { baseUrl: syncBaseUrl });
});

// #366/#381: the ElevenLabs API-key field moved to App Settings, so there's no
// change listener here. When the key changes there, App Settings re-fetches; the
// panel picks up EL voices on its next populateUnifiedVoices() (open / refresh).

ttsVoiceIdInput.addEventListener('change', () => {
  const id = ttsVoiceIdInput.value.trim();
  // A custom/cloned voice id (advanced) forces ElevenLabs so it actually routes.
  api.send('update-tts-config', id ? { provider: 'elevenlabs', voiceId: id } : { voiceId: '' });
  refreshVoiceStatus();
});

// #340: standard macOS voices are mostly robotic — keep only a couple tolerable
// ones ("Samantha", "Karen") in the main group; the rest drop to "Other".
// DUPLICATED in mcp-server/server.js (the agent's list_voices) — keep in sync.
// TODO(#342): single-source this + the merge logic behind one /api/voices endpoint.
const WHITELISTED_MACOS_STANDARD = ['Samantha', 'Karen'];

// Unified voice picker: merge macOS + ElevenLabs + Voicebox into one dropdown,
// grouped Voicebox → ElevenLabs → macOS(good) → Other, so the best voices are up
// top. Option value encodes the provider: "vb:<id>" / "el:<id>" / "mac:<name>".
// Pass the saved config on initial load to pre-select; call with no arg to
// refresh in place (preserves the current selection).
async function populateUnifiedVoices(config) {
  const sel = unifiedVoiceSelect;
  if (!sel) return;
  const apiKey = (ttsApiKeyInput?.value || config?.ttsApiKey || '').trim();
  const [macos, voicebox, eleven] = await Promise.all([
    api.invoke('list-macos-voices').catch(() => []),
    api.invoke('list-voicebox-profiles').catch(() => []),
    apiKey ? api.invoke('list-elevenlabs-voices', apiKey).catch(() => []) : Promise.resolve([]),
  ]);

  // Desired selection: derive from saved config on initial load, else keep current.
  let selectedValue = sel.value;
  if (config) {
    const provider = config.ttsProvider || '';
    const vb = config.voiceboxProfileId || '';
    const elId = config.ttsVoiceId || '';
    const mac = config.macosVoice || 'Samantha';
    if (provider === 'voicebox' && vb) selectedValue = 'vb:' + vb;
    else if (provider === 'elevenlabs' && elId) selectedValue = 'el:' + elId;
    else if (provider === 'macos-say') selectedValue = 'mac:' + mac;
    else if (vb) selectedValue = 'vb:' + vb;                 // no explicit provider — infer
    else if (elId && apiKey) selectedValue = 'el:' + elId;
    else selectedValue = 'mac:' + mac;
  }

  sel.innerHTML = '';
  const addGroup = (label, items) => {
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.text;
      if (it.engine) opt.dataset.engine = it.engine;
      if (it.value === selectedValue) opt.selected = true;
      og.appendChild(opt);
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
  const tierOf = (name) => (/\(Premium\)/i.test(name) ? 0 : /\(Enhanced\)/i.test(name) ? 1 : 2);
  const whitelisted = (name) => WHITELISTED_MACOS_STANDARD.some((w) => name === w || name.startsWith(w + ' '));
  addGroup('Built-in (macOS)', macList
    .filter((v) => tierOf(v.name) < 2 || whitelisted(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));
  addGroup('Other built-in (lower quality)', macList
    .filter((v) => tierOf(v.name) === 2 && !whitelisted(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));

  if (!sel.options.length) {
    sel.innerHTML = '<option value="mac:Samantha">Samantha (default)</option>';
  }
  refreshVoiceStatus();
}

// Audition a voice through the LOCAL speakers when it's picked — main synthesizes
// a short sample and returns a data URL we play here (mirrors the macOS `say`
// preview for ElevenLabs + Voicebox). Best-effort; stays quiet on failure.
let _voiceSampleAudio = null;
async function previewVoiceSample(opts) {
  try {
    if (_voiceSampleAudio) { try { _voiceSampleAudio.pause(); } catch { /* ignore */ } _voiceSampleAudio = null; }
    const r = await api.invoke('synth-voice-sample', opts);
    if (r?.ok && r.dataUrl) {
      _voiceSampleAudio = new Audio(r.dataUrl);
      _voiceSampleAudio.play().catch(() => {});
    }
  } catch { /* ignore — preview is best-effort */ }
}

unifiedVoiceSelect?.addEventListener('change', () => {
  const val = unifiedVoiceSelect.value || '';
  const sep = val.indexOf(':');
  const kind = val.slice(0, sep);
  const id = val.slice(sep + 1);
  // The spoken name = the dropdown label minus the "· premade" / "(Enhanced)" /
  // "(kokoro)" suffixes, so every provider says "Hello, my name is <name>."
  const label = unifiedVoiceSelect.selectedOptions[0]?.textContent || '';
  // A space-delimited dash in an ElevenLabs name ("Brian - Deep, Resonant…") is
  // spoken as a hyphen with no pause; turn it into ". " so the name and its
  // description land as separate sentences.
  const name = label.replace(/\s*[·(].*$/, '').replace(/\s+[-–—]+\s+/g, '. ').trim();
  const text = `Hello, my name is ${name || 'your voice assistant'}.`;
  if (kind === 'vb') {
    const engine = unifiedVoiceSelect.selectedOptions[0]?.dataset.engine || 'kokoro';
    api.send('update-tts-config', { provider: 'voicebox', voiceboxProfileId: id, voiceboxEngine: engine });
    previewVoiceSample({ provider: 'voicebox', voiceboxProfileId: id, voiceboxEngine: engine, text });
  } else if (kind === 'el') {
    // Picking a listed EL voice clears any custom-ID override so they don't fight.
    api.send('update-tts-config', { provider: 'elevenlabs', voiceId: id, voiceboxProfileId: '' });
    if (ttsVoiceIdInput) ttsVoiceIdInput.value = id;
    previewVoiceSample({ provider: 'elevenlabs', voiceId: id, text });
  } else if (kind === 'mac') {
    // Force the built-in provider so an ElevenLabs key doesn't override the pick.
    api.send('update-tts-config', { provider: 'macos-say', macosVoice: id, voiceboxProfileId: '' });
    previewVoiceSample({ provider: 'macos-say', macosVoice: id, text });
  }
  refreshVoiceStatus();
});

refreshVoicesBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  populateUnifiedVoices(); // refresh in place, preserving the current selection
});

document.getElementById('openVoiceSettingsBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  api.invoke('open-voice-settings').catch(() => {});
});

// #305: show the EFFECTIVE working dir (the override if set, else the bot's auto
// trusted folder). Refresh on load and whenever the override field changes.
const agentWorkdirPathEl = document.getElementById('agentWorkdirPath');
const openAgentWorkdirBtn = document.getElementById('openAgentWorkdirBtn');
async function refreshAgentWorkdir() {
  if (!agentWorkdirPathEl) return;
  try {
    const r = await api.invoke('get-agent-workdir');
    agentWorkdirPathEl.textContent = r?.path || '—';
    agentWorkdirPathEl.title = r?.isOverride
      ? `Override (Claude Working Directory): ${r.path}`
      : `This bot's own trusted folder: ${r?.path || ''}`;
  } catch { agentWorkdirPathEl.textContent = '—'; }
}
refreshAgentWorkdir();
openAgentWorkdirBtn?.addEventListener('click', () => api.invoke('open-agent-workdir').catch(() => {}));

// #305/#291: the bot's personality CLAUDE.md editor. Load the current file (or the
// starter template if none), save on click. Reloads when the working dir changes.
const agentClaudeMdEl = document.getElementById('agentClaudeMd');
const saveAgentClaudeMdBtn = document.getElementById('saveAgentClaudeMdBtn');
const agentClaudeMdStatus = document.getElementById('agentClaudeMdStatus');
async function refreshAgentClaudeMd() {
  if (!agentClaudeMdEl) return;
  try {
    const r = await api.invoke('get-agent-claudemd');
    agentClaudeMdEl.value = r?.content ?? '';
    if (agentClaudeMdStatus) agentClaudeMdStatus.textContent = r?.exists ? '' : 'starter template — Save to create';
  } catch { agentClaudeMdEl.placeholder = '(could not load CLAUDE.md)'; }
}
refreshAgentClaudeMd();
saveAgentClaudeMdBtn?.addEventListener('click', async () => {
  if (!agentClaudeMdEl) return;
  if (agentClaudeMdStatus) { agentClaudeMdStatus.style.color = '#81c995'; agentClaudeMdStatus.textContent = 'Saving…'; }
  const r = await api.invoke('save-agent-claudemd', agentClaudeMdEl.value).catch(() => ({ ok: false }));
  if (agentClaudeMdStatus) {
    agentClaudeMdStatus.style.color = r?.ok ? '#81c995' : '#f28b82';
    agentClaudeMdStatus.textContent = r?.ok ? 'Saved ✓' : 'Save failed';
    if (r?.ok) setTimeout(() => { agentClaudeMdStatus.textContent = ''; }, 2500);
  }
});

claudeWorkDirInput.addEventListener('change', () => {
  api.invoke('set-config', 'claudeWorkDir', claudeWorkDirInput.value.trim());
  refreshAgentWorkdir();
  refreshAgentClaudeMd();
});

claudeModelInput.addEventListener('change', () => {
  api.invoke('set-config', 'claudeModel', claudeModelInput.value.trim());
});

if (emojiSetInput) emojiSetInput.addEventListener('change', () => {
  api.invoke('set-config', 'emojiSet', emojiSetInput.value);
});

dangerousModeInput.addEventListener('change', () => {
  api.invoke('set-config', 'dangerousMode', dangerousModeInput.checked);
});

ackShortMinInput.addEventListener('change', () => {
  const v = parseInt(ackShortMinInput.value, 10);
  if (Number.isFinite(v) && v >= 0) api.invoke('set-config', 'ackShortMin', v);
});

ackLongMinInput.addEventListener('change', () => {
  const v = parseInt(ackLongMinInput.value, 10);
  if (Number.isFinite(v) && v >= 0) api.invoke('set-config', 'ackLongMin', v);
});

// Phrase textareas: split on newline, drop blanks. Won't save if the
// list ends up empty — the schema requires at least 1 entry.
function parsePhraseLines(textarea) {
  return textarea.value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

ackShortPhrasesInput.addEventListener('change', () => {
  const phrases = parsePhraseLines(ackShortPhrasesInput);
  if (phrases.length > 0) api.invoke('set-config', 'ackShortPhrases', phrases);
});

ackLongPhrasesInput.addEventListener('change', () => {
  const phrases = parsePhraseLines(ackLongPhrasesInput);
  if (phrases.length > 0) api.invoke('set-config', 'ackLongPhrases', phrases);
});

// ---------------------------------------------------------------------------
// Incoming messages from main process
// ---------------------------------------------------------------------------

const seenEntryIds = new Set();

api.on('extension-message', (message) => {
  if (message.action === 'error') {
    showError(message.message);
    if (/microphone|mic/i.test(message.message)) {
      micWarn.textContent = message.message;
      micWarn.style.display = 'block';
    }
  }

  if (message.action === 'mic-status' && message.status === 'healthy') {
    micWarn.style.display = 'none';
  }

  if (message.action === 'raw-caption') {
    rawCaptionText.textContent = `[${message.speaker}] ${message.text}`;
  }

  if (message.action === 'transcript' || message.action === 'caption-update') {
    const { speaker, text, timestamp } = message.payload || {};
    if (!text) return;

    // For caption-update, update the last entry if same speaker
    if (message.action === 'caption-update') {
      const lastEntry = transcriptArea.lastElementChild;
      if (lastEntry && lastEntry.dataset.speaker === speaker) {
        lastEntry.querySelector('.transcript-text').textContent = text;
        transcriptArea.scrollTop = transcriptArea.scrollHeight;
        return;
      }
    }

    const entry = document.createElement('div');
    entry.className = 'transcript-entry';
    entry.dataset.speaker = speaker;
    const time = new Date(timestamp).toLocaleTimeString();
    entry.innerHTML = `<span class="transcript-speaker">${speaker}</span> <span class="transcript-time">${time}</span><br><span class="transcript-text">${text}</span>`;
    transcriptArea.appendChild(entry);
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
  }
});

api.on('meet-status', (status) => {
  if (status.ready) {
    // Page loaded — remember the room code (so troubleshooting fields populate),
    // but don't yet show the "Leave Call" UI; we may still be denied or in the
    // waiting-room. The 'call-status-changed' IPC drives the actual inCall flip
    // once we're admitted.
    const match = status.url?.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
    if (match) {
      meetCodeInput.value = match[1];
      const base = syncBaseUrl || 'http://127.0.0.1:7865';
      roomLink.href = `${base}/room/${match[1]}`;
      updateCurlCommand(match[1]);
      updateAgentPrompt(match[1]);
    }
  }
});

api.on('call-status-changed', ({ status, provider }) => {
  // Authoritative call-state signal from the local server. Only show Leave Call
  // once we're actually in the meeting; hide it on idle/left.
  if (status === 'in-call') {
    callProvider = provider || 'meet';
    const code = meetCodeInput.value || '';
    enterCallState(code);
  } else if (status === 'idle' || status === 'left') {
    callProvider = null;
    exitCallState();
  }
  // 'joining' / 'waiting-to-be-admitted' stay in the pre-call UI — the join
  // button hides itself once clicked, and the user sees the Meet view loading.
});

api.on('call-failed', (data) => {
  exitCallState();
  if (data?.message) showError(data.message);
});
