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
    speechBtn.disabled = false;
    toneBtn.disabled = false;
    speakBtn.disabled = false;
  } else {
    statusEl.textContent = 'No Meet tab found — open a Google Meet link first';
    statusEl.className = 'status';
    joinBtn.disabled = true;
    presentBtn.disabled = true;
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

checkStatus();
