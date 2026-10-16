// dom-probe.js — what in a calling app's page changes while something happens?
//
// A research tool for adding (or repairing) a call provider. It answered #847 in
// one call: Teams' speaking ring turned out to be the ::before opacity of an
// outline element whose markup never changes, which DOM snapshots and an
// attributes-only watcher both missed. The next platform (Zoom's speaking
// indicator, WhatsApp, Discord…) will hide its signals somewhere equally odd, so
// this stays in the app, off by default.
//
// Turn it on per launch, either way:
//   --dom-probe=1                     the provider's own default items
//   --dom-probe='<css selector>'      watch these elements instead
//   VIBECONF_DOM_PROBE=1 / =<selector>  same, via the environment
//   VIBECONF_DOM_PROBE_MS=100         sampling interval (default 100ms)
//
// For each matched ITEM (e.g. one participant's video tile), every interval it
// samples the item and each descendant (capped), INCLUDING their ::before and
// ::after, across a wide set of computed styles, plus the item's class tokens,
// data-*/aria-* attributes, and every CSS custom property (--*) on the item and
// its ancestors. It logs only what CHANGED, per item and node, with a
// timestamp, tagged so the provider's console forwarder puts it in the session
// log. Then read those lines against the captions / what people did.
//
// Costs real CPU on a busy page (getComputedStyle × nodes × 3 at 10 Hz), which
// is why it is opt-in and never on in a normal call.
'use strict';

const STYLE_KEYS = [
  'opacity', 'visibility', 'display', 'content',
  'borderTopColor', 'borderTopWidth', 'borderTopStyle',
  'outlineColor', 'outlineWidth', 'outlineStyle', 'outlineOffset',
  'boxShadow', 'backgroundColor', 'backgroundImage', 'color', 'filter', 'transform',
  'clipPath', 'maskImage', 'animationName', 'animationPlayState',
  'width', 'height', 'zIndex',
];
const MAX_NODES_PER_ITEM = 400;
// Attribute values longer than this are recorded as length + checksum, so a
// change anywhere in a long value (an SVG path's `d`) still registers.
const MAX_ATTR_CHARS = 120;

// Short, stable checksum (FNV-1a) for long attribute values.
function checksum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}
function attrValue(v) {
  return v.length > MAX_ATTR_CHARS ? `${v.slice(0, 40)}…[${v.length} chars #${checksum(v)}]` : v;
}
const ANCESTOR_DEPTH = 6;

// What the probe should do, from the environment: null (off), or
// { selector, intervalMs }. `defaultSelector` is what "1" means for this provider.
function probeConfig(env, defaultSelector) {
  const raw = String((env && env.VIBECONF_DOM_PROBE) || '').trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return null;
  const selector = (raw === '1' || raw.toLowerCase() === 'true') ? defaultSelector : raw;
  if (!selector) return null;
  const ms = parseInt((env && env.VIBECONF_DOM_PROBE_MS) || '', 10);
  return { selector, intervalMs: Number.isFinite(ms) && ms >= 20 ? ms : 100 };
}

// A readable name for an item: whatever the page labels it with.
function itemName(el, index) {
  for (const a of ['data-tid', 'aria-label', 'data-participant-id', 'data-name', 'title', 'id']) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v) return v.length > 60 ? v.slice(0, 60) + '…' : v;
  }
  return '#' + index;
}

// Field-by-field difference of two flat snapshots; class lists by token, so a
// one-class flip in a 20-token Fluent class string reads as +x / -y.
function diffSnapshots(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (k === '@class' && typeof x === 'string' && typeof y === 'string') {
      const xs = new Set(x.split(/\s+/).filter(Boolean));
      const ys = new Set(y.split(/\s+/).filter(Boolean));
      out['@class'] = {
        added: [...ys].filter((t) => !xs.has(t)),
        removed: [...xs].filter((t) => !ys.has(t)),
      };
    } else {
      out[k] = [x, y];
    }
  }
  return out;
}

// Install in a page. `tag` must be a prefix the provider's console forwarder
// passes through ('[teams]', '[zoom]', '[slack]', '[bots-in-calls]').
function installDomProbe({ tag, defaultSelector, env = (typeof process !== 'undefined' ? process.env : {}), win = globalThis }) {
  const cfg = probeConfig(env, defaultSelector);
  if (!cfg) return false;
  const log = (...a) => win.console.log(tag + ' [dom-probe]', ...a);
  const last = new Map();

  const snapNode = (el, pseudo) => {
    const cs = win.getComputedStyle(el, pseudo || null);
    if (pseudo && (cs.content === 'none' || cs.content === 'normal')) return { none: true };
    const st = {};
    if (!pseudo) {
      // EVERY attribute, not just class/style/data/aria: Zoom's participant-row
      // mic animates inside its SVG (class unchanged across 8,000 samples), so
      // the signal can be in a `d`, `height`, `y` or `clip-path`.
      for (const at of el.attributes) st['@' + at.name] = attrValue(at.value);
    }
    // Styles AFTER attributes, so a truncated log line still shows the attributes.
    for (const k of STYLE_KEYS) st[k] = cs[k];
    return st;
  };
  const customProps = (el) => {
    const out = {};
    for (let n = el, d = 0; n && d < ANCESTOR_DEPTH; n = n.parentElement, d++) {
      const cs = win.getComputedStyle(n);
      for (let i = 0; i < cs.length; i++) {
        const k = cs[i];
        if (k.startsWith('--')) out[d + ':' + k] = cs.getPropertyValue(k).trim();
      }
    }
    return out;
  };
  // Each step carries the element's position among its siblings: tag names
  // alone gave sibling elements the SAME label (Zoom's row: a left and right
  // section div, a video and a mic svg), and the probe then diffed one against
  // the other on every sample — thousands of fake changes a minute.
  const pathIn = (el, item) => {
    if (el === item) return '(item)';
    const parts = [];
    for (let n = el; n && n !== item; n = n.parentElement) {
      const tid = n.getAttribute('data-tid') || n.getAttribute('data-testid');
      const idx = n.parentElement ? Array.prototype.indexOf.call(n.parentElement.children, n) : 0;
      parts.unshift(n.tagName.toLowerCase() + ':' + idx + (tid ? '[' + tid + ']' : ''));
    }
    return parts.join('>');
  };
  // Elements can signal by being INSERTED and REMOVED (Zoom's row inserts a
  // span while someone talks), so absence is tracked too: a key not seen in a
  // sample is logged GONE and forgotten, and its return is logged APPEAR.
  // `init` marks what was there on the first sample.
  let firstSample = true;
  let seen = new Set();
  const record = (key, snap) => {
    seen.add(key);
    const fp = JSON.stringify(snap);
    const prev = last.get(key);
    if (prev === fp) return;
    last.set(key, fp);
    if (prev === undefined) {
      // An empty pseudo-element is tracked (so it diffs if it gains content)
      // but not announced: every element has two, and nearly all are empty.
      if (!snap.none) log(firstSample ? 'init' : 'APPEAR', key, fp.length > 600 ? fp.slice(0, 600) + '…' : fp);
      return;
    }
    log('CHANGE', key, JSON.stringify(diffSnapshots(JSON.parse(prev), snap)));
  };
  const sweepGone = () => {
    for (const key of last.keys()) {
      if (seen.has(key)) continue;
      last.delete(key);
      // A gone element's pseudo-elements go with it; one line per element.
      if (!key.endsWith('::before') && !key.endsWith('::after')) log('GONE', key);
    }
    seen = new Set();
    firstSample = false;
  };

  win.setInterval(() => {
    let items;
    try { items = win.document.querySelectorAll(cfg.selector); } catch { return; }
    items.forEach((item, i) => {
      const name = itemName(item, i);
      const nodes = [item, ...Array.from(item.querySelectorAll('*')).slice(0, MAX_NODES_PER_ITEM)];
      for (const el of nodes) {
        const where = name + ' | ' + pathIn(el, item);
        try {
          record(where, snapNode(el));
          record(where + '::before', snapNode(el, '::before'));
          record(where + '::after', snapNode(el, '::after'));
        } catch { /* node left the DOM mid-sample */ }
      }
      try { record(name + ' | --vars', customProps(item)); } catch { /* ditto */ }
    });
    sweepGone();
  }, cfg.intervalMs);
  log(`running every ${cfg.intervalMs}ms on`, JSON.stringify(cfg.selector));
  return true;
}

module.exports = { installDomProbe, probeConfig, diffSnapshots, itemName, attrValue, checksum, STYLE_KEYS };
