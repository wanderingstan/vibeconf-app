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

// Visibility check: skip elements that are display:none, visibility:hidden,
// or zero-size. Meet renders accessibility live regions and stale UI shells
// off-screen, so text-walk matches frequently hit invisible nodes that look
// clickable but aren't (#175 — autoJoin matched a hidden "Ask to join" before
// the visible "Join now" and silently no-op-clicked into "waiting" forever).
function isVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null && el !== document.documentElement) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  // computed-style visibility check is the last defense — display:none is
  // already caught by offsetParent, but visibility:hidden is not.
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden') return false;
  return true;
}

function findByText(text, { exact = false } = {}) {
  if (!document.body) return null;
  const lower = text.toLowerCase();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const nodeText = walk.currentNode.textContent.trim().toLowerCase();
    const match = exact ? nodeText === lower : nodeText.includes(lower);
    if (!match) continue;
    let el = walk.currentNode.parentElement;
    let candidate = null;
    while (el && el !== document.body) {
      if (
        el.tagName === 'BUTTON' ||
        el.getAttribute('role') === 'button' ||
        el.hasAttribute('jsaction') ||
        el.tabIndex >= 0
      ) {
        candidate = el;
        break;
      }
      el = el.parentElement;
    }
    const result = candidate || walk.currentNode.parentElement;
    if (isVisible(result)) return result;
    // Keep walking — there may be a visible match later in the document.
  }
  return null;
}

function findByAriaLabel(label) {
  // No visibility filter here — Meet's toolbar buttons can be transiently 0×0
  // during initial layout (e.g. the captions button before the bot view has
  // its final dimensions), which made isVisible() reject them and broke the
  // auto-CC enable path. Unlike findByText (where invisible-duplicate text
  // nodes are real and motivated isVisible()), aria-labeled elements in
  // Meet's DOM don't have hidden-duplicate buttons. Add a visible-only
  // variant if a future caller needs one.
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

  // Meet's chat input is a <textarea>; calling HTMLInputElement's value setter
  // on it throws "Illegal invocation" because `this` is the wrong type. Pick
  // the setter from the element's own prototype.
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
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
// Chat — read & send Meet chat messages
//
// Opening chat CLOSES the people pane, which is what the DOMSpeakerTracker
// reads for speech detection. So every chat operation is discrete: open chat,
// do the thing, then reopen the people pane. The chat button's aria-label
// ("… - New message") is a passive unread signal we can read WITHOUT opening
// the pane, so monitoring for unread messages doesn't disturb speech tracking.
// ---------------------------------------------------------------------------

// Count participant tiles that are actually VISIBLE. Switching to the chat
// pane hides the people pane (display:none) but leaves the tile elements in the
// DOM, so a plain querySelectorAll count stays > 0 and falsely reads as "people
// pane open". getClientRects() is empty for display:none elements, so it's a
// reliable visibility test.
function visiblePeopleTileCount() {
  let n = 0;
  for (const el of document.querySelectorAll('div[role="listitem"][aria-label]')) {
    if (el.getClientRects().length > 0) n++;
  }
  return n;
}

function getChatToggle() {
  // Label is "Chat with everyone" or "Chat with everyone - New message".
  return document.querySelector(
    'button[aria-label^="Chat with everyone" i], [role="button"][aria-label^="Chat with everyone" i]'
  );
}

function hasUnreadChat() {
  const btn = getChatToggle();
  return !!btn && /new message/i.test(btn.getAttribute('aria-label') || '');
}

function getChatInput() {
  return document.querySelector('textarea[aria-label="Send a message" i]');
}

function isChatPaneOpen() {
  return !!getChatInput();
}

async function openChatPane() {
  if (isChatPaneOpen()) {
    console.log('[chat] Chat pane already open');
    return true;
  }
  const btn = getChatToggle();
  if (!btn) {
    console.warn('[chat] ❌ Chat toggle button not found');
    return false;
  }
  console.log('[chat] → switching to Chat pane (clicking', JSON.stringify(btn.getAttribute('aria-label')), ')');
  btn.click();
  for (let i = 0; i < 20; i++) {
    await delay(150);
    if (isChatPaneOpen()) {
      console.log('[chat] ✓ Chat pane open');
      return true;
    }
  }
  console.warn('[chat] ❌ Chat pane did not open after click');
  return false;
}

// Reopen the people pane so the DOMSpeakerTracker can resume reading speaking
// indicators. Clicking People also closes the chat pane (Meet's side panel
// shows one pane at a time). Verify the tiles actually appear and retry — a
// single click can be dropped mid-animation. The tracker's 2s self-heal is a
// backstop if all retries somehow fail.
async function restorePeoplePane() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = findPeopleButton();
    if (!btn) {
      console.warn('[chat] ❌ People button not found (attempt', attempt + 1, 'of 3)');
    } else {
      const labelledby = btn.getAttribute('aria-labelledby');
      const labelText = labelledby ? document.getElementById(labelledby)?.textContent?.trim() : null;
      console.log('[chat] → switching to People pane (clicking button, aria-label=' +
        JSON.stringify(btn.getAttribute('aria-label')) + ', label=' + JSON.stringify(labelText) + ', attempt ' + (attempt + 1) + ')');
      btn.click();
    }
    for (let i = 0; i < 8; i++) {
      await delay(150);
      const tiles = visiblePeopleTileCount();
      if (tiles > 0) {
        console.log('[chat] ✓ People pane restored (' + tiles + ' visible tiles) after attempt', attempt + 1);
        return true;
      }
    }
    console.warn('[chat] People pane not visible after attempt', attempt + 1, '— retrying');
  }
  console.warn('[chat] ❌ Failed to reopen People pane after 3 attempts — speech tracking is blind');
  return false;
}

// A sender header is a div with exactly two div children where the second is a
// timestamp (e.g. "2:32 PM") — the first is the participant name. Meet renders
// one header per run of consecutive messages from the same person; messages
// below it (until the next header) belong to that sender. Detect structurally
// rather than by class/jsname, which rotate.
function senderFromHeader(el) {
  if (el.tagName !== 'DIV' || el.children.length !== 2) return null;
  const [nameEl, timeEl] = el.children;
  if (nameEl.tagName !== 'DIV' || timeEl.tagName !== 'DIV') return null;
  const timeText = timeEl.textContent.trim();
  if (!/^\d{1,2}:\d{2}\s*([AP]\.?M\.?)?$/i.test(timeText)) return null;
  const name = nameEl.textContent.trim();
  return name || null;
}

function scrapeChatMessages() {
  // Collect sender headers and message bodies, order them by document position,
  // and attribute each message to the most recent header above it.
  //
  // Message bodies are divs carrying data-message-id="spaces/.../messages/...".
  // Pin BUTTONS share that attribute but have aria-label="Pin message" — skip
  // those (and any button). Only the chat pane is open during a scrape (people
  // pane is closed), so the header pattern doesn't collide with participant tiles.
  const markers = [];
  for (const el of document.querySelectorAll('div')) {
    const sender = senderFromHeader(el);
    if (sender) markers.push({ kind: 'header', el, sender });
  }
  for (const el of document.querySelectorAll('[data-message-id]')) {
    if (el.tagName === 'BUTTON') continue;
    if (/pin message/i.test(el.getAttribute('aria-label') || '')) continue;
    markers.push({ kind: 'msg', el });
  }
  markers.sort((a, b) => {
    if (a.el === b.el) return 0;
    return (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  const out = [];
  const seen = new Set();
  let currentSender = '';
  for (const m of markers) {
    if (m.kind === 'header') { currentSender = m.sender; continue; }
    const id = m.el.getAttribute('data-message-id');
    if (!id || seen.has(id)) continue;
    const text = (m.el.innerText || '').trim();
    if (!text) continue;
    seen.add(id);
    out.push(currentSender ? { id, sender: currentSender, text } : { id, text });
  }
  return out;
}

async function readChatFlow() {
  const opened = await openChatPane();
  if (!opened) throw new Error('Could not open the chat pane');
  await delay(300); // let messages render
  const messages = scrapeChatMessages();
  await restorePeoplePane(); // close chat, restore speech tracking
  return messages;
}

async function sendChatFlow(text) {
  const opened = await openChatPane();
  if (!opened) throw new Error('Could not open the chat pane');
  const input = getChatInput();
  if (!input) throw new Error('Could not find the chat input');
  await typeIntoInput(input, text);
  await delay(100);
  // Meet sends on Enter.
  const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  input.dispatchEvent(new KeyboardEvent('keydown', enter));
  input.dispatchEvent(new KeyboardEvent('keypress', enter));
  input.dispatchEvent(new KeyboardEvent('keyup', enter));
  await delay(200);
  const sent = input.value.trim() === '';
  await restorePeoplePane(); // close chat, restore speech tracking
  return sent;
}

ipcRenderer.on('read-chat', async (_event, { requestId }) => {
  let result;
  try { result = { ok: true, messages: await readChatFlow() }; }
  catch (err) { result = { ok: false, error: err.message }; }
  ipcRenderer.send('chat-result', { requestId, ...result });
});

ipcRenderer.on('send-chat', async (_event, { requestId, text }) => {
  let result;
  try {
    const sent = await sendChatFlow(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (input not cleared)' };
  } catch (err) { result = { ok: false, error: err.message }; }
  ipcRenderer.send('chat-result', { requestId, ...result });
});

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

// Race-sensitive: if Meet's pre-join screen renders before this resolves,
// autoJoin would type the default 'Jimmy' into the name input even when the
// user has a different botName configured. Keep the promise around so the
// DOMContentLoaded handler can await it before reading BOT_NAME.
const botNameLoaded = ipcRenderer.invoke('get-config', ['botName']).then((result) => {
  if (result?.botName) {
    BOT_NAME = result.botName;
    console.log('[electron-meet] Loaded botName from config:', BOT_NAME);
  }
}).catch((err) => {
  console.warn('[electron-meet] Failed to load botName from config:', err.message);
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

    // Fill name. The persona name should win — if the input is missing, the
    // Electron session is signed in to a Google account and Meet will show
    // the bot under that account's display name instead (see #167). Warn so
    // the mismatch isn't silent.
    const nameInput =
      document.querySelector('input[placeholder="Your name"]') ||
      document.querySelector('input[aria-label="Your name"]') ||
      document.querySelector('input[autocomplete="name"]');

    if (nameInput) {
      await typeIntoInput(nameInput, botName);
      await delay(1000);
      if (nameInput.value !== botName) {
        const msg = `Persona name "${botName}" didn't stick on the pre-join input (got "${nameInput.value}"). Meet may overwrite it.`;
        console.warn('[electron-meet] ⚠️  ' + msg);
        ipcRenderer.send('to-panel', { action: 'error', message: msg });
      } else {
        console.log('[electron-meet] Persona name set on pre-join input:', botName);
      }
    } else {
      // No "Your name" input is **expected** in account mode (#170) — the bot
      // is signed in to Google, so Meet skips the guest pre-join and uses the
      // account's display name. Only warn when we're actually in guest mode
      // and the input genuinely wasn't found (something's off).
      let mode = 'guest';
      try {
        const info = await ipcRenderer.invoke('get-meet-mode');
        if (info?.mode) mode = info.mode;
      } catch (err) {
        console.warn('[electron-meet] get-meet-mode failed, assuming guest:', err.message);
      }
      if (mode === 'guest') {
        const msg = `Guest mode but no "Your name" input on pre-join — the bot will appear under whatever Meet picks. Persona was "${botName}".`;
        console.warn('[electron-meet] ⚠️  ' + msg);
        ipcRenderer.send('to-panel', { action: 'error', message: msg });
      } else {
        console.log('[electron-meet] Account mode — using Google account display name (persona "' + botName + '" is informational).');
      }
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

      // Explicit denial pages — Meet shows one of these when the host blocks
      // entry or the call is otherwise inaccessible. Fail fast rather than
      // burning the 15s limbo grace, and give the agent a specific reason.
      if (bodyText.includes("You can't join this video call")) {
        sendStatus("Error: can't join this video call (host blocked entry or call inaccessible)");
        console.warn('[electron-meet] Denial page detected: "You can\'t join this video call"');
        return;
      }
      if (bodyText.includes('You have been removed from the meeting')) {
        sendStatus('Error: removed from the meeting');
        console.warn('[electron-meet] Removal page detected');
        return;
      }

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

// Locate the speaking indicator within a participant tile by structure rather
// than jsname/class. Meet's speaking indicator is a div whose only children are
// exactly three empty <div>s (the three animated bars/dots). Google rotates
// jsname/class tokens regularly, but the three-bars shape is stable.
function findSpeakingIndicator(item) {
  const candidates = item.querySelectorAll('div');
  for (const el of candidates) {
    const kids = el.children;
    if (kids.length !== 3) continue;
    if (kids[0].tagName !== 'DIV' || kids[1].tagName !== 'DIV' || kids[2].tagName !== 'DIV') continue;
    if (kids[0].children.length || kids[1].children.length || kids[2].children.length) continue;
    if (kids[0].textContent || kids[1].textContent || kids[2].textContent) continue;
    return el;
  }
  return null;
}

// Find the "People" toggle in the bottom bar. Match leniently — with
// participants present the accessible name often carries a count (e.g.
// "People3"), so an exact "People" check misses it. startsWith handles both.
function findPeopleButton() {
  for (const btn of document.querySelectorAll('[role="button"][aria-labelledby]')) {
    const labelId = btn.getAttribute('aria-labelledby');
    if (!labelId) continue;
    const label = document.getElementById(labelId);
    if (label && label.textContent.trim().startsWith('People')) return btn;
  }
  return document.querySelector('button[aria-label^="People" i], [role="button"][aria-label^="People" i]');
}

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
      // Self-heal: reopen the people pane whenever it's closed (e.g. a chat
      // read/send switched to the chat pane). _ensurePeoplePaneOpen no-ops when
      // tiles are already present, so this is cheap. Gating on participants.size
      // was wrong — the Map keeps stale entries after the pane closes, so it
      // stayed non-zero and the pane never reopened.
      this._ensurePeoplePaneOpen();
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
    // Detect "pane is open" by the same structural marker _scanParticipants uses:
    // tiles only exist when the people list is rendered. The previous check used
    // jsname="jrQDbd" + a stale aria-label fallback; once Google rotated jsname
    // the "open" check always returned false and the 2-second loop toggled the
    // pane open→closed→open→closed forever (especially visible under throttling).
    // Only treat the pane as open if tiles are actually visible — switching to
    // chat hides them (display:none) but leaves them in the DOM.
    if (visiblePeopleTileCount() > 0) return;

    // Throttle clicks so a slow Meet load doesn't fire repeated opens before
    // the first click has finished animating. If we just clicked, give it a
    // second to settle before trying again.
    const now = Date.now();
    if (this._lastPeopleClickAt && now - this._lastPeopleClickAt < 1500) return;

    const btn = findPeopleButton();
    if (btn) {
      this._lastPeopleClickAt = now;
      console.log('[speaker-tracker] Opening People pane');
      btn.click();
    }
  }

  _scanParticipants() {
    const items = document.querySelectorAll('div[role="listitem"][aria-label]');
    for (const item of items) {
      const name = item.getAttribute('aria-label');
      if (!name) continue;
      const indicator = findSpeakingIndicator(item);
      if (!indicator) {
        // Warn once per participant — likely a DOM-shape change in Meet
        // (Google rotated tokens or restructured the tile). Without the
        // indicator, anyoneSpeaking stays false and wait_for_speech falls back
        // to caption-based silence detection, which is slower.
        if (!this._missingWarned) this._missingWarned = new Set();
        if (!this._missingWarned.has(name)) {
          this._missingWarned.add(name);
          console.warn('[speaker-tracker] No speaking indicator found for', name,
            '— Meet DOM may have changed; fix findSpeakingIndicator() in preload-meet.js');
        }
        continue;
      }

      // Self-detection: Meet's own tile has a "(You)" text node next to the
      // display name (the aria-label is just the name, so we can't infer from
      // that alone). Without this flag the bot's TTS audio meter pulses get
      // counted as someone-is-speaking and cancel the silence timer.
      const isSelf = item.textContent.includes('(You)');

      if (!this.participants.has(name)) {
        if (isSelf) {
          console.log('[speaker-tracker] Identified self tile:', name);
        }
        this.participants.set(name, {
          speaking: false, isSelf, element: indicator, item,
          lastClasses: indicator.className, classChangeCount: 0,
          lastPollTime: Date.now(), lastChange: Date.now(),
        });
      } else {
        const info = this.participants.get(name);
        info.element = indicator;
        info.item = item;
        info.isSelf = isSelf;
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
          console.log('[speaker-tracker] (observer)', name, '→', isSpeaking);
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
        console.log('[speaker-tracker] (poll)', name, '→', isSpeaking);
        // Also IPC the false transition — previously only true was sent, which
        // meant the local-server never got the 'stopped speaking' edge from this
        // path (it had to wait for the periodic participants-updated broadcast).
        ipcRenderer.send('update-speaking', { name, speaking: isSpeaking });
      } else if (info.speaking) {
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
      .map(([name, info]) => ({ name, speaking: info.speaking, isSelf: !!info.isSelf }));
  }
}

const domSpeakerTracker = new DOMSpeakerTracker();

// ---------------------------------------------------------------------------
// Caption Scraper (from content-script.js)
// ---------------------------------------------------------------------------

class CaptionScraper {
  constructor() {
    this.isRunning = false;
    this.onReady = null; // fires once when caption container is observed
    // Stable per-DOM-child turn IDs. Each caption-container child = one
    // speaker turn (which Meet may continue editing — appending text or
    // rewriting the tail — while it's the bottommost child). WeakMap keyed
    // by DOM node so dead nodes drop out.
    //
    // Snapshot model (#178): each tick we send the full current state of
    // visible turns to local-server, which upserts them and marks settled
    // anything that's no longer bottommost. The transcript stops being an
    // event log and becomes a map of {turnId → current best-guess text},
    // matching how Meet's caption UI actually behaves.
    this._turnIdByChild = new WeakMap();
    this._nextTurnId = 1;
    this._lastSentSnapshot = ''; // for IPC dedup — skip sending if nothing changed
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

      // Snapshot every caption block currently in the DOM, in order. Each
      // child is one speaker turn. The bottommost may still be edited by
      // Meet; everything above it is settled (Meet doesn't revise non-current
      // speakers — confirmed empirically).
      //
      // Critical: determine bottommost based on the *DOM* state, then filter
      // out 'You' (the bot's own TTS, which we record separately via
      // addTranscript with the authoritative text). If we filtered before
      // checking bottommost, a Stan turn just above a "You" turn would look
      // bottommost to the server and stay unsettled forever.
      const allChildren = [...container.children].filter(c => c.querySelector('img'));
      const lastChild = allChildren[allChildren.length - 1] || null;
      const turns = [];
      for (const child of allChildren) {
        const span = child.querySelector('span');
        const speaker = span?.textContent?.trim() || 'unknown';
        let text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text.startsWith(speaker)) text = text.slice(speaker.length).trim();
        if (!text || speaker === 'You') continue;

        // Assign a stable turn id the first time we see this DOM node.
        let turnId = this._turnIdByChild.get(child);
        if (!turnId) {
          turnId = this._nextTurnId++;
          this._turnIdByChild.set(child, turnId);
        }
        turns.push({ turnId, speaker, text, isBottommost: child === lastChild });
      }

      if (turns.length === 0) return;

      // Dedup at the IPC boundary — no point firing on every poll if nothing
      // changed (the server-side updateTurns is idempotent, but skip the
      // serialization cost).
      const snapshot = turns.map(t => `${t.turnId}:${t.speaker}:${t.text}`).join('|');
      if (snapshot !== this._lastSentSnapshot) {
        this._lastSentSnapshot = snapshot;
        ipcRenderer.send('caption-turns', { turns });
      }

      // Live-growing caption display on the panel uses the bottommost turn's
      // full accumulated text, which is what users expect to see (matches
      // Meet's own caption UI). Always send — the panel does its own dedup
      // on identical text.
      const last = turns[turns.length - 1];
      ipcRenderer.send('to-panel', {
        action: 'raw-caption',
        text: last.text,
        speaker: last.speaker,
      });
      ipcRenderer.send('to-panel', {
        action: 'caption-update',
        payload: { speaker: last.speaker, text: last.text, timestamp: Date.now(), source: 'captions' },
      });
    } catch (err) {
      console.error('[captions] poll error:', err);
    }
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
  // Already presenting? Meet swaps "Present now" → "Stop presenting"/"Show", so
  // the present button vanishes. Without this check we'd report "Could not find
  // Present button" — which looks like an auth/permission failure when in fact
  // the share is already active (often with the infinity-mirror anti-loop
  // dialog showing). Detect it and tell the caller it's a no-op success.
  const alreadyPresenting =
    document.querySelector('[aria-label*="Stop presenting" i]') ||
    document.querySelector('[aria-label*="Stop sharing" i]') ||
    document.querySelector('[data-tooltip*="Stop presenting" i]') ||
    document.querySelector('[data-tooltip*="Stop sharing" i]');
  if (alreadyPresenting) {
    console.log('[electron-meet] Already presenting — skipping Present click');
    return 'already-presenting';
  }

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
    return 'started';
  }

  console.warn('[electron-meet] Could not find "Present now" button');
  return 'not-found';
}

ipcRenderer.on('trigger-screen-share', async (_event, options) => {
  const shareType = options?.shareType || 'window';
  console.log('[electron-meet] Screen share triggered, type:', shareType);
  const result = await clickPresentNow(shareType);
  if (result === 'already-presenting') {
    // Not an error — the share is already active. Tell main so it can report a
    // truthful "already sharing" instead of a misleading "couldn't find button".
    ipcRenderer.send('self-presenting', { presenting: true });
  } else if (result === 'not-found') {
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

    // Make sure the config-loaded botName has had a chance to land before we
    // type into Meet's name field. Without this await the IPC roundtrip can
    // lose to Meet's pre-join render and we'd type the default 'Jimmy'.
    await botNameLoaded;

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

    // Passive unread-chat signal — read from the chat button's aria-label
    // ("… - New message") WITHOUT opening the pane, so it doesn't disturb the
    // speaker tracker. Only emit on change.
    let lastChatUnread = null;
    setInterval(() => {
      const unread = hasUnreadChat();
      if (unread !== lastChatUnread) {
        lastChatUnread = unread;
        ipcRenderer.send('chat-unread', { unread });
      }
    }, 2000);

    // Pane-visibility signal for the debug panel — which side pane is showing.
    let lastPaneState = '';
    setInterval(() => {
      const state = { chatPaneOpen: isChatPaneOpen(), peoplePaneOpen: visiblePeopleTileCount() > 0 };
      const key = `${state.chatPaneOpen}|${state.peoplePaneOpen}`;
      if (key !== lastPaneState) {
        lastPaneState = key;
        ipcRenderer.send('pane-state', state);
      }
    }, 1000);

    // Detect presenting state:
    // - "Stop presenting" button/overlay OR toolbar share button with stop label → WE are presenting
    // - Present button tooltip says "{Name} is presenting" → someone ELSE is presenting
    // - Normal Present button → nobody is presenting
    setInterval(() => {
      // Check if we are currently presenting. Two locations depending on window size:
      // 1. Large window: "Stop presenting" overlay button on the shared content
      // 2. Small window: the toolbar share button itself shows "Stop presenting"
      // Ground truth: the share button's aria-label reads "You are presenting"
      // while we're actively sharing. Check that first, then fall back to the
      // "Stop presenting" button/overlay variants for older/other layouts.
      const presentingNow =
        document.querySelector('[aria-label*="You are presenting" i]') ||
        document.querySelector('[aria-label*="Stop presenting" i]') ||
        document.querySelector('[data-tooltip*="Stop presenting" i]') ||
        document.querySelector('button[aria-label*="stop" i][aria-label*="present" i]') ||
        document.querySelector('[data-tooltip*="stop" i][data-tooltip*="present" i]');
      if (presentingNow) {
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
