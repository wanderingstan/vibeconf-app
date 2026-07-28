// share-surface.js — pure helpers for the shared window's size and for the
// input events the bot sends into it. No electron/DOM requires, so main.js can
// use these and tests/share-surface.test.mjs can exercise them directly.

// The board is captured, not looked at, so its size is a content decision
// rather than a window-management one.
//
// 800×800 is the recommended default and deliberately square: Meet stacks the
// participant tiles down the RIGHT of a shared screen, so a 16:9 board wasted
// width behind the tiles and left the content as a tiny centred strip (#4).
// Square fills the visible area better. Other shapes are allowed because the
// board can host any URL — a phone-shaped mock, a wide dashboard, a tall
// document — and those have their own natural aspect.
const SHARE_SIZE = {
  recommended: { width: 800, height: 800 },
  // Floor: below this Meet's own downscaling makes text unreadable, and the
  // board stops being worth presenting. Ceiling: a window larger than any
  // real display can't be captured meaningfully and pushes encode cost up.
  min: 240,
  max: 4096,
};

/**
 * Resolve a requested share-window size against the current one.
 *
 * Either dimension may be omitted, which keeps the current value — so "make it
 * wider" is one field, not a whole size. Out-of-range values clamp rather than
 * error: a bot that asks for 10000px wants "as big as possible", and failing
 * the call would leave it with no board at all.
 *
 * @returns {{width:number, height:number, notes:string[]}} notes explains any
 *   adjustment, so the tool response can tell the agent what it actually got.
 */
function resolveShareSize(requested, current) {
  const cur = {
    width: current?.width || SHARE_SIZE.recommended.width,
    height: current?.height || SHARE_SIZE.recommended.height,
  };
  const notes = [];

  const pick = (value, fallback, label) => {
    if (value === undefined || value === null) return fallback;
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) {
      notes.push(`${label} "${value}" is not a number — kept ${fallback}`);
      return fallback;
    }
    if (n < SHARE_SIZE.min) {
      notes.push(`${label} ${n} is below the ${SHARE_SIZE.min}px minimum — used ${SHARE_SIZE.min}`);
      return SHARE_SIZE.min;
    }
    if (n > SHARE_SIZE.max) {
      notes.push(`${label} ${n} is above the ${SHARE_SIZE.max}px maximum — used ${SHARE_SIZE.max}`);
      return SHARE_SIZE.max;
    }
    return n;
  };

  return {
    width: pick(requested?.width, cur.width, 'width'),
    height: pick(requested?.height, cur.height, 'height'),
    notes,
  };
}

// Modifier names Electron's sendInputEvent accepts. 'cmd'/'command' and
// 'ctrl'/'option' are aliased because that is what a model writes when it is
// thinking about a Mac keyboard.
const MODIFIER_ALIASES = {
  cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta', win: 'meta',
  ctrl: 'control', control: 'control',
  alt: 'alt', option: 'alt',
  shift: 'shift',
};

function normalizeModifiers(modifiers) {
  const out = [];
  for (const raw of modifiers || []) {
    const key = String(raw).trim().toLowerCase();
    const mapped = MODIFIER_ALIASES[key];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

/**
 * Build the sendInputEvent payloads for a typing request.
 *
 * Text and named keys are different event shapes, and conflating them is the
 * classic way synthetic input silently does nothing: a 'char' event carrying
 * "Enter" types the literal word, while a keyDown of "a" without a matching
 * 'char' event moves focus but inserts nothing. So text becomes char events
 * (one per character) and a named key becomes keyDown/keyUp.
 *
 * A modifier chord (cmd+A) always goes through the keyDown/keyUp path, since
 * a char event carries no modifier state.
 *
 * @returns {{events:Array<object>, error?:string}}
 */
function keyEventsFor({ text, key, modifiers } = {}) {
  const mods = normalizeModifiers(modifiers);

  if (key) {
    const keyCode = String(key);
    return {
      events: [
        { type: 'keyDown', keyCode, modifiers: mods },
        { type: 'keyUp', keyCode, modifiers: mods },
      ],
    };
  }

  if (typeof text === 'string' && text.length > 0) {
    // With modifiers held, the intent is a shortcut over the text (cmd+A),
    // not literal characters — send it as a chord on the first character.
    if (mods.length) {
      const keyCode = text[0];
      return {
        events: [
          { type: 'keyDown', keyCode, modifiers: mods },
          { type: 'keyUp', keyCode, modifiers: mods },
        ],
      };
    }
    const events = [];
    for (const ch of Array.from(text)) {
      // Newlines in typed text mean Enter, not a literal control character.
      if (ch === '\n' || ch === '\r') {
        events.push({ type: 'keyDown', keyCode: 'Return', modifiers: [] });
        events.push({ type: 'keyUp', keyCode: 'Return', modifiers: [] });
      } else {
        events.push({ type: 'char', keyCode: ch, modifiers: [] });
      }
    }
    return { events };
  }

  return { events: [], error: 'Provide text to type, or a key to press.' };
}

/**
 * Build the sendInputEvent payloads for a click at a point.
 *
 * The mouseMove first is not ceremony: hover-driven UIs (menus, tooltips,
 * anything with :hover or mouseenter) will not have opened the thing being
 * clicked without it, so the click lands on whatever was underneath.
 */
function clickEventsFor({ x, y, button, clickCount } = {}) {
  const px = Math.round(Number(x));
  const py = Math.round(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { events: [], error: 'Click needs numeric x and y (CSS pixels in the shared page).' };
  }
  const btn = ['left', 'right', 'middle'].includes(String(button)) ? String(button) : 'left';
  const count = clickCount === 2 ? 2 : 1;
  const base = { x: px, y: py, button: btn };
  return {
    events: [
      { type: 'mouseMove', x: px, y: py },
      { ...base, type: 'mouseDown', clickCount: count },
      { ...base, type: 'mouseUp', clickCount: count },
    ],
  };
}

// Gap between the shared board and the app window, matching the one the
// terminal launcher already leaves below the app.
const SHARE_GAP = 10;

/**
 * Where to put the shared board relative to the app window.
 *
 * LEFT of the app by default, top-aligned. Left because the board is wide
 * (800 by default) and the app window is narrow, so a right-hand placement
 * collides with the way people actually park the app — top-right of the
 * display. The board's RIGHT edge is what gets anchored, so growing it with
 * set_share_size extends leftward and it keeps hugging the app instead of
 * sliding underneath it.
 *
 * Falls back to the right of the app when the left won't fit, then clamps into
 * the work area. Clamping can overlap the app window, which is fine — it is a
 * real window and can be moved; being off-screen is what isn't fine.
 *
 * @returns {{x:number, y:number, side:'left'|'right'|'clamped'}}
 */
function shareWindowPosition({ mainBounds, workArea, width, height, gap = SHARE_GAP } = {}) {
  if (!mainBounds || !workArea) return null;

  const fits = (x) => x >= workArea.x && x + width <= workArea.x + workArea.width;

  const leftX = mainBounds.x - gap - width;
  const rightX = mainBounds.x + mainBounds.width + gap;
  let x, side;
  if (fits(leftX)) { x = leftX; side = 'left'; }
  else if (fits(rightX)) { x = rightX; side = 'right'; }
  else {
    // Neither side fits: keep it on-screen, preferring the left edge so the
    // board stays where the eye expects it.
    x = Math.max(workArea.x, Math.min(leftX, workArea.x + workArea.width - width));
    side = 'clamped';
  }

  // Top-aligned with the app, pulled down if that would push the bottom off.
  let y = mainBounds.y;
  const maxY = workArea.y + workArea.height - height;
  if (y > maxY) y = maxY;
  if (y < workArea.y) y = workArea.y;

  return { x: Math.round(x), y: Math.round(y), side };
}

module.exports = {
  SHARE_SIZE,
  SHARE_GAP,
  resolveShareSize,
  shareWindowPosition,
  normalizeModifiers,
  keyEventsFor,
  clickEventsFor,
};
