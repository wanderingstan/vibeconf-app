// content-script.js — Runs in ISOLATED world on Google Meet pages.
// Responsibilities:
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
    console.log('[bots-in-calls] Bot name:', BOT_NAME);
  });
} catch (e) {
  // storage not available, use default
}

// ---------------------------------------------------------------------------
// Message bridge: extension ↔ page
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[bots-in-calls] Content script received:', message.action);

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
  console.log('[bots-in-calls] Attempting to type into input:', input.placeholder || input.ariaLabel);

  input.focus();
  input.click();
  await delay(200);

  // Strategy 1: execCommand
  input.select();
  const ok = document.execCommand('insertText', false, value);
  if (ok && input.value === value) {
    console.log('[bots-in-calls] Typed via execCommand ✓');
    return true;
  }
  console.log('[bots-in-calls] execCommand result:', ok, 'value:', input.value);

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

  console.log('[bots-in-calls] Typed via key simulation:', input.value);
  return input.value === value;
}

// ---------------------------------------------------------------------------
// Google Meet auto-join flow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screen share automation — click "Present now" in Meet's UI
// ---------------------------------------------------------------------------

async function startPresenting() {
  console.log('[bots-in-calls] Starting presentation...');

  try {
    // Step 1: Ask the background script to open the whiteboard tab
    chrome.runtime.sendMessage({ action: 'open-whiteboard' });
    console.log('[bots-in-calls] Requested whiteboard tab');
    await delay(1000);

    // Step 2: Click Meet's "Share screen" button
    const presentBtn =
      findByAriaLabel('Share screen') ||
      findByAriaLabel('Present now');

    if (presentBtn) {
      presentBtn.click();
      console.log('[bots-in-calls] Clicked "Share screen" — Chrome picker should appear');
      console.log('[bots-in-calls] Please select the "AI Assistant — Whiteboard" tab from the picker');
    } else {
      console.warn('[bots-in-calls] Could not find "Present now" button');
      // Debug
      const allBtns = document.querySelectorAll('button, [role="button"]');
      console.log('[bots-in-calls] All buttons:');
      allBtns.forEach((b, i) => {
        if (b.offsetParent !== null) {
          console.log(`  [${i}] "${b.textContent.trim().slice(0, 50)}" aria="${b.getAttribute('aria-label') || ''}"  tag=${b.tagName}`);
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
  console.log('[bots-in-calls] Bot name:', botName);

  try {
    // 1. Wait for Meet's pre-join UI to render
    console.log('[bots-in-calls] Waiting for pre-join UI...');
    await delay(3000);

    // 2. Dismiss any dialogs first
    for (const label of ['Got it', 'Dismiss', 'OK', 'Allow', 'Close', 'No thanks', 'Not now']) {
      const btn = findByText(label);
      if (btn) {
        btn.click();
        console.log('[bots-in-calls] Dismissed:', label);
        await delay(300);
      }
    }

    // 3. Fill the name input if present (Meet may skip it if name is remembered)
    const nameInput =
      document.querySelector('input[placeholder="Your name"]') ||
      document.querySelector('input[aria-label="Your name"]') ||
      document.querySelector('input[autocomplete="name"]');

    if (nameInput) {
      console.log('[bots-in-calls] Found name input, typing bot name');
      await typeIntoInput(nameInput, botName);
      await delay(1000);
    } else {
      console.log('[bots-in-calls] No name input — Meet likely remembered the name');
    }

    // 4. Click the join button
    console.log('[bots-in-calls] Looking for join button...');
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
        console.log('[bots-in-calls] Visible buttons (' + allBtns.length + '):');
        allBtns.forEach((b, i) => {
          console.log(`  [${i}] "${b.textContent.trim().slice(0, 50)}" aria="${b.getAttribute('aria-label') || ''}" disabled=${b.disabled}`);
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
  console.log('[bots-in-calls] Watching for pre-join screen...');

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

  console.log('[bots-in-calls] No pre-join screen detected (might already be signed in)');
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
    console.log('[bots-in-calls] DOM speaker tracker starting...');

    // Ensure the People pane is open so we can observe it
    this._ensurePeoplePaneOpen();

    // Poll for participant elements (the pane may load asynchronously)
    this.checkInterval = setInterval(() => this._scanParticipants(), 1000);

    // Also set up a MutationObserver on the entire document for class changes
    this._startObserving();
  }

  stop() {
    this.isTracking = false;
    if (this.observer) this.observer.disconnect();
    if (this.checkInterval) clearInterval(this.checkInterval);
    console.log('[bots-in-calls] DOM speaker tracker stopped');
  }

  _ensurePeoplePaneOpen() {
    // Check if participant list is already visible
    const participantList = document.querySelector('[jsname="jrQDbd"]') ||
      document.querySelector('[role="list"][aria-label="Participants"]');
    if (participantList) {
      console.log('[bots-in-calls] People pane already open');
      return;
    }

    // Look for the People button — it may have a count badge like "People2"
    const peopleBtn =
      findByAriaLabel('People') ||
      findByAriaLabel('Show everyone') ||
      findByText('People');

    if (peopleBtn) {
      peopleBtn.click();
      console.log('[bots-in-calls] Opened People pane for speaker tracking');
    } else {
      console.log('[bots-in-calls] People button not found — will retry');
    }
  }

  _scanParticipants() {
    // Each participant is a div[role="listitem"] with aria-label="Name"
    // inside the participant list (jsname="jrQDbd")
    const items = document.querySelectorAll('div[role="listitem"][aria-label]');

    for (const item of items) {
      const name = item.getAttribute('aria-label');
      if (!name) continue;

      // Skip "You" (the bot itself)
      const youTag = item.querySelector('.NnTWjc');
      if (youTag && youTag.textContent.includes('You')) continue;

      // Find the speaking indicator: div[jsname="QgSmzd"] with the animated bars
      const indicator = item.querySelector('[jsname="QgSmzd"]');
      if (!indicator) continue;

      if (!this.participants.has(name)) {
        // Record the baseline classes so we can detect changes
        const baselineClasses = indicator.className;
        this.participants.set(name, {
          speaking: false,
          element: indicator,
          item,
          baselineClasses,
          lastChange: Date.now(),
        });
        console.log('[bots-in-calls] Tracking participant:', name,
          '(baseline classes:', baselineClasses + ')');
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

  _isSpeakingIndicatorActive(element, name) {
    if (!element) return false;

    const info = name ? this.participants.get(name) : null;
    const currentClasses = element.className || '';

    // Primary detection: check if classes changed from baseline.
    // When speaking starts, Meet changes classes on this element.
    if (info?.baselineClasses && currentClasses !== info.baselineClasses) {
      // Log class changes for discovery (helps tune detection)
      if (!info._lastLoggedClasses || info._lastLoggedClasses !== currentClasses) {
        info._lastLoggedClasses = currentClasses;
        console.log(`[bots-in-calls] DOM classes changed for ${name}:`,
          `baseline="${info.baselineClasses}"`,
          `current="${currentClasses}"`);
      }
      // Classes differ from baseline → likely speaking
      return true;
    }

    // Fallback: check animated bars' computed styles
    const bars = element.querySelectorAll('.UBNDXc, .HPxjXe, .DwvCqe');
    for (const bar of bars) {
      const style = window.getComputedStyle(bar);
      const height = parseFloat(style.height);
      const opacity = parseFloat(style.opacity);
      if (height > 2 && opacity > 0.1) return true;
    }

    return false;
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

// Start tracking once the bot is in the call (delay to let the call UI load)
setTimeout(() => {
  domSpeakerTracker.start();
}, 10000);

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
