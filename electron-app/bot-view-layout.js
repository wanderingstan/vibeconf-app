// bot-view-layout.js — geometry + zoom for the bot's Meet view.
//
// New users (and Seth) keep mistaking the bot's Meet webview for THEIR own Meet
// window. The fix: shrink that webview to a thumbnail in a narrow column, so it
// reads as "a little monitor of what the bot sees" rather than a full call.
//
// The trick that makes it faithful: we hold Meet's VIRTUAL viewport constant and
// drop the page-zoom to compensate. Meet keeps the exact same layout it has today
// (no responsive reflow — same DOM, so caption scraping and every selector keep
// working); only the rendered scale changes. This is `webContents.setZoomFactor`,
// an Electron/Chromium page-zoom — NOT CSS — and the app already uses it (Meet
// runs at 0.75 today).
//
// Three states. One button toggles the resting state against 'popped':
//
//   hidden    : Meet lives in its own window that is never shown, at a LARGE
//               fixed size and zoom 1. DEFAULT. Nobody was watching the
//               thumbnail anyway — it was a debugging aid — and shrinking it
//               was actively costing the bot its eyesight (see below).
//   thumbnail : narrow column, panel on top, shrunk Meet below it. Legacy.
//   popped    : Meet floats in its own large VISIBLE window; the app column is
//               panel-only. This is the escape hatch — it's how a human signs
//               the bot into Google/Slack/GitHub (⌘L in that window), so it
//               must survive 'hidden' becoming the default.
//
// (There is no separate side-by-side "expanded" state — a single large floating
// window is enough, so the app is ALWAYS a narrow column.)
//
// #103 — why 'hidden' is the default. capturePage() grabs the COMPOSITED
// SURFACE: its pixel count is bounds x devicePixelRatio, and the page zoom is
// already baked in. It does not re-render at 1:1. Measured, bounds fixed at
// 400x300:
//
//   zoom 1.00   innerWidth  400css   capture 800x600   a 100px box -> 200 px
//   zoom 0.50   innerWidth  800css   capture 800x600   a 100px box -> 100 px
//   zoom 0.32   innerWidth 1250css   capture 800x600   a 100px box ->  64 px
//
// So the thumbnail's zoom compensation — lovely for keeping Meet's layout from
// reflowing — meant the bot's screenshots WERE the shrunken image. On the Jul 28
// call the Meet region was 380x214, captured at 760x428, with Meet laid out at
// 1173css inside it: an effective 0.32. A participant's shared terminal came
// through at ~3px per line of text, i.e. unreadable, and the bot had to say so
// out loud on the call. Rendering into real device pixels instead is the only
// fix; there is no full-resolution copy to ask for.
//
// This module is pure: given a state and the window's content size it returns the
// view bounds and the Meet zoom. All the Electron window surgery lives in main.js.

const STATES = ['hidden', 'thumbnail', 'popped'];

// Size of the never-shown host window in the 'hidden' state, in CSS px. Chosen
// so Meet's pinned virtual width (MEET_TARGET_CSS_WIDTH) fits at zoom 1 with
// room to spare, and 16:9 so Meet lays out as it would on a normal display.
// The capture comes back at this x devicePixelRatio — 3200x1800 on a 2x screen,
// against 760x428 docked. Roughly 3x linear, 10x area.
const HIDDEN_SIZE = { width: 1600, height: 900 };

// The sizes the meetViewSize preference can pick from (preferences-schema.js),
// keyed by the pref's string value. All 16:9 for the same reason HIDDEN_SIZE
// is. Bigger is more room for Meet's grid — at 1600x900 a call of three or
// more shows small tiles, and the bot's screenshots and the call recording
// (which keeps just the tile region, record-region.js) inherit that — at the
// cost of a bigger capture and recording. Above 1920x1080 the recording
// capture is bounded back to 1080p by call-recording-window.js's
// CAPTURE_CONSTRAINTS, so the largest size buys layout room, not recording
// pixels. Not user-editable free text: Meet has layout breakpoints, and an
// arbitrary size can land on one that hides tiles or the controls. Nothing
// SMALLER than the long-standing default either: below it Meet starts moving
// toolbar buttons into its overflow menu and hiding parts of the UI the
// provider's selectors rely on (seen in practice), and the cramped-grid
// problem this pref exists for only ever points the other way.
const MEET_VIEW_SIZES = {
  '1600x900': HIDDEN_SIZE,
  '1920x1080': { width: 1920, height: 1080 },
  '2560x1440': { width: 2560, height: 1440 },
};

// #673: the largest size, NOT the historical 1600x900. Measured against a real
// remote share (a second machine sharing a 1920x1080 screen into the call):
//
//   view 1600x900   share renders ~875px  (46% of source) — UNREADABLE below ~18px
//   view 1920x1080  share renders ~1100px (57%)           — 14px and above only
//   view 2560x1440  share renders ~1550px (81%)           — all of it, 10px included
//
// At the old default the bot genuinely could not read a student's screen: a
// 1920-wide share downscaled into an ~875px tile puts 12px editor text at about
// 5.5 effective pixels. That is the whole of Bethany's "I shared it 10 seconds
// ago, why aren't you seeing it" report.
//
// WHY A BIGGER VIEW ACTUALLY HELPS, which was not obvious: Meet adapts what it
// SENDS to what the receiver renders. Probed live, a share whose source was
// 1920x1080 arrived as 1606x830 against a 1608x832 rendering — Meet downscaled
// it BELOW its source to match the layout, to within two pixels. So enlarging
// the view does not upscale pixels we already had, it makes Meet transmit more.
//
// The ceiling is the sharer's own screen: Meet never sends more than the source,
// so this buys legibility only until the rendered share approaches the sharer's
// width. 2560x1440 is close to the practical maximum for a 1080p sharer.
//
// The recording is NOT affected: renderer/call-recording-window.js's
// CAPTURE_CONSTRAINTS bounds the capture to 1080p, so this buys screenshot
// pixels without growing recordings.
const DEFAULT_MEET_VIEW_SIZE = '2560x1440';

// The hidden host window's size for a meetViewSize pref value. Anything
// unrecognised (unset, a typo, a size removed from the table) is the DEFAULT,
// never a throw — this feeds window creation. Resolved through the table rather
// than a hardcoded constant so the fallback can never drift away from the
// default the way it would if both were written out separately.
function hiddenSizeFor(pref) {
  return MEET_VIEW_SIZES[pref] || MEET_VIEW_SIZES[DEFAULT_MEET_VIEW_SIZE];
}
// No compensation needed when we aren't squeezing it into a narrow column.
const HIDDEN_ZOOM = 1;

// The virtual width we keep Meet believing it has, in BOTH states, so its layout
// never reflows. Derived from today's default: the full Meet view is ~880 device
// px wide at zoom 0.75 → 880 / 0.75 ≈ 1173 CSS px. Pinning it makes the thumbnail
// a faithful miniature of the popped-out large view rather than a reflow.
const MEET_TARGET_CSS_WIDTH = 1173;
// Zoom for the popped-out large window — today's Meet zoom.
const POPPED_ZOOM = 0.75;

// Chromium clamps page zoom to ~[0.25, 5]. Below 0.25 the compensation stops
// working and Meet WOULD reflow, so we clamp and let the caller know layout is no
// longer guaranteed (the panel would have to be absurdly narrow to hit this).
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

const clamp = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

// The one button toggles the RESTING state against 'popped'. Resting is
// whichever of hidden/thumbnail the user has configured (botViewMode), so the
// toggle keeps meaning "show me the bot's view / put it away" regardless of
// which resting state is in force. An unknown state toggles toward popped.
function nextState(state, opts = {}) {
  const resting = opts.restingState === 'thumbnail' ? 'thumbnail' : 'hidden';
  return state === 'popped' ? resting : 'popped';
}

// Whether the bottom region (Meet thumbnail / popped-out placeholder) exists at
// all. It only earns its space during a call. `inCall` covers the whole live
// stretch — joining and waiting-to-be-admitted included, so the green room and
// the admission prompt are visible. Defaults to true so existing callers (and
// applyMeetZoom, which only wants the zoom) keep their old behaviour.
function showRegion(opts = {}) {
  return opts.inCall === undefined ? true : !!opts.inCall;
}

// The zoom that makes a device-pixel-wide viewport show MEET_TARGET_CSS_WIDTH
// virtual pixels. `clamped` flags when we hit the floor (layout no longer exact).
function meetZoomForWidth(deviceWidth, targetCss = MEET_TARGET_CSS_WIDTH) {
  const ideal = deviceWidth / targetCss;
  const z = clamp(ideal);
  return { zoom: z, clamped: z !== ideal };
}

// Compute the full layout for a state.
//
//   { panelBounds, meetBounds, meetZoom, meetInOwnWindow, clamped }
//
// { panelBounds, meetBounds, placeholderBounds, meetZoom, meetInOwnWindow, clamped }
//
// panelBounds / meetBounds / placeholderBounds are {x,y,width,height} in the MAIN
// window's content coordinates, or null when that view isn't in the main window.
// The column KEEPS THE SAME SHAPE in both states — panel on top, a 16:9 region
// below — so it never reshuffles when you toggle. Only the region's occupant
// changes: the Meet thumbnail when docked, a "popped out" placeholder when Meet
// has floated into its own window. meetInOwnWindow is true only for 'popped'.
function computeLayout(state, contentSize, opts = {}) {
  const windowWidth = opts.windowWidth || 380;
  const height = Math.max(0, (contentSize && contentSize.height) || 0);

  // Same geometry for both states: panel on top, a 16:9 region at the bottom.
  const { zoom, clamped } = meetZoomForWidth(windowWidth);
  const regionHeight = Math.round(windowWidth * 9 / 16);
  const panelHeight = Math.max(0, height - regionHeight);
  const region = { x: 0, y: panelHeight, width: windowWidth, height: regionHeight };
  const panelBounds = { x: 0, y: 0, width: windowWidth, height: panelHeight };

  // Out of a call there is nothing for the bot's view to show — it was just a
  // permanent "This is the bot's view" placard eating a 16:9 slab of the window.
  // Give the whole column to the panel and report no region at all. Callers must
  // DETACH the Meet view on a null meetBounds, not merely skip setBounds (a
  // still-attached view keeps painting at its old bounds).
  if (!showRegion(opts)) {
    return {
      panelBounds: { x: 0, y: 0, width: windowWidth, height },
      meetBounds: null,
      placeholderBounds: null,
      meetZoom: state === 'popped' ? POPPED_ZOOM : (state === 'hidden' ? HIDDEN_ZOOM : zoom),
      // 'hidden' is own-window in AND out of a call — the host window persists so
      // the capture surface (and Meet itself) survives the gap between calls.
      meetInOwnWindow: state === 'popped' || state === 'hidden',
      clamped: false,
      regionHidden: true,
    };
  }

  if (state === 'hidden') {
    // Meet lives in a window that is never shown, so there is nothing to lay out
    // in the column at all — the panel takes the whole thing, exactly as it does
    // out of a call. No placeholder either: a "popped out" placard would be a
    // lie, since nothing popped out and there is nothing to go and look at.
    return {
      panelBounds: { x: 0, y: 0, width: windowWidth, height },
      meetBounds: null,
      placeholderBounds: null,
      meetZoom: HIDDEN_ZOOM,
      meetInOwnWindow: true,
      clamped: false,
      regionHidden: true,
    };
  }

  if (state === 'popped') {
    // Meet floats in its own window (main.js owns that window's zoom + size), and
    // the column gives the freed space back to the panel — exactly as 'hidden'
    // does. There is no placeholder: the region used to hold a "Popped out"
    // placard, which meant popping the view out cost you half the panel window to
    // be told, in words, what the button you just pressed had already done.
    return {
      panelBounds: { x: 0, y: 0, width: windowWidth, height },
      meetBounds: null,
      placeholderBounds: null,
      meetZoom: POPPED_ZOOM, // applied in the popped window
      meetInOwnWindow: true,
      clamped: false,
      regionHidden: true,
    };
  }

  // thumbnail (default): the region holds the shrunk Meet view.
  return {
    panelBounds,
    meetBounds: region,
    placeholderBounds: null,
    meetZoom: zoom,
    meetInOwnWindow: false,
    clamped,
  };
}

// Height of the bot's-view region (the 16:9 slab under the panel). Exported so
// main.js can size the window to "panel content + region" without re-deriving
// the ratio. Zero when the region is hidden — see computeLayout.
function regionHeightFor(windowWidth = 380, state) {
  // 'hidden' has no region at all — Meet is in a window nobody sees, so the
  // column must not reserve a 16:9 slab for it.
  //
  // Neither does 'popped', for the same reason: Meet is in ITS OWN window, so
  // there is nothing left in the column to reserve height for. This used to
  // return the full slab, because the region held a "Popped out" placard — with
  // that gone, keeping the reservation would grow the main window by 214px of
  // empty panel background every time you popped the view out.
  //
  // Only 'thumbnail' actually puts something in the column.
  if (state === 'hidden' || state === 'popped') return 0;
  return Math.round(windowWidth * 9 / 16);
}

// The MAIN window is ALWAYS a narrow column (panel + optional Meet thumbnail), so
// its content width is the same in every state. Kept as a function so main.js has
// one place to ask, and in case a future state wants a different shape.
function windowWidthFor(state, opts = {}) {
  return (opts.windowWidth || 380); // always a column
}

module.exports = {
  STATES,
  HIDDEN_SIZE,
  MEET_VIEW_SIZES,
  DEFAULT_MEET_VIEW_SIZE,
  hiddenSizeFor,
  HIDDEN_ZOOM,
  MEET_TARGET_CSS_WIDTH,
  POPPED_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  nextState,
  showRegion,
  regionHeightFor,
  meetZoomForWidth,
  computeLayout,
  windowWidthFor,
};
