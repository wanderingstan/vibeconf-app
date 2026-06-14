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

// Settings
const botNameInput = document.getElementById('botName');
const websiteUrlInput = document.getElementById('websiteUrl');
const ttsApiKeyInput = document.getElementById('ttsApiKey');
const ttsVoiceIdInput = document.getElementById('ttsVoiceId');
const claudeWorkDirInput = document.getElementById('claudeWorkDir');
const dangerousModeInput = document.getElementById('dangerousMode');
const ackShortMinInput = document.getElementById('ackShortMin');
const ackLongMinInput = document.getElementById('ackLongMin');
const ackShortPhrasesInput = document.getElementById('ackShortPhrases');
const ackLongPhrasesInput = document.getElementById('ackLongPhrases');

let syncBaseUrl = 'http://127.0.0.1:7865';
let currentBotName = 'Jimmy';
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

document.getElementById('openSettingsBtn').addEventListener('click', () => showScreen(settingsScreen));
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
  // workingMemory (two-tier). Show each field on its own indented block so we
  // can watch the slow model's read evolve live during a call.
  const wm = s.workingMemory || {};
  const wmField = (label, val) => {
    const text = (val || '').trim();
    if (!text) return [`    ${label}: (empty)`];
    const wrapped = text.replace(/\s+/g, ' ');
    return [`    ${label}:`, `      ${wrapped.slice(0, 240)}${wrapped.length > 240 ? '…' : ''}`];
  };
  const wmAge = wm.updatedAt ? agoLabel(wm.updatedAt) : 'never';
  callStateDebug.textContent = [
    `Call status:        ${s.callStatus || 'unknown'}`,
    `Bot state:          ${s.botState || 'unknown'}`,
    `Bot mode:           ${s.mode || 'unknown'}`,
    `Anyone speaking:    ${yesNo(s.anyoneSpeaking)}`,
    `Screen sharing:     ${yesNo(s.sharing)}${s.someoneElsePresenting ? ` (other: ${s.presenterName || 'someone'})` : ''}`,
    `WB window URL:      ${s.whiteboardLoadedUrl || '(none)'}`,
    `People pane open:   ${yesNo(s.peoplePaneOpen)}`,
    `Chat pane open:     ${yesNo(s.chatPaneOpen)}`,
    `Unread chat:        ${yesNo(s.chatUnread)}`,
    `Screen rec perm:    ${s.screenRecording || 'unknown'}`,
    `Agent loop:         ${agentLoopHealth(s)}`,
    `Last wait_for_speech: ${agoLabel(s.lastWaitForSpeechAt)}`,
    `Last ack:           ${ackLabel(s.lastAckEvent)}`,
    `Working memory (updated ${wmAge}${wm.updatedBy ? ` by ${wm.updatedBy}` : ''}):`,
    ...wmField('understanding', wm.understanding),
    ...wmField('stance', wm.stance),
    ...wmField('people', wm.people),
    `Queued speech (${queued.length}):`,
    ...queuedLines,
    `Participants (${(s.participants || []).length}):`,
    ...(parts.length ? parts : ['    (none detected)']),
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

function updateJoinBtnState() {
  const url = meetUrlInput.value.trim();
  joinBtn.disabled = !url || !isValidMeetUrl(url.startsWith('http') ? url : 'https://meet.google.com/' + url);
}

meetUrlInput.addEventListener('input', updateJoinBtnState);

// ---------------------------------------------------------------------------
// App version
// ---------------------------------------------------------------------------

api.invoke('get-app-version').then((version) => {
  const el = document.getElementById('appVersion');
  if (el && version) el.textContent = `v${version}`;
}).catch(() => {});

api.invoke('get-app-profile').then((profile) => {
  const el = document.getElementById('appProfile');
  if (el && profile) {
    el.textContent = profile;
    el.title = `App profile: "${profile}" — this Electron instance runs in an isolated userData dir with its own preferences and Google login. Launched with --profile=${profile}.`;
    el.style.display = '';
  }
}).catch(() => {});

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

api.invoke('get-config', ['botName', 'websiteUrl', 'syncBaseUrl', 'ttsApiKey', 'ttsVoiceId', 'claudeWorkDir', 'dangerousMode', 'ackShortMin', 'ackLongMin', 'ackShortPhrases', 'ackLongPhrases']).then((result) => {
  if (result?.botName) { botNameInput.value = result.botName; currentBotName = result.botName; }
  // Prefer the new websiteUrl key; fall back to legacy syncBaseUrl so users with
  // older configs still see their existing override populated in the field.
  const effectiveUrl = result?.websiteUrl || result?.syncBaseUrl || '';
  if (effectiveUrl) { websiteUrlInput.value = effectiveUrl; syncBaseUrl = effectiveUrl; }
  if (result?.ttsApiKey) ttsApiKeyInput.value = result.ttsApiKey;
  if (result?.ttsVoiceId) ttsVoiceIdInput.value = result.ttsVoiceId;
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

const loginPrompt = document.getElementById('loginPrompt');
const mainLoginBtn = document.getElementById('mainLoginBtn');

async function checkAuthStatus() {
  try {
    const data = await api.invoke('check-auth');
    if (data?.authenticated) {
      authStatus.textContent = `Logged in as ${data.user.name}`;
      authStatus.style.color = '#81c995';
      loginBtn.style.display = 'none';
      logoutBtn.style.display = 'inline-block';
      loginPrompt.style.display = 'none';
    } else {
      authStatus.textContent = 'Not logged in';
      authStatus.style.color = '#f28b82';
      loginBtn.style.display = 'block';
      logoutBtn.style.display = 'none';
      loginPrompt.style.display = 'block';
    }
  } catch {
    authStatus.textContent = 'Auth check failed';
    authStatus.style.color = '#f28b82';
    loginBtn.style.display = 'block';
    logoutBtn.style.display = 'none';
    loginPrompt.style.display = 'block';
  }
}

mainLoginBtn.addEventListener('click', async () => {
  mainLoginBtn.textContent = 'Opening Google sign-in...';
  mainLoginBtn.disabled = true;
  await api.invoke('login');
  setTimeout(() => {
    mainLoginBtn.textContent = 'Sign in with Google';
    mainLoginBtn.disabled = false;
  }, 3000);
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
  connectedSection.style.display = 'none';
  joinBtn.style.display = '';
  joinBtn.textContent = 'Join Meet';
  updateJoinBtnState();

  roomIdField.style.display = 'none';
  roomLink.style.display = 'none';
}

joinBtn.addEventListener('click', () => {
  let url = meetUrlInput.value.trim();
  if (!url) return;
  if (!url.startsWith('http')) url = 'https://meet.google.com/' + url;
  api.joinMeet(url);
  joinBtn.textContent = 'Joining...';
  joinBtn.disabled = true;

  // Don't eagerly call enterCallState here — wait for the 'call-status-changed'
  // IPC to fire with 'in-call'. Otherwise the Leave Call button appears
  // before we know whether admission succeeded.

  setTimeout(() => {
    if (!inCall) {
      joinBtn.style.display = '';
      joinBtn.textContent = 'Join Meet';
      updateJoinBtnState();
    }
  }, 3000);
});

meetUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
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

function applyMeetMode(mode) {
  if (!meetModeIndicator) return;
  meetModeIndicator.textContent = mode;
  if (mode === 'account') {
    meetSignInBtn.style.display = 'none';
    meetSignOutBtn.style.display = '';
  } else {
    meetSignInBtn.style.display = '';
    meetSignOutBtn.style.display = 'none';
  }
}

// Initial state on panel load.
api.invoke('get-meet-mode').then((info) => {
  if (info?.mode) applyMeetMode(info.mode);
}).catch(() => {});

// Stay in sync when main swaps partitions.
api.on('meet-mode-changed', ({ mode }) => applyMeetMode(mode));

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

api.on('call-status-changed', ({ status }) => {
  // Authoritative call-state signal from the local server. Only show Leave Call
  // once we're actually in the meeting; hide it on idle/left.
  if (status === 'in-call') {
    const code = meetCodeInput.value || '';
    enterCallState(code);
  } else if (status === 'idle' || status === 'left') {
    exitCallState();
  }
  // 'joining' / 'waiting-to-be-admitted' stay in the pre-call UI — the join
  // button hides itself once clicked, and the user sees the Meet view loading.
});

api.on('call-failed', (data) => {
  exitCallState();
  if (data?.message) showError(data.message);
});
