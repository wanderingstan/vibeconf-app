// popup.js — Side panel controller (live call info)

const statusEl = document.getElementById('status');
const presentBtn = document.getElementById('presentBtn');
const transcriptArea = document.getElementById('transcriptArea');
const audioStatusEl = document.getElementById('audioStatus');
const audioParticipantsEl = document.getElementById('audioParticipants');

// Navigate to settings within the side panel
document.getElementById('settingsLink').addEventListener('click', (e) => {
  e.preventDefault();
  window.location.href = 'settings.html';
});

function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'content', ...message }, (resp) => resolve(resp));
  });
}

// --- Load transcript from server on panel open ---
let seenEntryIds = new Set();

async function loadTranscriptFromServer() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    if (tabs.length === 0) return;
    const meetCode = new URL(tabs[0].url).pathname.replace('/', '');
    if (!meetCode) return;

    const resp = await fetch(`https://vibeconferencing.com/api/sync/${meetCode}`);
    if (!resp.ok) return;
    const data = await resp.json();
    const entries = data.transcript?.entries || [];

    // Add entries oldest-first
    for (const entry of entries) {
      if (seenEntryIds.has(entry.id)) continue;
      seenEntryIds.add(entry.id);
      addTranscriptEntry({
        timestamp: new Date(entry.timestamp).getTime(),
        speaker: entry.participantName,
        text: entry.text,
      });
    }
  } catch (err) {
    console.debug('[panel] Failed to load transcript from server:', err.message);
  }
}

loadTranscriptFromServer();

// --- Check for Meet tab ---
async function checkStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    if (tabs.length > 0) {
      statusEl.style.display = 'none';
      presentBtn.disabled = false;
      copyPromptBtn.disabled = false;
      updateAgentInfo();
    } else {
      statusEl.style.display = 'block';
      presentBtn.disabled = true;
      copyPromptBtn.disabled = true;
      document.getElementById('roomLink').style.display = 'none';
    }
  } catch (err) {
    console.error('[panel] checkStatus error:', err);
  }
}

// --- Agent connection info ---
const meetCodeInput = document.getElementById('meetCode');
const apiEndpointInput = document.getElementById('apiEndpoint');
const syncStatusEl = document.getElementById('syncStatus');
const copyPromptBtn = document.getElementById('copyPromptBtn');

async function updateAgentInfo() {
  const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  if (tabs.length > 0) {
    const url = new URL(tabs[0].url);
    const meetCode = url.pathname.replace('/', '');
    if (meetCode) {
      meetCodeInput.value = meetCode;
      const baseUrl = 'https://vibeconferencing.com';
      apiEndpointInput.value = `${baseUrl}/api/sync/${meetCode}`;
      const roomLink = document.getElementById('roomLink');
      roomLink.href = `${baseUrl}/room/${meetCode}`;
      roomLink.style.display = 'block';
      syncStatusEl.textContent = 'Syncing: ' + meetCode;
      syncStatusEl.className = 'audio-status active';
    }
  }
}

copyPromptBtn.addEventListener('click', () => {
  const meetCode = meetCodeInput.value;
  // Load bot name from storage
  chrome.storage.local.get('botName', (result) => {
    const botName = result.botName || 'AI Assistant';
    const endpoint = apiEndpointInput.value;

    const prompt = `You are "${botName}", an AI assistant participating in a Google Meet call.

## How to interact

**Read what people are saying:**
\`\`\`bash
curl -s "${endpoint}?since=TIMESTAMP" | python3 -m json.tool
\`\`\`
First call: omit \`?since=\` to get recent history. Then use the \`asOf\` value from each response as the next \`since\` parameter.

Transcript entries include \`participantName\` (who said it) and \`text\` (what they said).

**Say something in the call:**
\`\`\`bash
curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"${botName}","role":"bot","ownerName":"${botName}","transcript":[{"text":"Your message here"}]}'
\`\`\`
Your transcript text will be spoken aloud in the Meet call via text-to-speech.

**Update the whiteboard (shared screen):**
\`\`\`bash
curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -d '{"sender":"${botName}","role":"bot","ownerName":"${botName}","whiteboard":{"content":"# Your markdown here"}}'
\`\`\`

## Important notes
- \`ownerName\` is REQUIRED in every POST request
- \`sender\` must be exactly "${botName}" for the extension to speak your responses
- Avoid exclamation marks and special characters in text — they can cause shell escaping issues with curl. Use periods instead.
- When using curl with single quotes, apostrophes in text will break the command. Use double quotes with escaped inner quotes, or avoid contractions.
- Poll for new transcripts every few seconds
- Keep responses concise — they will be spoken aloud via TTS
- Use the whiteboard for structured content (notes, diagrams, action items)
`;

    navigator.clipboard.writeText(prompt).then(() => {
      copyPromptBtn.textContent = 'Copied!';
      setTimeout(() => { copyPromptBtn.textContent = 'Copy Agent Prompt'; }, 2000);
    });
  });
});

presentBtn.addEventListener('click', () => {
  sendToContent({ action: 'start-presenting' });
  presentBtn.textContent = 'Presenting…';
  setTimeout(() => { presentBtn.textContent = 'Start Presenting Whiteboard'; }, 3000);
});

// --- Errors, audio status & transcripts ---

const errorBar = document.getElementById('errorBar');
let errorTimeout = null;

function showError(msg) {
  errorBar.textContent = msg;
  errorBar.style.display = 'block';
  if (errorTimeout) clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => { errorBar.style.display = 'none'; }, 10000);
}
errorBar.addEventListener('click', () => { errorBar.style.display = 'none'; });

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'audio-status' || message.action === 'audio-status-response') {
    updateAudioDisplay(message.payload);
  }
  if (message.action === 'transcript') {
    addTranscriptEntry(message.payload);
  }
  if (message.action === 'error') {
    showError(message.message);
  }
});

function addTranscriptEntry(t) {
  // Dedup by content+timestamp
  const key = `${t.speaker}:${t.text}:${t.timestamp}`;
  if (seenEntryIds.has(key)) return;
  seenEntryIds.add(key);

  const time = new Date(t.timestamp).toLocaleTimeString();
  const div = document.createElement('div');
  div.className = 'transcript-entry';
  div.dataset.timestamp = t.timestamp;
  div.innerHTML = `
    <span class="transcript-time">${time}</span>
    <span class="transcript-speaker">[${t.speaker}]</span>
    <span class="transcript-text">${t.text}</span>
  `;

  // Insert in chronological order (newest on top)
  const existing = transcriptArea.children;
  let inserted = false;
  for (let i = 0; i < existing.length; i++) {
    if (Number(existing[i].dataset.timestamp) < t.timestamp) {
      transcriptArea.insertBefore(div, existing[i]);
      inserted = true;
      break;
    }
  }
  if (!inserted) transcriptArea.appendChild(div);

  while (transcriptArea.children.length > 100) {
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
checkStatus();
setInterval(checkStatus, 3000);
