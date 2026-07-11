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
// Two states, toggled by one button:
//   thumbnail ↔ popped
//
//   thumbnail : narrow column, panel on top, shrunk Meet below it. DEFAULT.
//   popped    : Meet floats in its own large window at today's zoom; the app
//               column is panel-only.
//
// (There is no separate side-by-side "expanded" state — a single large floating
// window is enough, so the app is ALWAYS a narrow column.)
//
// This module is pure: given a state and the window's content size it returns the
// view bounds and the Meet zoom. All the Electron window surgery lives in main.js.

const STATES = ['thumbnail', 'popped'];

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

// Toggle between the two states. An unknown state resets to the default.
function nextState(state) {
  return state === 'popped' ? 'thumbnail' : 'popped';
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
// panelBounds / meetBounds are {x,y,width,height} in the MAIN window's content
// coordinates, or null when that view isn't in the main window. meetInOwnWindow
// is true only for 'popped'. The caller sets the window's outer size from
// windowSizeFor() below.
function computeLayout(state, contentSize, opts = {}) {
  const panelWidth = opts.panelWidth || 380;
  const width = Math.max(0, (contentSize && contentSize.width) || 0);
  const height = Math.max(0, (contentSize && contentSize.height) || 0);

  if (state === 'popped') {
    // Meet floats in its own window (main.js owns that window's zoom = POPPED_ZOOM
    // and size). The main window is just the panel column.
    return {
      panelBounds: { x: 0, y: 0, width: panelWidth, height },
      meetBounds: null,
      meetZoom: POPPED_ZOOM, // applied in the popped window
      meetInOwnWindow: true,
      clamped: false,
    };
  }

  // thumbnail (default): narrow column, panel on top, Meet miniature below.
  // The Meet region is a 16:9 box at the column's width, so the whole virtual
  // viewport is visible; the panel takes the rest of the column height.
  const { zoom, clamped } = meetZoomForWidth(panelWidth);
  const meetHeight = Math.round(panelWidth * 9 / 16);
  const panelHeight = Math.max(0, height - meetHeight);
  return {
    panelBounds: { x: 0, y: 0, width: panelWidth, height: panelHeight },
    meetBounds: { x: 0, y: panelHeight, width: panelWidth, height: meetHeight },
    meetZoom: zoom,
    meetInOwnWindow: false,
    clamped,
  };
}

// The MAIN window is ALWAYS a narrow column now (panel + optional Meet thumbnail),
// so its content width is the panel width in both states. Kept as a function so
// main.js has one place to ask, and in case a future state wants a different shape.
function windowWidthFor(state, opts = {}) {
  return (opts.panelWidth || 380); // always a column
}

module.exports = {
  STATES,
  MEET_TARGET_CSS_WIDTH,
  POPPED_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  nextState,
  meetZoomForWidth,
  computeLayout,
  windowWidthFor,
};
