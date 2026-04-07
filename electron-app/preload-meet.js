// preload-meet.js — Preload script for the Meet BrowserWindow.
// Runs with contextIsolation: false so it shares the page's world.
// This lets us patch getUserMedia BEFORE Meet's scripts run.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Inject page-inject.js IMMEDIATELY — before any page scripts execute.
// With contextIsolation: false, this runs in the page's JS context,
// so our getUserMedia override is in place when Meet's code loads.
// ---------------------------------------------------------------------------

try {
  const pageInjectPath = path.join(__dirname, '..', 'extension', 'page-inject.js');
  const pageInjectCode = fs.readFileSync(pageInjectPath, 'utf-8');
  // Use indirect eval to run in the global scope (same as page context)
  (0, eval)(pageInjectCode);
  console.log('[electron-meet] page-inject.js loaded successfully');
} catch (err) {
  console.error('[electron-meet] Failed to load page-inject.js:', err.message);
}

// ---------------------------------------------------------------------------
// Listen for messages from main process and forward to page context
// ---------------------------------------------------------------------------

ipcRenderer.on('extension-message', (_event, message) => {
  // Forward to page context via window.postMessage
  // page-inject.js listens for __botsInCalls messages
  if (message.action === 'play-tts-audio') {
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: 'play-tts-audio',
      payload: message.payload,
    }, '*');
  } else if (message.action === 'unmute-mic') {
    setMicMuted(false);
  } else if (message.action === 'mute-mic') {
    setMicMuted(true);
  } else if (message.action === 'play-speech-test') {
    // Resolve test audio — main process sends the base64 directly
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: 'play-speech-test',
      payload: message.payload,
    }, '*');
  } else {
    // Generic forward
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      ...message,
    }, '*');
  }
});

// ---------------------------------------------------------------------------
// DOM helpers (from content-script.js)
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findByText(text, { exact = false } = {}) {
  if (!document.body) return null;
  const lower = text.toLowerCase();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const nodeText = walk.currentNode.textContent.trim().toLowerCase();
    const match = exact ? nodeText === lower : nodeText.includes(lower);
    if (match) {
      let el = walk.currentNode.parentElement;
      while (el && el !== document.body) {
        if (
          el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'button' ||
          el.hasAttribute('jsaction') ||
          el.tabIndex >= 0
        ) {
          return el;
        }
        el = el.parentElement;
      }
      return walk.currentNode.parentElement;
    }
  }
  return null;
}

function findByAriaLabel(label) {
  return document.querySelector(
    `button[aria-label*="${label}" i], [role="button"][aria-label*="${label}" i]`
  );
}

async function typeIntoInput(input, value) {
  input.focus();
  input.click();
  await delay(200);

  input.select();
  const ok = document.execCommand('insertText', false, value);
  if (ok && input.value === value) return true;

  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, '');

  for (const char of value) {
    const keyOpts = { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    input.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
    nativeSetter.call(input, input.value + char);
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, data: char, inputType: 'insertText',
    }));
    input.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    await delay(10);
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  input.focus();
  return input.value === value;
}

// ---------------------------------------------------------------------------
// Mic control
// ---------------------------------------------------------------------------

function getMicButton() {
  return document.querySelector('button[data-is-muted][aria-label*="microphone" i]');
}

function isMicMuted() {
  const btn = getMicButton();
  return btn?.getAttribute('data-is-muted') === 'true';
}

function setMicMuted(mute) {
  const btn = getMicButton();
  if (!btn) return;
  const currentlyMuted = btn.getAttribute('data-is-muted') === 'true';
  if (mute !== currentlyMuted) {
    btn.click();
    console.debug('[electron-meet] Mic', mute ? 'muted' : 'unmuted');
  }
}

// ---------------------------------------------------------------------------
// Mic permission check
// ---------------------------------------------------------------------------

let lastMicStatus = 'unknown';

function checkMicPermission() {
  const btn = document.querySelector('button[data-is-muted]');
  if (!btn) return;

  const label = btn.getAttribute('aria-label') || '';
  const isMutedAttr = btn.getAttribute('data-is-muted');

  const isHealthy =
    (label === 'Turn off microphone' && isMutedAttr === 'false') ||
    (label === 'Turn on microphone' && isMutedAttr === 'true');

  const newStatus = isHealthy ? 'healthy' : 'problem';

  if (newStatus === 'problem') {
    if (newStatus !== lastMicStatus) {
      console.warn('[electron-meet] Mic issue:', label, 'data-is-muted:', isMutedAttr);
    }
    ipcRenderer.send('to-panel', {
      action: 'error',
      message: `Microphone issue: "${label}". Try reloading the Meet window.`,
    });
  } else if (newStatus !== lastMicStatus) {
    ipcRenderer.send('to-panel', { action: 'mic-status', status: 'healthy' });
  }
  lastMicStatus = newStatus;
}

// ---------------------------------------------------------------------------
// Auto-join
// ---------------------------------------------------------------------------

let BOT_NAME = 'AI Assistant';

ipcRenderer.invoke('get-config', ['botName']).then((result) => {
  if (result?.botName) BOT_NAME = result.botName;
});

async function autoJoin(botName) {
  console.log('[electron-meet] ===== AUTO-JOIN STARTING =====');

  try {
    await delay(3000);

    // Dismiss dialogs
    for (const label of ['Got it', 'Dismiss', 'OK', 'Allow', 'Close', 'No thanks', 'Not now']) {
      const btn = findByText(label);
      if (btn) {
        btn.click();
        await delay(300);
      }
    }

    // Fill name
    const nameInput =
      document.querySelector('input[placeholder="Your name"]') ||
      document.querySelector('input[aria-label="Your name"]') ||
      document.querySelector('input[autocomplete="name"]');

    if (nameInput) {
      await typeIntoInput(nameInput, botName);
      await delay(1000);
    }

    // Check mic health before joining
    const micBtn = document.querySelector('button[data-is-muted]');
    if (micBtn) {
      const micLabel = micBtn.getAttribute('aria-label') || '';
      const micMuted = micBtn.getAttribute('data-is-muted');
      const micHealthy =
        (micLabel === 'Turn off microphone' && micMuted === 'false') ||
        (micLabel === 'Turn on microphone' && micMuted === 'true');

      if (!micHealthy) {
        console.warn('[electron-meet] Mic problem on pre-join screen');
        ipcRenderer.send('to-panel', {
          action: 'error',
          message: `Cannot join: mic issue detected ("${micLabel}").`,
        });
        return;
      }
    }

    // Click join
    let joined = false;
    for (let attempt = 0; attempt < 5 && !joined; attempt++) {
      await delay(1000);
      const joinBtn =
        findByText('Ask to join') ||
        findByText('Join now') ||
        findByAriaLabel('Ask to join') ||
        findByAriaLabel('Join');

      if (joinBtn) {
        console.log('[electron-meet] Clicking join:', joinBtn.textContent.trim().slice(0, 30));
        joinBtn.click();
        joined = true;
      }
    }

    if (!joined) {
      console.warn('[electron-meet] Could not find join button');
    }
  } catch (err) {
    console.error('[electron-meet] Auto-join error:', err);
  }
}

// ---------------------------------------------------------------------------
// DOM Speaker Tracker (from content-script.js)
// ---------------------------------------------------------------------------

class DOMSpeakerTracker {
  constructor() {
    this.participants = new Map();
    this.observer = null;
    this.isTracking = false;
    this.checkInterval = null;
  }

  start() {
    if (this.isTracking) return;
    this.isTracking = true;
    this._ensurePeoplePaneOpen();
    this.checkInterval = setInterval(() => {
      this._scanParticipants();
      if (this.participants.size === 0) this._ensurePeoplePaneOpen();
    }, 2000);
    this._startObserving();
    this.speakingPollInterval = setInterval(() => this._pollSpeakingState(), 200);
  }

  stop() {
    this.isTracking = false;
    if (this.observer) this.observer.disconnect();
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.speakingPollInterval) clearInterval(this.speakingPollInterval);
  }

  _ensurePeoplePaneOpen() {
    const participantList = document.querySelector('[jsname="jrQDbd"]') ||
      document.querySelector('[role="list"][aria-label="Participants"]');
    if (participantList) return;

    const allButtons = document.querySelectorAll('[role="button"][aria-labelledby]');
    for (const btn of allButtons) {
      const labelId = btn.getAttribute('aria-labelledby');
      if (labelId) {
        const label = document.getElementById(labelId);
        if (label && label.textContent.trim() === 'People') {
          btn.click();
          return;
        }
      }
    }
  }

  _scanParticipants() {
    const items = document.querySelectorAll('div[role="listitem"][aria-label]');
    for (const item of items) {
      const name = item.getAttribute('aria-label');
      if (!name) continue;
      const indicator = item.querySelector('[jsname="QgSmzd"]');
      if (!indicator) continue;

      if (!this.participants.has(name)) {
        this.participants.set(name, {
          speaking: false, element: indicator, item,
          lastClasses: indicator.className, classChangeCount: 0,
          lastPollTime: Date.now(), lastChange: Date.now(),
        });
      } else {
        const info = this.participants.get(name);
        info.element = indicator;
        info.item = item;
      }
    }
  }

  _startObserving() {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          this._checkSpeakingChange(mutation.target);
        }
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) this._checkSpeakingChange(node);
          }
        }
      }
    });
    this.observer.observe(document.body, {
      attributes: true, attributeFilter: ['class'], childList: true, subtree: true,
    });
  }

  _checkSpeakingChange(element) {
    for (const [name, info] of this.participants) {
      if (!info.element) continue;
      if (info.element === element || info.element.contains(element) || element.contains?.(info.element)) {
        const isSpeaking = this._isSpeakingIndicatorActive(info.element, name);
        if (isSpeaking !== info.speaking) {
          info.speaking = isSpeaking;
          info.lastChange = Date.now();
          ipcRenderer.send('update-speaking', { name, speaking: isSpeaking });
        }
      }
    }
  }

  _isSpeakingIndicatorActive(element, name) {
    if (!element) return false;
    const info = name ? this.participants.get(name) : null;
    if (!info) return false;

    const currentClasses = element.className || '';
    const now = Date.now();

    if (currentClasses !== info.lastClasses) {
      info.classChangeCount++;
      info.lastClasses = currentClasses;
      info.lastClassChangeTime = now;
    }

    if (now - info.lastPollTime > 2000) {
      info.wasAnimating = info.classChangeCount >= 2;
      info.classChangeCount = 0;
      info.lastPollTime = now;
    }

    const recentChange = info.lastClassChangeTime && (now - info.lastClassChangeTime < 1000);
    return recentChange && (info.classChangeCount >= 2 || info.wasAnimating);
  }

  _pollSpeakingState() {
    for (const [name, info] of this.participants) {
      if (!info.element) continue;
      const isSpeaking = this._isSpeakingIndicatorActive(info.element, name);
      if (isSpeaking !== info.speaking) {
        info.speaking = isSpeaking;
        info.lastChange = Date.now();
      }
      if (info.speaking) {
        ipcRenderer.send('update-speaking', { name, speaking: true });
      }
    }
  }

  getSpeakingNames() {
    return Array.from(this.participants.entries())
      .filter(([_, info]) => info.speaking)
      .map(([name]) => name);
  }
}

const domSpeakerTracker = new DOMSpeakerTracker();

// ---------------------------------------------------------------------------
// Caption Scraper (from content-script.js)
// ---------------------------------------------------------------------------

class CaptionScraper {
  constructor() {
    this.lastText = '';
    this.lastSpeaker = '';
    this.lastPostedText = '';
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this._enableCaptions();
    this._waitForCaptions();
  }

  _enableCaptions() {
    const ccButton = findByAriaLabel('Turn on captions') || findByAriaLabel('Activar subtítulos');
    if (ccButton) {
      ccButton.click();
      console.log('[electron-meet] Enabled captions');
    }
  }

  _waitForCaptions() {
    let attempts = 0;
    const poll = setInterval(() => {
      const container = document.querySelector('div[role="region"][aria-label="Captions"]');
      if (container) {
        clearInterval(poll);
        this._observe();
      } else if (++attempts > 30) {
        clearInterval(poll);
        this._enableCaptions();
        setTimeout(() => {
          if (document.querySelector('div[role="region"][aria-label="Captions"]')) this._observe();
        }, 5000);
      }
    }, 1000);
  }

  _observe() {
    this.isRunning = true;
    this._pollInterval = setInterval(() => this._checkCaptions(), 1000);
  }

  _checkCaptions() {
    try {
      const container = document.querySelector('div[role="region"][aria-label="Captions"]');
      if (!container) return;

      const captionBlocks = [];
      for (const child of container.children) {
        if (!child.querySelector('img')) continue;
        const span = child.querySelector('span');
        const speaker = span?.textContent?.trim() || 'unknown';
        let text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text.startsWith(speaker)) text = text.slice(speaker.length).trim();
        if (text) captionBlocks.push({ speaker, text });
      }

      if (captionBlocks.length === 0) return;

      const snapshot = captionBlocks.map(b => `${b.speaker}:${b.text}`).join('|');
      const lastBlock = captionBlocks[captionBlocks.length - 1];

      // Forward raw caption to panel
      ipcRenderer.send('to-panel', {
        action: 'raw-caption',
        text: lastBlock.text,
        speaker: lastBlock.speaker,
      });

      if (snapshot === this._lastSnapshot) {
        if (lastBlock.text !== this.lastPostedText && lastBlock.speaker !== 'You') {
          this._postCaption(lastBlock.speaker, lastBlock.text, false);
        }
        return;
      }

      if (lastBlock.speaker !== this.lastSpeaker && this.lastSpeaker && this.lastPostedText) {
        this._postCaption(this.lastSpeaker, this.lastPostedText, true);
      }

      this._lastSnapshot = snapshot;
      this.lastSpeaker = lastBlock.speaker;
      this.lastText = lastBlock.text;

      const now = Date.now();
      if (!this._lastPostTime) this._lastPostTime = now;
      if (now - this._lastPostTime > 3000) {
        this._postCaption(lastBlock.speaker, lastBlock.text, false);
        this._lastPostTime = now;
      }
    } catch (err) {
      console.error('[captions] poll error:', err);
    }
  }

  _postCaption(speaker, text, isFinal) {
    if (speaker === 'You') return;
    if (text === this.lastPostedText) return;
    this.lastPostedText = text;

    ipcRenderer.send('post-transcripts', [{ speaker, text, timestamp: Date.now() }]);
    ipcRenderer.send('to-panel', {
      action: isFinal ? 'transcript' : 'caption-update',
      payload: { speaker, text, timestamp: Date.now(), source: 'captions' },
    });
  }

  stop() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    this.isRunning = false;
  }
}

const captionScraper = new CaptionScraper();

// ---------------------------------------------------------------------------
// Page message listener — forward from page-inject.js to main process
// ---------------------------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__botsInCalls) return;

  if (event.data.action === 'dom-speaker-change') {
    const { name, speaking } = event.data.payload;
    if (name) ipcRenderer.send('update-speaking', { name, speaking });
  }

  if (event.data.action === 'tts-ended') {
    setTimeout(() => setMicMuted(true), 500);
  }

  if (event.data.action === 'transcript') {
    const t = event.data.payload;
    if (t?.text && t?.speaker) {
      ipcRenderer.send('post-transcripts', [t]);
    }
  }
});

// ---------------------------------------------------------------------------
// Auto-start after DOM loads
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  // Watch for pre-join screen
  (async () => {
    for (let i = 0; i < 30; i++) {
      const nameInput =
        document.querySelector('input[placeholder="Your name"]') ||
        document.querySelector('input[aria-label="Your name"]') ||
        document.querySelector('input[autocomplete="name"]');
      const joinBtn = findByText('Ask to join') || findByText('Join now');

      if (nameInput || joinBtn) {
        await autoJoin(BOT_NAME);
        break;
      }
      await delay(1000);
    }

    // Start trackers after join
    await delay(3000);
    domSpeakerTracker.start();
    await delay(5000);
    captionScraper.start();
    setMicMuted(true);

    // Start mic health checks
    setInterval(checkMicPermission, 5000);

    // Start sync
    const meetCode = window.location.pathname.replace('/', '');
    if (meetCode) {
      ipcRenderer.send('start-sync', { meetCode, botName: BOT_NAME });
    }
  })();
});
