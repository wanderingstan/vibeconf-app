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
    // First update the whiteboard with some test content
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: 'set-whiteboard',
      payload: {
        content: '# Meeting Notes\n\n## Agenda\n- Review project status\n- Discuss next milestones\n- Q&A\n\n## Key Points\nThis whiteboard is being shared by the AI Assistant.\nContent can be updated in real-time during the meeting.\n\n## Action Items\n- Item 1: TBD\n- Item 2: TBD',
      },
    }, '*');

    // Look for Meet's "Present now" button
    // It's in the bottom bar, usually has a "Present now" tooltip or aria-label
    await delay(500);

    const presentBtn =
      findByAriaLabel('Share screen') ||
      findByAriaLabel('Present now') ||
      findByText('Present now') ||
      findByText('Share screen');

    if (presentBtn) {
      presentBtn.click();
      console.log('[bots-in-calls] Clicked "Share screen" button');

      // Meet shows a submenu/popover — poll for it
      for (let i = 0; i < 10; i++) {
        await delay(500);

        // Log everything visible for debugging
        const allInteractive = document.querySelectorAll(
          'button, [role="button"], [role="menuitem"], [role="menuitemradio"], li[data-value], div[data-value]'
        );
        const visible = Array.from(allInteractive).filter(el => el.offsetParent !== null);

        if (i === 0 || i === 2) {
          console.log('[bots-in-calls] Visible elements (poll ' + i + '):');
          visible.forEach((b, j) => {
            console.log(`  [${j}] <${b.tagName.toLowerCase()}> "${b.textContent.trim().slice(0, 60)}" aria="${b.getAttribute('aria-label') || ''}" role="${b.getAttribute('role') || ''}" data-value="${b.getAttribute('data-value') || ''}"`);
          });
        }

        // Try various text patterns Meet might use for screen share options
        const option =
          findByText('Your entire screen') ||
          findByText('Entire screen') ||
          findByText('A tab') ||
          findByText('Tab') ||
          findByText('A window') ||
          findByText('Window') ||
          findByAriaLabel('Your entire screen') ||
          findByAriaLabel('A tab') ||
          findByAriaLabel('A window');

        if (option) {
          console.log('[bots-in-calls] Found option:', option.textContent.trim());
          option.click();
          console.log('[bots-in-calls] Clicked screen share option');
          break;
        }
      }
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
