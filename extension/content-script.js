// content-script.js — Runs in ISOLATED world on Google Meet pages.
// Responsibilities:
//  0. FIRST: inject early media API patches before any page scripts run
//  1. Message bridge between extension (popup/background) and page context
//  2. Google Meet UI automation (guest name entry, join button, dialogs)
//  3. Auto-join: detects the pre-join screen and fills in name automatically

'use strict';

console.log('[bots-in-calls] Content script loaded on:', location.href);

// ---------------------------------------------------------------------------
// Configuration — read from storage, with fallback
// ---------------------------------------------------------------------------

let BOT_NAME = 'AI Assistant';

// Try to get the name from extension storage
try {
  chrome.storage?.local?.get('botName', (result) => {
    if (result?.botName) BOT_NAME = result.botName;
    console.debug('[bots-in-calls] Bot name:', BOT_NAME);
  });
} catch (e) {
  // storage not available, use default
}

// ---------------------------------------------------------------------------
// Message bridge: extension ↔ page
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.debug('[bots-in-calls] Content script received:', message.action);

  if (message.target === 'page') {
    const outgoing = { __botsInCalls: true, __fromExtension: true, ...message };

    // For speech test, resolve the extension URL (page script can't access chrome.runtime)
    if (message.action === 'play-speech-test') {
      outgoing.payload = { url: chrome.runtime.getURL('test-speech.mp3') };
    }

    window.postMessage(outgoing, '*');
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'get-status') {
    sendResponse({ url: location.href, ready: true });
    return;
  }

  if (message.action === 'join-meet') {
    BOT_NAME = message.botName || BOT_NAME;
    autoJoin(BOT_NAME);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'start-presenting') {
    startPresenting();
    sendResponse({ ok: true });
    return;
  }

  // STT result from tab audio capture
  if (message.action === 'stt-result') {
    const speakingNames = domSpeakerTracker.getSpeakingNames();
    const speaker = speakingNames[0] || 'unknown';

    console.log(`[bots-in-calls] STT [${speaker}]: ${message.text.slice(0, 60)}`);

    // Emit as transcript (for sync and side panel display)
    window.postMessage({
      __botsInCalls: true,
      action: 'transcript',
      payload: {
        timestamp: Date.now(),
        text: message.text,
        speaker,
        confidence: 1.0,
        source: 'tabCapture-stt',
      },
    }, '*');
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'unmute-mic') {
    setMicMuted(false);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'mute-mic') {
    setMicMuted(true);
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'set-bot-name') {
    BOT_NAME = message.botName || BOT_NAME;
    sendResponse({ ok: true });
    return;
  }
});

// Page → extension (only forward messages originating from the page, not our own)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__botsInCalls) return;
  if (event.data.__fromExtension) return; // don't echo back our own messages
  chrome.runtime.sendMessage(event.data).catch(() => {});
});

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Find a clickable element by its visible text (case-insensitive, substring match).
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

// Simulate typing — multiple strategies for Google's JSAction framework
async function typeIntoInput(input, value) {
  console.debug('[bots-in-calls] Attempting to type into input:', input.placeholder || input.ariaLabel);

  input.focus();
  input.click();
  await delay(200);

  // Strategy 1: execCommand
  input.select();
  const ok = document.execCommand('insertText', false, value);
  if (ok && input.value === value) {
    console.debug('[bots-in-calls] Typed via execCommand');
    return true;
  }
  console.debug('[bots-in-calls] execCommand result:', ok, 'value:', input.value);

  // Strategy 2: Native setter + synthetic InputEvent
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  nativeSetter.call(input, '');

  for (const char of value) {
    const keyOpts = { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    input.dispatchEvent(new KeyboardEvent('keypress', keyOpts));

    nativeSetter.call(input, input.value + char);

    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: char,
      inputType: 'insertText',
    }));

    input.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    await delay(10); // small delay between chars for realism
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  input.focus();

  console.debug('[bots-in-calls] Typed via key simulation:', input.value);
  return input.value === value;
}

// ---------------------------------------------------------------------------
// Google Meet auto-join flow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mic mute/unmute — bot mutes itself except when speaking
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
  if (!btn) {
    console.debug('[bots-in-calls] Mic button not found');
    return;
  }
  const currentlyMuted = btn.getAttribute('data-is-muted') === 'true';
  if (mute !== currentlyMuted) {
    btn.click();
    console.debug('[bots-in-calls] Mic', mute ? 'muted' : 'unmuted');
  }
}

// ---------------------------------------------------------------------------
// Screen share automation — click "Present now" in Meet's UI
// ---------------------------------------------------------------------------

async function startPresenting() {
  console.debug('[bots-in-calls] Starting presentation...');

  try {
    // Step 1: Ask the background script to open the whiteboard tab
    chrome.runtime.sendMessage({ action: 'open-whiteboard' });
    console.debug('[bots-in-calls] Requested whiteboard tab');
    await delay(1000);

    // Step 2: Click Meet's "Share screen" button
    const presentBtn =
      findByAriaLabel('Share screen') ||
      findByAriaLabel('Present now');

    if (presentBtn) {
      presentBtn.click();
      console.debug('[bots-in-calls] Clicked "Share screen" — Chrome picker should appear');
      console.debug('[bots-in-calls] Please select the "AI Assistant — Whiteboard" tab from the picker');
    } else {
      console.warn('[bots-in-calls] Could not find "Present now" button');
      // Debug
      const allBtns = document.querySelectorAll('button, [role="button"]');
      console.debug('[bots-in-calls] All buttons:');
      allBtns.forEach((b, i) => {
        if (b.offsetParent !== null) {
          console.debug(`  [${i}] "${b.textContent.trim().slice(0, 50)}" aria="${b.getAttribute('aria-label') || ''}"  tag=${b.tagName}`);
        }
      });
    }
  } catch (err) {
    console.error('[bots-in-calls] Present failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Google Meet auto-join flow
// ---------------------------------------------------------------------------

async function autoJoin(botName) {
  console.log('[bots-in-calls] ===== AUTO-JOIN STARTING =====');
  console.debug('[bots-in-calls] Bot name:', botName);

  try {
    // 1. Wait for Meet's pre-join UI to render
    console.debug('[bots-in-calls] Waiting for pre-join UI...');
    await delay(3000);

    // 2. Dismiss any dialogs first
    for (const label of ['Got it', 'Dismiss', 'OK', 'Allow', 'Close', 'No thanks', 'Not now']) {
      const btn = findByText(label);
      if (btn) {
        btn.click();
        console.debug('[bots-in-calls] Dismissed:', label);
        await delay(300);
      }
    }

    // 3. Fill the name input if present (Meet may skip it if name is remembered)
    const nameInput =
      document.querySelector('input[placeholder="Your name"]') ||
      document.querySelector('input[aria-label="Your name"]') ||
      document.querySelector('input[autocomplete="name"]');

    if (nameInput) {
      console.debug('[bots-in-calls] Found name input, typing bot name');
      await typeIntoInput(nameInput, botName);
      await delay(1000);
    } else {
      console.debug('[bots-in-calls] No name input — Meet likely remembered the name');
    }

    // 4. Click the join button
    console.debug('[bots-in-calls] Looking for join button...');
    let joined = false;
    for (let attempt = 0; attempt < 5 && !joined; attempt++) {
      await delay(1000);

      const joinBtn =
        findByText('Ask to join') ||
        findByText('Join now') ||
        findByAriaLabel('Ask to join') ||
        findByAriaLabel('Join');

      if (joinBtn) {
        console.log('[bots-in-calls] Found join button:', joinBtn.textContent.trim().slice(0, 30));
        joinBtn.click();
        joined = true;
        break;
      }

      // Debug: log visible buttons on attempt 2
      if (attempt === 1) {
        const allBtns = document.querySelectorAll('button, [role="button"]');
        console.debug('[bots-in-calls] Visible buttons (' + allBtns.length + '):');
        allBtns.forEach((b, i) => {
          console.debug(`  [${i}] "${b.textContent.trim().slice(0, 50)}" aria="${b.getAttribute('aria-label') || ''}" disabled=${b.disabled}`);
        });
      }
    }

    if (!joined) {
      console.warn('[bots-in-calls] ✗ Could not find join button after 5 attempts');
    }
  } catch (err) {
    console.error('[bots-in-calls] Auto-join error:', err);
  }
}

// ---------------------------------------------------------------------------
// Auto-start: watch for the pre-join screen and join automatically
// ---------------------------------------------------------------------------

async function watchForPreJoinScreen() {
  console.debug('[bots-in-calls] Watching for pre-join screen...');

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
  }

  // Poll for name input OR join button (Meet may skip the name if it remembers it)
  for (let i = 0; i < 30; i++) { // up to 30 seconds
    const nameInput =
      document.querySelector('input[placeholder="Your name"]') ||
      document.querySelector('input[aria-label="Your name"]') ||
      document.querySelector('input[autocomplete="name"]');

    const joinBtn =
      findByText('Ask to join') ||
      findByText('Join now') ||
      findByAriaLabel('Ask to join') ||
      findByAriaLabel('Join');

    if (nameInput || joinBtn) {
      console.log('[bots-in-calls] Pre-join screen detected',
        nameInput ? '(name input found)' : '(join button found, name remembered)');
      await autoJoin(BOT_NAME);
      return;
    }
    await delay(1000);
  }

  console.debug('[bots-in-calls] No pre-join screen detected (might already be signed in)');
}

// Kick off the auto-join watcher
watchForPreJoinScreen();

// ---------------------------------------------------------------------------
// DOM-based Speaker Tracker
//
// Meet's People pane shows speaking indicators for each participant.
// We observe DOM mutations on these elements to know exactly who is
// speaking and when — using Meet's own voice activity detection.
//
// This gives us:
//   - Real participant names (from aria-label)
//   - Reliable speaking detection (Meet's own VAD)
//   - No audio analysis needed
// ---------------------------------------------------------------------------

class DOMSpeakerTracker {
  constructor() {
    this.participants = new Map(); // name → {speaking, element, lastChange}
    this.observer = null;
    this.peoplePane = null;
    this.isTracking = false;
    this.checkInterval = null;
  }

  // Start tracking — call after joining the call
  start() {
    if (this.isTracking) return;
    this.isTracking = true;
    console.debug('[bots-in-calls] DOM speaker tracker starting...');

    // Ensure the People pane is open so we can observe it
    this._ensurePeoplePaneOpen();

    // Poll for participant elements; retry opening the pane if needed
    this.checkInterval = setInterval(() => {
      this._scanParticipants();
      // If no participants found, pane may not be open
      if (this.participants.size === 0) {
        this._ensurePeoplePaneOpen();
      }
    }, 2000);

    // Also set up a MutationObserver on the entire document for class changes
    this._startObserving();

    // Periodically post who is currently speaking (not just transitions)
    // so the speakingLog in the transcription system gets continuous entries
    this.speakingPollInterval = setInterval(() => this._pollSpeakingState(), 200);
  }

  stop() {
    this.isTracking = false;
    if (this.observer) this.observer.disconnect();
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.speakingPollInterval) clearInterval(this.speakingPollInterval);
    console.debug('[bots-in-calls] DOM speaker tracker stopped');
  }

  _ensurePeoplePaneOpen() {
    // Check if participant list is already visible
    const participantList = document.querySelector('[jsname="jrQDbd"]') ||
      document.querySelector('[role="list"][aria-label="Participants"]');
    if (participantList) {
      console.debug('[bots-in-calls] People pane already open');
      return;
    }

    // The People button is a div[role="button"] whose aria-labelledby points
    // to a hidden span containing "People". Find it by looking for that span.
    const allButtons = document.querySelectorAll('[role="button"][aria-labelledby]');
    for (const btn of allButtons) {
      const labelId = btn.getAttribute('aria-labelledby');
      if (labelId) {
        const label = document.getElementById(labelId);
        if (label && label.textContent.trim() === 'People') {
          console.debug('[bots-in-calls] Found People button, clicking...');
          btn.click();
          console.log('[bots-in-calls] People pane opened for speaker tracking');
          return;
        }
      }
    }

    // Fallback: look for the element by its hidden span directly
    const allSpans = document.querySelectorAll('span[id]');
    for (const span of allSpans) {
      if (span.textContent.trim() === 'People' && span.style.display === 'none') {
        // Find the closest clickable ancestor
        const btn = span.closest('[role="button"]') ||
          span.closest('[tabindex="0"]') ||
          span.parentElement?.closest('[role="button"]');
        if (btn) {
          console.debug('[bots-in-calls] Found People button via hidden span, clicking...');
          btn.click();
          return;
        }
      }
    }

    console.debug('[bots-in-calls] People button not found — will retry');
  }

  _scanParticipants() {
    // Each participant is a div[role="listitem"] with aria-label="Name"
    // inside the participant list (jsname="jrQDbd")
    const items = document.querySelectorAll('div[role="listitem"][aria-label]');

    for (const item of items) {
      const name = item.getAttribute('aria-label');
      if (!name) continue;

      // Find the speaking indicator: div[jsname="QgSmzd"] with the animated bars
      const indicator = item.querySelector('[jsname="QgSmzd"]');
      if (!indicator) continue;

      if (!this.participants.has(name)) {
        this.participants.set(name, {
          speaking: false,
          element: indicator,
          item,
          lastClasses: indicator.className,
          classChangeCount: 0,
          lastPollTime: Date.now(),
          lastChange: Date.now(),
        });
        console.log('[bots-in-calls] Tracking participant:', name);
      } else {
        // Update element references in case DOM rebuilt
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
        // Also check child elements for class changes
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) this._checkSpeakingChange(node);
          }
        }
      }
    });

    this.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
  }

  _checkSpeakingChange(element) {
    // Check if this element or its parent is a tracked speaking indicator
    for (const [name, info] of this.participants) {
      if (!info.element) continue;
      if (info.element === element || info.element.contains(element) ||
          element.contains?.(info.element)) {
        const isSpeaking = this._isSpeakingIndicatorActive(info.element, name);
        if (isSpeaking !== info.speaking) {
          info.speaking = isSpeaking;
          info.lastChange = Date.now();

          // Report to page context
          window.postMessage({
            __botsInCalls: true,
            __fromExtension: true,
            action: 'dom-speaker-change',
            payload: {
              name,
              speaking: isSpeaking,
              timestamp: Date.now(),
            },
          }, '*');

          console.log(`[bots-in-calls] DOM: ${name} ${isSpeaking ? 'started' : 'stopped'} speaking`);
        }
      }
    }
  }

  // Detect speaking by checking if classes are actively changing (animating).
  // Meet rotates classes on the indicator element during speech animation.
  // A static class (even if different from others) means NOT speaking.
  _isSpeakingIndicatorActive(element, name) {
    if (!element) return false;
    const info = name ? this.participants.get(name) : null;
    if (!info) return false;

    const currentClasses = element.className || '';
    const now = Date.now();

    // Check if classes changed since last poll
    if (currentClasses !== info.lastClasses) {
      info.classChangeCount++;
      info.lastClasses = currentClasses;
      info.lastClassChangeTime = now;
    }

    // Reset change count periodically (every 2 seconds)
    if (now - info.lastPollTime > 2000) {
      // If classes changed multiple times in the last 2 seconds, it's animating
      info.wasAnimating = info.classChangeCount >= 2;
      info.classChangeCount = 0;
      info.lastPollTime = now;
    }

    // Speaking = classes changed recently AND changed multiple times (animation)
    const recentChange = info.lastClassChangeTime && (now - info.lastClassChangeTime < 1000);
    return recentChange && (info.classChangeCount >= 2 || info.wasAnimating);
  }

  // Periodically check and broadcast who is speaking right now
  _pollSpeakingState() {
    for (const [name, info] of this.participants) {
      if (!info.element) continue;
      const isSpeaking = this._isSpeakingIndicatorActive(info.element, name);

      // Update state
      if (isSpeaking !== info.speaking) {
        info.speaking = isSpeaking;
        info.lastChange = Date.now();
        console.log(`[bots-in-calls] DOM: ${name} ${isSpeaking ? 'started' : 'stopped'} speaking`);
      }

      // Always post if speaking (so the speakingLog gets continuous entries)
      if (info.speaking) {
        window.postMessage({
          __botsInCalls: true,
          __fromExtension: true,
          action: 'dom-speaker-change',
          payload: {
            name,
            speaking: true,
            timestamp: Date.now(),
          },
        }, '*');
      }
    }
  }

  // Get current speaking state for all participants
  getStatus() {
    const result = {};
    for (const [name, info] of this.participants) {
      result[name] = {
        speaking: info.speaking,
        lastChange: info.lastChange,
      };
    }
    return result;
  }

  getSpeakingNames() {
    return Array.from(this.participants.entries())
      .filter(([_, info]) => info.speaking)
      .map(([name]) => name);
  }
}

const domSpeakerTracker = new DOMSpeakerTracker();

// ---------------------------------------------------------------------------
// Caption Scraper — reads Google Meet's built-in captions from the DOM.
// Meet does the speech-to-text; we just read the results. Includes speaker
// names. No audio capture, no external STT API, no feedback loops.
// ---------------------------------------------------------------------------

class CaptionScraper {
  constructor() {
    this.observer = null;
    this.lastText = '';        // current caption text (grows as Meet appends)
    this.lastSpeaker = '';
    this.lastPostedText = '';  // what we last posted to the server
    this.isRunning = false;
    this._debounceTimer = null;
  }

  start() {
    if (this.isRunning) return;
    console.log('[bots-in-calls] Caption scraper starting...');
    this._enableCaptions();
    this._waitForCaptions();
  }

  _enableCaptions() {
    const ccButton =
      findByAriaLabel('Turn on captions') ||
      findByAriaLabel('Activar subtítulos');
    if (ccButton) {
      ccButton.click();
      console.log('[bots-in-calls] Enabled captions');
    } else {
      console.debug('[bots-in-calls] Captions may already be on');
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
          const c = document.querySelector('div[role="region"][aria-label="Captions"]');
          if (c) this._observe();
          else console.warn('[bots-in-calls] Caption container not found');
        }, 5000);
      }
    }, 1000);
  }

  _observe() {
    console.log('[bots-in-calls] Caption scraping active, polling every 1s');
    this.isRunning = true;
    this._pollInterval = setInterval(() => this._checkCaptions(), 1000);
  }

  _checkCaptions() {
    try {
    // Re-query every time — Meet may rebuild the container
    const container = document.querySelector('div[role="region"][aria-label="Captions"]');
    if (!container) {
      console.debug('[captions] no container');
      return;
    }

    // Read text from the first child div (the caption block, not buttons)
    const firstChild = container.firstElementChild;
    if (!firstChild) return;

    const rawText = firstChild.textContent || '';
    if (!rawText.trim()) return;

    // Speaker name is the first text, then caption follows
    // Split by finding the speaker name element
    const speakerSpan = firstChild.querySelector('span');
    const speaker = speakerSpan?.textContent?.trim() || 'unknown';

    // Remove speaker name from the beginning, normalize whitespace
    let captionText = rawText.replace(/\s+/g, ' ').trim();
    if (captionText.startsWith(speaker)) {
      captionText = captionText.slice(speaker.length).trim();
    }

    if (!captionText || captionText === this.lastText) return;

    // Text changed — update and post periodically
    this.lastText = captionText;

    // Speaker changed — post previous speaker's text
    if (speaker !== this.lastSpeaker && this.lastSpeaker) {
      this._postCaption(this.lastSpeaker, this.lastPostedText || captionText);
      this.lastPostedText = '';
    }
    this.lastSpeaker = speaker;

    // Post every 2 seconds while text is growing
    const now = Date.now();
    if (!this._lastPostTime) this._lastPostTime = now;
    if (now - this._lastPostTime > 2000) {
      this._postCaption(speaker, captionText);
      this._lastPostTime = now;
    }
    } catch (err) {
      console.error('[captions] poll error:', err);
    }
  }

  _postCaption(speaker, text) {
    // Skip bot's own speech (shows as "You" in captions)
    if (speaker === 'You') {
      console.debug('[bots-in-calls] Skipping self caption');
      return;
    }

    // Skip if we already posted this exact text
    if (text === this.lastPostedText) return;
    this.lastPostedText = text;

    console.log(`[bots-in-calls] Caption [${speaker}] (${text.length} chars): ${text.slice(0, 120)}...`);

    const transcript = { speaker, text, timestamp: Date.now(), source: 'captions' };

    // Post to sync API
    chrome.runtime.sendMessage({
      action: 'post-transcripts',
      transcripts: [transcript],
    });

    // Broadcast to side panel (chrome.runtime messages reach all extension pages)
    chrome.runtime.sendMessage({
      action: 'transcript',
      payload: transcript,
    }).catch(() => {});
  }

  stop() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    this.isRunning = false;
  }
}

const captionScraper = new CaptionScraper();

// Start tracking, listening, and syncing once the bot is in the call
setTimeout(() => {
  domSpeakerTracker.start();

  // Start caption polling — post when speaker changes or after silence
  setTimeout(() => {
    captionScraper.start();
  }, 5000);

  // Auto-mute the bot's mic — only unmute when speaking via TTS
  setTimeout(() => setMicMuted(true), 5000);

  // Start syncing with vibeconferencing.com
  const meetCode = location.pathname.replace('/', ''); // e.g., "abc-defg-hij"
  if (meetCode) {
    chrome.runtime.sendMessage({
      action: 'start-sync',
      meetCode,
      botName: BOT_NAME,
    }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[bots-in-calls] Sync message error:', chrome.runtime.lastError.message);
        return;
      }
      if (resp?.ok) {
        console.log('[bots-in-calls] Sync started for room:', meetCode);
      } else {
        console.warn('[bots-in-calls] Sync room creation failed, trying to poll anyway:', resp?.error);
      }
    });
  }
}, 3000);

// Forward transcripts and STT requests to the backend
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__botsInCalls) return;

  // Forward transcripts to sync
  if (event.data.action === 'transcript') {
    const t = event.data.payload;
    if (t && t.text && t.speaker) {
      chrome.runtime.sendMessage({
        action: 'post-transcripts',
        transcripts: [t],
      });
    }
  }

  // Mute mic after TTS playback ends
  if (event.data.action === 'tts-ended') {
    setTimeout(() => setMicMuted(true), 500); // small delay for audio to flush
  }

  // Forward audio for STT
  if (event.data.action === 'transcribe-audio') {
    const { audioBase64, participantId } = event.data.payload;
    chrome.runtime.sendMessage({
      action: 'transcribe',
      audioBase64,
    }, (resp) => {
      if (resp?.ok && resp.text?.trim()) {
        // Get the current DOM speaker for attribution
        const speakingNames = domSpeakerTracker.getSpeakingNames();
        const speaker = speakingNames[0] || participantId;

        console.log(`[bots-in-calls] STT [${speaker}]: ${resp.text.slice(0, 60)}`);

        // Emit as a transcript
        window.postMessage({
          __botsInCalls: true,
          action: 'transcript',
          payload: {
            timestamp: Date.now(),
            text: resp.text.trim(),
            speaker,
            confidence: 1.0,
            source: 'elevenlabs-stt',
          },
        }, '*');
      } else if (resp?.error) {
        console.debug('[bots-in-calls] STT error:', resp.error);
      }
    });
  }
});

// Also handle explicit start request
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'start-speaker-tracking') {
    domSpeakerTracker.start();
    sendResponse({ ok: true });
    return;
  }
  if (message.action === 'get-speakers') {
    sendResponse({ speakers: domSpeakerTracker.getStatus() });
    return;
  }
});
