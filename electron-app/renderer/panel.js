// panel.js — Control panel for the Electron app.
// Adapted from popup.js — uses window.electronAPI instead of chrome.* APIs.

const api = window.electronAPI;

const joinBtn = document.getElementById('joinBtn');
const meetUrlInput = document.getElementById('meetUrl');
const connectedSection = document.getElementById('connectedSection');
const meetCodeInput = document.getElementById('meetCode');
const roomLink = document.getElementById('roomLink');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const transcriptArea = document.getElementById('transcriptArea');
const errorBar = document.getElementById('errorBar');
const rawCaptionText = document.getElementById('rawCaptionText');
const speakTextInput = document.getElementById('speakText');
const speakTextBtn = document.getElementById('speakTextBtn');
const speechBtn = document.getElementById('speechBtn');
const curlCommand = document.getElementById('curlCommand');
const copyCurlBtn = document.getElementById('copyCurlBtn');
const micWarn = document.getElementById('micPermissionWarning');

// Settings
const botNameInput = document.getElementById('botName');
const syncBaseUrlInput = document.getElementById('syncBaseUrl');
const ttsApiKeyInput = document.getElementById('ttsApiKey');
const ttsVoiceIdInput = document.getElementById('ttsVoiceId');

let syncBaseUrl = 'https://vibeconferencing.com';
let currentBotName = 'AI Assistant';

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

api.invoke('get-config', ['botName', 'syncBaseUrl', 'ttsApiKey', 'ttsVoiceId']).then((result) => {
  if (result?.botName) { botNameInput.value = result.botName; currentBotName = result.botName; }
  if (result?.syncBaseUrl) { syncBaseUrlInput.value = result.syncBaseUrl; syncBaseUrl = result.syncBaseUrl; }
  if (result?.ttsApiKey) ttsApiKeyInput.value = result.ttsApiKey;
  if (result?.ttsVoiceId) ttsVoiceIdInput.value = result.ttsVoiceId;

  // Check auth status after config is loaded (so we know the server URL)
  checkAuthStatus();
});

const authStatus = document.getElementById('authStatus');

async function checkAuthStatus() {
  try {
    const data = await api.invoke('check-auth');
    if (data?.authenticated) {
      authStatus.textContent = `Logged in as ${data.user.name}`;
      authStatus.style.color = '#4caf50';
    } else {
      authStatus.textContent = 'Not logged in';
      authStatus.style.color = '#f44336';
    }
  } catch {
    authStatus.textContent = 'Auth check failed';
    authStatus.style.color = '#f44336';
  }
}

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
// Join Meet
// ---------------------------------------------------------------------------

joinBtn.addEventListener('click', () => {
  let url = meetUrlInput.value.trim();
  if (!url) return;
  if (!url.startsWith('http')) url = 'https://meet.google.com/' + url;
  api.joinMeet(url);
  joinBtn.textContent = 'Joining...';
  joinBtn.disabled = true;

  // Extract meet code
  const match = url.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
  if (match) {
    const meetCode = match[1];
    meetCodeInput.value = meetCode;
    const base = syncBaseUrl || 'https://vibeconferencing.com';
    roomLink.href = `${base}/room/${meetCode}`;
    roomLink.style.display = 'block';
    connectedSection.style.display = 'block';
    updateCurlCommand(meetCode);
  }

  setTimeout(() => {
    joinBtn.textContent = 'Join Meet';
    joinBtn.disabled = false;
  }, 3000);
});

meetUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click();
});

// ---------------------------------------------------------------------------
// Share Whiteboard
// ---------------------------------------------------------------------------

const shareWhiteboardBtn = document.getElementById('shareWhiteboardBtn');

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
    shareWhiteboardBtn.disabled = false;
  }, 3000);
});

// ---------------------------------------------------------------------------
// Agent prompt
// ---------------------------------------------------------------------------

copyPromptBtn.addEventListener('click', () => {
  const meetCode = meetCodeInput.value;
  const base = syncBaseUrl || 'https://vibeconferencing.com';
  const endpoint = `${base}/api/sync/${meetCode}`;
  const botParam = encodeURIComponent(currentBotName);

  const prompt = `You are "${currentBotName}", an AI assistant participating in a Google Meet call.

## How to interact

**Wait for people to speak (long-poll, recommended):**
\`\`\`bash
curl -s "${endpoint}?since=TIMESTAMP&wait=55&silence=5&bot=${botParam}" | python3 -m json.tool
\`\`\`
This holds the connection open for up to 55 seconds and returns only when someone finishes speaking (5 seconds of silence detected). The \`bot\` parameter excludes your own entries. Use the \`asOf\` value from each response as the next \`since\` parameter.

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
1. GET with \`?wait=55&silence=5\` to block until someone speaks
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

  api.copyToClipboard(prompt);
  copyPromptBtn.textContent = 'Copied!';
  setTimeout(() => { copyPromptBtn.textContent = 'Copy Agent Prompt'; }, 2000);
});

// ---------------------------------------------------------------------------
// Curl command
// ---------------------------------------------------------------------------

function updateCurlCommand(meetCode) {
  const base = syncBaseUrl || 'https://vibeconferencing.com';
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
  const name = botNameInput.value.trim() || 'AI Assistant';
  currentBotName = name;
  api.invoke('set-config', 'botName', name);
  api.send('to-meet', { action: 'set-config', payload: { botName: name } });
});

syncBaseUrlInput.addEventListener('change', () => {
  const url = syncBaseUrlInput.value.trim().replace(/\/+$/, '');
  syncBaseUrl = url || 'https://vibeconferencing.com';
  api.invoke('set-config', 'syncBaseUrl', url);
  api.send('update-sync-config', { baseUrl: syncBaseUrl });
});

ttsApiKeyInput.addEventListener('change', () => {
  api.send('update-tts-config', { apiKey: ttsApiKeyInput.value.trim() });
});

ttsVoiceIdInput.addEventListener('change', () => {
  api.send('update-tts-config', { voiceId: ttsVoiceIdInput.value.trim() });
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
    const match = status.url?.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
    if (match) {
      const meetCode = match[1];
      meetCodeInput.value = meetCode;
      connectedSection.style.display = 'block';
      updateCurlCommand(meetCode);
    }
  }
});
