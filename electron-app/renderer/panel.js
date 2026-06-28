// panel.js — Control panel for the Electron app.
// Adapted from popup.js — uses window.electronAPI instead of chrome.* APIs.

const api = window.electronAPI;

const joinBtn = document.getElementById('joinBtn');
const meetUrlInput = document.getElementById('meetUrl');
const connectedSection = document.getElementById('connectedSection');
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
const macosVoiceSelect = document.getElementById('macosVoice');
const claudeWorkDirInput = document.getElementById('claudeWorkDir');
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

api.invoke('get-app-version').then((version) => {
  const el = document.getElementById('appVersion');
  if (el && version) el.textContent = `v${version}`;
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
  const el = document.getElementById('appProfile');
  if (el && profile) {
    el.textContent = profile;
    el.title = `App profile: "${profile}" — isolated userData dir with its own preferences and Google login. Launched with --profile=${profile}.`
      + (port ? ` · local-server port ${port}` : '');
    el.style.display = '';
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

async function doSwitchProfile(name) {
  closeProfileMenu();
  const n = (name || '').trim();
  if (!n) return;
  try {
    const r = await api.invoke('switch-profile', n);
    if (r && r.ok === false) window.alert('Could not switch profile: ' + (r.error || 'unknown'));
  } catch (e) { window.alert('Could not switch profile: ' + e.message); }
}

function renderProfileMenu(data) {
  if (!profileMenu) return;
  profileMenu.innerHTML = '';
  const profiles = (data && data.profiles) || [];
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No saved profiles yet.';
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
      row.onclick = () => doSwitchProfile(p.name);
    }
    // Left marker: ✓ for the current profile (so "Default" reads clearly as a
    // profile and the active one is obvious), else a running/not-running dot.
    const mark = document.createElement('span');
    mark.style.cssText = 'width:14px;flex:0 0 auto;text-align:center';
    if (p.isCurrent) {
      mark.textContent = '✓'; mark.style.color = '#8ab4f8'; mark.title = 'current profile (this window)';
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
    row.appendChild(mark); row.appendChild(label);
    profileMenu.appendChild(row);
  }
  const add = document.createElement('div');
  add.textContent = '＋ New profile…';
  add.style.cssText = 'padding:6px 8px;margin-top:4px;border-top:1px solid #5f6368;color:#8ab4f8;cursor:pointer';
  add.onclick = async () => {
    closeProfileMenu();
    const name = await inlinePrompt({ title: 'New profile name (letters, numbers, . _ - only):', placeholder: 'e.g. alice', okLabel: 'Create' });
    if (name) doSwitchProfile(name);
  };
  profileMenu.appendChild(add);

  // Debugging help: reveal the profiles folder so the user can delete/rename
  // profile dirs directly (#282).
  const folder = document.createElement('div');
  folder.textContent = '📂 Open profiles folder';
  folder.style.cssText = 'padding:6px 8px;color:#9aa0a6;cursor:pointer';
  folder.onmouseenter = () => { folder.style.background = '#3c4043'; };
  folder.onmouseleave = () => { folder.style.background = ''; };
  folder.onclick = () => { closeProfileMenu(); api.invoke('open-profiles-folder').catch(() => {}); };
  profileMenu.appendChild(folder);
}

if (profileMenuBtn && profileMenu) {
  profileMenuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (profileMenu.style.display !== 'none') { closeProfileMenu(); return; }
    profileMenu.style.display = 'block';
    profileMenu.innerHTML = '<div style="padding:6px 8px;color:#9aa0a6">Loading…</div>';
    try { renderProfileMenu(await api.invoke('list-profiles')); }
    catch { profileMenu.innerHTML = '<div style="padding:6px 8px;color:#f28b82">Failed to load profiles</div>'; }
  });
  document.addEventListener('click', (e) => {
    if (profileMenu.style.display !== 'none' && !profileMenu.contains(e.target) && e.target !== profileMenuBtn) closeProfileMenu();
  });
}

const debugOverlayToggle = document.getElementById('debugOverlayToggle');
if (debugOverlayToggle) {
  api.invoke('get-debug-overlay').then((enabled) => {
    debugOverlayToggle.checked = !!enabled;
  }).catch(() => {});
  debugOverlayToggle.addEventListener('change', () => {
    api.invoke('set-debug-overlay', debugOverlayToggle.checked).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

api.invoke('get-config', ['botName', 'websiteUrl', 'syncBaseUrl', 'ttsApiKey', 'ttsVoiceId', 'macosVoice', 'claudeWorkDir', 'dangerousMode', 'ackShortMin', 'ackLongMin', 'ackShortPhrases', 'ackLongPhrases', 'lastMeetName', 'lastSlackName']).then((result) => {
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
  if (result?.ttsApiKey) ttsApiKeyInput.value = result.ttsApiKey;
  if (result?.ttsVoiceId) ttsVoiceIdInput.value = result.ttsVoiceId;
  // Default the dropdown to Samantha when unset, to match tts.js's actual
  // default voice (so the UI reflects what's really used before any pick).
  populateMacosVoices(result?.macosVoice || 'Samantha');
  try { refreshVoiceStatus(); } catch { /* defined below; ignore if not yet */ }
  if (result?.claudeWorkDir) claudeWorkDirInput.value = result.claudeWorkDir;
  if (result?.dangerousMode) dangerousModeInput.checked = true;
  if (result?.ackShortMin != null) ackShortMinInput.value = result.ackShortMin;
  if (result?.ackLongMin != null) ackLongMinInput.value = result.ackLongMin;
  if (Array.isArray(result?.ackShortPhrases)) ackShortPhrasesInput.value = result.ackShortPhrases.join('\n');
  if (Array.isArray(result?.ackLongPhrases)) ackLongPhrasesInput.value = result.ackLongPhrases.join('\n');

  // Check auth status after config is loaded (so we know the server URL)
  checkAuthStatus();
});

const authStatus = document.getElementById('authStatus');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');

// User (vibeconferencing.com) identity row on the MAIN view — always shown.
const userIdStatus = document.getElementById('userIdStatus');
const userSignInMainBtn = document.getElementById('userSignInMainBtn');
const userSignOutMainBtn = document.getElementById('userSignOutMainBtn');

function setUserRow(signedIn, who) {
  if (userIdStatus) {
    userIdStatus.textContent = signedIn ? `✓ ${who}` : '⚠ not signed in';
    userIdStatus.style.color = signedIn ? '#81c995' : '#fdd663';
  }
  if (userSignInMainBtn) userSignInMainBtn.style.display = signedIn ? 'none' : 'inline-block';
  if (userSignOutMainBtn) userSignOutMainBtn.style.display = signedIn ? 'inline-block' : 'none';
}

async function checkAuthStatus() {
  try {
    const data = await api.invoke('check-auth');
    if (data?.authenticated) {
      const who = data.user?.email || data.user?.name || 'signed in';
      authStatus.textContent = `Logged in as ${data.user?.name || who}`;
      authStatus.style.color = '#81c995';
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'inline-block';
      setUserRow(true, who);
    } else {
      authStatus.textContent = 'Not logged in';
      authStatus.style.color = '#f28b82';
      loginBtn.style.display = 'block';
      logoutBtn.style.display = 'none';
      setUserRow(false);
    }
  } catch {
    authStatus.textContent = 'Auth check failed';
    authStatus.style.color = '#f28b82';
    loginBtn.style.display = 'block';
    logoutBtn.style.display = 'none';
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

loginBtn.addEventListener('click', async () => {
  loginBtn.textContent = 'Opening Google sign-in...';
  loginBtn.disabled = true;
  await api.invoke('login');
  setTimeout(() => {
    loginBtn.textContent = 'Sign in with Google';
    loginBtn.disabled = false;
  }, 3000);
});

logoutBtn.addEventListener('click', async () => {
  await api.invoke('logout');
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
  updateCallIdentity(); // light up the "appearing as" sub-line (#282)
  connectedSection.style.display = 'block';
  joinBtn.style.display = 'none';

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
    // Idle: surface the remembered name so the profile isn't anonymous between
    // calls (#282). Prefer a real remembered Meet name, then Slack, then the
    // (not-yet-used) Bot Name as "will appear as", else nothing.
    botCallIdentity.style.color = '#9aa0a6';
    if (rememberedMeetName) botCallIdentity.textContent = `↩ last in Meet as ${rememberedMeetName}`;
    else if (rememberedSlackName) botCallIdentity.textContent = `↩ last in Slack as ${rememberedSlackName}`;
    else if (currentBotName) botCallIdentity.textContent = `will appear as ${currentBotName}`;
    else botCallIdentity.textContent = 'not in a call';
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
    if (r?.signedIn && r.email) botIdentityStatus.textContent = '✓ ' + r.email;
    else if (r?.signedIn) botIdentityStatus.textContent = '✓ Signed in (couldn\'t read which account)';
    else { botIdentityStatus.textContent = '⚠ Account mode but not signed in yet'; botIdentityStatus.style.color = '#fdd663'; }
    // In-call name: prefer the Google display name, fall back to the email's
    // local part, then (in updateCallIdentity) the Bot Name preference.
    botAccountName = r?.name || (r?.email ? r.email.split('@')[0] : null);
    if (r?.name) rememberedMeetName = r.name; // persist for the idle sub-line after the call (#282)
    updateBotNameBig();
    updateCallIdentity(); // refresh "in Meet as …" once the account name resolves
  } catch { botIdentityStatus.textContent = '✓ Signed in'; }
}

// --- Bot Slack identity on the MAIN view (parity with Bot Meet identity). In a
// huddle the bot joins as its signed-in Slack ACCOUNT name. We don't read that
// live name from the huddle DOM yet (#283), so this is informational; once a
// remembered Slack name exists it's shown. No override preference anymore. ---
const botSlackIdentityStatus = document.getElementById('botSlackIdentityStatus');
function refreshSlackIdentity() {
  if (!botSlackIdentityStatus) return;
  if (rememberedSlackName) {
    botSlackIdentityStatus.textContent = `💬 ${rememberedSlackName}`;
    botSlackIdentityStatus.style.color = '#81c995';
  } else {
    botSlackIdentityStatus.textContent = '💬 Uses your Slack account name';
    botSlackIdentityStatus.style.color = '#9aa0a6';
  }
}
refreshSlackIdentity();

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
  const id = (ttsVoiceIdInput?.value || '').trim();
  if (id) {
    voiceStatus.textContent = '🔊 ElevenLabs voice set';
    voiceStatus.style.color = '#81c995';
    voiceStatus.title = `ElevenLabs voice ID: ${id}`;
  } else {
    const macVoice = (macosVoiceSelect?.value || '').trim();
    voiceStatus.textContent = macVoice ? `🔈 Built-in macOS voice: ${macVoice}` : '🔈 Built-in macOS voice';
    voiceStatus.style.color = '#9aa0a6';
    voiceStatus.title = 'No ElevenLabs voice ID set — using the built-in macOS voice.';
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
api.on('navigate-webview-prompt', async () => {
  const url = await inlinePrompt({
    title: 'Navigate the bot webview to URL (advanced — Slack/Google account setup):',
    initial: 'https://', okLabel: 'Go',
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

// Slack identity (#285): open Slack in the bot's view to log in / out. No state
// toggle — Slack signed-in state isn't read yet (#283), so both buttons show.
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
    slackSignInBtn.textContent = 'Sign into Slack';
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

ttsApiKeyInput.addEventListener('change', () => {
  api.send('update-tts-config', { apiKey: ttsApiKeyInput.value.trim() });
});

ttsVoiceIdInput.addEventListener('change', () => {
  api.send('update-tts-config', { voiceId: ttsVoiceIdInput.value.trim() });
  refreshVoiceStatus();
});

// Populate the built-in macOS voice dropdown from `say -v '?'` (via main).
// `selected` is the currently-saved voice name to pre-select.
async function populateMacosVoices(selected) {
  if (!macosVoiceSelect) return;
  let voices = [];
  try { voices = await api.invoke('list-macos-voices'); } catch { /* ignore */ }
  if (!Array.isArray(voices) || voices.length === 0) {
    // Not on macOS, or enumeration failed — keep a single sane default.
    macosVoiceSelect.innerHTML = '<option value="">Samantha (default)</option>';
    return;
  }
  macosVoiceSelect.innerHTML = '';
  // Group by quality tier (the list arrives pre-sorted Premium→Enhanced→plain)
  // so the good downloadable voices are clearly separated from the poor ones.
  const tierOf = (name) => (/\(Premium\)/i.test(name) ? 'Premium' : /\(Enhanced\)/i.test(name) ? 'Enhanced' : 'Standard');
  const groups = {};
  for (const v of voices) {
    const t = tierOf(v.name);
    if (!groups[t]) {
      const og = document.createElement('optgroup');
      og.label = t === 'Standard' ? 'Standard (lower quality)' : `${t} (high quality)`;
      groups[t] = og;
      macosVoiceSelect.appendChild(og);
    }
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.locale})`;
    if (v.name === selected) opt.selected = true;
    groups[t].appendChild(opt);
  }
  // If the saved voice wasn't in the list (e.g. uninstalled), default to the
  // first English voice so the dropdown reflects what will actually be used.
  if (selected && !voices.some((v) => v.name === selected)) {
    macosVoiceSelect.selectedIndex = 0;
  }
}

macosVoiceSelect?.addEventListener('change', () => {
  const name = macosVoiceSelect.value;
  if (!name) return;
  api.send('update-tts-config', { macosVoice: name });
  refreshVoiceStatus();
  // Audition the chosen voice on the local speakers.
  api.invoke('preview-macos-voice', name).catch(() => {});
});

document.getElementById('openVoiceSettingsBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  api.invoke('open-voice-settings').catch(() => {});
});

claudeWorkDirInput.addEventListener('change', () => {
  api.invoke('set-config', 'claudeWorkDir', claudeWorkDirInput.value.trim());
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
