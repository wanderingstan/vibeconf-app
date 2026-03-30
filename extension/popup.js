// popup.js — Popup UI controller

const statusEl = document.getElementById('status');
const botNameInput = document.getElementById('botName');
const presentBtn = document.getElementById('presentBtn');
const speechBtn = document.getElementById('speechBtn');
const toneBtn = document.getElementById('toneBtn');
const speakBtn = document.getElementById('speakBtn');
const listenBtn = document.getElementById('listenBtn');
const transcriptArea = document.getElementById('transcriptArea');
const audioStatusEl = document.getElementById('audioStatus');
const audioParticipantsEl = document.getElementById('audioParticipants');

let isSpeaking = false;
let isListening = true; // auto-start

// Send a message to the content script (and optionally through to the page)
function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'content', ...message }, (resp) => {
      resolve(resp);
    });
  });
}

console.log('[popup] Script loaded');

// Check whether a Google Meet tab is open
async function checkStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    console.log('[popup] checkStatus: found', tabs.length, 'Meet tab(s)');
  if (tabs.length > 0) {
    statusEl.textContent = 'Meet tab detected';
    statusEl.className = 'status active';
    presentBtn.disabled = false;
    listenBtn.disabled = false;
    speakTextBtn.disabled = false;
    speechBtn.disabled = false;
    toneBtn.disabled = false;
    speakBtn.disabled = false;

    // Auto-start listening
    sendToContent({ target: 'page', action: 'start-listening' });
    updateAgentInfo();
  } else {
    statusEl.textContent = 'No Meet tab found — open a Google Meet link first';
    statusEl.className = 'status';
    presentBtn.disabled = true;
    listenBtn.disabled = true;
    speakTextBtn.disabled = true;
    speechBtn.disabled = true;
    toneBtn.disabled = true;
    speakBtn.disabled = true;
  }
  } catch (err) {
    console.error('[popup] checkStatus error:', err);
  }
}

// Push the current bot name to the page-inject script and persist it
function pushBotName() {
  const name = botNameInput.value.trim() || 'AI Assistant';
  chrome.storage.local.set({ botName: name });
  sendToContent({
    target: 'page',
    action: 'set-config',
    payload: { botName: name },
  });
}

// --- TTS controls ---
const ttsApiKeyInput = document.getElementById('ttsApiKey');
const ttsVoiceIdInput = document.getElementById('ttsVoiceId');
const speakTextInput = document.getElementById('speakText');
const speakTextBtn = document.getElementById('speakTextBtn');

// Load saved TTS config
chrome.storage.local.get(['ttsApiKey', 'ttsVoiceId'], (result) => {
  if (result.ttsApiKey) ttsApiKeyInput.value = result.ttsApiKey;
  if (result.ttsVoiceId) ttsVoiceIdInput.value = result.ttsVoiceId;
});

ttsApiKeyInput.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    action: 'update-tts-config',
    config: { apiKey: ttsApiKeyInput.value.trim() },
  });
});

ttsVoiceIdInput.addEventListener('change', () => {
  chrome.runtime.sendMessage({
    action: 'update-tts-config',
    config: { voiceId: ttsVoiceIdInput.value.trim() },
  });
});

speakTextBtn.addEventListener('click', () => {
  const text = speakTextInput.value.trim();
  if (!text) return;
  speakTextBtn.textContent = 'Speaking…';
  speakTextBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'speak', text }, (resp) => {
    speakTextBtn.textContent = 'Speak';
    speakTextBtn.disabled = false;
    if (resp?.error) {
      console.error('[popup] TTS error:', resp.error);
      speakTextBtn.textContent = 'Error — check key';
      setTimeout(() => { speakTextBtn.textContent = 'Speak'; }, 3000);
    }
  });
});

// Also allow Enter key to trigger speak
speakTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') speakTextBtn.click();
});

// --- Agent connection info ---
const meetCodeInput = document.getElementById('meetCode');
const apiEndpointInput = document.getElementById('apiEndpoint');
const syncStatusEl = document.getElementById('syncStatus');
const copyPromptBtn = document.getElementById('copyPromptBtn');

// Populate Meet code from the active Meet tab
async function updateAgentInfo() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  if (tabs.length > 0) {
    const url = new URL(tabs[0].url);
    const meetCode = url.pathname.replace('/', '');
    if (meetCode) {
      meetCodeInput.value = meetCode;
      const baseUrl = 'https://vibeconferencing.com';
      apiEndpointInput.value = `${baseUrl}/api/sync/${meetCode}`;
      copyPromptBtn.disabled = false;
      syncStatusEl.textContent = 'Syncing: ' + meetCode;
      syncStatusEl.className = 'audio-status active';
    }
  }
}

copyPromptBtn.addEventListener('click', () => {
  const meetCode = meetCodeInput.value;
  const botName = botNameInput.value.trim() || 'AI Assistant';
  const endpoint = apiEndpointInput.value;

  const prompt = `You are "${botName}", an AI assistant participating in a Google Meet call.

## How to interact

**Read what people are saying:**
\`\`\`bash
curl -s "${endpoint}?since=TIMESTAMP" | python3 -m json.tool
\`\`\`
(First call: omit ?since= to get recent history. Then use the \`asOf\` value from the response as the next \`since\` parameter.)

Transcript entries from other participants look like: "[Speaker Name]: what they said"

**Say something in the call:**
\`\`\`bash
curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"${botName}","role":"bot","transcript":[{"text":"Your message here"}]}'
\`\`\`
Your transcript text will be spoken aloud in the Meet call via text-to-speech.

**Update the whiteboard (shared screen):**
\`\`\`bash
curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"${botName}","role":"bot","whiteboard":{"content":"# Your markdown here"}}'
\`\`\`

## Guidelines
- Poll for new transcripts every few seconds
- Respond naturally to what participants say
- Keep responses concise — they'll be spoken aloud
- Use the whiteboard for structured content (notes, diagrams, action items)
- Your sender name must be exactly "${botName}" for the extension to pick up your responses
`;

  navigator.clipboard.writeText(prompt).then(() => {
    copyPromptBtn.textContent = 'Copied!';
    setTimeout(() => { copyPromptBtn.textContent = 'Copy Agent Prompt'; }, 2000);
  });
});

presentBtn.addEventListener('click', () => {
  sendToContent({ action: 'start-presenting' });
  presentBtn.textContent = 'Presenting…';
  setTimeout(() => { presentBtn.textContent = 'Start Presenting Whiteboard'; }, 3000);
});

speechBtn.addEventListener('click', () => {
  sendToContent({ target: 'page', action: 'play-speech-test' });
  speechBtn.textContent = 'Speaking…';
  setTimeout(() => { speechBtn.textContent = 'Play Speech Test'; }, 5000);
});

toneBtn.addEventListener('click', () => {
  sendToContent({
    target: 'page',
    action: 'play-test-tone',
    payload: { duration: 2, frequency: 440 },
  });
  toneBtn.textContent = 'Playing…';
  setTimeout(() => { toneBtn.textContent = 'Play Test Tone'; }, 2500);
});

speakBtn.addEventListener('click', () => {
  isSpeaking = !isSpeaking;
  sendToContent({ target: 'page', action: 'set-speaking', payload: isSpeaking });
  speakBtn.textContent = isSpeaking ? 'Stop Speaking Animation' : 'Toggle Speaking Animation';
});

listenBtn.addEventListener('click', () => {
  isListening = !isListening;
  sendToContent({
    target: 'page',
    action: isListening ? 'start-listening' : 'stop-listening',
  });
  listenBtn.textContent = isListening ? 'Stop Listening' : 'Start Listening (STT)';
});

botNameInput.addEventListener('change', pushBotName);

// --- Audio capture status & transcripts ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'audio-status' || message.action === 'audio-status-response') {
    updateAudioDisplay(message.payload);
  }
  if (message.action === 'transcript') {
    addTranscriptEntry(message.payload);
  }
});

function addTranscriptEntry(t) {
  const time = new Date(t.timestamp).toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'transcript-entry';
  div.innerHTML = `
    <span class="transcript-time">${time}</span>
    <span class="transcript-speaker">[${t.speaker}]</span>
    <span class="transcript-text">${t.text}</span>
  `;
  transcriptArea.prepend(div);
  while (transcriptArea.children.length > 50) {
    transcriptArea.removeChild(transcriptArea.lastChild);
  }
}

function updateAudioDisplay(payload) {
  if (!payload?.participants || payload.participants.length === 0) {
    audioStatusEl.textContent = 'No participants detected';
    audioParticipantsEl.innerHTML = '';
    return;
  }

  audioStatusEl.textContent =
    `${payload.participants.length} participant(s) | ${payload.connectionCount || '?'} connection(s)`;

  audioParticipantsEl.innerHTML = payload.participants.map((p) => {
    const levelPct = Math.min(100, Math.max(0, (p.db + 60) * 2));
    return `
      <div class="participant-row">
        <span class="participant-id">${p.id}</span>
        <div class="level-bar">
          <div class="level-fill ${p.speaking ? 'speaking' : ''}"
               style="width: ${levelPct}%"></div>
        </div>
        <span class="speaking-indicator">${p.speaking ? '🔊' : '🔇'}</span>
      </div>
    `;
  }).join('');
}

// Poll for audio status every 2 seconds
setInterval(() => {
  sendToContent({ target: 'page', action: 'get-audio-status' });
}, 2000);

// Check immediately and re-check every 3 seconds
// (side panel persists, so we need to keep polling for the Meet tab)
checkStatus();
setInterval(checkStatus, 3000);
