// panel.js — Control panel for the Electron app.
// Adapted from popup.js — uses window.electronAPI instead of chrome.* APIs.

const api = window.electronAPI;

// Markup for one of the chrome icons in ui-icons.css (OpenMoji outlines, painted
// with currentColor). Use this instead of pasting an emoji character into a
// label: the OS emoji fonts draw ⚙/👀/🚧 at different sizes and weights, so the
// same button looked different on every platform.
//
// `lead` adds the gap an icon needs when it sits in front of a text label; an
// icon that IS the whole label takes no variant.
//
// Both arguments are OURS — never interpolate anything user-supplied here, since
// callers assign the result with innerHTML.
function uiIcon(name, variant = '') {
  const mod = variant === 'lead' ? ' ui-icon--lead' : '';
  return `<i class="ui-icon ui-icon-${name}${mod}"></i>`;
}

// This file backs TWO windows: the control panel, and the ⓘ Troubleshooting
// window (main loads panel.html?screen=troubleshooting). In the latter we show
// only the troubleshooting screen and suppress everything belonging to the panel
// proper — specifically anything that would DOUBLE a side effect: reporting a
// content height (which resizes the MAIN window), rewriting the cached avatar
// thumbnail, or running the identity/profile pollers a second time.
//
// Inbound broadcasts need no guarding: main sends those to panelView.webContents,
// which this window is not.
const IS_TROUBLESHOOTING_WINDOW =
  new URLSearchParams(window.location.search).get('screen') === 'troubleshooting';

// Any pop-out window: panel.html is loaded with ?screen=<name> for each of them.
//
// Deliberately a CLASS rather than a list of names. Anything scoped to "the
// panel inside the main window" must exclude all satellites, and an explicit
// list silently omits the next one added — which is exactly what happened when
// the 🧠 brain window arrived: it reported its own (tall) content height to
// main, which duly resized the MAIN window to match, leaving a large empty band
// below the avatar. The symptom appeared in a completely different window from
// the change that caused it.
const IS_POPOUT_WINDOW = new URLSearchParams(window.location.search).has('screen');

const joinBtn = document.getElementById('joinBtn');
const setupCallBtn = document.getElementById('setupCallBtn');
const meetUrlInput = document.getElementById('meetUrl');
const callUrlDisplay = document.getElementById('callUrlDisplay');
const copyCallUrlBtn = document.getElementById('copyCallUrlBtn');
// Copy the current call's URL for inviting others (#panel-cleanup).
copyCallUrlBtn?.addEventListener('click', async () => {
  const url = (callUrlDisplay && callUrlDisplay.textContent || '').trim();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    const prev = copyCallUrlBtn.textContent;
    copyCallUrlBtn.textContent = '✓';
    setTimeout(() => { copyCallUrlBtn.textContent = prev; }, 1200);
  } catch { /* clipboard unavailable */ }
});
const meetCodeInput = document.getElementById('meetCode');
const roomIdField = document.getElementById('roomIdField');
const roomLink = document.getElementById('roomLink');
const transcriptArea = document.getElementById('transcriptArea');
const errorBar = document.getElementById('errorBar');
const rawCaptionText = document.getElementById('rawCaptionText');
const speakTextInput = document.getElementById('speakText');
const speakTextBtn = document.getElementById('speakTextBtn');
const speechBtn = document.getElementById('speechBtn');
const curlCommand = document.getElementById('curlCommand');
const copyCurlBtn = document.getElementById('copyCurlBtn');
const micWarn = document.getElementById('micPermissionWarning');
const shareWhiteboardBtn = document.getElementById('shareWhiteboardBtn');
const meetSignInBtn = document.getElementById('meetSignInBtn');
const meetSignOutBtn = document.getElementById('meetSignOutBtn');
const slackSignInBtn = document.getElementById('slackSignInBtn');
const slackSignOutBtn = document.getElementById('slackSignOutBtn');

// Settings
const botNameInput = document.getElementById('botName');
const calendarIdentityEmailInput = document.getElementById('calendarIdentityEmail'); // #299
const websiteUrlInput = document.getElementById('websiteUrl');
const ttsApiKeyInput = document.getElementById('ttsApiKey');
const ttsVoiceIdInput = document.getElementById('ttsVoiceId');
const unifiedVoiceSelect = document.getElementById('unifiedVoice'); // #340 merged picker
const refreshVoicesBtn = document.getElementById('refreshVoicesBtn');
const claudeWorkDirInput = document.getElementById('claudeWorkDir');
const agentSessionIdInput = document.getElementById('agentSessionId');
const claudeModelInput = document.getElementById('claudeModel');
const emojiSetInput = document.getElementById('emojiSet');
const captionLanguageInput = document.getElementById('captionLanguage');
const dangerousModeInput = document.getElementById('dangerousMode');
const ackShortMinInput = document.getElementById('ackShortMin');
const ackLongMinInput = document.getElementById('ackLongMin');
const ackShortPhrasesInput = document.getElementById('ackShortPhrases');
const ackLongPhrasesInput = document.getElementById('ackLongPhrases');

// The website, not the local server. This is the base for the curl helper and
// the room links — things a human runs from somewhere else. It used to fall back
// to http://127.0.0.1:7865, which made the copied curl command 401 once the
// local control API started requiring a bearer token (#201): the endpoint it
// named was real, and the request was rejected. The website accepts these posts
// unauthenticated and is the path that actually makes sense to hand someone.
let syncBaseUrl = 'https://vibeconferencing.com';
// Until get-config lands. Not a plausible name on purpose — see
// DEFAULT_BOT_NAME in preferences-schema.js (this renderer is sandboxed and
// cannot require it).
let currentBotName = 'Unnamed bot';
// The headline may show a provenance tag the plain name must not carry (e.g.
// "Alice [CLI name]" for a launched test bot) — currentBotName stays clean for
// the "Call X now" button and the curl examples; this drives botNameBig only.
let botNameDisplay = null;
let appProfileName = null; // app profile (stable heading identity, #282); null for the default instance
let inCall = false;

// ---------------------------------------------------------------------------
// Screen navigation
// ---------------------------------------------------------------------------

const mainScreen = document.getElementById('mainScreen');
const settingsScreen = document.getElementById('settingsScreen');
const troubleshootingScreen = document.getElementById('troubleshootingScreen');
const brainScreen = document.getElementById('brainScreen');

function showScreen(screen) {
  mainScreen.style.display = 'none';
  settingsScreen.style.display = 'none';
  troubleshootingScreen.style.display = 'none';
  screen.style.display = 'block';
  // Screens differ a lot in height (Settings is long) and the window is sized to
  // fit — remeasure. Defined below; ignore on the very first paint.
  try { reportContentHeight(); } catch { /* not wired yet */ }
}

// A brand-new bot opens straight on Settings (main passes ?startScreen=settings
// when launched with --open-settings). Landing on "Call now" would be backwards:
// a fresh bot has no name, voice or face, and this page is where it gets them —
// including the guided-setup call at the top.
//
// Deliberately not the 'screen' param, which marks a POP-OUT window and would
// stop this panel reporting its height to main.
if (new URLSearchParams(window.location.search).get('startScreen') === 'settings') {
  showScreen(settingsScreen);
}

document.getElementById('openSettingsBtn').addEventListener('click', () => {
  showScreen(settingsScreen);
  // Re-read the signed-in account each time Settings opens — the Google account
  // chip renders async, so a single fetch at panel load often missed it.
  if (typeof refreshAccountEmail === 'function') refreshAccountEmail(lastMeetMode);
});
document.getElementById('backFromSettingsBtn').addEventListener('click', () => showScreen(mainScreen));

// Escape leaves Settings too. A pane you can open with one key should close with
// one, and it's the reflex when a control isn't where you expect.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (settingsScreen.style.display === 'none') return;
  // Don't steal it from a field mid-edit — the URL box uses Escape to dismiss.
  const tag = (document.activeElement?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  showScreen(mainScreen);
});
// ⓘ opens Troubleshooting in its OWN window, so the panel keeps showing the
// avatar and the call controls. (The screen's own ⧉ Pop out can't do this: it
// re-parents the single panelView, which leaves the main window with no panel
// and falling back to a full-size Meet view.)
document.getElementById('openBrainBtn')?.addEventListener('click', () => {
  api.invoke('open-brain-window').catch(() => {});
});

document.getElementById('openTroubleshootingBtn')?.addEventListener('click', () => {
  api.invoke('open-troubleshooting-window').catch(() => {});
});

// #242: the brain pane runs as its own window (same panel.html, ?screen=brain),
// so it can sit beside the Meet window while a call runs — the whole point is
// watching the agent AND the call at once.
const IS_BRAIN_WINDOW =
  new URLSearchParams(location.search).get('screen') === 'brain';

if (IS_BRAIN_WINDOW) {
  showScreen(brainScreen);
  const back = document.getElementById('backFromBrainBtn');
  if (back) back.style.display = 'none';   // nothing to go back to in its own window
}

if (IS_TROUBLESHOOTING_WINDOW) {
  showScreen(troubleshootingScreen);
  // Lets the stylesheet drop the panel chrome that has no business in a plain
  // window — see body[data-window="troubleshooting"] in panel.css.
  document.body.dataset.window = 'troubleshooting';
  // No panel behind this to go back to, and the window's own title bar already
  // has a close button directly above it.
  const back = document.getElementById('backFromTroubleshootingBtn');
  if (back) back.style.display = 'none';
  // "⧉ Pop out" detaches the whole panelView — from here that would empty the
  // MAIN window, which is the exact behaviour this window exists to avoid.
  const popout = document.getElementById('popoutPanelBtn');
  if (popout) popout.style.display = 'none';
}


// In the panel this returns to the main screen; in the ⓘ window it's rebound
// above to close the window, so don't also swap screens underneath it.
if (!IS_TROUBLESHOOTING_WINDOW) {
  document.getElementById('backFromTroubleshootingBtn').addEventListener('click', () => showScreen(mainScreen));
}

// ── #289 panel redesign: bot identity (avatar + name) wiring ────────────────
// ("⊕ Add calling platform" was here; removed until there's a 3rd platform to
// add — Meet + Slack are both fixed for now. #289.)

// Render the agent avatar's background SVG layer (the same `avatarBackgroundSvg`
// pref the bot can set via MCP). Empty/unset → keep the default CSS gradient.
// Two tiles wear this look: the panel masthead and the Bot Settings heading, so
// each config read paints both.
const agentAvatarEls = ['agentAvatar', 'settingsAvatar']
  .map((id) => document.getElementById(id))
  .filter(Boolean);

function paintAvatarBg(el, svg) {
  let bg = el.querySelector('.agent-avatar-bg');
  if (svg && svg.trim()) {
    if (!bg) {
      bg = document.createElement('div');
      bg.className = 'agent-avatar-bg';
      el.insertBefore(bg, el.firstChild);
    }
    // Namespace this copy's ids. Several tiles carry the SAME background at
    // once, and duplicate inline-SVG ids make every copy's url(#…) / <use>
    // resolve to the first one in the document — which sits in the hidden
    // screen, so gradients silently stopped painting. See svg-scope.js.
    bg.innerHTML = scopeSvgIds(svg, scopeForElement(el));
    // The tile is square; backgrounds are authored 16:9. `object-fit: cover` in
    // the stylesheet does nothing to an INLINE <svg> — only to replaced elements
    // — so the SVG was letterboxing on its default preserveAspectRatio ("meet").
    // Force the SVG-native spelling of cover. (See renderer/svg-cover.js.)
    coverFitFirstSvg(bg);
  } else if (bg) {
    bg.remove();
  }
}

// --- Avatar background, by hand (Bot Settings) ------------------------------
// The agent can set `avatarBackgroundSvg` itself mid-call, but that means
// authoring SVG. This is the old-fashioned path: see what's set, pick an image,
// clear it. The heavy lifting (downscale, encode, wrap in a 16:9 SVG) happens in
// main — the renderer is sandboxed and can't read files.
const avatarBgPreview = document.getElementById('avatarBgPreview');
const avatarBgStatus = document.getElementById('avatarBgStatus');
const chooseAvatarBgBtn = document.getElementById('chooseAvatarBgBtn');
const clearAvatarBgBtn = document.getElementById('clearAvatarBgBtn');

// Unlike the avatar tiles, this preview is ALREADY 16:9 — the camera's shape —
// so cover-fitting it is a no-op for a well-authored background and only crops
// one that isn't. That's the point: it shows the framing the call will use.
//
// The art goes in its own layer rather than straight into the box, so the face
// painted over it survives a background change (and vice versa) — innerHTML on
// the box itself would wipe whichever one it wasn't updating.
function paintAvatarBgPreview(svg) {
  if (!avatarBgPreview) return;
  const art = avatarBgPreview.querySelector('.avatar-bg-preview-art');
  if (!art) return;
  const has = !!(svg && svg.trim());
  if (has) {
    art.innerHTML = scopeSvgIds(svg, scopeForElement(avatarBgPreview));
    coverFitFirstSvg(art);
  } else {
    // No background set → show the SAME default gradient the camera falls back
    // to, not a "nothing here" message. Empty is a real look the bot can wear,
    // so the preview should show it rather than describe it. (The Clear button
    // hides itself below, which is what signals "nothing set".)
    art.innerHTML = '';
  }
  avatarBgPreview.classList.toggle('is-default', !has);
  if (clearAvatarBgBtn) clearAvatarBgBtn.style.display = has ? '' : 'none';
}

// The resting face, over the background — so this previews the whole picture the
// call will show, not just the backdrop. Static on purpose: the tiles blink and
// change mood, but a settings preview wants a portrait, the same call
// refreshAvatarThumb makes for the switcher thumbnail.
function paintAvatarBgPreviewFace(dataUri, emojiChar) {
  if (!avatarBgPreview) return;
  const face = avatarBgPreview.querySelector('.avatar-bg-preview-face');
  if (!face) return;
  if (dataUri) {
    // The chosen set's artwork, exactly as the camera draws it.
    face.innerHTML = '';
    const img = document.createElement('img');
    img.src = dataUri;
    img.alt = '';
    face.appendChild(img);
  } else {
    // 'native' set, or an emoji this set doesn't ship — the OS glyph.
    face.textContent = emojiChar || RESTING_EMOJI;
  }
}

function setAvatarBgStatus(text, isError) {
  if (!avatarBgStatus) return;
  avatarBgStatus.textContent = text || '';
  avatarBgStatus.style.color = isError ? '#f28b82' : '#81c995';
}

chooseAvatarBgBtn?.addEventListener('click', async () => {
  chooseAvatarBgBtn.disabled = true;
  setAvatarBgStatus('');
  try {
    const r = await api.invoke('choose-avatar-background-image');
    if (r?.canceled) return;
    if (r?.ok) {
      paintAvatarBgPreview(r.svg);
      // Repaint the avatar tiles too — the masthead and the settings heading
      // both wear this background, and waiting out the 60s timer would read as
      // the change not having taken.
      for (const el of agentAvatarEls) paintAvatarBg(el, r.svg);
      setAvatarBgStatus('Set from ' + (r.name || 'image'));
    } else {
      setAvatarBgStatus(r?.error || 'Could not load that image', true);
    }
  } catch (err) {
    setAvatarBgStatus(err?.message || 'Could not load that image', true);
  } finally {
    chooseAvatarBgBtn.disabled = false;
  }
});

clearAvatarBgBtn?.addEventListener('click', async () => {
  try {
    await api.invoke('set-config', 'avatarBackgroundSvg', '');
    await api.invoke('set-config', 'avatarBackgroundCaption', '');
    paintAvatarBgPreview('');
    for (const el of agentAvatarEls) paintAvatarBg(el, '');
    setAvatarBgStatus('Cleared — back to the default gradient');
  } catch (err) {
    setAvatarBgStatus(err?.message || 'Could not clear', true);
  }
});

// The face the panel shows: the bot's RESTING expression. The live in-call face
// cycles through a dozen states (thinking, muted, yielding…), but a control panel
// wants a stable portrait, and resting is the one the bot wears most.
// (`idleEmojiOverride` and friends are runtime-only — not persisted — so there is
// nothing per-bot to read here yet.)
const RESTING_EMOJI = '\u{1F642}'; // 🙂

// set|emoji → data URI (or null for native / not in the set). Main reads a file
// per lookup and the blink asks for the same handful over and over, so cache.
const emojiUriCache = new Map();
// emojiSet carries either a bundled set name or `font:<Family>` for a font
// installed on this machine. The panel draws its OWN avatar (and its switcher
// thumbnail), so it has to understand the font form too — otherwise the call
// shows the chosen font and the app's own picture of the bot does not, which is
// exactly how this was first noticed.
function parseFontSet(setName) {
  const m = /^font:([^#]+)(?:#([0-9A-Fa-f]{3,8}))?$/.exec(String(setName || ''));
  if (!m) return null;
  return {
    family: m[1].replace(/[^A-Za-z0-9 _-]/g, '').trim(),
    // Strict hex only: an invalid CSS colour is ignored silently, so a typo
    // would show the previous colour with nothing to explain it.
    color: m[2] ? '#' + m[2] : '',
  };
}
function fontFamilyFromSet(setName) {
  return parseFontSet(setName)?.family || '';
}
function fontColorFromSet(setName) {
  return parseFontSet(setName)?.color || '';
}
// Keep the platform emoji fonts as the tail so an uninstalled family degrades to
// a real face instead of tofu.
const NATIVE_EMOJI_STACK = '"Apple Color Emoji", "Segoe UI Emoji", '
  + '"Noto Color Emoji", "Twemoji Mozilla", system-ui, sans-serif';
function emojiFontStackFor(setName) {
  const parts = [];
  const fam = fontFamilyFromSet(setName);          // a font the user named
  if (fam) parts.push(`"${fam}"`);
  if (EMOJI_FONT_SETS[setName]) parts.push(`"${bundledFamilyFor(setName)}"`);
  parts.push(NATIVE_EMOJI_STACK);
  return parts.join(', ');
}

// twemoji / openmoji / noto are colour FONTS now, not thousands of files. The
// panel draws its own avatar, so it loads them itself — same bytes, same
// FontFace, just via IPC instead of the Meet preload.
const EMOJI_FONT_SETS = { twemoji: 1, openmoji: 1, noto: 1 };
const bundledFamilyFor = (setName) => 'VibeEmoji-' + setName;
const _fontsAsked = new Set();
async function ensureBundledEmojiFont(setName) {
  if (!EMOJI_FONT_SETS[setName] || _fontsAsked.has(setName)) return;
  _fontsAsked.add(setName);
  try {
    const bytes = await api.invoke('emoji-font-bytes', setName);
    if (!bytes) return;                       // falls through to the OS emoji font
    const buf = bytes.buffer
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes;
    const ff = new FontFace(bundledFamilyFor(setName), buf);
    await ff.load();
    document.fonts.add(ff);
    renderAgentAvatar();                      // repaint now that the face can be drawn
  } catch { /* the font stack's tail keeps a face on screen */ }
}

const dirFromSet = (setName) => {
  const m = /^dir:(.+)$/.exec(String(setName || ''));
  return m ? m[1].trim() : null;
};

async function emojiUriFor(setName, emoji) {
  // Glyphs, not pictures — for a user font OR a bundled set font.
  if (fontFamilyFromSet(setName) || EMOJI_FONT_SETS[setName]) return null;
  // A folder of images the user or an agent made. The panel draws its own
  // avatar, so it resolves these too — otherwise the call would wear the custom
  // set and the app's own picture of the bot would not.
  const dir = dirFromSet(setName);
  if (dir) {
    const key = setName + '|' + emoji;
    if (emojiUriCache.has(key)) return emojiUriCache.get(key);
    let uri = null;
    try { uri = await api.invoke('emoji-dir-uri', dir, emoji); } catch { /* native */ }
    emojiUriCache.set(key, uri);
    return uri;
  }
  const key = setName + '|' + emoji;
  if (emojiUriCache.has(key)) return emojiUriCache.get(key);
  let uri = null;
  try { uri = await api.invoke('emoji-data-uri', setName, emoji); } catch { /* native glyph */ }
  emojiUriCache.set(key, uri);
  return uri;
}

// Draw the face from the CHOSEN EMOJI SET's artwork, exactly like the virtual
// camera does, so the panel and the call show the same picture. 'native' (or an
// emoji the set doesn't ship) falls back to the OS glyph already in the markup.
// The face's font and colour live at module scope rather than being passed in.
// They were parameters for one commit, and the BLINK path (playFaceSequence,
// below) repaints without them — so the styling applied on render and was wiped
// a couple of seconds later by the first blink, which looked like the colour
// simply not working. Anything that repaints the face gets the current styling
// by construction now.
let avatarFontStack = '';
let avatarFontColor = '';
function paintAvatarEmoji(el, dataUri, emojiChar) {
  const glyph = el.querySelector('.agent-avatar-emoji');
  if (glyph) {
    glyph.style.fontFamily = avatarFontStack || '';
    glyph.style.color = avatarFontColor || '';
  }
  let img = el.querySelector('.agent-avatar-emoji-img');
  if (dataUri) {
    if (!img) {
      img = document.createElement('img');
      img.className = 'agent-avatar-emoji-img';
      img.alt = '';
      el.appendChild(img);
    }
    if (img.getAttribute('src') !== dataUri) img.src = dataUri;
    if (glyph) glyph.style.display = 'none';
  } else {
    if (img) img.remove();
    if (glyph) {
      glyph.style.display = '';
      if (emojiChar) glyph.textContent = emojiChar; // 'native' set — swap the glyph
    }
  }
}

async function renderAgentAvatar() {
  if (IS_TROUBLESHOOTING_WINDOW) return; // no avatar here; skips its timers too
  if (!agentAvatarEls.length) return;
  let svg = '';
  let emojiSet = 'native';
  try {
    const cfg = await api.invoke('get-config', ['avatarBackgroundSvg', 'emojiSet']);
    svg = (cfg && cfg.avatarBackgroundSvg) || '';
    emojiSet = (cfg && cfg.emojiSet) || 'native';
  } catch { /* ignore — fall back to gradient + native glyph */ }

  // Fire-and-forget: the first call kicks off the load and repaints when ready.
  ensureBundledEmojiFont(emojiSet);

  // Before anything paints: every repaint path reads these.
  avatarFontStack = emojiFontStackFor(emojiSet);
  avatarFontColor = fontColorFromSet(emojiSet);

  // The thumbnail is a PORTRAIT — always the resting face, never a live state.
  const restingUri = await emojiUriFor(emojiSet, RESTING_EMOJI);
  // …but what's on screen right now may be the bot's live in-call face.
  const face = baseFaceEmoji();
  const faceUri = face === RESTING_EMOJI ? restingUri : await emojiUriFor(emojiSet, face);

  paintAvatarBgPreview(svg);
  // Resting face, not the live one: this is a portrait of the setting, and it
  // shouldn't flicker through in-call states while someone is editing.
  paintAvatarBgPreviewFace(restingUri, RESTING_EMOJI);
  for (const el of agentAvatarEls) {
    paintAvatarBg(el, svg);
    // Don't stomp a blink or mood that's mid-play — this runs on a 60s timer,
    // so it would otherwise cut ~4% of expressions short (a 2.4s mood inside a
    // 60s window). playFaceSequence lands on the right base itself.
    if (!facePlaying) paintAvatarEmoji(el, faceUri, face);
  }
  refreshAvatarThumb(svg, emojiSet, restingUri);
  startBlinking(emojiSet);
}

// --- Blink ------------------------------------------------------------------
// A still face reads as a screenshot; an occasional blink reads as alive. This
// is panel-only decoration — the in-call avatar has its own state machine.
//
// 🙂 → 😐 → 😑 → 😐 → 🙂. The closed-eye face (😑) also flattens the mouth, so
// cutting straight to it from the smile reads as a change of MOOD rather than a
// blink; passing through 😐 lets the mouth relax and snap back, which reads as
// one motion. Frame times are deliberately uneven — closing is faster than
// opening, as in a real blink.
const BLINK_FRAMES = [
  { emoji: '\u{1F610}', ms: 60 },  // 😐 mouth relaxes, eyes still open
  { emoji: '\u{1F611}', ms: 110 }, // 😑 eyes closed — the blink itself
  { emoji: '\u{1F610}', ms: 70 },  // 😐 eyes back open
];
const BLINK_MIN_GAP_MS = 5700;
const BLINK_MAX_GAP_MS = 13500;

// Occasional change of expression, on a much slower clock than the blink. The
// bot isn't reacting to anything — this is idle personality, so it stays rare
// enough to feel like a glance rather than a tic.
// Chosen to read as IDLE personality, not as a reaction to you. Each is a round
// yellow face like the resting 🙂, so the pass through 😐 still reads as one
// movement; anything with hands (🤗 🫡), an object, or a strong emotion breaks
// that and looks like the bot is responding to something that didn't happen.
const MOOD_EMOJIS = [
  '\u{1F914}',        // 🤔 thinking
  '\u{1F609}',        // 😉 wink
  '\u{1F60F}',        // 😏 smirk
  '\u263A\uFE0F',     // ☺️ smiling
  '\u{1F61B}',        // 😛 tongue out
  '\u{1F643}',        // 🙃 upside-down — playful and completely unreadable as a mood, which is the point
  '\u{1F60C}',        // 😌 relieved — closed eyes, so it lands naturally right after a blink
  '\u{1F60A}',        // 😊 smiling eyes — the warm cousin of the resting face; the gentlest of the set
  '\u{1F971}',        // 🥱 yawn
];
const MOOD_MIN_GAP_MS = 70000;
const MOOD_MAX_GAP_MS = 110000;  // ~90s on average, but never on a fixed beat
const MOOD_HOLD_MIN_MS = 2000;
const MOOD_HOLD_MAX_MS = 2800;
// Lead in and out through 😐, the same trick the blink uses: cutting straight
// from a smile to 🤔 reads as a jump-cut, but letting the face pass through
// neutral reads as one movement.
const MOOD_EASE_EMOJI = '\u{1F610}'; // 😐
const MOOD_EASE_MS = 90;

let blinkTimer = null;
let moodTimer = null;
let blinkSet = null;
// The bot's ACTUAL face while it's in a call, pushed from the virtual camera's
// render loop (main → 'avatar-emoji'). When set it wins over everything here:
// personality when idle, state when working. So during a call the panel avatar
// is a live status display in the same vocabulary the other participants see —
// 🤔 formulating a reply, 😄 speaking, 🙋 yielding, 🤐 muted — instead of
// winking at you while the bot is mid-sentence.
let liveFaceEmoji = null;
// Whether a call is live at all (joining → in-call). Gates the mirror: the
// camera's render loop reports asynchronously, so its LAST frame of a call
// (🫥, from callStatus 'left') lands AFTER the call-ended handlers have run.
// Clearing on hangup alone therefore loses the race and the panel keeps wearing
// 🫥 — so late reports are rejected outright instead.
let callActive = false;
// One face, two animations — whichever starts first owns it until it's done, so
// a mood can't be interrupted by a blink halfway through (or vice versa).
let facePlaying = false;

const randBetween = (lo, hi) => lo + Math.random() * (hi - lo);

function faceAnimationAllowed() {
  // Someone who asked the OS for less motion doesn't want a face twitching at
  // them, and a hidden panel shouldn't burn timers.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (liveFaceEmoji) return false; // the real face is on screen — don't animate over it
  return document.visibilityState !== 'hidden';
}

// The face to show when nothing is playing: the bot's real one in a call, else
// the resting portrait.
function baseFaceEmoji() {
  return liveFaceEmoji || RESTING_EMOJI;
}

async function paintFace(emoji) {
  const uri = await emojiUriFor(blinkSet, emoji);
  for (const el of agentAvatarEls) paintAvatarEmoji(el, uri, emoji);
}

const hold = (ms) => new Promise((r) => setTimeout(r, ms));

// Play a sequence of {emoji, ms} frames, then return to resting. Refuses to
// start if the face is already busy; always lands back on 🙂 even if cut short.
async function playFaceSequence(frames) {
  if (facePlaying || !faceAnimationAllowed()) return;
  facePlaying = true;
  try {
    for (const f of frames) {
      if (!faceAnimationAllowed()) break;
      await paintFace(f.emoji);
      await hold(f.ms);
    }
    await paintFace(baseFaceEmoji());
  } finally {
    facePlaying = false;
  }
}

function scheduleBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = setTimeout(async () => {
    await playFaceSequence(BLINK_FRAMES);
    scheduleBlink();
  }, randBetween(BLINK_MIN_GAP_MS, BLINK_MAX_GAP_MS));
}

function scheduleMood() {
  clearTimeout(moodTimer);
  moodTimer = setTimeout(async () => {
    const mood = MOOD_EMOJIS[Math.floor(Math.random() * MOOD_EMOJIS.length)];
    await playFaceSequence([
      { emoji: MOOD_EASE_EMOJI, ms: MOOD_EASE_MS },
      { emoji: mood, ms: randBetween(MOOD_HOLD_MIN_MS, MOOD_HOLD_MAX_MS) },
      { emoji: MOOD_EASE_EMOJI, ms: MOOD_EASE_MS },
    ]);
    scheduleMood();
  }, randBetween(MOOD_MIN_GAP_MS, MOOD_MAX_GAP_MS));
}

// Called on every avatar render; only (re)starts when the set actually changed,
// so the 60s re-render doesn't restart the cycle each time.
function startBlinking(emojiSet) {
  if (blinkTimer && blinkSet === emojiSet) return;
  blinkSet = emojiSet;
  // Warm the cache so the first play doesn't flash an undecoded frame. Main
  // reads a file per lookup, so doing this up front also keeps the animations
  // off the IPC path once they're running.
  for (const f of BLINK_FRAMES) emojiUriFor(emojiSet, f.emoji);
  for (const e of MOOD_EMOJIS) emojiUriFor(emojiSet, e);
  emojiUriFor(emojiSet, MOOD_EASE_EMOJI);
  scheduleBlink();
  scheduleMood();
}

// Live face from the virtual camera (in-call). Null/absent → back to idle
// personality. Repaints immediately unless a blink/mood is mid-play, which lands
// on the new base itself.
function clearLiveFace() {
  if (!liveFaceEmoji) return;
  liveFaceEmoji = null;
  if (!facePlaying) paintFace(RESTING_EMOJI);
  if (blinkSet !== null) { scheduleBlink(); scheduleMood(); } // idle personality resumes
}

api.on('avatar-emoji', ({ emoji }) => {
  if (!callActive) return; // a straggler from a call that already ended
  const next = emoji || null;
  if (next === liveFaceEmoji) return;
  liveFaceEmoji = next;
  if (!facePlaying) paintFace(baseFaceEmoji());
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(blinkTimer);
    clearTimeout(moodTimer);
  } else if (blinkSet !== null) {
    scheduleBlink();
    scheduleMood();
  }
});

// --- Switcher thumbnail cache --------------------------------------------
// The bot switcher lists OTHER profiles, and it can't render their avatars the
// way we render ours: it would have to read each profile's avatarBackgroundSvg
// (capped at 1MB each) and parse a dozen of them on every menu open, to paint
// 24px squares. So each bot rasterises its OWN avatar once, here, into a small
// PNG in its config — and the switcher just shows that image.
//
// This replaces the old `profileIcon`, which was a snapshot stolen from the live
// camera feed and so only existed after the bot had been in a call (and caught
// mid-blink at that). Rendering it locally means a brand-new bot has a correct
// thumbnail immediately.
const AVATAR_THUMB_PX = 96;

// Only re-rasterise when the inputs actually changed — this runs on a 60s timer.
let lastThumbKey = null;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Scale-to-fill + centre-crop, matching how the background is cover-fitted
// everywhere else (and how the camera treats it).
function drawCover(ctx, img, size) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = Math.max(size / iw, size / ih);
  const w = iw * scale;
  const h = ih * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

async function refreshAvatarThumb(svg, emojiSet, emojiUri) {
  if (IS_TROUBLESHOOTING_WINDOW) return; // one writer for the cached thumbnail
  const key = `${emojiSet}|${svg.length}|${svg.slice(0, 64)}|${svg.slice(-64)}`;
  if (key === lastThumbKey) return;
  lastThumbKey = key; // claim it up front so overlapping runs don't both rasterise
  try {
    const size = AVATAR_THUMB_PX;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Background: the bot's SVG, or the same neutral gradient the CSS uses so a
    // bot that never set one still gets a real thumbnail.
    let painted = false;
    if (svg && svg.trim()) {
      const bg = await loadImage('data:image/svg+xml;utf8,' + encodeURIComponent(svg));
      if (bg) { drawCover(ctx, bg, size); painted = true; }
    }
    if (!painted) {
      // Same fallback as the CSS tile and the virtual camera: the blue gradient,
      // not a neutral grey. See the note on .agent-avatar in panel.css.
      const g = ctx.createLinearGradient(size * 0.3, 0, size * 0.7, size);
      g.addColorStop(0, '#1a237e');
      g.addColorStop(0.5, '#283593');
      g.addColorStop(1, '#1565c0');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }

    // Face, centred at roughly the proportion the live avatar uses.
    const face = size * 0.62;
    if (emojiUri) {
      const em = await loadImage(emojiUri);
      if (em) ctx.drawImage(em, (size - face) / 2, (size - face) / 2, face, face);
    } else {
      // 'native' set — draw the OS glyph so the thumbnail still has a face. One
      // name per platform, since this is the one path that deliberately uses the
      // system font rather than our bundled artwork: macOS, Windows, then the
      // usual Linux packages. Unmatched names are skipped, so listing all of
      // them costs nothing.
      ctx.font = `${Math.round(face)}px ${emojiFontStackFor(emojiSet)}`;
      const thumbColor = fontColorFromSet(emojiSet);
      if (thumbColor) ctx.fillStyle = thumbColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(RESTING_EMOJI, size / 2, size / 2 + face * 0.04);
    }

    await api.invoke('set-config', 'avatarThumb', canvas.toDataURL('image/png'));
  } catch {
    lastThumbKey = null; // let the next tick retry
  }
}

// (The per-platform connection dots lived here. The panel no longer shows the
// bot's platform logins — that detail is in this bot's Settings screen.)
renderAgentAvatar();
// Re-render periodically so a background/emoji change made by the bot (via MCP)
// shows without a panel reload. Cheap; both rarely change.
setInterval(renderAgentAvatar, 60 * 1000);

// ---------------------------------------------------------------------------
// Call State debug view — live snapshot of the app's detectors
// ---------------------------------------------------------------------------

const callStateDebug = document.getElementById('callStateDebug');

function yesNo(v) { return v ? '🟢 yes' : '⚪️ no'; }

function agoLabel(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function ackLabel(ev) {
  if (!ev) return '(none yet)';
  const ago = agoLabel(ev.at);
  const phrase = ev.phrase ? JSON.stringify(ev.phrase) : 'SKIP';
  const latency = ev.latencyMs != null ? `${ev.latencyMs}ms` : '?';
  let sourceTag;
  switch (ev.source) {
    case 'llm':                   sourceTag = '🟢 llm'; break;
    case 'llm-fallback-builtin':  sourceTag = `🔴 llm→builtin (${ev.error || 'failed'})`; break;
    case 'builtin':               sourceTag = '⚪️ builtin'; break;
    default:                      sourceTag = ev.source || '?';
  }
  return `${phrase} · ${sourceTag} · ${latency} · ${ago}`;
}

// The verdict comes from the server (agent-liveness.js) rather than being
// recomputed here: the avatar shows 🫥 off the same classification, and two
// copies of the thresholds would eventually disagree about whether anyone is
// driving — with the debug screen reassuring you while the face says otherwise.
//
// This reads lastAgentActivityAt (ANY agent request), not lastWaitForSpeechAt:
// an agent deep in tool work is alive and simply not waiting, which the old
// wait-only view scored as going stale.
function agentLoopHealth(s) {
  const quietSecs = s.lastAgentActivityAt
    ? Math.round((Date.now() - s.lastAgentActivityAt) / 1000)
    : 0;
  switch (s.agentState) {
    case 'live': return `🟢 listening (${s.activeWaiters} waiter${s.activeWaiters === 1 ? '' : 's'})`;
    case 'settling': return `🟡 between waits (${quietSecs}s)`;
    case 'busy': return `🟡 idle ${quietSecs}s — agent may be processing or speaking`;
    case 'away': return `🔴 stale ${agoLabel(s.lastAgentActivityAt)} — agent likely stopped the wait_for_speech loop`;
    case 'never': return '⚪️ no agent activity yet — agent may not have started the loop';
    default: return `⚪️ unknown (${s.agentState || 'no state reported'})`;
  }
}

// Health thresholds for Claude's reaction time (ms). Tune freely — mirrored in
// the camera overlay's colorFor(). <3s snappy, 3–4s noticeable lag, >4s sluggish.
const PERF_GREEN_MS = 3000;
const PERF_YELLOW_MS = 4000;
function perfDot(ms) {
  if (ms == null) return '⚪';
  if (ms < PERF_GREEN_MS) return '🟢';
  if (ms <= PERF_YELLOW_MS) return '🟡';
  return '🔴';
}

// Claude's reaction time (resolve → first speak) — last + rolling avg/p90.
// This is mostly "how fast is Claude today", independent of our code, so it
// explains a lot of the day-to-day "the bot feels snappy/sluggish" swing. The
// dot reflects the LAST value (matches the headline number beside it); avg/p90
// give the sustained picture.
function responsePerfLabel(s) {
  const p = s.responsePerf;
  if (!p || !p.count) return '⚪ — (no response timed yet)';
  const secs = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`);
  return `${perfDot(p.last)} ${secs(p.last)} (avg ${secs(p.avg)} · p90 ${secs(p.p90)} · n=${p.count})`;
}

function renderCallState(s) {
  if (!s || !s.roomId) {
    callStateDebug.textContent = 'Not in a call.';
    return;
  }
  const parts = (s.participants || []).map(p => {
    const tags = [];
    if (p.isSelf) tags.push('self');
    if (p.isBot) tags.push('bot');
    const tagStr = tags.length ? ` (${tags.join(', ')})` : '';
    return `    • ${p.name}${tagStr} ${p.speaking ? '🗣️ speaking' : '— quiet'}`;
  });
  const queued = s.pendingBotSpeech || [];
  const queuedLines = queued.length === 0
    ? ['    (empty)']
    : queued.map((e, i) => {
        const snippet = (e.text || '').replace(/\s+/g, ' ').slice(0, 80);
        const more = (e.text || '').length > 80 ? '…' : '';
        const tag = e.emoji ? ` ${e.emoji}` : '';
        return `    ${i + 1}.${tag} "${snippet}${more}"`;
      });
  // (workingMemory / stance display removed — the two-tier experiment that
  // maintained it is parked, so the fields were always empty noise.)
  callStateDebug.textContent = [
    `Call status:        ${s.callStatus || 'unknown'}`,
    `Bot state:          ${s.botState || 'unknown'}`,
    `Bot mode:           ${s.mode || 'unknown'}`,
    `Anyone speaking:    ${yesNo(s.anyoneSpeaking)}`,
    `Screen sharing:     ${yesNo(s.sharing)}${s.someoneElsePresenting ? ` (other: ${s.presenterName || 'someone'})` : ''}`,
    `Screen share URL:   ${s.screenShareUrl || '(none)'}`,
    `People pane open:   ${yesNo(s.peoplePaneOpen)}`,
    `Chat pane open:     ${yesNo(s.chatPaneOpen)}`,
    `Unread chat:        ${yesNo(s.chatUnread)}`,
    `Screen rec perm:    ${s.screenRecording || 'unknown'}`,
    `Agent loop:         ${agentLoopHealth(s)}`,
    `Last wait_for_speech: ${agoLabel(s.lastWaitForSpeechAt)}`,
    `Claude response:    ${responsePerfLabel(s)}`,
    `Last ack:           ${ackLabel(s.lastAckEvent)}`,
    `Queued speech (${queued.length}):`,
    ...queuedLines,
    `Participants (${(s.participants || []).length}):`,
    ...(parts.length ? parts : ['    (none detected)']),
    `Agent activity (${(s.agentLog || []).length}):`,
    ...((s.agentLog || []).length ? s.agentLog.map((l) => `    ${l}`) : ['    (no agent session)']),
  ].join('\n');
}

// #242: the brain feed. Reuses the SAME agentLog the app already tails from the
// Claude session's transcript — 🗣 said, 🔧 ran a tool, 💬 was asked — so this is
// a surface over an existing signal rather than a new pipeline.
//
// Read-only, and not by choice: Terminal.app owns the agent process, so the app
// has no stdin to it. An input box would need #242's headless spawn first, where
// we own the pipe. Worth stating in the UI rather than leaving people hunting
// for a prompt that cannot exist yet.
const BRAIN_LINE_CLASS = { '🗣': 'l-say', '🔧': 'l-tool', '💬': 'l-ask', '💭': 'l-think' };
let _brainLastRendered = '';
function renderBrain(s) {
  const feed = document.getElementById('brainFeed');
  const status = document.getElementById('brainStatus');
  if (!feed) return;
  const lines = (s && s.agentLog) || [];
  // #385: which model drives this bot — the at-a-glance differentiator when
  // several profiles are up. Set BEFORE the unchanged-content guard below,
  // because the model is read off the session's turns and can become known
  // without the feed changing. Empty until known: no guessing.
  if (status) {
    const parts = [];
    if (s && s.agentModel) parts.push(s.agentModel);
    if (lines.length) parts.push(`${lines.length} lines`);
    status.textContent = parts.join(' · ');
  }
  const joined = lines.join('\n');
  if (joined === _brainLastRendered) return;   // don't fight the user's scroll
  _brainLastRendered = joined;

  if (!lines.length) {
    feed.innerHTML = '<span class="l-none">No agent session yet. This fills in once a bot is driven by '
      + 'Claude Code — the app reads the session\u2019s own transcript.</span>';
    return;
  }
  // Pinned to the bottom unless the user has scrolled up to read something —
  // a live feed that yanks you back to the end is unreadable.
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  feed.innerHTML = lines.map((l) => {
    const cls = BRAIN_LINE_CLASS[l.slice(0, 2)] || BRAIN_LINE_CLASS[[...l][0]] || 'l-say';
    const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="${cls}">${esc}</div>`;
  }).join('');
  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

setInterval(async () => {
  if (IS_BRAIN_WINDOW) {
    try { renderBrain(await api.invoke('get-call-state')); } catch { /* ignore */ }
    return;
  }
  if (troubleshootingScreen.style.display === 'none') return; // only poll when visible
  try {
    const s = await api.invoke('get-call-state');
    renderCallState(s);
    renderShareState();
    // Same source of truth as the view above, so the curl helper works in the
    // pop-out window too (see updateCurlCommand).
    updateCurlCommand(s && s.roomId);
  } catch { /* ignore */ }
}, 1000);

// Listen for menu bar "Settings" command
api.on('show-settings', () => showScreen(settingsScreen));

// Listen for agent-triggered leave
api.on('leave-requested', () => {
  api.send('leave-meet');
  exitCallState();
});

// Live share state, polled with the rest of the troubleshooting view.
//
// The count has to keep moving while the call does: the share is a stream, not
// a snapshot, and a frozen number next to "still sharing" looks like a stall.
// It also has to say when it STOPS, since the grant ends with the call and
// nothing else in the window would show that.
async function renderShareState() {
  if (!shareCallLogStatus) return;
  let st;
  try { st = await api.invoke('get-call-log-share-state'); } catch { return; }
  if (!st) return;

  // Nothing for the button to do when everything is already being shipped.
  // Disabling it with a reason beats leaving a control that would silently
  // no-op, and it points at where the setting actually lives.
  if (st.globalLogging) {
    if (shareCallLogBtn) shareCallLogBtn.disabled = true;
    setShareMsg('Logs are already shared for every call (App Settings → Remote logging). '
      + 'Turn that off if you would rather share call by call.');
    return;
  }
  if (shareCallLogBtn && !st.sharedCallId) shareCallLogBtn.disabled = !st.inCall;
  if (!st.sharedCallId) {
    setShareLabel(SHARE_LABEL);
    setShareMsg(st.inCall ? '' : 'Available during a call.');
    return;
  }
  if (st.active) {
    // The button is a toggle while the call runs: stop before something you
    // would rather not send, start again after.
    setShareLabel(st.streaming ? '⏹ Stop sharing' : '📤 Resume sharing');
    setShareMsg(st.streaming
      ? `Sharing this call. ${st.sent} lines sent so far.`
      // "Stopped" not "cancelled": what went cannot come back, and the count
      // says how much did. The gap is real though — nothing is sent while
      // stopped, so the paused stretch never leaves the machine.
      : `Stopped. ${st.sent} lines were sent; nothing is being sent now.`);
  } else {
    // The call the grant belonged to has ended.
    setShareLabel(SHARE_LABEL);
    setShareMsg(`Shared that call (${st.sent} lines). Sharing has stopped.`);
    // (The share runs to the END of the call's wrap-up, not the goodbye — the
    // agent's after-call work belongs to the same call and is often where the
    // interesting part is.)
    if (shareCallLogBtn) shareCallLogBtn.disabled = false;   // a NEW call can be shared
  }
}

// #255 — share this ONE call's log.
//
// Its own control, not a tick-box on the feedback buttons: those stay on the
// machine as guidance to the bot, this sends transcript text off it. Reporting a
// problem must never quietly ship a log as a side effect.
const shareCallLogBtn = document.getElementById('shareCallLogBtn');
const shareCallLogStatus = document.getElementById('shareCallLogStatus');
const shareCallLogWhy = document.querySelector('.share-log-why');

// The slot beside the button holds ONE message. Empty text restores the "why
// share" line; anything else replaces it. They are never both true — leaving the
// invitation up beside "Sharing this call…" would be answering a question the
// user has already answered.
const SHARE_LABEL = "📤 Share this call's log";
function setShareLabel(text) {
  if (shareCallLogBtn && shareCallLogBtn.textContent !== text) shareCallLogBtn.textContent = text;
}

function setShareMsg(text) {
  const showing = !!text;
  if (shareCallLogStatus) {
    shareCallLogStatus.textContent = text || '';
    shareCallLogStatus.style.display = showing ? 'block' : 'none';
  }
  if (shareCallLogWhy) shareCallLogWhy.style.display = showing ? 'none' : 'block';
}
shareCallLogBtn?.addEventListener('click', async () => {
  shareCallLogBtn.disabled = true;
  setShareMsg('Working…');
  try {
    const r = await api.invoke('share-call-log');
    if (r?.ok && r.alreadyGlobal) {
      setShareMsg('Logs are already shared for every call (App Settings → Remote logging).');
    } else if (r?.ok) {
      // Say what actually happened, including that it keeps going: someone who
      // thinks a snapshot was sent would be surprised to find the rest of the
      // call followed it.
      // No count in the click result — renderShareState owns the number from
      // here, so the two cannot disagree. A static "sent 347 lines" sitting
      // beside "sharing the rest of this call" reads as though it has stalled.
      setShareMsg(r.stopped ? 'Stopped. What was already sent stays sent.'
        : r.resumed ? 'Sharing again. The paused part was not sent.'
        : r.streaming ? 'Shared. Still sending as the call goes on…' : 'Shared.');
    } else {
      // A share that silently did nothing is worse than no button — the user
      // walks away believing the evidence was handed over.
      setShareMsg('Could not send: ' + (r?.error || 'unknown'));
    }
  } catch (e) {
    setShareMsg('Could not send: ' + e.message);
  }
  // Always re-enabled: it is a toggle now, so the next press is always
  // meaningful — stop, or start again.
  shareCallLogBtn.disabled = false;
});

// ---------------------------------------------------------------------------
// Meet URL validation
// ---------------------------------------------------------------------------

function isValidMeetUrl(url) {
  return /meet\.google\.com\/[a-z]+-[a-z]+-[a-z]+/.test(url);
}

// A Slack workspace/channel URL — joining it switches the app to the Slack
// provider at runtime and auto-joins that channel's huddle.
function isValidSlackUrl(url) {
  return /app\.slack\.com\/client\/[^/]+\/[^/?#]+/.test(url);
}

// Turn whatever was pasted into a full Meet URL.
//
// The old test was `url.startsWith('http')`, which misses the single most
// common paste: "meet.google.com/abc-defg-hij". Chrome HIDES the scheme in the
// address bar, so copying from there — or from a chat message, or a calendar
// entry — gives a host-qualified string with no https://. That failed the
// startsWith check, so the host was prepended a SECOND time and the bot
// navigated to
//     https://meet.google.com/meet.google.com/abc-defg-hij
// which fails as "the page ended up somewhere else instead of the meeting".
//
// The MCP path already handles this (mcp-server/meet-room.js, #314/#319); the
// panel — the front door for anyone using the app by hand — never did.
function toMeetUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^https?:\/\//i.test(s)) return s;
  // Already host-qualified, just scheme-less. Strip the host rather than
  // stacking another one in front of it.
  return 'https://meet.google.com/' + s.replace(/^(?:www\.)?meet\.google\.com\//i, '');
}

function isJoinableUrl(url) {
  if (isValidSlackUrl(url)) return true;
  return isValidMeetUrl(toMeetUrl(url));
}

// --- Pre-call modes -------------------------------------------------------
// Out of the box the panel offers ONE action: "Call <bot> now". The Meet/Slack
// URL field only appears when there's a reason for it — a call was detected in
// the browser, or the user opened manual entry via ⋯ — and the button then
// becomes "Add <bot> to call", because that's a different act: joining the bot
// to a call that already exists.
const callUrlField = document.getElementById('callUrlField');
const manualUrlToggle = document.getElementById('manualUrlToggle');

let detectedCallUrl = null; // the ACTIVE offer — drives the auto-expanded mode
let manualUrlEntry = false; // the user opened + themselves
// The last call we were told about, kept even after a dismissal so reopening +
// prefills it. Dismissing means "not right now", not "forget what you saw" —
// without this, collapsing and reopening seconds later gave an empty box even
// though the Meet was still sitting there in the browser. Only an undetect
// (main sending null: the tab closed or navigated away) forgets it.

// "Add to call" mode = there's a URL to act on, from either source.
function isAddToCallMode() {
  return !!detectedCallUrl || manualUrlEntry;
}

// True between pressing the call button and the call actually starting (or
// failing). A REAL state rather than something the click handler pokes into the
// button, because updateJoinBtnState recomputes `disabled` purely from URL
// validity — and it is called from updateBotNameBig, the URL input handler and
// config updates, any of which can fire mid-join. Each one silently re-enabled
// the button and overwrote "Joining…" with "Call Jimmy now", so the control
// looked live and clickable while the bot was already on its way in.
// 'starting' (asking the website for a room) | 'joining' (bot on its way in) | null
let joinPhase = null;
function setJoinPhase(phase) {
  joinPhase = phase || null;
  updateJoinBtnState();
}

// ── Option-held: the Call button becomes "Chat with <bot>" (#500 follow-up) ──
//
// A bot keeps ONE Claude session named after itself, so the session it uses on
// calls is the same one a person can open in a terminal. Rather than spend
// permanent panel space on that, it rides the button that is already about
// reaching this bot — Option-held, which on macOS conventionally means "the
// alternate version of this action" (Finder: ⌘C copies the file, ⌥⌘C copies its
// path). The label genuinely swaps while held, so it is discoverable by
// accident rather than only by being told.
let optionHeld = false;

function setOptionHeld(next) {
  if (next === optionHeld) return;
  optionHeld = next;
  updateJoinBtnState();
}

// Keyed on the EVENT's modifier state, not on keydown/keyup of Option itself:
// releasing the key over another window (or a ⌥-Tab away) never delivers the
// keyup, and the label would stick in the alternate state with no way back.
// Reading .altKey off whatever event arrives self-corrects on the next one.
for (const evt of ['keydown', 'keyup', 'mousemove']) {
  window.addEventListener(evt, (e) => setOptionHeld(!!e.altKey));
}
// Same reason: focus loss is the one case where no further event arrives.
window.addEventListener('blur', () => setOptionHeld(false));

async function openChatSession() {
  try {
    const r = await api.invoke('chat-session:open');
    if (r && r.ok === false && r.copied) {
      // No terminal we can drive — say what we did instead, rather than
      // appearing to do nothing.
      showError('Copied the command to your clipboard — paste it into a terminal.');
    }
  } catch (err) {
    showError('Could not open a terminal: ' + err.message);
  }
}

// ⌥⌘C — the Finder precedent this borrows from: ⌘C takes the thing, ⌥⌘C takes
// its address. Here the address is the command that reaches the same session.
window.addEventListener('keydown', async (e) => {
  if (!e.altKey || !(e.metaKey || e.ctrlKey)) return;
  if ((e.key || '').toLowerCase() !== 'c') return;
  // Don't steal a real copy out of a text field.
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && String(t.value || '').length
      && t.selectionStart !== t.selectionEnd) return;
  e.preventDefault();
  try {
    const r = await api.invoke('chat-session:copy');
    // showError is the panel's only transient-message surface today; the copy
    // succeeding is worth confirming, since nothing else on screen changes.
    if (r?.ok) showError('Chat command copied — paste it into a terminal.');
  } catch { /* noop */ }
});

function updateJoinBtnState() {
  if (inCall) return; // in-call UI owns the button
  if (joinPhase) {
    // One label per phase, in one place. (The two routes used to disagree:
    // 'Joining…' with an ellipsis on the create-a-call path, 'Joining...' with
    // three dots on the paste-a-URL path.)
    joinBtn.textContent = joinPhase === 'starting' ? 'Starting…' : 'Joining…';
    joinBtn.disabled = true;
    return;
  }
  const addMode = isAddToCallMode();
  const name = currentBotName || 'your bot';

  if (callUrlField) callUrlField.style.display = addMode ? '' : 'none';
  if (manualUrlToggle) {
    // ALWAYS visible, including when a call was auto-detected — collapsing it is
    // how you dismiss that detection and get back to "Call <bot> now". Hiding it
    // in the detected case (as it first did) left no route back at all: main
    // won't re-notify while the tab is still open, so the panel was stuck in
    // "Add to call" from the first Meet it ever saw.
    manualUrlToggle.style.display = '';
    // The triangle points the way the panel is about to move: right to open,
    // rotated up to collapse. aria-expanded drives the rotation in CSS, so this
    // is the only thing to set — and it tracks the ACTUAL expanded state, so a
    // detected call already points up, ready to dismiss.
    manualUrlToggle.setAttribute('aria-expanded', String(addMode));
    manualUrlToggle.title = addMode
      ? 'Dismiss this call — go back to starting a new one'
      : "Add the bot to a call that's already running — paste its Meet or Slack URL";
  }

  if (optionHeld) {
    // Same button, alternate action. Enabled regardless of the URL field: this
    // does not join anything, so nothing about a call needs to be valid.
    joinBtn.textContent = `Chat with ${name}`;
    joinBtn.disabled = false;
    joinBtn.title = `Open a terminal in ${name}'s session — the same session it uses on calls (⌥⌘C copies the command)`;
    return;
  }
  joinBtn.title = 'Calls open in Chrome/Safari are detected automatically. You can also type /join-call in any Claude Code session.';

  if (addMode) {
    joinBtn.textContent = `Add ${name} to call`;
    const url = meetUrlInput.value.trim();
    joinBtn.disabled = !url || !isJoinableUrl(url);
  } else {
    joinBtn.textContent = `Call ${name} now`;
    joinBtn.disabled = false; // nothing to validate — it starts a fresh call
  }
}

if (manualUrlToggle) {
  manualUrlToggle.addEventListener('click', () => {
    if (isAddToCallMode()) {
      dismissCallUrl(); // collapsing also drops a detected URL — that IS the dismissal
      return;
    }
    manualUrlEntry = true;
    // Reopening after a dismissal restores the call we last saw, so you don't
    // have to go and copy the URL again for a Meet that's still open.
    if (meetUrlInput && !meetUrlInput.value.trim() && lastKnownCallUrl) {
      meetUrlInput.value = lastKnownCallUrl;
    }
      updateJoinBtnState();
    if (meetUrlInput) { meetUrlInput.focus(); meetUrlInput.select(); }
  });
}

// A call turned up in the browser → switch to "Add to call" and fill the URL.
let lastKnownCallUrl = null;

function noteDetectedCall(url) {
  if (!url || inCall) return;
  detectedCallUrl = url;
  lastKnownCallUrl = url;
  meetUrlInput.value = url;
  updateJoinBtnState();
}

// The detected call went away (the tab closed, or the user navigated off it —
// main sends meet-detected/slack-huddle-detected with null). Without this the
// panel would stay in "Add <bot> to call" forever after the FIRST call it ever
// saw, with the + toggle hidden and no route back to "Call <bot> now".
function clearDetectedCall() {
  if (!detectedCallUrl) return;
  // Don't wipe a URL the user typed over the detected one — just stop treating
  // it as detected, which brings the + toggle back.
  if (meetUrlInput.value.trim() === detectedCallUrl.trim()) meetUrlInput.value = '';
  detectedCallUrl = null;
  lastKnownCallUrl = null; // the call is genuinely gone — nothing to restore
  updateJoinBtnState();
}

// Explicit dismissal: empty the field, or press Escape in it. Either way we drop
// back to the single "Call <bot> now" button. + reopens it.
function dismissCallUrl() {
  meetUrlInput.value = '';
  detectedCallUrl = null;
  manualUrlEntry = false;
  if (manualUrlToggle) manualUrlToggle.setAttribute('aria-expanded', 'false');
  updateJoinBtnState();
}

meetUrlInput.addEventListener('input', () => {
  // Clearing the box is a dismissal — it's the obvious gesture for "no, not
  // that call", and it's the only way to shed a detected URL while its tab is
  // still open (main won't re-notify until the tab's URL actually changes).
  if (!meetUrlInput.value.trim()) dismissCallUrl();
  else updateJoinBtnState();
});
updateJoinBtnState(); // paint the initial label (the markup ships a neutral one)

// With the title bar hidden (macOS only — see titleBarOptions in main.js)
// there's no OS bar left to drag the window by, so the banner's top strip
// becomes the handle. The stylesheet does the rest. Windows and Linux keep a
// standard frame, so they never set this and the banner starts below the bar.
api.invoke('get-window-chrome').then((c) => {
  if (c?.hiddenTitleBar) document.body.dataset.titlebar = c.hiddenTitleBar; // 'mac'
  // "Download more voices…" opens the OS pane that installs them: Spoken
  // Content on macOS, Settings → Speech on Windows. Nothing is behind it
  // anywhere else, so hide it there rather than offer a link that can only fail.
  paintMoreVoicesLink(c?.platform);
}).catch(() => {
  // Platform unknown — better a missing shortcut than a dead one.
  paintMoreVoicesLink('');
});

function paintMoreVoicesLink(platform) {
  const el = document.getElementById('macVoicesLink');
  if (!el) return;
  const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : '';
  if (!osName) { el.style.display = 'none'; return; }
  const link = document.getElementById('openVoiceSettingsBtn');
  if (link) link.textContent = `Download more ${osName} voices…`;
}

// --- Window sizing --------------------------------------------------------
// The window is only as tall as the panel needs. Out of a call that's the
// avatar banner + footer; in a call main.js adds the bot's-view region on top
// of whatever we report here. We just measure and tell it; main clamps to the
// screen and owns the actual resize.
//
// Measure the ACTIVE screen only — the settings and troubleshooting screens are
// long, and document.scrollHeight would report the tallest one even while it's
// display:none-adjacent. rAF-coalesced because ResizeObserver can fire several
// times for one layout pass.
let _lastReportedHeight = 0;
let _heightTimer = 0;
function reportContentHeight() {
  // Sizing the main window is not a pop-out's business — it measures its OWN
  // content, and main would apply that to the main window.
  if (IS_POPOUT_WINDOW) return;
  // setTimeout, NOT requestAnimationFrame: rAF stops entirely for an occluded
  // view, so a call starting while the window sits behind another app would
  // never report its taller in-call height — and the bot's-view region would be
  // placed over the panel's own content. Timers still fire when throttled.
  clearTimeout(_heightTimer);
  _heightTimer = setTimeout(() => {
    const screenEl = [...document.querySelectorAll('.screen')]
      .find((el) => el.style.display !== 'none');
    if (!screenEl) return;
    const h = Math.ceil(screenEl.getBoundingClientRect().height);
    if (!h || h === _lastReportedHeight) return;
    _lastReportedHeight = h;
    api.send('panel-content-height', h);
  }, 16);
}

if (window.ResizeObserver) {
  const ro = new ResizeObserver(reportContentHeight);
  for (const el of document.querySelectorAll('.screen .container')) ro.observe(el);
}
window.addEventListener('load', reportContentHeight);
reportContentHeight();

// ---------------------------------------------------------------------------
// App version
// ---------------------------------------------------------------------------

api.invoke('get-app-version').then((info) => {
  const el = document.getElementById('appVersion');
  if (!el || !info) return;
  // Tolerate both the old string return and the new {version, packaged} shape.
  const version = typeof info === 'string' ? info : info.version;
  const packaged = typeof info === 'object' ? info.packaged : true;
  if (!version) return;
  // Source builds get a "-dev" suffix so a bare version number always means the
  // released DMG. Disambiguates "is this the DMG or pnpm dev?" at a glance (#release).
  el.textContent = `v${version}${packaged ? '' : '-dev'}`;
  el.title = packaged
    ? 'Release build (installed .app / DMG).'
    : 'Running from SOURCE (pnpm dev) — not a released build. A clean version with no “-dev” means the installed DMG.';
}).catch(() => {});

// Prefill the URL field from whatever the app is already pointed at (e.g. a
// --meet-url CLI launch), so you can tell at a glance which call this instance
// is for. The live meet-detected event handles later programmatic joins; this
// covers the case where the URL was set before the panel finished loading.
api.invoke('get-call-state').then((s) => {
  if (s && s.currentMeetUrl && !inCall && !meetUrlInput.value.trim()) {
    noteDetectedCall(s.currentMeetUrl);
  }
}).catch(() => {});

Promise.all([
  api.invoke('get-app-profile'),
  api.invoke('get-local-port').catch(() => null),
]).then(([profile, port]) => {
  appProfileName = profile || null; // the on-disk profile name (#282)
  // The profile chip is gone (it duplicated the bot name). Fold the profile +
  // local-server port — the "which instance is this" debug detail — into the
  // name control's tooltip instead (#289). The tooltip lives on the BUTTON, not
  // the inner name span, since the button is what the pointer is over.
  const nameBtn = document.getElementById('profileMenuBtn');
  if (nameBtn) {
    const baseTitle = nameBtn.getAttribute('title') || '';
    const detail = [
      profile ? `Bot: "${profile}" (launched with --profile=${profile}) — isolated storage with its own preferences and Google login.` : 'Default bot.',
      port ? `local-server port ${port}` : null,
    ].filter(Boolean).join('\n');
    nameBtn.title = baseTitle + '\n\n' + detail;
  }
  // Name the profile in the Settings header too. get-app-profile returns null
  // for the default instance (it's launched without --profile), but "Default"
  // IS the folder under profiles/ that these settings write to — so say that
  // rather than leaving the line blank on the most common case of all.
  const profileEl = document.getElementById('settingsProfileName');
  if (profileEl) {
    const name = profile || 'Default';
    profileEl.textContent = 'Bot profile: ' + name + (port ? ' · port ' + port : '');
  }
  updateBotNameBig();
}).catch(() => {
  // Don't strand the header on its "…" placeholder if the lookup fails.
  const profileEl = document.getElementById('settingsProfileName');
  if (profileEl) profileEl.textContent = 'Bot profile: Default';
});

// --- Profile switcher (#282): Chrome-style list + launch/focus. -------------
const profileMenuBtn = document.getElementById('profileMenuBtn');
const profileMenu = document.getElementById('profileMenu');

function closeProfileMenu() {
  if (profileMenu) profileMenu.style.display = 'none';
  delete document.body.dataset.menuOpen;
}

// Electron renderers don't implement window.prompt (it silently returns null),
// which is what this replaces. alert()/confirm() DO work, but they're blocking
// native modals that freeze the renderer until dismissed — so the app's errors
// go through showError() (the overlay on the avatar) instead, and this file
// calls no window dialogs at all.
//
// so use a small in-DOM modal instead. Resolves to the trimmed string, or null
// on cancel/escape. Reused by "New profile" and the navigate-webview tool.
function inlinePrompt({ title, placeholder = '', initial = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#2a2d31;border:1px solid #5f6368;border-radius:10px;padding:16px;width:min(360px,86vw);box-shadow:0 10px 40px rgba(0,0,0,0.6)';
    const t = document.createElement('div');
    t.textContent = title;
    t.style.cssText = 'color:#e8eaed;font-size:13px;margin-bottom:10px;line-height:1.4';
    const input = document.createElement('input');
    input.type = 'text'; input.value = initial; input.placeholder = placeholder;
    input.style.cssText = 'width:100%;box-sizing:border-box;background:#202124;border:1px solid #5f6368;border-radius:6px;color:#e8eaed;padding:8px;font-size:13px;outline:none';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:none;border:1px solid #5f6368;color:#9aa0a6;border-radius:18px;padding:6px 14px;cursor:pointer';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.style.cssText = 'background:#8ab4f8;border:none;color:#202124;border-radius:18px;padding:6px 14px;font-weight:600;cursor:pointer';
    const close = (val) => { overlay.remove(); resolve(val); };
    cancel.onclick = () => close(null);
    ok.onclick = () => close(input.value.trim() || null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim() || null); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(t); box.appendChild(input); box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus(); input.select();
  });
}

// Two-field (username + masked password) dialog for an HTTP Basic/Digest auth
// challenge the bot webview hit. Resolves {user, password} on submit, or null on
// cancel. Styled to match inlinePrompt.
function basicAuthPrompt({ host = '', realm = '' }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#2a2d31;border:1px solid #5f6368;border-radius:10px;padding:16px;width:min(360px,86vw);box-shadow:0 10px 40px rgba(0,0,0,0.6)';
    const t = document.createElement('div');
    t.textContent = `Sign in to ${host || 'this site'}`;
    t.style.cssText = 'color:#e8eaed;font-size:13px;margin-bottom:4px';
    const sub = document.createElement('div');
    sub.textContent = realm ? `This site is password-protected (${realm}). It stays signed in for the rest of the session.` : 'This site is password-protected. It stays signed in for the rest of the session.';
    sub.style.cssText = 'color:#9aa0a6;font-size:11px;margin-bottom:10px;line-height:1.4';
    const mkInput = (type, ph) => {
      const el = document.createElement('input');
      el.type = type; el.placeholder = ph;
      el.style.cssText = 'width:100%;box-sizing:border-box;background:#202124;border:1px solid #5f6368;border-radius:6px;color:#e8eaed;padding:8px;font-size:13px;outline:none;margin-bottom:8px';
      return el;
    };
    const userIn = mkInput('text', 'Username');
    const passIn = mkInput('password', 'Password');
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:none;border:1px solid #5f6368;color:#9aa0a6;border-radius:18px;padding:6px 14px;cursor:pointer';
    const ok = document.createElement('button');
    ok.textContent = 'Sign in';
    ok.style.cssText = 'background:#8ab4f8;border:none;color:#202124;border-radius:18px;padding:6px 14px;font-weight:600;cursor:pointer';
    const close = (val) => { overlay.remove(); resolve(val); };
    const submit = () => { const u = userIn.value.trim(); close(u ? { user: u, password: passIn.value } : null); };
    cancel.onclick = () => close(null);
    ok.onclick = submit;
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
    userIn.addEventListener('keydown', onKey);
    passIn.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    btns.appendChild(cancel); btns.appendChild(ok);
    box.appendChild(t); box.appendChild(sub); box.appendChild(userIn); box.appendChild(passIn); box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    userIn.focus();
  });
}

// The bot webview hit an HTTP Basic/Digest challenge — prompt the operator and
// hand the result back to main (which calls Electron's login callback).
api.on('basic-auth-prompt', async ({ id, host, realm }) => {
  const creds = await basicAuthPrompt({ host, realm });
  api.send('basic-auth-result', { id, user: creds?.user || '', password: creds?.password || '' });
});

async function doSwitchProfile(name) {
  closeProfileMenu();
  const n = (name || '').trim();
  if (!n) return;
  try {
    const r = await api.invoke('switch-profile', n);
    if (r && r.ok === false) showError('Could not switch bot: ' + (r.error || 'unknown'));
  } catch (e) { showError('Could not switch bot: ' + e.message); }
}

// #379: additive path — open a profile in a SEPARATE new window, leaving THIS
// window (and any call it's in) untouched. Reached via ⌥-click in the switcher
// and File ▸ New Profile… (the latter works even in-call).
async function doOpenProfileWindow(name) {
  closeProfileMenu();
  const n = (name || '').trim();
  if (!n) return;
  try {
    const r = await api.invoke('open-profile-window', n);
    if (r && r.ok === false) showError('Could not open bot window: ' + (r.error || 'unknown'));
  } catch (e) { showError('Could not open bot window: ' + e.message); }
}

// Menu-bar "New Bot" → identical to the switcher's "＋ New bot": auto-named
// profile, real bot name, opened in its own window on Settings. One behaviour
// for both entry points; two ways to create a bot that worked differently was
// the actual problem, not the prompt on its own.
api.on('new-bot', async () => {
  try {
    const r = await api.invoke('create-new-bot');
    if (r && r.ok === false) showError('Could not create bot: ' + (r.error || 'unknown'));
  } catch (e) { showError('Could not create bot: ' + e.message); }
});

// Menu-bar "New Window" → open the next profile that isn't already running (the
// app is one-window-per-profile — same bot in two calls is #393). No prompt.
api.on('new-window', async () => {
  try {
    const r = await api.invoke('open-next-available-window');
    if (r && r.ok === false) {
      if (r.error === 'all-running') showError('Every bot is already open in a window.');
      else showError('Could not open window: ' + (r.error || 'unknown'));
    }
  } catch (e) { showError('Could not open window: ' + e.message); }
});

function renderProfileMenu(data) {
  if (!profileMenu) return;
  profileMenu.innerHTML = '';
  const profiles = (data && data.profiles) || [];
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No saved bots yet.';
    empty.style.cssText = 'padding:6px 8px;color:#9aa0a6';
    profileMenu.appendChild(empty);
  }
  for (const p of profiles) {
    // Friendly name, like the panel heading: the bot's own name, with the
    // on-disk profile dir only as a fallback (and in the row tooltip).
    const dirName = p.isDefault ? 'Default' : p.name;
    const displayName = p.botName || dirName;
    const row = document.createElement('div');
    row.title = `Profile folder: ${p.name}`;
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:' + (p.isCurrent ? 'default' : 'pointer');
    if (p.isCurrent) {
      // Picking the bot you're already on is a no-op — but it must still close
      // the menu. Leaving it inert meant a natural "never mind" gesture left the
      // dropdown stuck open.
      row.onclick = () => closeProfileMenu();
    } else {
      row.onmouseenter = () => { row.style.background = '#3c4043'; };
      row.onmouseleave = () => { row.style.background = ''; };
      // Default click SWITCHES this window to that profile (#379). ⌥-click opens
      // it in a SEPARATE new window instead (additive, advanced).
      row.onclick = (e) => (e.altKey ? doOpenProfileWindow(p.name) : doSwitchProfile(p.name));
    }
    // Left marker: ✓ for the current profile (so "Default" reads clearly as a
    // profile and the active one is obvious), else a running/not-running dot.
    const mark = document.createElement('span');
    mark.style.cssText = 'width:14px;flex:0 0 auto;text-align:center';
    if (p.isCurrent) {
      mark.textContent = '✓'; mark.style.color = '#8ab4f8'; mark.title = 'current bot (this window)';
    } else {
      mark.textContent = '●'; mark.style.color = p.running ? '#81c995' : '#5f6368';
      mark.title = p.running ? `running on port ${p.port}` : 'not running';
    }
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0';
    const top = document.createElement('div');
    top.textContent = displayName;
    top.style.cssText = 'font-weight:600;color:#e8eaed;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const sub = document.createElement('div');
    // Prefer the most identifying remembered fact: bound account email, then the
    // remembered Meet/Slack display name (#282). The Bot Name is the top line
    // now, so it's no longer a useful sub-line — fall back to the profile dir.
    sub.textContent = p.meetAccountEmail || p.lastMeetName || p.lastSlackName || dirName;
    sub.style.cssText = 'color:#9aa0a6;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.appendChild(top); label.appendChild(sub);
    // Avatar thumbnail: the small PNG each bot rasterises of its own avatar
    // (see refreshAvatarThumb), else a neutral monogram so every row aligns.
    const avatar = document.createElement('div');
    // Rounded SQUARE (not a circle) to match the main agent avatar and show more
    // of the background — the most customizable part of the icon (emojis all read
    // about the same). 6px ≈ the main avatar's 14px/54px proportion at 24px.
    avatar.style.cssText = 'width:24px;height:24px;flex:0 0 auto;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#3c4043;color:#9aa0a6;font-size:11px;font-weight:600';
    if (p.avatarThumb) {
      const img = document.createElement('img');
      img.src = p.avatarThumb;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover';
      avatar.appendChild(img);
    } else {
      avatar.textContent = (displayName || '?').trim().charAt(0).toUpperCase() || '?';
    }
    row.appendChild(mark); row.appendChild(avatar); row.appendChild(label);
    profileMenu.appendChild(row);
  }
  const add = document.createElement('div');
  add.textContent = '＋ New bot…';
  add.style.cssText = 'padding:6px 8px;margin-top:4px;border-top:1px solid #5f6368;color:#8ab4f8;cursor:pointer';
  // Hover, like every other row in this menu. It was the only item without it,
  // so the one entry that CREATES something was also the one that looked inert.
  add.onmouseenter = () => { add.style.background = '#3c4043'; };
  add.onmouseleave = () => { add.style.background = ''; };
  // No prompt. The name it used to ask for was the profile DIRECTORY, from when
  // that was also the bot's name — it isn't any more, so this asked people to
  // name the bot twice, the first time in a field that only takes [A-Za-z0-9._-].
  // Main picks the next free botN and opens it in its own window on Settings,
  // where naming it (or starting the guided setup call) is the obvious next step.
  add.onclick = async () => {
    closeProfileMenu();
    try {
      const r = await api.invoke('create-new-bot');
      if (r && r.ok === false) showError('Could not create bot: ' + (r.error || 'unknown'));
    } catch (e) { showError('Could not create bot: ' + e.message); }
  };
  profileMenu.appendChild(add);

  // #379: discoverability hint for the additive path.
  const hint = document.createElement('div');
  hint.textContent = '⌥-click a bot profile to open it in a new window instead';
  hint.style.cssText = 'padding:4px 8px 2px;color:#5f6368;font-size:10px';
  profileMenu.appendChild(hint);

  // Debugging help: reveal the bot-profiles folder so the user can delete/rename
  // profile dirs directly (#282).
  const folder = document.createElement('div');
  folder.innerHTML = uiIcon('folder', 'lead') + 'Open bot profiles folder';
  folder.style.cssText = 'padding:6px 8px;color:#9aa0a6;cursor:pointer';
  folder.onmouseenter = () => { folder.style.background = '#3c4043'; };
  folder.onmouseleave = () => { folder.style.background = ''; };
  folder.onclick = () => { closeProfileMenu(); api.invoke('open-profiles-folder').catch(() => {}); };
  profileMenu.appendChild(folder);

  // Reveal the session-log folder — quick path to past calls' logs (#292).
  const logs = document.createElement('div');
  logs.innerHTML = uiIcon('clipboard', 'lead') + 'Open call logs folder';
  logs.style.cssText = 'padding:6px 8px;color:#9aa0a6;cursor:pointer';
  logs.onmouseenter = () => { logs.style.background = '#3c4043'; };
  logs.onmouseleave = () => { logs.style.background = ''; };
  logs.onclick = () => { closeProfileMenu(); api.invoke('open-logs-folder').catch(() => {}); };
  profileMenu.appendChild(logs);
}

// Cache the profile-switcher data so the menu opens INSTANTLY on click. With
// ~12 profiles, list-profiles reads every profile's config + icon and probes
// each running port, which made the first (cold) open lag. Prefetch at app load,
// render from cache on click, and refresh in the background so running-status /
// freshly-captured icons stay current.
let cachedProfiles = null;
async function refreshProfilesCache() {
  if (IS_TROUBLESHOOTING_WINDOW) return; // list-profiles probes every port; once is enough
  try {
    cachedProfiles = await api.invoke('list-profiles');
    if (profileMenu && profileMenu.style.display === 'block') renderProfileMenu(cachedProfiles);
  } catch {
    if (!cachedProfiles && profileMenu && profileMenu.style.display === 'block') {
      profileMenu.innerHTML = '<div style="padding:6px 8px;color:#f28b82">Failed to load profiles</div>';
    }
  }
}

if (profileMenuBtn && profileMenu) {
  refreshProfilesCache(); // warm the cache at load so the first open is instant
  profileMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // The name doubles as the switcher, and the name stays on screen in-call —
    // so the CLICK is what gets gated now, not the control's visibility (#379:
    // no hot-swapping the bot mid-call).
    if (inCall) return;
    // Test the actually-open state (=== 'block'), NOT "!== 'none'": the menu
    // starts hidden via the CSS class, so the INLINE style.display is '' on the
    // first click — "!== 'none'" was true, so the first click closed-then-returned
    // (a no-op) and only the second click opened it.
    if (profileMenu.style.display === 'block') { closeProfileMenu(); return; }
    profileMenu.style.display = 'block';
    // While the menu is open the banner's top strip must stop being a window
    // drag handle: a drag region swallows mouse events before the DOM sees them,
    // so clicking the space beside the bot name — the usual "click outside to
    // dismiss" — did nothing at all.
    document.body.dataset.menuOpen = 'true';
    if (cachedProfiles) renderProfileMenu(cachedProfiles);           // instant from cache
    else profileMenu.innerHTML = '<div style="padding:6px 8px;color:#9aa0a6">Loading…</div>';
    refreshProfilesCache();                                          // refresh in the background (re-renders if still open)
  });
  document.addEventListener('click', (e) => {
    if (profileMenu.style.display === 'block' && !profileMenu.contains(e.target) && e.target !== profileMenuBtn) closeProfileMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && profileMenu.style.display === 'block') closeProfileMenu();
  });
}

// Per-category debug overlay (#overlay). Each checkbox id matches its store key,
// so a bare loop wires them all. All sections default off; opt in per profile.
api.invoke('get-overlay-flags').then((flags) => {
  for (const key of Object.keys(flags || {})) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.checked = !!flags[key];
    el.addEventListener('change', () => {
      api.invoke('set-overlay-flag', key, el.checked).catch(() => {});
    });
  }
}).catch(() => {});

// ---------------------------------------------------------------------------
// Load saved config
// ---------------------------------------------------------------------------

// #381: onboarding banner — the ElevenLabs key is machine-wide and now lives in
// App Settings, so surface a deep-link when voice is off instead of burying the
// field. The key can be set in the separate App Settings window, so re-check when
// this window regains focus.
const appSettingsBanner = document.getElementById('appSettingsBanner');

// Shown ONLY when the bot has no way to make sound at all.
//
// This used to key off `!ttsApiKey`, which is a different question and got the
// answer wrong for most people: a keyless bot on macOS or Windows speaks fine
// through the OS voice, and a Voicebox user has local TTS. Both were told
// "Voice is off" while their voice was on — and someone who deliberately picked
// a built-in voice with set_voice got nagged about a key their own choice had
// made irrelevant. Main owns the real answer (electron-app/voice-status.js);
// asking it over IPC keeps one copy of the rule rather than a second one here
// that drifts.
function updateAppSettingsBanner(status) {
  if (appSettingsBanner) appSettingsBanner.style.display = status?.canSpeak === false ? 'flex' : 'none';
}
function refreshVoiceBanner() {
  return api.invoke('get-voice-status').then(updateAppSettingsBanner).catch(() => {});
}
document.getElementById('openAppSettingsFromBanner')?.addEventListener('click', () => api.invoke('open-app-settings'));
// The key lives in the separate App Settings window, so re-check on focus.
window.addEventListener('focus', refreshVoiceBanner);

// #137: Claude Code installed but signed out. Strictly `=== false` — the state
// is tri-state and `null` means the check could not tell, which must stay
// silent. Warning someone who IS signed in is worse than not warning at all,
// because it teaches people that this banner is noise.
const claudeAuthBanner = document.getElementById('claudeAuthBanner');
function paintClaudeAuth(state) {
  if (claudeAuthBanner) claudeAuthBanner.style.display = state?.authed === false ? 'flex' : 'none';
}
// `refresh` asks main to re-check behind the answer it hands back, so the panel
// paints from cache immediately and corrects itself a moment later. Main
// throttles it, so alt-tabbing cannot spawn a login shell per focus event.
function refreshClaudeAuthBanner(refresh = false) {
  return api.invoke('get-claude-auth-status', { refresh }).then(paintClaudeAuth).catch(() => {});
}
// Pushed when main re-checks, and — the case that matters — the moment an agent
// connects, so finishing the sign-in clears this immediately rather than at the
// next poll.
api.on('claude-auth-changed', paintClaudeAuth);
window.addEventListener('focus', () => refreshClaudeAuthBanner(true));
refreshClaudeAuthBanner();

// Calendar auto-join (#299): "your next matching meeting" notice. Wide
// visibility window (up to 24h out, see calendar-auto-join.js's
// selectUpcomingMatches) — this is purely informational, distinct from the
// tight 5-minute window that actually arms the join timer in main.js.
const calendarUpcomingBanner = document.getElementById('calendarUpcomingBanner');
const calendarUpcomingText = document.getElementById('calendarUpcomingText');
function paintCalendarUpcoming(events, error) {
  if (!calendarUpcomingBanner || !calendarUpcomingText) return;
  // Poll error (main.js pushCalendarPollError): the backend can no longer
  // reach Google Calendar for this user — auto-join is silently dead until
  // they re-grant access, so say so instead of quietly showing no meetings
  // (vibeconferencing#512). Takes over the banner from the upcoming-meeting
  // notice: a meeting list the poll can't refresh is stale anyway.
  calendarUpcomingBanner.classList.toggle('notice-warn', !!error);
  calendarUpcomingBanner.classList.toggle('notice-info', !error);
  if (error) {
    calendarUpcomingText.textContent = '⚠️ Calendar connection broken: '
      + 'auto-join has stopped. Re-connect Google Calendar by signing in '
      + 'again at vibeconferencing.com.';
    calendarUpcomingBanner.style.display = 'flex';
    return;
  }
  const next = Array.isArray(events) && events.length ? events[0] : null;
  if (!next) {
    calendarUpcomingBanner.style.display = 'none';
    return;
  }
  const title = next.summary || 'Untitled event';
  const localTime = new Date(next.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // ownerConfirmed === false means the calendar owner hasn't accepted this
  // event yet, so the bot won't auto-join it (main.js's owner-RSVP gate):
  // the meeting line renders struck through (it's not happening as far as
  // the bot is concerned) with a short normal-weight warning after it.
  // Built with DOM nodes, not innerHTML — the title is calendar-sourced text.
  // Absolute time only, deliberately — NOT "in 12m". The countdown was computed
  // once at paint time and the panel only repaints when the calendar poll pushes
  // events, and that poll returns early while callStatus is 'in-call'. So the
  // moment the bot joined a call the countdown froze, and a stale relative time
  // is worse than none: it still reads as live. "4:30 PM" is right whenever it
  // is read. (Observed 2026-08-19: banner said "in 54m" for a meeting 10
  // minutes away, the difference being how long the call had been running.)
  const line = `${localTime} meeting: "${title}"`;
  calendarUpcomingText.textContent = '';
  const lineSpan = document.createElement('span');
  lineSpan.textContent = line;
  calendarUpcomingText.appendChild(lineSpan);
  if (next.ownerConfirmed === false) {
    lineSpan.style.textDecoration = 'line-through';
    calendarUpcomingText.appendChild(document.createTextNode(' ⚠️ (not yet accepted)'));
  }
  calendarUpcomingBanner.style.display = 'flex';
}
api.on('calendar-upcoming', ({ events, error }) => paintCalendarUpcoming(events, error));
// The IPC answer used to be a bare events array; it now carries poll health
// too ({ events, error }). Accept both so a panel reload against an older
// main (dev hot-swap) still paints.
api.invoke('get-upcoming-calendar-events').then((r) => {
  if (Array.isArray(r)) paintCalendarUpcoming(r, null);
  else paintCalendarUpcoming((r && r.events) || [], (r && r.error) || null);
}).catch(() => {});

// Load every config value this window displays, and paint the controls from it.
//
// EXTRACTED so it can run more than once. It used to be a bare call at startup,
// which meant the panel showed a boot-time snapshot forever: anything written
// afterwards — by the onboarding wizard, by set_preference from an agent, by
// another window — left the controls showing stale values. Someone naming their
// bot in the wizard saw "Unnamed bot" in Settings and reasonably concluded the
// save had failed, when it had worked (#190, #143).
function loadConfigIntoControls() {
  return api.invoke('get-config', ['botName', 'calendarIdentityEmail', 'websiteUrl', 'syncBaseUrl', 'ttsApiKey', 'ttsVoiceId', 'macosVoice', 'voiceboxProfileId', 'ttsProvider', 'claudeWorkDir', 'agentSession', 'claudeModel', 'emojiSet', 'captionLanguage', 'dangerousMode', 'ackShortMin', 'ackLongMin', 'ackShortPhrases', 'ackLongPhrases', 'lastMeetName', 'lastSlackName']).then((result) => {
  if (result?.botName) {
    botNameInput.value = result.botName;
    currentBotName = result.botName;
  } else {
    // No explicit name set — show what the rest of the app already falls back
    // to (resolvedBotName's storedName -> cliName -> profileName chain) as
    // the placeholder, instead of the generic "Unnamed bot". Field stays
    // genuinely empty; this is informative, not a silent pre-fill.
    api.invoke('get-resolved-bot-name').then((name) => {
      if (name && !botNameInput.value) botNameInput.placeholder = name;
    }).catch(() => { /* keep the generic placeholder */ });
  }
  calendarIdentityEmailInput.value = result?.calendarIdentityEmail || '';
  rememberedMeetName = result?.lastMeetName || null;   // #282 remembered names
  rememberedSlackName = result?.lastSlackName || null;
  refreshSlackIdentity();
  try { updateBotNameBig(); } catch { /* defined below; ignore on first paint */ }
  // The headline shows the RESOLVED name with a provenance tag for launched/named
  // test bots ("Alice [CLI name]") — the biggest cue when monitoring tests — while
  // currentBotName stays the plain name the button and curl examples need.
  api.invoke('get-bot-name-info').then((info) => {
    if (info?.name) currentBotName = info.name;
    botNameDisplay = info?.display || null;
    try { updateBotNameBig(); } catch { /* ignore */ }
  }).catch(() => { /* older main without the handler — headline stays as-is */ });
  // Prefer the new websiteUrl key; fall back to legacy syncBaseUrl so users with
  // older configs still see their existing override populated in the field.
  const effectiveUrl = result?.websiteUrl || result?.syncBaseUrl || '';
  if (effectiveUrl) { websiteUrlInput.value = effectiveUrl; syncBaseUrl = effectiveUrl; }
  // #366/#381: the ElevenLabs key field moved to App Settings — no input here to
  // fill. The onboarding banner still reflects whether a key is configured.
  refreshVoiceBanner(); // #381 — only when nothing can speak at all
  if (result?.ttsVoiceId) {
    ttsVoiceIdInput.value = result.ttsVoiceId;
    // A stored id must be VISIBLE on load, whether or not the voice list works.
    // populateUnifiedVoices re-evaluates this too, but it races the config read
    // and may have already run with an empty field.
    const f = document.getElementById('ttsVoiceIdField');
    if (f) f.style.display = '';
  }
  // #340: one unified picker merging macOS + ElevenLabs + Voicebox. Pre-selects
  // from the saved provider/voice; defaults to Daniel (tts.js's real default).
  populateUnifiedVoices(result);
  if (result?.claudeWorkDir) claudeWorkDirInput.value = result.claudeWorkDir;
  if (result?.agentSession) agentSessionIdInput.value = result.agentSession;
  // Before the first launch there is nothing stored yet, so show the name that
  // WOULD be used rather than a vague "(auto)" — same reason the field is
  // pinned on first use: the name is the thing you can type at `claude --resume`.
  if (agentSessionIdInput) agentSessionIdInput.placeholder = result?.botName || '(the bot’s name)';
  if (result?.claudeModel) claudeModelInput.value = result.claudeModel;
  if (emojiSetInput && result?.emojiSet) {
    // emojiSet has two OPEN forms — `font:<Family>` and `dir:<path>` — and
    // neither has a matching <option>. Assigning an unknown value to a <select>
    // leaves it BLANK with selectedIndex -1, so a face set from a call would
    // read as "no emoji set chosen". Synthesise an option for whichever form is
    // in effect. Deliberately generic: this was written for font: and a folder
    // set reintroduced the exact same blank dropdown a day later.
    const openLabel = (() => {
      const fam = fontFamilyFromSet(result.emojiSet);
      if (fam) return `Font: ${fam}`;
      const dir = dirFromSet(result.emojiSet);
      if (dir) return `Folder: ${dir.replace(/\/+$/, '').split('/').pop() || dir}`;
      return null;
    })();
    emojiSetInput.querySelector('option[data-open-option]')?.remove();
    if (openLabel) {
      const opt = document.createElement('option');
      opt.value = result.emojiSet;
      opt.textContent = openLabel;
      opt.title = result.emojiSet;      // the full path, on hover
      opt.setAttribute('data-open-option', '1');
      emojiSetInput.appendChild(opt);
    }
    emojiSetInput.value = result.emojiSet;
  }
  // '' is a real value here ("leave as Meet has it"), so don't treat it as absent.
  if (captionLanguageInput && result?.captionLanguage !== undefined) {
    captionLanguageInput.value = result.captionLanguage || '';
  }
  if (result?.dangerousMode) dangerousModeInput.checked = true;
  if (result?.ackShortMin != null) ackShortMinInput.value = result.ackShortMin;
  if (result?.ackLongMin != null) ackLongMinInput.value = result.ackLongMin;
  if (Array.isArray(result?.ackShortPhrases)) ackShortPhrasesInput.value = result.ackShortPhrases.join('\n');
  if (Array.isArray(result?.ackLongPhrases)) ackLongPhrasesInput.value = result.ackLongPhrases.join('\n');

  // Check auth status after config is loaded (so we know the server URL)
  checkAuthStatus();
}).catch(() => {});
}

loadConfigIntoControls();

// Re-read whenever something else writes config. main sends this from BOTH write
// paths — set-config (the wizard, this panel) and applyPref (an agent's
// set_preference) — so the controls track reality no matter who changed it.
//
// Re-reading everything rather than applying message.payload on purpose: a
// targeted update has to know which control shows which key, and that mapping
// silently rots as prefs are added. Re-reading cannot drift.
// The after-call write-up, made visible. See pollAgentWrapUp in main.js: the
// avatar keeps reacting through this window, so without a banner it reads as
// "still on the call" — which is exactly how the 2026-08-23 mute-bot confusion
// started. Says what it is doing AND that calling now will cut it short, since
// that is the decision the banner exists to inform.
const agentWrapUpBanner = document.getElementById('agentWrapUpBanner');
const agentWrapUpText = document.getElementById('agentWrapUpText');
function showAgentWrapUp(payload) {
  if (!agentWrapUpBanner || !agentWrapUpText) return;
  const who = payload?.botName || 'The bot';
  agentWrapUpText.textContent = `${who} is finishing up the last call — calling now will cut that short.`;
  agentWrapUpBanner.style.display = payload?.active ? 'flex' : 'none';
}
api.on('extension-message', (message) => {
  if (message?.action !== 'agent-wrapping-up') return;
  showAgentWrapUp(message.payload);
});
// Catch up on a wrap-up already in progress when this window opened.
api.invoke('get-agent-wrapping-up').then(showAgentWrapUp).catch(() => {});

api.on('extension-message', (message) => {
  if (message?.action !== 'config-updated') return;
  // The avatar repaints regardless of the focus guard below: it is a picture,
  // not a form control, so nothing can be typed into it. Without this the panel
  // showed the OLD face for up to 60s after an agent changed it mid-call (the
  // repaint is otherwise on a 60s timer) — the call and the app's own picture of
  // the bot disagreeing, which is the thing that made the font look broken.
  const changed = message.payload?.key;
  if (changed === 'emojiSet' || changed === 'avatarBackgroundSvg') renderAgentAvatar();
  // Don't repaint under someone's hands. A re-read rewrites every control,
  // including the ack-phrase textareas — so an echo triggered by changing the
  // emoji dropdown could wipe a half-typed phrase in a different field. The
  // panel re-reads on open and on focus anyway, so skipping here costs nothing.
  const el = document.activeElement;
  const editing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  if (editing) return;
  loadConfigIntoControls();
});

// Catch up on anything written while this window was in the background — the
// wizard and App Settings are separate windows, and an agent can write at any
// time. Pairs with the focus-time voice-banner refresh just above.
window.addEventListener('focus', () => { loadConfigIntoControls(); });

// #366/#381: the user (vibeconferencing.com) login moved OUT of the profile
// Settings pane — it's app-level, so it lives in App Settings (⌘,). It also
// stays on the MAIN view's user row (always shown), which this handler drives.
const userIdStatus = document.getElementById('userIdStatus');
const userSignInMainBtn = document.getElementById('userSignInMainBtn');
const userSignOutMainBtn = document.getElementById('userSignOutMainBtn');

function setUserRow(signedIn, who) {
  if (userIdStatus) {
    userIdStatus.textContent = signedIn ? who : '⚠ not signed in';
    // Signed in is the normal case — let it sit quiet in the footer's grey.
    // Only the actionable "not signed in" state earns a colour.
    userIdStatus.style.color = signedIn ? '' : '#fdd663';
  }
  if (userSignInMainBtn) userSignInMainBtn.style.display = signedIn ? 'none' : 'inline-block';
  if (userSignOutMainBtn) userSignOutMainBtn.style.display = signedIn ? 'inline-block' : 'none';
}

async function checkAuthStatus() {
  try {
    const data = await api.invoke('check-auth');
    if (data?.authenticated) {
      setUserRow(true, data.user?.email || data.user?.name || 'signed in');
    } else {
      setUserRow(false);
    }
  } catch {
    setUserRow(false);
  }
}

userSignInMainBtn?.addEventListener('click', async () => {
  userSignInMainBtn.disabled = true;
  userSignInMainBtn.textContent = 'Opening…';
  try { await api.invoke('login'); } catch { /* ignore */ }
  setTimeout(() => { userSignInMainBtn.disabled = false; userSignInMainBtn.textContent = 'Sign in'; checkAuthStatus(); }, 3000);
});
userSignOutMainBtn?.addEventListener('click', async () => {
  try { await api.invoke('logout'); } catch { /* ignore */ }
  checkAuthStatus();
});

// Listen for auth changes (e.g. after Google login popup closes)
api.on('auth-changed', () => {
  checkAuthStatus();
});

// ---------------------------------------------------------------------------
// Meet detection — pre-fill the URL field
// ---------------------------------------------------------------------------

api.on('meet-detected', (data) => {
  if (inCall) return;
  if (data && data.url) noteDetectedCall(data.url);
  else clearDetectedCall(); // main sends null when the Meet tab is gone
});

// A Slack huddle detected in the browser (about:blank window + an app.slack.com
// workspace tab). Fill the URL so the user can Join it — joining switches to the
// Slack provider at runtime (no --provider flag).
api.on('slack-huddle-detected', (data) => {
  if (inCall) return;
  if (data && data.url) noteDetectedCall(data.url);
  else clearDetectedCall(); // huddle ended / workspace tab closed
});

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------

function showError(message) {
  document.getElementById('errorText').textContent = message;
  errorBar.style.display = 'flex';
}

document.getElementById('errorClose').addEventListener('click', () => {
  errorBar.style.display = 'none';
});

// ---------------------------------------------------------------------------
// Join / Leave Meet
// ---------------------------------------------------------------------------

function enterCallState(meetCode) {
  inCall = true;
  joinPhase = null; // we're in; the in-call row owns this space now
  // #379: mark the panel in-call so CSS can hide pre-call-only controls (the
  // profile switcher). A single body flag keeps room for the broader pre-call vs
  // in-call UI split (#289). Also close the switcher if it happened to be open.
  document.body.dataset.callState = 'in-call';
  closeProfileMenu();
  reportContentHeight(); // the in-call card just appeared — the window must grow
  joinBtn.style.display = 'none';
  // "Run setup call" starts a BRAND-NEW call — nonsensical mid-call, same as
  // "Call now" itself. Lives in Settings, so it isn't covered by the
  // .hero-precall/.hero-incall CSS swap and needs its own toggle.
  if (setupCallBtn) setupCallBtn.style.display = 'none';

  // Show which call the bot is actually in (read-only) — for confirming the
  // right room and copying the invite link. Prefer the joined URL; fall back
  // to reconstructing a Meet URL from the code.
  if (callUrlDisplay) {
    const joined = (meetUrlInput && meetUrlInput.value.trim()) || '';
    callUrlDisplay.textContent = joined || (meetCode ? `https://meet.google.com/${meetCode}` : '');
  }

  // Update troubleshooting section
  meetCodeInput.value = meetCode;
  roomIdField.style.display = 'block';
  const base = syncBaseUrl || 'https://vibeconferencing.com';
  roomLink.href = `${base}/room/${meetCode}`;
  roomLink.style.display = 'block';
  updateCurlCommand(meetCode);
}

function exitCallState() {
  inCall = false;
  callProvider = null;
  document.body.dataset.callState = 'idle'; // #379: pre-call controls return
  reportContentHeight(); // the in-call card just went away — shrink back
  joinBtn.style.display = '';
  if (setupCallBtn) setupCallBtn.style.display = '';
  // Clears "Joining…" too: leaving covers the case where a join was still in
  // flight (denied admission, host never let the bot in) and would otherwise
  // strand the button disabled.
  setJoinPhase(null); // restores the right label for the current mode

  roomIdField.style.display = 'none';
  roomLink.style.display = 'none';
}

// Messages for every way POST /api/meet/create can fail. The signed-out case is
// a real state, not an edge: this is the first feature that hard-requires a
// vibeconferencing.com login, so it has to say what to do about it.
const CREATE_MEET_ERRORS = {
  'signed-out': 'Sign in at vibeconferencing.com to start a call — the footer below has your login.',
  'rate-limited': 'Too many calls started just now. Try again in a few minutes.',
  'upstream': "Google couldn't create the room. Try again.",
  'bad-request': 'The app sent a malformed request — this is a bug, please report it.',
  'offline': "Couldn't reach vibeconferencing.com. Check your connection.",
  'unknown': "Couldn't start a call.",
};

joinBtn.addEventListener('click', async (e) => {
  // Option-held is the alternate action: open the bot's session in a terminal
  // instead of calling it. Read the event rather than `optionHeld` so a click
  // that arrives with the key down is honoured even if the label has not caught
  // up yet.
  if (e.altKey) {
    await openChatSession();
    return;
  }
  // "Call <bot> now" — ask the website for a fresh Meet anyone can walk into,
  // then send the bot in. Main does the request: a renderer fetch carries an
  // Origin the backend rejects.
  if (!isAddToCallMode()) {
    setJoinPhase('starting'); // asking the website for a room, not joining yet
    try {
      const r = await api.invoke('create-and-join-meet');
      if (r?.ok) {
        // Main has already pointed the bot's view at the room. Put the link in
        // the field so the in-call view can show and copy it for the human.
        if (r.url) { meetUrlInput.value = r.url; detectedCallUrl = r.url; lastKnownCallUrl = r.url; }
        setJoinPhase('joining');
        // enterCallState waits for 'call-status-changed', same as a manual join.
        return;
      }
      showError(CREATE_MEET_ERRORS[r?.code] || CREATE_MEET_ERRORS.unknown);
    } catch (err) {
      showError('Could not start a call: ' + err.message);
    }
    setJoinPhase(null); // restores the right label + enabled state for the mode
    return;
  }

  let url = meetUrlInput.value.trim();
  if (!url) return;
  if (isValidSlackUrl(url)) {
    // Runtime provider switch: build the Slack surface + auto-join the huddle.
    api.send('join-detected-slack', { url });
  } else {
    url = toMeetUrl(url);
    api.joinMeet(url);
  }
  setJoinPhase('joining');

  // Don't eagerly call enterCallState here — wait for the 'call-status-changed'
  // IPC to fire with 'in-call'. Otherwise the Leave Call button appears
  // before we know whether admission succeeded.

  setTimeout(() => {
    if (!inCall) {
      joinBtn.style.display = '';
      setJoinPhase(null); // give the button back if we never made it in
    }
  }, 3000);
});

setupCallBtn?.addEventListener('click', async () => {
  // Triggered from Settings, not the main screen, so switch back first — that's
  // where the "joining…" state and the in-call UI actually render.
  showScreen(mainScreen);

  // If a call is already going, SET UP IN IT rather than creating a second one.
  //
  // The main button has always worked this way ("Add <bot> to call" when a call
  // is detected); this one did not, so pressing Setup while sitting in a call
  // opened a brand-new Meet and left the user in the wrong room — with the
  // person they were talking to still in the old one.
  //
  // Only a DETECTED call counts, not manualUrlEntry: that flag means the user
  // opened the URL field themselves, which is a request to type one, not
  // evidence a call exists.
  const existing = detectedCallUrl;
  if (existing && isJoinableUrl(existing)) {
    setJoinPhase('joining');
    api.send('join-meet', existing, { onboardingCall: true });
    return;
  }

  setJoinPhase('starting');
  try {
    const r = await api.invoke('create-and-join-meet', { onboardingCall: true });
    if (r?.ok) {
      if (r.url) { meetUrlInput.value = r.url; detectedCallUrl = r.url; lastKnownCallUrl = r.url; }
      setJoinPhase('joining');
      return;
    }
    showError(CREATE_MEET_ERRORS[r?.code] || CREATE_MEET_ERRORS.unknown);
  } catch (err) {
    showError('Could not start a setup call: ' + err.message);
  }
  setJoinPhase(null);
});

meetUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
  if (e.key === 'Escape') { e.preventDefault(); dismissCallUrl(); }
});

document.getElementById('leaveCallBtn').addEventListener('click', () => {
  // Don't flip to "Add Jimmy to call" here — that's optimistic and can leave
  // the button saying "left" while the bot is still visibly in the Meet.
  // 'leave-call-requested' runs the same clean-leave sequence as the agent's
  // leave_call tool (clicks Meet's own Leave button first, then tears down);
  // the 'call-status-changed' broadcast is what actually calls exitCallState()
  // once the bot has genuinely left.
  api.send('leave-call-requested');
});

// ---------------------------------------------------------------------------
// Share Whiteboard
// ---------------------------------------------------------------------------

shareWhiteboardBtn.addEventListener('click', async () => {
  const meetCode = meetCodeInput.value;
  if (!meetCode) { showError('Join a call first'); return; }

  shareWhiteboardBtn.textContent = 'Starting share...';
  shareWhiteboardBtn.disabled = true;

  try {
    const result = await api.invoke('share-whiteboard', { meetCode });
    if (result?.error) showError(result.error);
  } catch (err) {
    showError('Failed to share: ' + err.message);
  }

  setTimeout(() => {
    shareWhiteboardBtn.textContent = 'Share Whiteboard';
  }, 3000);
});

// ---------------------------------------------------------------------------
// Share window visibility
//
// The board window is hidden by default — for most people it's a capture
// surface, not something to look at, and it shares fine hidden. This toggle is
// for when you want to drive it by hand (or just see what the room sees). It
// only appears while a board window exists, since there's nothing to toggle
// otherwise.
// ---------------------------------------------------------------------------

const shareWindowToggleBtn = document.getElementById('shareWindowToggleBtn');

function applyShareWindowState({ exists, visible, lockedVisible } = {}) {
  if (!shareWindowToggleBtn) return;
  // Its own line above the call URL, in the in-call block. Only present while a
  // board window exists — there is nothing to toggle otherwise, and an always-on
  // button would imply a share that isn't running. That conditionality is why it
  // gets a line rather than a fourth pill in the button row: it costs nothing
  // when absent, and keeps its text label, which a bare icon couldn't carry.
  shareWindowToggleBtn.style.display = exists ? '' : 'none';
  // Only the WORD changes — the 🖥 icon is a static element in the markup, so
  // rewriting the button's whole text content would delete it.
  const shareLabel = shareWindowToggleBtn.querySelector('.share-window-label');
  if (shareLabel) shareLabel.textContent = visible ? 'Hide share' : 'Show share';
  // While a live share is capturing the WINDOW, hiding it would black out what
  // the room sees — say so on the button rather than failing on click.
  shareWindowToggleBtn.disabled = !!lockedVisible;
  shareWindowToggleBtn.title = lockedVisible
    ? 'Can\'t hide it while the share is capturing this window — stop sharing first.'
    : '';
}

shareWindowToggleBtn?.addEventListener('click', async () => {
  shareWindowToggleBtn.disabled = true;
  try {
    const r = await api.invoke('toggle-share-window');
    if (r?.error) showError(r.error);
  } catch (err) {
    showError('Failed to toggle the share window: ' + err.message);
  }
  try { applyShareWindowState(await api.invoke('get-share-window')); } catch { /* ignore */ }
});

api.on('share-window-state', (state) => applyShareWindowState(state));
api.invoke('get-share-window').then(applyShareWindowState).catch(() => {});

// ---------------------------------------------------------------------------
// Bot Google identity — guest vs account mode (#170)
// ---------------------------------------------------------------------------

// #299: when the bot is actually signed in to Google, that account's own
// address IS its calendar identity — there's no such thing as a bot that's
// both signed in AND wants a different placeholder email, so the field is
// forced to match and locked rather than merely pre-filled. Guest-mode bots
// (or a signed-in bot whose email isn't known yet, see the fallback above)
// keep the field free-text, same as before #299 added this.
const calendarIdentityEmailCaption = document.getElementById('calendarIdentityEmailCaption');
function lockCalendarIdentityToAccount(email) {
  if (!calendarIdentityEmailInput) return;
  if (calendarIdentityEmailInput.value !== email) {
    calendarIdentityEmailInput.value = email;
    api.invoke('set-config', 'calendarIdentityEmail', email);
  }
  calendarIdentityEmailInput.readOnly = true;
  calendarIdentityEmailInput.title = 'Locked to the bot\'s signed-in Google account. Sign out to set a custom calendar invite email.';
  if (calendarIdentityEmailCaption) {
    calendarIdentityEmailCaption.textContent = `Locked to this bot's signed-in Google account (${email}) — that's already a valid calendar invite address. Sign out above to use a custom one instead.`;
  }
}
function unlockCalendarIdentity() {
  if (!calendarIdentityEmailInput) return;
  calendarIdentityEmailInput.readOnly = false;
  calendarIdentityEmailInput.title = '';
  if (calendarIdentityEmailCaption) {
    calendarIdentityEmailCaption.innerHTML = 'Add this address as a guest on a Google Calendar event to have this bot join it automatically. It doesn\'t need to be a real, working email. You can also put <code>#vibeconf:&lt;this bot\'s name&gt;</code> in the event\'s title or description instead. Filled in automatically from "Sign in to Google as bot" above, if used.';
  }
}

const meetAccountEmail = document.getElementById('meetAccountEmail');
// Show WHICH Google account the bot is actually signed in as — surfaces the gap
// that hid #250 (mode said "account" while the bot was silently logged out).
function refreshAccountEmail(mode) {
  if (!meetAccountEmail) return;
  if (mode !== 'account') { meetAccountEmail.style.display = 'none'; unlockCalendarIdentity(); return; }
  meetAccountEmail.style.display = '';
  meetAccountEmail.textContent = 'Checking signed-in account…';
  meetAccountEmail.className = 'account-email';
  api.invoke('get-meet-account-email').then((r) => {
    if (r && r.signedIn && r.email) {
      meetAccountEmail.textContent = '✓ Signed in as ' + r.email;
      meetAccountEmail.className = 'account-email email-ok';
      lockCalendarIdentityToAccount(r.email);
    } else if (r && r.signedIn) {
      // Auth cookies present but we couldn't read the email — signed in for sure.
      meetAccountEmail.textContent = '✓ Signed in to Google (could not read which account)';
      meetAccountEmail.className = 'account-email email-ok';
      unlockCalendarIdentity();
    } else {
      meetAccountEmail.textContent = '⚠ Mode is "account" but no Google session detected. The bot may not be signed in. If joins require admission, click "Sign in to Google as bot".';
      meetAccountEmail.className = 'account-email email-bad';
      unlockCalendarIdentity();
    }
  }).catch(() => {
    meetAccountEmail.textContent = '(could not read signed-in account)';
    meetAccountEmail.className = 'account-email';
    unlockCalendarIdentity();
  });
}

let lastMeetMode = 'guest';
function applyMeetMode(mode) {
  lastMeetMode = mode;
  if (meetSignInBtn) meetSignInBtn.style.display = (mode === 'account') ? 'none' : '';
  if (meetSignOutBtn) meetSignOutBtn.style.display = (mode === 'account') ? '' : 'none';
  // The Name field stays visible in BOTH modes now. It used to be hidden in
  // account mode (a signed-in bot uses its Google name), but it's still the
  // bot's name everywhere else in the app — hiding it made the settings screen
  // look broken for signed-in bots.
  refreshAccountEmail(mode);
  refreshBotIdentity(mode); // keep the main-view identity row in sync
  updateBotNameBig();
}

// Big glanceable heading = the bot's FRIENDLY name (its Bot Name preference),
// the way Chrome shows a profile's display name and keeps the directory name on
// disk only. So the profile that lives in profiles/Default renders as "Jimmy"
// until the user renames it; the on-disk profile name survives in the tooltip.
// It does NOT swap to the account name — the live in-call name lives in the
// name is not restated anywhere, so the heading never lies.
const botNameBig = document.getElementById('botNameBig');
let botAccountName = null;   // the bot's Google display name when signed in
let callProvider = null;     // 'meet' | 'slack' while in a call, else null
let rememberedMeetName = null;  // last Meet display name for this profile (#282)
let rememberedSlackName = null; // last Slack display name for this profile (#282)
function updateBotNameBig() {
  if (!botNameBig) return;
  // Friendly name first (the Bot Name preference); fall back to the on-disk
  // profile name only if there isn't one, so the heading is never empty.
  botNameBig.textContent = botNameDisplay || currentBotName || appProfileName || 'Default';
  // The pre-call button says the bot's name too ("Call Jimmy now"), so it has
  // to follow a rename. One choke point keeps the two from drifting.
  updateJoinBtnState();
  // Same for the guided-setup button ("Call Jimmy for setup"). It lives on the
  // Settings screen, which is exactly where a rename happens — so without this
  // it would still be offering to call the old name on the very page you just
  // renamed the bot on.
  updateSetupCallBtnLabel();
  // And the Settings screen's own heading ("Jimmy Settings") — same page,
  // same reasoning: a rename should not leave the title above it stale.
  updateSettingsHeading();
}

// "Jimmy Settings" — same shape and fallback as updateSetupCallBtnLabel, so a
// bot with no name yet reads the same way in both places.
function updateSettingsHeading() {
  const el = document.getElementById('settingsHeading');
  if (el) el.textContent = `${currentBotName || 'your bot'} Settings`;
}

// "Call Jimmy for setup" — deliberately the same shape as the main button's
// "Call Jimmy now": verb first, then the bot. It IS a call, and it was reading
// as a settings action because it looked like one.
function updateSetupCallBtnLabel() {
  const btn = document.getElementById('setupCallBtn');
  if (!btn) return;
  btn.textContent = `Call ${currentBotName || 'your bot'} for setup`;
}

// (The "● in Meet as Jimmy" sub-line lived here. Removed — the bot's name is
// already the banner's headline, so restating it during a call was noise.
// callProvider / botAccountName / rememberedMeetName are still tracked: the bot
// switcher's per-profile sub-line uses them.)

// --- Bot Meet identity. The main view no longer renders a Meet status row (the
// sign-in lives in this bot's Settings), but we still resolve the bot's Google
// account name here: it feeds the in-call "appearing as" line and the remembered
// Meet name used by the bot switcher. ---
const botSignOutMainBtn = document.getElementById('botSignOutMainBtn');

async function refreshBotIdentity(mode) {
  const m = mode || lastMeetMode;
  if (m !== 'account') {
    if (botSignOutMainBtn) botSignOutMainBtn.style.display = 'none';
    botAccountName = null; // guest → in-call name uses the Bot Name preference
    updateBotNameBig();
    return;
  }
  if (botSignOutMainBtn) botSignOutMainBtn.style.display = 'inline-block';
  try {
    const r = await api.invoke('get-meet-account-email');
    // In-call name: prefer the Google display name, fall back to the email's
    // local part. Feeds the bot switcher's per-profile sub-line.
    botAccountName = r?.name || (r?.email ? r.email.split('@')[0] : null);
    if (r?.name) rememberedMeetName = r.name; // persist for the switcher sub-line (#282)
    updateBotNameBig();
  } catch { /* scrape failed — keep the remembered name and retry on the next poll */ }
}

// --- Bot Slack identity. Like the Meet identity above, the main view no longer
// renders a Slack status row — sign-in/out live in this bot's Settings. This
// keeps the Settings sign-out button honest against the live cookie. ---
async function refreshSlackIdentity() {
  // Cookie-authoritative connected check (get-slack-mode → the `d` session
  // cookie). We can't read WHICH workspace/user without the huddle DOM (#283).
  let signedIn = false;
  try { signedIn = !!(await api.invoke('get-slack-mode'))?.signedIn; } catch { /* treat as unknown */ }
  // Sign-out only makes sense while signed in — hidden otherwise.
  if (slackSignOutBtn) slackSignOutBtn.style.display = signedIn ? '' : 'none';
}
refreshSlackIdentity();

botSignOutMainBtn?.addEventListener('click', async () => {
  botSignOutMainBtn.disabled = true;
  try { await api.invoke('meet-sign-out-bot'); applyMeetMode('guest'); } catch { /* ignore */ }
  setTimeout(() => { botSignOutMainBtn.disabled = false; }, 1500);
});

// Keep the Bot Meet identity honest. AUTHORITATIVE: re-derive mode from the live
// cookies (get-meet-mode → isSignedInToGoogle) rather than trusting the
// optimistic event-driven flag, so the pane self-corrects once a Google sign-in
// completes regardless of event ordering. While still resolving the account
// email, retry the scrape.
//
// SKIPPED WHILE IN A CALL: identity is settled then, and refreshBotIdentity runs
// get-meet-account-email — a DOM scrape on the live meet page — which spams the
// meet console every 7s and is noise while debugging a call (Stan).
setInterval(() => {
  if (IS_TROUBLESHOOTING_WINDOW) return; // the panel already runs this poll
  if (inCall) return;
  api.invoke('get-meet-mode').then((info) => {
    if (!info?.mode) return;
    if (info.mode !== lastMeetMode) {
      applyMeetMode(info.mode);            // mode changed (e.g. login just finished) → full refresh
    } else if (info.mode === 'account' && !botAccountName) {
      refreshBotIdentity('account');        // signed in but email not resolved yet → retry the scrape
    }
    // else: stable (guest, or account with email already shown) → just the cheap cookie read above
  }).catch(() => {});
  // Keep the Slack row honest too — same cheap cookie read (get-slack-mode).
  refreshSlackIdentity();
}, 7000);

// (The "⚡ Fast model" health line + its 7s reachability poll lived here. The
// panel no longer surfaces it — the on-device model still backs triage /
// engagement in main.js, it just isn't something the user acts on.)

// Initial state on panel load.
api.invoke('get-meet-mode').then((info) => {
  if (info?.mode) applyMeetMode(info.mode);
}).catch(() => {});

// Stay in sync when sign-in/out changes identity. The event no longer carries
// the mode (single partition now — #282); re-query the authoritative state.
api.on('meet-mode-changed', () => {
  api.invoke('get-meet-mode').then((info) => { if (info?.mode) applyMeetMode(info.mode); }).catch(() => {});
});

// Advanced: "Navigate Webview…" (⌘⇧L) → prompt for a URL and drive the bot's
// embedded view there, so the operator can set up Slack/Google account state in
// the bot's own partition (#282).
api.on('navigate-webview-prompt', async (data) => {
  // Pre-fill the CURRENT webview URL (passed from main) so you can see where the
  // view actually landed — handy for debugging redirects/blank pages — and edit
  // from there. Falls back to https:// when there's no current URL.
  const current = (data && data.currentUrl) || '';
  const url = await inlinePrompt({
    title: 'Navigate the bot webview to URL (advanced — Slack/Google account setup):',
    initial: current || 'https://', okLabel: 'Go',
  });
  if (!url) return;
  api.invoke('navigate-webview', url).then((r) => {
    if (r && r.ok === false) showError('Could not navigate: ' + (r.error || 'unknown'));
  }).catch(() => {});
});

// --- Live caption feed: the "bot's-eye view" of exactly what captions the bot
// is receiving, mirroring the [caption-raw]/[heard] logs. Each tick main sends
// the full current turn snapshot; render the recent history with the still-
// growing (bottommost) turn marked LIVE, so you can compare it in real time
// against the bot's Meet view. ---
function renderCaptionFeed(turns) {
  if (!rawCaptionText || !Array.isArray(turns)) return;
  const recent = turns.slice(-12);
  rawCaptionText.innerHTML = recent.map((t) => {
    const live = t.isBottommost;
    const speaker = (t.speaker || '?').replace(/[<>&]/g, '');
    const text = (t.text || '').replace(/[<>&]/g, '');
    return `<div class="cap-line${live ? ' cap-live' : ''}">`
      + `<span class="cap-tag">${live ? 'LIVE' : 'settled'}</span> `
      + `<span class="cap-speaker">${speaker}:</span> ${text}</div>`;
  }).join('') || '<span class="helper-text">No captions yet.</span>';
  rawCaptionText.scrollTop = rawCaptionText.scrollHeight;
}
api.on('caption-feed', ({ turns }) => renderCaptionFeed(turns));

// Captions on/off (deaf signal) — a badge so a deaf bot is obvious at a glance.
function renderCaptionState(on) {
  const el = document.getElementById('captionStateBadge');
  if (!el) return;
  el.textContent = on ? '● captions ON' : '○ captions OFF — bot is DEAF';
  el.className = 'caption-badge ' + (on ? 'cap-on' : 'cap-off');
}
api.on('caption-state', ({ on }) => renderCaptionState(on));

// --- Pop the panel out into its own window (place it next to the bot's Meet). ---
const popoutPanelBtn = document.getElementById('popoutPanelBtn');
function applyPopoutLabel(poppedOut) {
  if (!popoutPanelBtn) return;
  popoutPanelBtn.textContent = poppedOut ? '⧉ Dock' : '⧉ Pop out';
}
if (popoutPanelBtn) {
  popoutPanelBtn.addEventListener('click', async () => {
    try {
      const res = await api.invoke('toggle-panel-popout');
      applyPopoutLabel(!!res?.poppedOut);
    } catch { /* ignore */ }
  });
  api.invoke('get-panel-popout').then((r) => applyPopoutLabel(!!r?.poppedOut)).catch(() => {});
}
// Main tells us when the state changes (incl. user closing the popout window).
api.on('panel-popout-changed', ({ poppedOut }) => applyPopoutLabel(!!poppedOut));

// Bot-view toggle (👀): the Meet view hidden/docked ↔ its own large window.
// Sits left of the main button in BOTH states — "Call now" and "Leave Call".
// With the view hidden by default this is the only way to see what the bot is
// doing, and that matters BEFORE a call too: ⌘⇧L navigates first, so it cannot
// show you the current state. Its TITLE flips so the control always names what
// a click will DO.
//
// Two elements, not one: the pre-call and in-call rows are separate blocks the
// stylesheet swaps, so a single button cannot be in both. They are driven as a
// set here, which keeps one handler and one label rule for both.
const botViewToggleBtns = [...document.querySelectorAll('.botview-toggle-btn')];
function applyBotViewLabel(state, resting) {
  if (!botViewToggleBtns.length) return;
  const popped = state === 'popped';
  // #103: the resting state is 'hidden' by default now, so "Dock" would be a
  // lie — clicking puts the view away entirely rather than docking it as a
  // thumbnail. Name what the click actually does.
  const hides = resting !== 'thumbnail';
  // 👀 to open the view, ✕ to put it away again. A one-GLYPH swap, not the old
  // "⧉ Pop out"/"⧉ Hide" relabel: same width either way, so the row doesn't
  // resize and shift on every state flip. The title still names what a click
  // will DO, which is the part that has to stay honest.
  const title = popped
    ? (hides
        ? "Put the bot's view away. It keeps running at full size so the bot can still read shared screens — you just stop seeing it."
        : "Dock the bot's view back as a thumbnail below this panel")
    : "Pop the bot's view out into its own large window — this is where you sign the bot into Google, Slack or GitHub (\u2318L)";
  for (const btn of botViewToggleBtns) {
    // Both states are now the same 20px icon box, so the swap can't change the
    // button's size — which is what the one-glyph swap was reaching for in the
    // first place. (The old ✕ character needed .is-close to bump its font-size
    // back up to the emoji's; drawn art needs no such correction.)
    btn.innerHTML = popped ? uiIcon('close') : uiIcon('eyes');
    btn.classList.toggle('is-close', popped);
    btn.title = title;
  }
}
// Main's "is there a call" signal. It spans joining/waiting-to-be-admitted,
// which the panel's own data-call-state deliberately doesn't — which is why the
// face state below reads from THIS rather than from `inCall`.
//
// (This used to also drive body[data-botview], which showed the bot's-view bar
// and reserved 44px for it. Both are gone with the bar.)
function applyBotViewVisible(visible) {
  // This flag is main's callStatusMeansInCall — true from 'joining' right
  // through 'in-call', false on idle/left. It's the authority on whether the
  // panel should be mirroring the bot's live face, and it's deliberately WIDER
  // than the panel's own `inCall` (which only flips once actually admitted), so
  // the 🫥 "not on the line yet" face shows while joining.
  callActive = !!visible;
  if (!callActive) clearLiveFace();
  // The in-call controls differ in height from the pre-call ones, so re-measure.
  reportContentHeight();
}
applyBotViewVisible(false); // no call yet on load

if (botViewToggleBtns.length) {
  for (const btn of botViewToggleBtns) {
    btn.addEventListener('click', async () => {
      try {
        const res = await api.invoke('toggle-bot-view');
        applyBotViewLabel(res?.state, res?.resting);
      } catch { /* ignore */ }
    });
  }
  api.invoke('get-bot-view').then((r) => {
    applyBotViewLabel(r?.state, r?.resting);
    applyBotViewVisible(!!r?.visible);
  }).catch(() => {});
}
// Main tells us when it changes (incl. the user closing the popped-out window).
api.on('bot-view-changed', ({ state, resting }) => applyBotViewLabel(state, resting));
api.on('bot-view-visible', ({ visible }) => applyBotViewVisible(!!visible));

meetSignInBtn?.addEventListener('click', async () => {
  meetSignInBtn.disabled = true;
  meetSignInBtn.textContent = 'Switching to Google sign-in...';
  try {
    await api.invoke('meet-sign-in-as-bot');
  } catch (err) {
    showError('Sign-in swap failed: ' + err.message);
  }
  setTimeout(() => {
    meetSignInBtn.disabled = false;
    meetSignInBtn.textContent = 'Sign in to Google as bot';
  }, 1500);
});

meetSignOutBtn?.addEventListener('click', async () => {
  meetSignOutBtn.disabled = true;
  meetSignOutBtn.textContent = 'Clearing account session...';
  try {
    await api.invoke('meet-sign-out-bot');
  } catch (err) {
    showError('Sign-out failed: ' + err.message);
  }
  setTimeout(() => {
    meetSignOutBtn.disabled = false;
    meetSignOutBtn.textContent = 'Sign out (use as guest)';
  }, 1500);
});

// Slack identity (#285): open Slack in the bot's view to log in / out. The
// sign-out button only shows while signed in (refreshSlackIdentity's cookie
// check toggles it — same behavior as the Meet identity section).
slackSignInBtn?.addEventListener('click', async () => {
  slackSignInBtn.disabled = true;
  slackSignInBtn.textContent = 'Opening Slack…';
  try {
    await api.invoke('slack-sign-in');
  } catch (err) {
    showError('Slack sign-in failed: ' + err.message);
  }
  setTimeout(() => {
    slackSignInBtn.disabled = false;
    slackSignInBtn.textContent = 'Sign into Slack as bot';
    refreshSlackIdentity();
  }, 1500);
});

slackSignOutBtn?.addEventListener('click', async () => {
  slackSignOutBtn.disabled = true;
  slackSignOutBtn.textContent = 'Signing out of Slack…';
  try {
    await api.invoke('slack-sign-out');
  } catch (err) {
    showError('Slack sign-out failed: ' + err.message);
  }
  setTimeout(() => {
    slackSignOutBtn.disabled = false;
    slackSignOutBtn.textContent = 'Sign out of Slack';
    refreshSlackIdentity();
  }, 1500);
});

// ---------------------------------------------------------------------------
// Agent prompt
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Curl command
// ---------------------------------------------------------------------------

// Paint the copyable curl command, or say why there isn't one.
//
// This used to be driven only by the panel's `meet-detected` / call-status
// events — which the pop-out troubleshooting window never receives, because it
// is a second webContents and those broadcasts go to panelView. So in the
// window where it actually lives, the button was disabled permanently, in a
// call or out of one, with nothing on screen saying why.
//
// It is now driven by the same 1s poll that renders the call state, so both
// windows agree, and the empty state explains itself instead of presenting a
// dead control.
function updateCurlCommand(meetCode) {
  if (!meetCode) {
    curlCommand.textContent = 'Available once the bot is in a call — the command needs the room id.';
    copyCurlBtn.disabled = true;
    return;
  }
  const base = syncBaseUrl || 'https://vibeconferencing.com';
  curlCommand.textContent = `curl -X POST "${base}/api/sync/${meetCode}" -H "Content-Type: application/json" -d '{"sender":"${currentBotName}","role":"bot","ownerName":"${currentBotName}","transcript":[{"text":"Hello from curl test."}]}'`;
  copyCurlBtn.disabled = false;
}

copyCurlBtn.addEventListener('click', () => {
  api.copyToClipboard(curlCommand.textContent);
  copyCurlBtn.textContent = 'Copied!';
  setTimeout(() => { copyCurlBtn.textContent = 'Copy Curl Command'; }, 2000);
});

// ---------------------------------------------------------------------------
// DevTools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Call feedback (#…): one click leaves a mark in the session log.
//
// Clicked mid-call, so the interaction budget is about a second: no dialog, no
// confirmation step, no typing. The value is the TIMESTAMP — it puts a marker
// next to whatever the bot was doing at that moment, which is what turns "it
// kept interrupting" from a memory into something diagnosable.
//
// Fire-and-forget on purpose: a failed log write must never interrupt a call,
// so the button flashes regardless and the failure lands in the console.
document.querySelectorAll('[data-feedback]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.feedback;
    const noteEl = document.getElementById('feedbackNote');
    const note = (noteEl?.value || '').trim();
    // Echo the note back rather than just saying "with your note". The field
    // keeps its text after submit, so without seeing the words quoted there is
    // no way to tell a sent note from one still sitting there unsent — which is
    // the exact doubt that makes someone click again.
    const shown = note.length > 48 ? `${note.slice(0, 48).trimEnd()}…` : note;
    const withNote = (tail) => (note ? `Marked "${label}" · “${shown}”${tail}` : `Marked "${label}"${tail}`);
    // Read the label element rather than stripping emoji out of textContent.
    // The emoji reads well on the button and is noise in a grep — `kind=` is the
    // machine-readable key, and the label is there so a human scanning the log
    // knows what was clicked without a lookup table.
    const label = (btn.querySelector('.fb-label') || btn).textContent.trim();
    api.invoke('call-feedback', { kind, label, note }).then((r) => {
      // Say whether it reached the BOT, not just the log. Four of the seven
      // kinds have nothing the agent can act on, and repeats inside the cooldown
      // are deliberately log-only — without this the human can't tell the
      // difference between "noted" and "the bot is adjusting", and would
      // reasonably keep clicking.
      const status = document.getElementById('feedbackStatus');
      if (status && r && r.toldAgent) {
        status.textContent = withNote(' — and told the bot.');
      }
    }).catch((e) => {
      console.warn('[feedback] not recorded:', e && e.message);
    });
    // Confirm without stealing attention from the call.
    btn.classList.remove('logged');
    void btn.offsetWidth;   // reflow, so a repeat click replays the pop
    btn.classList.add('logged');
    setTimeout(() => btn.classList.remove('logged'), 1200);
    // Kept, not cleared — the same complaint often recurs in one call and
    // retyping it is the friction these buttons exist to remove. Selected so it
    // reads as consumed and the next keystroke replaces it.
    if (noteEl && note) {
      noteEl.focus();
      noteEl.select();
      // Restart the flash even on rapid repeat clicks: without removing the
      // class first the animation only plays once and the second click looks
      // like it did nothing.
      noteEl.classList.remove('sent');
      void noteEl.offsetWidth;
      noteEl.classList.add('sent');
      setTimeout(() => noteEl.classList.remove('sent'), 900);
    }
    const status = document.getElementById('feedbackStatus');
    if (status) {
      status.textContent = withNote(' in the log.');
      clearTimeout(status._t);
      status._t = setTimeout(() => { status.textContent = ''; }, 4000);
    }
  });
});

document.getElementById('devtoolsBtn').addEventListener('click', () => {
  api.send('open-devtools');
});

// ---------------------------------------------------------------------------
// TTS test buttons
// ---------------------------------------------------------------------------

speakTextBtn.addEventListener('click', () => {
  const text = speakTextInput.value.trim();
  if (!text) return;
  api.send('speak', text);
  speakTextBtn.textContent = 'Speaking...';
  setTimeout(() => { speakTextBtn.textContent = 'Speak using TTS'; }, 3000);
});

// Named so it is obvious in the transcript and the session log that this turn
// was injected rather than heard.
const SIMULATED_SPEAKER = 'Troubleshooting User';

const simulateSpeechBtn = document.getElementById('simulateSpeechBtn');
const simulateText = document.getElementById('simulateText');
const simulateSpeechStatus = document.getElementById('simulateSpeechStatus');

if (simulateSpeechBtn) {
  async function submitSimulatedSpeech() {
    const text = simulateText.value.trim();
    // Fixed, not a field. Nobody varied it, and a stray or blank value silently
    // changed who the bot thought had spoken — which is the one thing about a
    // simulated turn that must not be ambiguous when you read it back in the log.
    const speaker = SIMULATED_SPEAKER;
    if (!text) {
      simulateSpeechStatus.textContent = 'Enter some text first.';
      simulateSpeechStatus.style.color = '#fdd663';
      simulateText.focus();
      return;
    }
    simulateSpeechBtn.disabled = true;
    simulateSpeechStatus.textContent = 'Sending…';
    simulateSpeechStatus.style.color = '#9aa0a6';
    try {
      const result = await api.invoke('simulate-speech', { text, speaker });
      if (result?.ok) {
        // Echo the submitted text back since it won't appear in any caption
        // feed the user can see. Truncate so the status line stays compact.
        const echo = text.length > 80 ? text.slice(0, 80) + '…' : text;
        simulateSpeechStatus.textContent = `Sent as ${speaker}: "${echo}"`;
        simulateSpeechStatus.style.color = '#81c995';
        simulateText.value = '';
      } else {
        simulateSpeechStatus.textContent = `Failed: ${result?.error || 'unknown'}`;
        simulateSpeechStatus.style.color = '#ea4335';
      }
    } catch (err) {
      simulateSpeechStatus.textContent = `Error: ${err.message}`;
      simulateSpeechStatus.style.color = '#ea4335';
    } finally {
      simulateSpeechBtn.disabled = false;
      // Refocus so the user is primed to type the next message immediately.
      simulateText.focus();
      setTimeout(() => { simulateSpeechStatus.textContent = ''; }, 6000);
    }
  }

  simulateSpeechBtn.addEventListener('click', submitSimulatedSpeech);

  // Enter submits, Shift-Enter inserts a newline (chat-app convention).
  simulateText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitSimulatedSpeech();
    }
  });
}

speakTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') speakTextBtn.click();
});

speechBtn.addEventListener('click', () => {
  api.send('play-speech-test');
  speechBtn.textContent = 'Playing...';
  setTimeout(() => { speechBtn.textContent = 'Play Test Audio File'; }, 2000);
});

// ---------------------------------------------------------------------------
// Settings handlers
// ---------------------------------------------------------------------------

botNameInput.addEventListener('change', () => {
  const typed = botNameInput.value.trim();
  if (typed) {
    currentBotName = typed;
    botNameDisplay = null; // a typed/saved name is a real identity — drop any fallback tag
    api.invoke('set-config', 'botName', typed);
    api.send('to-meet', { action: 'set-config', payload: { botName: typed } });
    updateBotNameBig();
    refreshBotIdentity(); // keep the guest "👤 Guest 'Name'" line in sync
    return;
  }
  // Emptying the field CLEARS the stored name rather than persisting the
  // literal fallback text as if it were a real one — a prior version of this
  // handler saved the string "Unnamed bot" itself into botName, which then
  // read back as a genuine 'stored' identity (bot-name.js's clean()/
  // resolveBotNameWithSource only fall through on an EMPTY value, not on the
  // literal word "Unnamed bot") and permanently overrode the real fallback
  // (e.g. a named profile's humanized name) with the generic label
  // everywhere in the app. Clearing lets resolveBotName's storedName ->
  // cliName -> profileName -> "Unnamed bot" chain run for real, and
  // get-bot-name-info re-fetches so the headline/placeholder reflect
  // whatever that chain resolves to immediately, not a stale value.
  api.invoke('set-config', 'botName', '');
  api.send('to-meet', { action: 'set-config', payload: { botName: '' } });
  api.invoke('get-bot-name-info').then((info) => {
    currentBotName = info?.name || 'Unnamed bot';
    botNameDisplay = info?.display || null;
    if (info?.name) botNameInput.placeholder = info.name;
    updateBotNameBig();
    refreshBotIdentity();
  }).catch(() => {
    currentBotName = 'Unnamed bot';
    botNameDisplay = null;
    updateBotNameBig();
    refreshBotIdentity();
  });
});

// #299: no validation on this — it's a free-text guest email that never needs
// to resolve to a real mailbox, and calendar-auto-join.js's matching is
// already trim+lowercase-tolerant, so there's nothing meaningful to reject.
calendarIdentityEmailInput.addEventListener('change', () => {
  api.invoke('set-config', 'calendarIdentityEmail', calendarIdentityEmailInput.value.trim());
});

websiteUrlInput.addEventListener('change', () => {
  const url = websiteUrlInput.value.trim().replace(/\/+$/, '');
  syncBaseUrl = url || 'https://vibeconferencing.com';
  // Write to the new key. Also clear the legacy syncBaseUrl so we don't end up
  // with two values diverging — getWebsiteUrl()'s resolution chain prefers
  // websiteUrl anyway, but cleaning legacy makes the precedence visible in
  // config.json. Restart required for the change to take effect (the URL is
  // captured at startup by sync/auth init paths).
  api.invoke('set-config', 'websiteUrl', url);
  api.invoke('set-config', 'syncBaseUrl', '');
  api.send('update-sync-config', { baseUrl: syncBaseUrl });
});

// #366/#381: the ElevenLabs API-key field moved to App Settings, so there's no
// change listener here. When the key changes there, App Settings re-fetches; the
// panel picks up EL voices on its next populateUnifiedVoices() (open / refresh).

ttsVoiceIdInput.addEventListener('change', () => {
  const id = ttsVoiceIdInput.value.trim();
  // A custom/cloned voice id (advanced) forces ElevenLabs so it actually routes.
  api.send('update-tts-config', id ? { provider: 'elevenlabs', voiceId: id } : { voiceId: '' });
});

// #340: standard macOS voices are mostly robotic — keep only a couple tolerable
// ones ("Daniel", "Samantha", "Karen") in the main group; the rest drop to "Other".
// Windows' SAPI voices arrive pre-tiered (tier 1) and never hit this list — see
// system-voices.js for why they aren't demoted.
// DUPLICATED in mcp-server/server.js (the agent's list_voices) and
// electron-app/renderer/onboarding.js — keep all three in sync.
// TODO(#342): single-source this + the merge logic behind one /api/voices endpoint.
const WHITELISTED_MACOS_STANDARD = ['Daniel', 'Samantha', 'Karen'];

// Unified voice picker: merge the OS's built-in voices + ElevenLabs + Voicebox
// into one dropdown, grouped Voicebox → ElevenLabs → built-in(good) → Other, so
// the best voices are up top. Option value encodes the provider: "vb:<id>" /
// "el:<id>" / "mac:<name>" ("mac:" is the historical prefix for "built-in").
// Show (or clear) why the ElevenLabs voice list came back empty. Only the
// actionable cases are worth a line under the picker — a missing/rejected key
// is already obvious from the key field, but "valid key, wrong scope" is not
// discoverable any other way.
function showElevenVoiceError(error) {
  const el = document.getElementById('elevenVoiceError');
  if (el) {
    if (!error) { el.style.display = 'none'; el.textContent = ''; }
    else { el.textContent = '⚠ ' + error.message; el.style.display = 'block'; }
  }
  // The voice-id field is the way IN when the list is unavailable, so it appears
  // exactly then — and stays visible whenever it already holds a value.
  //
  // That second rule is not politeness. A setting that is in effect but not
  // rendered is how a bot ends up speaking in a voice nobody can find in the UI;
  // the same shape cost real time twice this week (an emojiSet the dropdown
  // couldn't display, a botName in a config the app no longer read).
  const field = document.getElementById('ttsVoiceIdField');
  if (field) {
    const hasValue = !!(ttsVoiceIdInput && ttsVoiceIdInput.value.trim());
    field.style.display = (error || hasValue) ? '' : 'none';
  }
}

// Pass the saved config on initial load to pre-select; call with no arg to
// refresh in place (preserves the current selection).
async function populateUnifiedVoices(config) {
  const sel = unifiedVoiceSelect;
  if (!sel) return;
  const apiKey = (ttsApiKeyInput?.value || config?.ttsApiKey || '').trim();
  const [systemResult, voicebox, elevenResult] = await Promise.all([
    api.invoke('list-system-voices').catch(() => ({ platform: '', voices: [] })),
    api.invoke('list-voicebox-profiles').catch(() => []),
    apiKey
      ? api.invoke('list-elevenlabs-voices', apiKey).catch(() => ({ voices: [], error: null }))
      : Promise.resolve({ voices: [], error: null }),
  ]);
  // {voices, error}: a scoped key that can't read voices used to look exactly
  // like no key at all. Show why instead of nothing.
  const eleven = elevenResult?.voices || [];
  showElevenVoiceError(elevenResult?.error || null);

  // Desired selection: derive from saved config on initial load, else keep current.
  let selectedValue = sel.value;
  if (config) {
    const provider = config.ttsProvider || '';
    const vb = config.voiceboxProfileId || '';
    const elId = config.ttsVoiceId || '';
    const mac = config.macosVoice || 'Daniel';
    if (provider === 'voicebox' && vb) selectedValue = 'vb:' + vb;
    else if (provider === 'elevenlabs' && elId) selectedValue = 'el:' + elId;
    else if (provider === 'macos-say') selectedValue = 'mac:' + mac;
    else if (vb) selectedValue = 'vb:' + vb;                 // no explicit provider — infer
    else if (elId && apiKey) selectedValue = 'el:' + elId;
    else selectedValue = 'mac:' + mac;
  }

  sel.innerHTML = '';
  const addGroup = (label, items) => {
    if (!items.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.text;
      if (it.engine) opt.dataset.engine = it.engine;
      if (it.value === selectedValue) opt.selected = true;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  };

  addGroup('Voicebox (local)', (Array.isArray(voicebox) ? voicebox : []).map((p) => ({
    value: 'vb:' + p.id,
    text: `${p.name} (${p.preset_engine || p.default_engine || 'engine'})`,
    engine: p.preset_engine || p.default_engine || '',
  })));
  addGroup('ElevenLabs', (Array.isArray(eleven) ? eleven : []).map((v) => ({
    value: 'el:' + v.id,
    text: v.category && v.category !== 'premade' ? `${v.name} · ${v.category}` : v.name,
  })));
  // main tiers the voices (0 Premium / 1 Enhanced-or-SAPI / 2 plain); tierOf is
  // the fallback for the shape older builds returned.
  const sysList = Array.isArray(systemResult?.voices) ? systemResult.voices : [];
  const osName = systemResult?.platform === 'win32' ? 'Windows'
    : systemResult?.platform === 'darwin' ? 'macOS' : 'system';
  const tierOf = (v) => (v.tier != null ? v.tier : /\(Premium\)/i.test(v.name) ? 0 : /\(Enhanced\)/i.test(v.name) ? 1 : 2);
  const whitelisted = (name) => WHITELISTED_MACOS_STANDARD.some((w) => name === w || name.startsWith(w + ' '));
  addGroup(`Built-in (${osName})`, sysList
    .filter((v) => tierOf(v) < 2 || whitelisted(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));
  addGroup('Other built-in (lower quality)', sysList
    .filter((v) => tierOf(v) === 2 && !whitelisted(v.name))
    .map((v) => ({ value: 'mac:' + v.name, text: `${v.name} (${v.locale})` })));

  if (!sel.options.length) {
    sel.innerHTML = '<option value="mac:Daniel">Daniel (default)</option>';
  }
}

// Audition a voice through the LOCAL speakers when it's picked — main synthesizes
// a short sample and returns a data URL we play here (mirrors the built-in
// voice preview for ElevenLabs + Voicebox). Best-effort; stays quiet on failure.
let _voiceSampleAudio = null;
async function previewVoiceSample(opts) {
  try {
    if (_voiceSampleAudio) { try { _voiceSampleAudio.pause(); } catch { /* ignore */ } _voiceSampleAudio = null; }
    const r = await api.invoke('synth-voice-sample', opts);
    if (r?.ok && r.dataUrl) {
      _voiceSampleAudio = new Audio(r.dataUrl);
      _voiceSampleAudio.play().catch(() => {});
    }
  } catch { /* ignore — preview is best-effort */ }
}

// A key just became active (paste or gift accept, #273) — the only feedback
// otherwise is a silent color change in Settings, easy to miss since nothing
// else in the app makes a sound until a bot is in a call. Spoken here (the
// panel, not app-settings) because it's the one window that's always open,
// so a gift auto-accepted at launch — before anyone opened Settings — still
// gets announced.
api.on('elevenlabs-key-validated', ({ message }) => {
  previewVoiceSample({ provider: 'elevenlabs', text: message });
});

// #394: mid-call, don't play the audition over the human's speakers — they're
// already listening to the live call, and the new voice speaks the bot's very
// next line anyway. Show a brief note instead so the pick still visibly lands.
// (Gated on callActive, main's callStatusMeansInCall — wider than `inCall`, so
// the sample also stays quiet while joining.)
const voiceSetNote = document.getElementById('voiceSetNote');
let _voiceSetNoteTimer = null;
function auditionVoice(opts) {
  if (!callActive) { previewVoiceSample(opts); return; }
  if (!voiceSetNote) return;
  voiceSetNote.textContent = "Voice set: you'll hear it on the bot's next line.";
  voiceSetNote.style.display = 'block';
  clearTimeout(_voiceSetNoteTimer);
  _voiceSetNoteTimer = setTimeout(() => { voiceSetNote.style.display = 'none'; }, 4000);
}

unifiedVoiceSelect?.addEventListener('change', () => {
  const val = unifiedVoiceSelect.value || '';
  const sep = val.indexOf(':');
  const kind = val.slice(0, sep);
  const id = val.slice(sep + 1);
  // The spoken name = the dropdown label minus the "· premade" / "(Enhanced)" /
  // "(kokoro)" suffixes, so every provider says "Hello, my name is <name>."
  const label = unifiedVoiceSelect.selectedOptions[0]?.textContent || '';
  // A space-delimited dash in an ElevenLabs name ("Brian - Deep, Resonant…") is
  // spoken as a hyphen with no pause; turn it into ". " so the name and its
  // description land as separate sentences.
  const name = label.replace(/\s*[·(].*$/, '').replace(/\s+[-–—]+\s+/g, '. ').trim();
  const text = `Hello, my name is ${name || 'your voice assistant'}.`;
  if (kind === 'vb') {
    const engine = unifiedVoiceSelect.selectedOptions[0]?.dataset.engine || 'kokoro';
    api.send('update-tts-config', { provider: 'voicebox', voiceboxProfileId: id, voiceboxEngine: engine });
    auditionVoice({ provider: 'voicebox', voiceboxProfileId: id, voiceboxEngine: engine, text });
  } else if (kind === 'el') {
    // Picking a listed EL voice clears any custom-ID override so they don't fight.
    api.send('update-tts-config', { provider: 'elevenlabs', voiceId: id, voiceboxProfileId: '' });
    if (ttsVoiceIdInput) ttsVoiceIdInput.value = id;
    auditionVoice({ provider: 'elevenlabs', voiceId: id, text });
  } else if (kind === 'mac') {
    // Force the built-in provider so an ElevenLabs key doesn't override the pick.
    api.send('update-tts-config', { provider: 'macos-say', macosVoice: id, voiceboxProfileId: '' });
    auditionVoice({ provider: 'macos-say', macosVoice: id, text });
  }
});

refreshVoicesBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  populateUnifiedVoices(); // refresh in place, preserving the current selection
});

document.getElementById('openVoiceSettingsBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  api.invoke('open-voice-settings').catch(() => {});
});

// #305: show the EFFECTIVE working dir (the override if set, else the bot's auto
// trusted folder). Refresh on load and whenever the override field changes.
const agentWorkdirPathEl = document.getElementById('agentWorkdirPath');
const openAgentWorkdirBtn = document.getElementById('openAgentWorkdirBtn');
async function refreshAgentWorkdir() {
  if (!agentWorkdirPathEl) return;
  try {
    const r = await api.invoke('get-agent-workdir');
    agentWorkdirPathEl.textContent = r?.path || '—';
    agentWorkdirPathEl.title = r?.isOverride
      ? `Override (Working Directory): ${r.path}`
      : `This bot's own trusted folder: ${r?.path || ''}`;
  } catch { agentWorkdirPathEl.textContent = '—'; }
}
refreshAgentWorkdir();
openAgentWorkdirBtn?.addEventListener('click', () => api.invoke('open-agent-workdir').catch(() => {}));

// #305/#291: the bot's personality CLAUDE.md editor. Load the current file (or the
// starter template if none), save on click. Reloads when the working dir changes.
const agentClaudeMdEl = document.getElementById('agentClaudeMd');
const saveAgentClaudeMdBtn = document.getElementById('saveAgentClaudeMdBtn');
const agentClaudeMdStatus = document.getElementById('agentClaudeMdStatus');
async function refreshAgentClaudeMd() {
  if (!agentClaudeMdEl) return;
  try {
    const r = await api.invoke('get-agent-claudemd');
    agentClaudeMdEl.value = r?.content ?? '';
    if (agentClaudeMdStatus) agentClaudeMdStatus.textContent = r?.exists ? '' : 'starter template — Save to create';
  } catch { agentClaudeMdEl.placeholder = '(could not load CLAUDE.md)'; }
}
refreshAgentClaudeMd();
saveAgentClaudeMdBtn?.addEventListener('click', async () => {
  if (!agentClaudeMdEl) return;
  if (agentClaudeMdStatus) { agentClaudeMdStatus.style.color = '#81c995'; agentClaudeMdStatus.textContent = 'Saving…'; }
  const r = await api.invoke('save-agent-claudemd', agentClaudeMdEl.value).catch(() => ({ ok: false }));
  if (agentClaudeMdStatus) {
    agentClaudeMdStatus.style.color = r?.ok ? '#81c995' : '#f28b82';
    agentClaudeMdStatus.textContent = r?.ok ? 'Saved ✓' : 'Save failed';
    if (r?.ok) setTimeout(() => { agentClaudeMdStatus.textContent = ''; }, 2500);
  }
});

claudeWorkDirInput.addEventListener('change', () => {
  api.invoke('set-config', 'claudeWorkDir', claudeWorkDirInput.value.trim());
  refreshAgentWorkdir();
  refreshAgentClaudeMd();
  // Sessions are per working directory, so this changes which one is in use.
  refreshAgentSession();
});

// The session actually in use, under the field. The id is never something to
// type — it is looked up from the name — so it is shown rather than filled in.
const agentSessionStatusEl = document.getElementById('agentSessionStatus');
async function refreshAgentSession() {
  if (!agentSessionStatusEl) return;
  try {
    const s = await api.invoke('get-agent-session');
    if (!s?.name) { agentSessionStatusEl.textContent = ''; return; }
    const where = s.pinned ? 'Pinned to' : (s.auto ? 'Following the bot’s name:' : 'Session');
    agentSessionStatusEl.textContent = s.exists
      ? `${where} “${s.name}” — resuming ${s.id}`
      : `${where} “${s.name}” — no session yet; the next launch starts one.`;
  } catch { agentSessionStatusEl.textContent = ''; }
}
refreshAgentSession();

agentSessionIdInput?.addEventListener('change', async () => {
  const value = agentSessionIdInput.value.trim();
  // Typing here takes the field over, so renaming the bot no longer drags the
  // session along with it. Clearing hands it back — the field returns to
  // tracking the bot's name, which is what almost everyone should be on.
  await api.invoke('set-config', 'agentSessionAuto', !value);
  await api.invoke('set-config', 'agentSession', value);
  refreshAgentSession();
});

claudeModelInput.addEventListener('change', () => {
  api.invoke('set-config', 'claudeModel', claudeModelInput.value.trim());
});

if (captionLanguageInput) captionLanguageInput.addEventListener('change', () => {
  // set-config live-applies it: mid-call it takes effect now, otherwise on the
  // next join. See applyCaptionLanguagePref in main.
  api.invoke('set-config', 'captionLanguage', captionLanguageInput.value);
});

if (emojiSetInput) emojiSetInput.addEventListener('change', async () => {
  await api.invoke('set-config', 'emojiSet', emojiSetInput.value);
  // Repaint OUR avatar now. set-config pushes the new set to the in-call camera
  // immediately, but the panel's own face is painted by renderAgentAvatar on a
  // 60s timer — so picking a set used to change the bot's face in the call while
  // the face on this screen sat on the old artwork for up to a minute, which
  // reads as "the setting didn't take".
  renderAgentAvatar();
});

dangerousModeInput.addEventListener('change', () => {
  api.invoke('set-config', 'dangerousMode', dangerousModeInput.checked);
});

ackShortMinInput.addEventListener('change', () => {
  const v = parseInt(ackShortMinInput.value, 10);
  if (Number.isFinite(v) && v >= 0) api.invoke('set-config', 'ackShortMin', v);
});

ackLongMinInput.addEventListener('change', () => {
  const v = parseInt(ackLongMinInput.value, 10);
  if (Number.isFinite(v) && v >= 0) api.invoke('set-config', 'ackLongMin', v);
});

// Phrase textareas: split on newline, drop blanks. Won't save if the
// list ends up empty — the schema requires at least 1 entry.
function parsePhraseLines(textarea) {
  return textarea.value
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

ackShortPhrasesInput.addEventListener('change', () => {
  const phrases = parsePhraseLines(ackShortPhrasesInput);
  if (phrases.length > 0) api.invoke('set-config', 'ackShortPhrases', phrases);
});

ackLongPhrasesInput.addEventListener('change', () => {
  const phrases = parsePhraseLines(ackLongPhrasesInput);
  if (phrases.length > 0) api.invoke('set-config', 'ackLongPhrases', phrases);
});

// ---------------------------------------------------------------------------
// Incoming messages from main process
// ---------------------------------------------------------------------------

const seenEntryIds = new Set();

api.on('extension-message', (message) => {
  if (message.action === 'error') {
    showError(message.message);
    if (/microphone|mic/i.test(message.message)) {
      micWarn.textContent = message.message;
      micWarn.style.display = 'block';
    }
  }

  if (message.action === 'mic-status' && message.status === 'healthy') {
    micWarn.style.display = 'none';
  }

  if (message.action === 'raw-caption') {
    rawCaptionText.textContent = `[${message.speaker}] ${message.text}`;
  }

  if (message.action === 'transcript' || message.action === 'caption-update') {
    const { speaker, text, timestamp } = message.payload || {};
    if (!text) return;

    // For caption-update, update the last entry if same speaker
    if (message.action === 'caption-update') {
      const lastEntry = transcriptArea.lastElementChild;
      if (lastEntry && lastEntry.dataset.speaker === speaker) {
        lastEntry.querySelector('.transcript-text').textContent = text;
        transcriptArea.scrollTop = transcriptArea.scrollHeight;
        return;
      }
    }

    const entry = document.createElement('div');
    entry.className = 'transcript-entry';
    entry.dataset.speaker = speaker;
    const time = new Date(timestamp).toLocaleTimeString();
    entry.innerHTML = `<span class="transcript-speaker">${speaker}</span> <span class="transcript-time">${time}</span><br><span class="transcript-text">${text}</span>`;
    transcriptArea.appendChild(entry);
    transcriptArea.scrollTop = transcriptArea.scrollHeight;
  }
});

api.on('meet-status', (status) => {
  if (status.ready) {
    // Page loaded — remember the room code (so troubleshooting fields populate),
    // but don't yet show the "Leave Call" UI; we may still be denied or in the
    // waiting-room. The 'call-status-changed' IPC drives the actual inCall flip
    // once we're admitted.
    const match = status.url?.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/);
    if (match) {
      meetCodeInput.value = match[1];
      const base = syncBaseUrl || 'https://vibeconferencing.com';
      roomLink.href = `${base}/room/${match[1]}`;
      updateCurlCommand(match[1]);
    }
  }
});

api.on('call-status-changed', ({ status, provider }) => {
  // Authoritative call-state signal from the local server. Only show Leave Call
  // once we're actually in the meeting; hide it once the bot has left.
  if (status === 'in-call') {
    callProvider = provider || 'meet';
    const code = meetCodeInput.value || '';
    enterCallState(code);
    // after-call-work counts as out of the call: the bot HAS left the meeting,
    // so "Leave Call" is no longer the action on offer even though the agent is
    // still busy. (call-phase.js owns this vocabulary; the renderer is context-
    // isolated and can't require it, so the values are spelled out.)
  } else if (status === 'idle' || status === 'call-complete' || status === 'after-call-work') {
    callProvider = null;
    exitCallState();
  }
  // 'joining' / 'waiting-to-be-admitted' stay in the pre-call UI — the join
  // button hides itself once clicked, and the user sees the Meet view loading.
});

api.on('call-failed', (data) => {
  exitCallState();
  if (data?.message) showError(data.message);
});
