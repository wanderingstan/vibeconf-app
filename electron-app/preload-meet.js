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

// Inject page-inject.js IMMEDIATELY in preload — before any page scripts run.
// This ensures our getUserMedia override is in place when Meet requests media.
// With contextIsolation: false, this preload only runs in the Meet BrowserView,
// so no URL check is needed. Injecting at DOMContentLoaded was too late — Meet's
// scripts could call getUserMedia before that, getting a real mic stream instead
// of our VirtualMic, causing TTS audio to silently fail.
try {
  const pageInjectPath = path.join(__dirname, '..', 'extension', 'page-inject.js');
  const pageInjectCode = fs.readFileSync(pageInjectPath, 'utf-8');
  (0, eval)(pageInjectCode);
  console.log('[electron-meet] page-inject.js loaded (preload, before page scripts)');
} catch (err) {
  console.error('[electron-meet] Failed to load page-inject.js:', err.message);
}

// ---------------------------------------------------------------------------
// Expose screen share helper to page context (for getDisplayMedia override)
// ---------------------------------------------------------------------------

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

window.__vibeconf_startWhiteboardShare = function (meetCode) {
  ipcRenderer.send('start-whiteboard-share', { meetCode });
};

// ---------------------------------------------------------------------------
// Listen for messages from main process and forward to page context
// ---------------------------------------------------------------------------

ipcRenderer.on('extension-message', (_event, message) => {
  // Forward to page context via window.postMessage
  // page-inject.js listens for __botsInCalls messages
  if (message.action === 'play-tts') {
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: 'play-tts',
      payload: message.payload,
    }, '*');
  } else if (message.action === 'unmute-mic') {
    setMicMuted(false);
  } else if (message.action === 'mute-mic') {
    setMicMuted(true);
  } else if (message.action === 'camera-on') {
    setCameraOff(false);
  } else if (message.action === 'camera-off') {
    setCameraOff(true);
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

// Set when we toggle the mic ourselves (TTS unmute / re-mute) so the
// MutationObserver below doesn't interpret our own click as a user gesture.
let suppressMicMuteWatcher = false;

function setMicMuted(mute) {
  const btn = getMicButton();
  if (!btn) return;
  const currentlyMuted = btn.getAttribute('data-is-muted') === 'true';
  if (mute !== currentlyMuted) {
    suppressMicMuteWatcher = true;
    btn.click();
    // Clear after a tick — the data-is-muted update is synchronous on click.
    setTimeout(() => { suppressMicMuteWatcher = false; }, 50);
    console.debug('[electron-meet] Mic', mute ? 'muted' : 'unmuted');
  }
}

// Watch for user toggling the mic via Meet's UI. When that happens we map
// it to a listening-mode change: muted = passive, unmuted = active. Calls
// from our own setMicMuted() set suppressMicMuteWatcher and are ignored.
function startMicMuteWatcher() {
  const btn = getMicButton();
  if (!btn) {
    setTimeout(startMicMuteWatcher, 1000);
    return;
  }
  const observer = new MutationObserver(() => {
    if (suppressMicMuteWatcher) return;
    const muted = btn.getAttribute('data-is-muted') === 'true';
    console.log('[electron-meet] User toggled mic →', muted ? 'muted (passive)' : 'unmuted (active)');
    ipcRenderer.send('mic-mute-changed', { muted });
  });
  observer.observe(btn, { attributes: true, attributeFilter: ['data-is-muted'] });
  console.log('[electron-meet] Mic mute watcher started');
}

// ---------------------------------------------------------------------------
// Camera control
// ---------------------------------------------------------------------------

// Meet's camera toggle swaps its aria-label between "Turn off camera" (when
// the camera is on) and "Turn on camera" (when it's off) — the label is the
// action you'd take by clicking. So we read the current state from the label.
function getCameraButton() {
  return (
    document.querySelector('button[aria-label="Turn off camera"]') ||
    document.querySelector('button[aria-label="Turn on camera"]')
  );
}

function isCameraOn() {
  return !!document.querySelector('button[aria-label="Turn off camera"]');
}

function setCameraOff(off) {
  const btn = getCameraButton();
  if (!btn) {
    console.warn('[electron-meet] Camera button not found');
    return;
  }
  const currentlyOff = !isCameraOn();
  if (off !== currentlyOff) {
    btn.click();
    console.log('[electron-meet] Camera', off ? 'off' : 'on');
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

let BOT_NAME = 'Jimmy';

ipcRenderer.invoke('get-config', ['botName']).then((result) => {
  if (result?.botName) BOT_NAME = result.botName;
});

function ensureStatusBar() {
  if (document.getElementById('vibeconf-status-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'vibeconf-status-bar';
  bar.innerHTML = '<span class="icon">🤖</span><span class="label">Bot View —</span><span class="status" id="vibeconf-status">Initializing...</span>';

  const style = document.createElement('style');
  style.textContent = `
    #vibeconf-status-bar {
      position: fixed; top: 0; left: 0; right: 0; height: 56px;
      background: #cc2222; color: #ffffff;
      font-family: 'Google Sans', 'Roboto', sans-serif; font-size: 26px;
      font-weight: 500;
      display: flex; align-items: center; padding: 0 24px;
      z-index: 999999; user-select: none;
      letter-spacing: 0.5px;
    }
    #vibeconf-status-bar .icon { margin-right: 14px; font-size: 28px; }
    #vibeconf-status-bar .label { color: #ffcccc; margin-right: 12px; }
    #vibeconf-status-bar .status { color: #ffffff; }
    #vibeconf-status-bar .status.error { color: #ffaaaa; font-weight: 700; }
    #vibeconf-status-bar .status.active { color: #ffffff; }
    body { padding-top: 56px !important; }
  `;
  document.head.appendChild(style);
  document.body.prepend(bar);
}

function sendStatus(status) {
  console.log('[electron-meet] Status:', status);
  ensureStatusBar();
  const el = document.getElementById('vibeconf-status');
  if (el) {
    el.textContent = status;
    el.className = 'status';
    if (status.startsWith('Error')) el.classList.add('error');
    else if (status === 'Participating in Meet') el.classList.add('active');
  }
  // Also notify main process for logging
  ipcRenderer.send('meet-status-update', status);
}

// Poll for the captions button and click it as soon as it appears.
// At admission time the "Leave call" button often renders before "Turn on
// captions" does, so a single click attempt misses and we fall through to
// captionScraper's eventual retry (~30s later). This polls every 250ms
// for up to 30 seconds and clicks at the first opportunity.
let captionsClickArmed = false;
function clickCaptionsWhenReady() {
  if (captionsClickArmed) return;
  captionsClickArmed = true;
  const startTime = Date.now();
  const poll = setInterval(() => {
    const onBtn = findByAriaLabel('Turn on captions') || findByAriaLabel('Activar subtítulos');
    const offBtn = findByAriaLabel('Turn off captions') || findByAriaLabel('Desactivar subtítulos');
    if (offBtn) {
      clearInterval(poll);
      console.log('[electron-meet] [CC] Already on, no click needed (', Date.now() - startTime, 'ms after admission)');
      return;
    }
    if (onBtn) {
      clearInterval(poll);
      onBtn.click();
      console.log('[electron-meet] [CC] Clicked "Turn on captions" at', Date.now() - startTime, 'ms after admission');
      return;
    }
    if (Date.now() - startTime > 30_000) {
      clearInterval(poll);
      console.warn('[electron-meet] [CC] Captions button never appeared after 30s');
    }
  }, 250);
}

async function autoJoin(botName) {
  console.log('[electron-meet] ===== AUTO-JOIN STARTING =====');
  sendStatus('Joining Meet...');

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
        sendStatus('Error: mic issue detected');
        ipcRenderer.send('to-panel', {
          action: 'error',
          message: `Cannot join: mic issue detected ("${micLabel}").`,
        });
        return;
      }
    }

    // Click join
    let clicked = false;
    for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
      await delay(1000);
      const joinBtn =
        findByText('Ask to join') ||
        findByText('Join now') ||
        findByAriaLabel('Ask to join') ||
        findByAriaLabel('Join');

      if (joinBtn) {
        const btnText = joinBtn.textContent.trim();
        console.log('[electron-meet] Clicking join:', btnText.slice(0, 30));
        joinBtn.click();
        clicked = true;

        if (btnText.includes('Ask to join')) {
          sendStatus('Waiting to be admitted...');
        } else {
          sendStatus('Joining...');
        }
      }
    }

    if (!clicked) {
      sendStatus('Error: join button not found');
      console.warn('[electron-meet] Could not find join button');
      return;
    }

    // Wait for actual admission — keep waiting indefinitely while Meet shows
    // the "waiting to be admitted" UI. The host may take several minutes to
    // notice the request; we should not time out as long as Meet itself is
    // still asking us to wait. We only bail if waiting text disappears AND
    // in-call UI never appears within a grace period (denied / kicked / etc).
    //
    // Why the grace period: at the moment of admission, the waiting text
    // disappears a beat before the in-call toolbar (Leave call / captions
    // buttons) renders. Without slack, the loop sees "no waiting UI, no
    // in-call UI" and bails immediately even though admission succeeded.
    let admitted = false;
    let waitedSeconds = 0;
    let limboSeconds = 0; // consecutive seconds with neither waiting nor in-call UI
    const LIMBO_GRACE_SECONDS = 15;
    let logEvery = 30;
    while (!admitted) {
      await delay(1000);
      waitedSeconds++;

      const bodyText = document.body.innerText;
      const waitingText = bodyText.includes('wait until') ||
        bodyText.includes('asking to be let in') ||
        bodyText.includes('Please wait');
      const hasJoinUI = !!findByText('Ask to join') || !!findByText('Join now');
      const inCallUI =
        findByAriaLabel('Leave call') ||
        findByAriaLabel('Turn on captions') ||
        findByAriaLabel('Turn off captions') ||
        document.querySelector('[data-tooltip="Leave call"]');

      if (inCallUI && !hasJoinUI) {
        admitted = true;
        sendStatus('Participating in Meet');
        // Don't try a one-shot captions click here — the toolbar's "Leave
        // call" button often renders before "Turn on captions" does, so a
        // single click attempt at admission misses. Instead kick off a
        // separate waiter that retries every 250ms until the captions
        // button is in the DOM, then clicks it. captionScraper.start()
        // also retries via its own loop, so this is a fast-path overlap.
        clickCaptionsWhenReady();
        break;
      }

      if (!waitingText && !hasJoinUI && !inCallUI) {
        limboSeconds++;
        if (limboSeconds >= LIMBO_GRACE_SECONDS) {
          // Genuine failure: waiting UI gone, never saw in-call UI.
          sendStatus("Error: couldn't enter call (denied or removed?)");
          console.warn('[electron-meet] Lost waiting UI without entering call after',
            waitedSeconds, 's (', limboSeconds, 's in limbo)');
          return;
        }
      } else {
        limboSeconds = 0; // reset whenever a known UI is visible
      }

      if (waitedSeconds % logEvery === 0) {
        console.log('[electron-meet] Still waiting to be admitted (', waitedSeconds, 's )');
        sendStatus(`Waiting to be admitted (${Math.floor(waitedSeconds / 60)}m ${waitedSeconds % 60}s)...`);
      }
    }
  } catch (err) {
    sendStatus('Error: ' + err.message);
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

  getParticipantList() {
    return Array.from(this.participants.entries())
      .map(([name, info]) => ({ name, speaking: info.speaking }));
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
    this.onReady = null; // fires once when caption container is observed
  }

  start() {
    if (this.isRunning) return;
    // Don't click here — clickCaptionsWhenReady (armed in the admission
    // loop) is already polling for the button. Clicking again risks a
    // double-toggle (off → on → off). Just wait for confirmation.
    this._waitForCaptions();
  }

  _enableCaptions() {
    const ccButton = findByAriaLabel('Turn on captions') || findByAriaLabel('Activar subtítulos');
    const offBtn = findByAriaLabel('Turn off captions') || findByAriaLabel('Desactivar subtítulos');
    if (ccButton) {
      console.log('[electron-meet] [CC] _enableCaptions: clicking "Turn on captions"');
      ccButton.click();
      console.log('[electron-meet] [CC] _enableCaptions: click() returned at', Date.now());
    } else if (offBtn) {
      console.log('[electron-meet] [CC] _enableCaptions: already on');
    } else {
      console.warn('[electron-meet] [CC] _enableCaptions: no captions button in DOM');
    }
  }

  _waitForCaptions() {
    let attempts = 0;
    // The toolbar's caption button labels itself "Turn off captions" only
    // when captions are actually ON — much more reliable than checking
    // [aria-label="Captions"] container presence (which exists earlier).
    // 250ms poll, retry the click after 30s if the button never flips.
    const poll = setInterval(() => {
      const captionsAreOn = !!document.querySelector('[aria-label="Turn off captions" i]')
        || !!findByAriaLabel('Turn off captions')
        || !!findByAriaLabel('Desactivar subtítulos');
      if (captionsAreOn) {
        clearInterval(poll);
        console.log('[electron-meet] [CC] Captions confirmed on at', Date.now(),
          'after', attempts * 250, 'ms of polling');
        this._observe();
        if (this.onReady) { try { this.onReady(); } catch {} }
      } else if (++attempts > 120) { // 30s of 250ms polls
        clearInterval(poll);
        console.warn('[electron-meet] Captions never flipped on; retrying click');
        this._enableCaptions();
        setTimeout(() => {
          if (findByAriaLabel('Turn off captions')) {
            this._observe();
            if (this.onReady) { try { this.onReady(); } catch {} }
          }
        }, 5000);
      }
    }, 250);
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
    // After speaking, restore mic to its mode-appropriate state. Active mode
    // wants the mic open so the bot can be heard; passive/silent want it muted
    // so the user's mute click maps cleanly to mode. The current mode lives in
    // the main process, so we just ask main to decide.
    ipcRenderer.send('tts-ended');
  }

  if (event.data.action === 'log') {
    // Forward page-inject log lines to main so they land in the Electron
    // stdout stream alongside [local-server]/[electron] lines.
    if (event.data.payload?.line) {
      ipcRenderer.send('page-inject-log', event.data.payload.line);
    }
  }

  if (event.data.action === 'transcript') {
    const t = event.data.payload;
    if (t?.text && t?.speaker) {
      ipcRenderer.send('post-transcripts', [t]);
    }
  }
});

// ---------------------------------------------------------------------------
// Screen share — click "Present now" in Meet UI
// ---------------------------------------------------------------------------

async function clickPresentNow(shareType) {
  // Meet's "Present now" button — try multiple selectors
  // When someone else is presenting, the tooltip changes to "{Name} is presenting"
  const presentBtn =
    findByAriaLabel('Share screen') ||
    findByAriaLabel('Present now') ||
    findByText('Present now') ||
    document.querySelector('[data-tooltip="Share screen"]') ||
    document.querySelector('[data-tooltip="Present now"]') ||
    document.querySelector('[data-tooltip*="is presenting" i]');

  if (presentBtn) {
    presentBtn.click();
    console.log('[electron-meet] Clicked "Present now"');

    // Wait for the share picker to appear, then select share type
    await delay(500);

    if (shareType === 'screen') {
      // Full screen share
      const entireScreen =
        findByText('Your entire screen') ||
        findByText('Entire screen');
      if (entireScreen) {
        entireScreen.click();
        console.log('[electron-meet] Selected "entire screen"');
      }
    } else {
      // Window share (for whiteboard)
      const windowOption =
        findByText('A window') ||
        findByText('Your entire screen') ||
        findByText('Entire screen');
      if (windowOption) {
        windowOption.click();
        console.log('[electron-meet] Selected window/screen share type');
      } else {
        console.log('[electron-meet] Share picker will trigger getDisplayMedia directly');
      }
    }
    return true;
  }

  console.warn('[electron-meet] Could not find "Present now" button');
  return false;
}

ipcRenderer.on('trigger-screen-share', async (_event, options) => {
  const shareType = options?.shareType || 'window';
  console.log('[electron-meet] Screen share triggered, type:', shareType);
  const success = await clickPresentNow(shareType);
  if (!success) {
    ipcRenderer.send('screen-share-error', 'Could not find Present button');
  }

  // Watch for screen share error dialogs
  setTimeout(() => {
    const errorTexts = ["Can't share your screen", "Something went wrong when screen sharing"];
    const allText = document.body?.innerText || '';
    for (const errText of errorTexts) {
      if (allText.includes(errText)) {
        console.error('[electron-meet] Screen share error detected:', errText);
        ipcRenderer.send('screen-share-error', errText);
        // Try to dismiss the dialog
        const dismissBtn = document.querySelector('[aria-label="Close"], [aria-label="Dismiss"], [aria-label="Got it"]');
        if (dismissBtn) dismissBtn.click();
        break;
      }
    }
  }, 3000);
});

ipcRenderer.on('trigger-stop-sharing', () => {
  console.log('[electron-meet] Stop sharing triggered');
  const stopBtn = document.querySelector('[aria-label*="Stop presenting"], [aria-label*="Stop sharing"], [data-tooltip*="Stop presenting"], [data-tooltip*="Stop sharing"]');
  if (stopBtn) {
    stopBtn.click();
    console.log('[electron-meet] Clicked stop sharing button');
    ipcRenderer.send('screen-share-stopped');
  } else {
    console.log('[electron-meet] Stop sharing button not found (may have already stopped)');
    ipcRenderer.send('screen-share-stopped');
  }
});

// ---------------------------------------------------------------------------
// Auto-start after DOM loads
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  // Only run Meet automation on actual Meet pages
  if (!window.location.href.includes('meet.google.com')) {
    console.log('[electron-meet] Not a Meet page, skipping automation');
    return;
  }

  // Watch for pre-join screen
  (async () => {
    sendStatus('Loading Meet...');

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

    // Only start trackers if we're actually in the call
    const leaveBtn = findByAriaLabel('Leave call') ||
      document.querySelector('[data-tooltip="Leave call"]');
    if (!leaveBtn) {
      console.warn('[electron-meet] Not in call, skipping tracker setup');
      return;
    }

    // Start trackers in parallel. Captions were already clicked during the
    // admission loop (~seconds earlier), so by the time we get here Meet's
    // toolbar is rendering the captions UI in parallel with our setup.
    // captionScraper now just polls for the "Turn off captions" label to
    // confirm captions are actually on, then fires 'captions-ready' to
    // main, which flushes the deferred welcome speech.
    captionScraper.onReady = () => {
      console.log('[electron-meet] Captions ready');
      ipcRenderer.send('captions-ready');
    };
    captionScraper.start();
    domSpeakerTracker.start();
    // Don't auto-mute on admission — the mic state IS the mode toggle now.
    // Default unmuted = active mode, which is the historical default.
    startMicMuteWatcher();

    // Start mic health checks
    setInterval(checkMicPermission, 5000);

    // Periodically send participant list to main process
    setInterval(() => {
      const participants = domSpeakerTracker.getParticipantList();
      if (participants.length > 0) {
        ipcRenderer.send('participants-updated', participants);
      }
    }, 2000);

    // Detect presenting state:
    // - "Stop presenting" button/overlay OR toolbar share button with stop label → WE are presenting
    // - Present button tooltip says "{Name} is presenting" → someone ELSE is presenting
    // - Normal Present button → nobody is presenting
    setInterval(() => {
      // Check if we are currently presenting. Two locations depending on window size:
      // 1. Large window: "Stop presenting" overlay button on the shared content
      // 2. Small window: the toolbar share button itself shows "Stop presenting"
      const stopPresentingBtn =
        document.querySelector('[aria-label*="Stop presenting" i]') ||
        document.querySelector('[data-tooltip*="Stop presenting" i]') ||
        document.querySelector('button[aria-label*="stop" i][aria-label*="present" i]') ||
        document.querySelector('[data-tooltip*="stop" i][data-tooltip*="present" i]');
      if (stopPresentingBtn) {
        ipcRenderer.send('self-presenting', { presenting: true });
        ipcRenderer.send('someone-presenting', { presenting: false, presenterName: null });
        return;
      }
      ipcRenderer.send('self-presenting', { presenting: false });

      // Check if someone else is presenting
      const presentBtn =
        findByAriaLabel('Share screen') ||
        findByAriaLabel('Present now') ||
        document.querySelector('[data-tooltip*="presenting" i]') ||
        document.querySelector('[data-tooltip*="Present" i]') ||
        document.querySelector('[data-tooltip*="Share screen" i]');
      if (presentBtn) {
        const tooltip = presentBtn.getAttribute('data-tooltip') || presentBtn.getAttribute('aria-label') || '';
        // When someone else is presenting, tooltip is like "John Doe is presenting"
        const match = tooltip.match(/^(.+?)\s+is presenting/i);
        if (match) {
          ipcRenderer.send('someone-presenting', { presenting: true, presenterName: match[1] });
        } else {
          ipcRenderer.send('someone-presenting', { presenting: false, presenterName: null });
        }
      }
    }, 3000);

    // Start sync and announce arrival
    const meetCode = window.location.pathname.replace('/', '');
    if (meetCode) {
      ipcRenderer.send('start-sync', { meetCode, botName: BOT_NAME });
      ipcRenderer.send('bot-joined-call', { meetCode, botName: BOT_NAME });
    }
  })();
});
