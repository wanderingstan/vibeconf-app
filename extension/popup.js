// popup.js — Popup UI controller

const statusEl = document.getElementById('status');
const botNameInput = document.getElementById('botName');
const joinBtn = document.getElementById('joinBtn');
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
    speakBtn.disabled = false;
  } else {
    statusEl.textContent = 'No Meet tab found — open a Google Meet link first';
    statusEl.className = 'status';
    joinBtn.disabled = true;
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
