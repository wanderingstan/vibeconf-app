// settings.js — Settings popup controller

const statusEl = document.getElementById('status');
const botNameInput = document.getElementById('botName');
const ttsApiKeyInput = document.getElementById('ttsApiKey');
const ttsVoiceIdInput = document.getElementById('ttsVoiceId');
const speakTextInput = document.getElementById('speakText');
const speakTextBtn = document.getElementById('speakTextBtn');
const speechBtn = document.getElementById('speechBtn');

function sendToContent(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ target: 'content', ...message }, (resp) => resolve(resp));
  });
}

// --- Load saved config ---
chrome.storage.local.get(['botName', 'ttsApiKey', 'ttsVoiceId'], (result) => {
  if (result.botName) botNameInput.value = result.botName;
  if (result.ttsApiKey) ttsApiKeyInput.value = result.ttsApiKey;
  if (result.ttsVoiceId) ttsVoiceIdInput.value = result.ttsVoiceId;
});

// --- Check for Meet tab ---
async function checkStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    if (tabs.length > 0) {
      statusEl.textContent = 'Meet tab detected';
      statusEl.className = 'status active';
      speakTextBtn.disabled = false;
      speechBtn.disabled = false;
    } else {
      statusEl.textContent = 'No Meet tab — test buttons require an active call';
      statusEl.className = 'status';
      speakTextBtn.disabled = true;
      speechBtn.disabled = true;
    }
  } catch (err) {
    console.error('[settings] checkStatus error:', err);
  }
}

// --- Save handlers ---
botNameInput.addEventListener('change', () => {
  const name = botNameInput.value.trim() || 'AI Assistant';
  chrome.storage.local.set({ botName: name });
  sendToContent({ target: 'page', action: 'set-config', payload: { botName: name } });
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

// --- Test buttons ---
speakTextBtn.addEventListener('click', () => {
  const text = speakTextInput.value.trim();
  if (!text) return;
  speakTextBtn.textContent = 'Speaking…';
  speakTextBtn.disabled = true;
  chrome.runtime.sendMessage({ action: 'speak', text }, (resp) => {
    speakTextBtn.textContent = 'Speak';
    speakTextBtn.disabled = false;
    if (resp?.error) {
      speakTextBtn.textContent = 'Error — check key';
      setTimeout(() => { speakTextBtn.textContent = 'Speak'; }, 3000);
    }
  });
});

speakTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') speakTextBtn.click();
});

speechBtn.addEventListener('click', () => {
  sendToContent({ target: 'page', action: 'play-speech-test' });
  speechBtn.textContent = 'Playing…';
  setTimeout(() => { speechBtn.textContent = 'Play Sample Audio'; }, 5000);
});

checkStatus();
setInterval(checkStatus, 5000);
