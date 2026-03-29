// popup.js — Popup UI controller

const statusEl = document.getElementById('status');
const botNameInput = document.getElementById('botName');
const joinBtn = document.getElementById('joinBtn');
const presentBtn = document.getElementById('presentBtn');
const speechBtn = document.getElementById('speechBtn');
const toneBtn = document.getElementById('toneBtn');
const speakBtn = document.getElementById('speakBtn');

let isSpeaking = false;

// Send a message to the content script (and optionally through to the page)
function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'content', ...message }, (resp) => {
      resolve(resp);
    });
  });
}

// Check whether a Google Meet tab is open
async function checkStatus() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  if (tabs.length > 0) {
    statusEl.textContent = 'Meet tab detected';
    statusEl.className = 'status active';
    joinBtn.disabled = false;
    presentBtn.disabled = false;
    listenBtn.disabled = false;
    speechBtn.disabled = false;
    toneBtn.disabled = false;
    speakBtn.disabled = false;
  } else {
    statusEl.textContent = 'No Meet tab found — open a Google Meet link first';
    statusEl.className = 'status';
    joinBtn.disabled = true;
    presentBtn.disabled = true;
    listenBtn.disabled = true;
    speechBtn.disabled = true;
    toneBtn.disabled = true;
    speakBtn.disabled = true;
  }
}

// Push the current bot name to the page-inject script and persist it
function pushBotName() {
  const name = botNameInput.value.trim() || 'AI Assistant';
  // Save to storage so content scripts on new tabs pick it up
  chrome.storage.local.set({ botName: name });
  sendToContent({
    target: 'page',
    action: 'set-config',
    payload: { botName: name },
  });
}

joinBtn.addEventListener('click', async () => {
  const name = botNameInput.value.trim() || 'AI Assistant';

  pushBotName();

  // Trigger the content-script auto-join sequence
  await sendToContent({ action: 'join-meet', botName: name });

  joinBtn.textContent = 'Joining…';
  setTimeout(() => { joinBtn.textContent = 'Join Meeting'; }, 3000);
});

presentBtn.addEventListener('click', () => {
  sendToContent({ action: 'start-presenting' });
  presentBtn.textContent = 'Presenting…';
  setTimeout(() => { presentBtn.textContent = 'Start Presenting Whiteboard'; }, 3000);
});

speechBtn.addEventListener('click', () => {
  sendToContent({
    target: 'page',
    action: 'play-speech-test',
  });
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
  sendToContent({
    target: 'page',
    action: 'set-speaking',
    payload: isSpeaking,
  });
  speakBtn.textContent = isSpeaking ? 'Stop Speaking Animation' : 'Toggle Speaking Animation';
});

botNameInput.addEventListener('change', pushBotName);

// --- Listen (STT) button ---

const listenBtn = document.getElementById('listenBtn');
const transcriptArea = document.getElementById('transcriptArea');
let isListening = false;

listenBtn.addEventListener('click', () => {
  isListening = !isListening;
  sendToContent({
    target: 'page',
    action: isListening ? 'start-listening' : 'stop-listening',
  });
  listenBtn.textContent = isListening ? 'Stop Listening' : 'Start Listening (STT)';
});

// --- Audio capture status ---

const audioStatusEl = document.getElementById('audioStatus');
const audioParticipantsEl = document.getElementById('audioParticipants');

// Listen for audio status updates and transcripts relayed from the page
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

  // Keep max 50 entries
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
    const levelPct = Math.min(100, Math.max(0, (p.db + 60) * 2)); // -60dB → 0%, -10dB → 100%
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

checkStatus();
