// emoji-assets.js — locate the bundled emoji graphics (#316).
//
// The app ships four emoji sets under electron-app/emoji/<set>/, each ~3.7k
// files named after the emoji's codepoints. Every set uses a slightly different
// filename convention, so turning "🙂" into a path is fiddly enough that two
// copies of the rules WILL drift.
//
// This module is the Node-side source of truth, used by the preloads:
//   · preload-meet  → the virtual camera's face (via page-inject)
//   · preload-panel → the control panel's avatar
//
// page-inject.js keeps its own copy of the filename rules because it is eval'd
// into the PAGE world, where `require` doesn't exist. tests/emoji-assets.test.mjs
// asserts the two agree, so the duplicate can't silently drift.

const fs = require('fs');
const path = require('path');

// Codepoints → hex, under whichever convention the set uses. dropFe0f strips the
// VARIATION SELECTOR-16 that makes an emoji render as a picture rather than text;
// some sets include it in filenames, some don't.
function emojiHex(emoji, { sep = '-', upper = false, dropFe0f = true } = {}) {
  let cps = Array.from(String(emoji)).map((c) => c.codePointAt(0));
  if (dropFe0f) cps = cps.filter((cp) => cp !== 0xfe0f);
  const s = cps.map((cp) => cp.toString(16)).join(sep);
  return upper ? s.toUpperCase() : s;
}

const canon = (e) => emojiHex(e, { sep: '-', upper: false, dropFe0f: true });

// Keep in lockstep with EMOJI_SETS in page-inject.js.
const EMOJI_SETS = {
  twemoji: { dir: 'twemoji', file: (e) => emojiHex(e, { sep: '-', upper: false, dropFe0f: true }) + '.svg' },
  openmoji: { dir: 'openmoji', file: (e) => emojiHex(e, { sep: '-', upper: true, dropFe0f: false }) + '.svg' },
  noto: { dir: 'noto', file: (e) => 'emoji_u' + emojiHex(e, { sep: '_', upper: false, dropFe0f: true }) + '.svg' },
  fluent3d: { dir: 'fluent3d', file: (e) => canon(e) + '.png' },
  redpanda: { dir: 'redpanda', file: (e) => canon(e) + '.png' },
};

// Sets that ship as a COLOUR FONT rather than one file per emoji.
//
// Three sets were ~11,900 SVGs and 76MB; the same artwork as COLRv1/COLR fonts
// is three files and 8.4MB, and renders in colour on a canvas — measured in the
// panel AND inside the real Meet page, where the concern was CSP. It never
// applies: a FontFace built from an ArrayBuffer has no URL, so font-src has
// nothing to check. Coverage was checked against every emoji the avatar uses,
// including the ZWJ sequence 🧑‍💻: 17/17.
//
// fluent3d and redpanda are NOT here and stay as images — rendered/illustrated
// raster art with no font equivalent.
//
// One 🙂 per set survives in the old image dirs on purpose: list_visual_assets
// hands those paths to the whiteboard for the setup call's picker, and the
// whiteboard renders on the WEBSITE, which has no access to a font we bundle.
const EMOJI_FONTS = {
  twemoji: 'fonts/twemoji.ttf',
  openmoji: 'fonts/openmoji.ttf',
  noto: 'fonts/noto.ttf',
};
function fontRelPathFor(setName) {
  return EMOJI_FONTS[setName] || null;
}
// The bytes, for FontFace(). Not a data URI: FontFace takes an ArrayBuffer, and
// base64-ing 4.8MB to immediately decode it again is pure waste.
function fontBytesFor(setName, dirname = __dirname) {
  const rel = fontRelPathFor(setName);
  if (!rel) return null;
  try {
    const buf = fs.readFileSync(path.join(baseDir(dirname), rel));
    // Copy out of Node's pooled Buffer: .buffer is a shared arena, so handing it
    // straight to FontFace would pass megabytes of unrelated memory and a wrong
    // length. Passing buf.buffer directly is a real bug, not a style nit.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// External sets: `dir:/some/folder` — a folder of images, exactly like
// fluent3d, so anyone (or an agent) can make their own.
//
// NO NAMING CONVENTION IS IMPOSED. The four bundled sets each use a different
// one, which is a fair sign that picking a winner would just be picking whose
// set is easy to convert. Instead the folder is INDEXED once and every
// filename is normalised to the same key, so all of these resolve to 🙂:
//
//     🙂.png            the emoji itself — easiest to produce by hand or by agent
//     1f642.png         lowercase hex, FE0F dropped   (twemoji / fluent3d)
//     1F642.svg         uppercase hex, FE0F kept      (openmoji)
//     emoji_u1f642.png  underscore-joined, u-prefixed (noto)
//
// Indexing beats trying candidate filenames: one readdir instead of a stat per
// convention per extension, it is O(1) per lookup afterwards, and it accepts
// spellings nobody thought to enumerate. An emoji with no file falls back to the
// native glyph, exactly as a gap in a bundled set does.
const IMAGE_EXTS = new Set(['.png', '.svg', '.webp', '.gif', '.jpg', '.jpeg', '.apng']);

// A hard cap, because this path takes a directory from a PREFERENCE: an agent
// could point it at a huge tree, and indexing is synchronous.
const MAX_INDEXED_FILES = 5000;

// Normalise any of the spellings above to one key. null = not an emoji filename.
function emojiKeyFromBasename(base) {
  if (!base) return null;
  // Non-ASCII means the file is named after the character itself.
  if (/[^\x00-\x7F]/.test(base)) {
    const k = canon(base);
    return /^[0-9a-f]+(-[0-9a-f]+)*$/.test(k) ? k : null;
  }
  const s = base.toLowerCase().replace(/^emoji_u/, '').replace(/_/g, '-');
  if (!/^[0-9a-f]{2,}(-[0-9a-f]+)*$/.test(s)) return null;
  // Drop FE0F so the openmoji-style and twemoji-style spellings agree.
  const k = s.split('-').filter((c) => c !== 'fe0f').join('-');
  return k || null;
}

const _dirIndexCache = new Map();   // absolute dir -> Map(key -> absolute file)
function indexExternalDir(dir) {
  const abs = path.resolve(String(dir || ''));
  if (_dirIndexCache.has(abs)) return _dirIndexCache.get(abs);
  const index = new Map();
  try {
    const names = fs.readdirSync(abs).sort();   // sorted so collisions resolve the same way every run
    let seen = 0;
    for (const name of names) {
      if (++seen > MAX_INDEXED_FILES) break;
      const ext = path.extname(name).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;       // also what stops this reading non-images
      const key = emojiKeyFromBasename(name.slice(0, -ext.length));
      if (key && !index.has(key)) index.set(key, path.join(abs, name));
    }
  } catch { /* missing or unreadable → an empty index, so every face stays native */ }
  _dirIndexCache.set(abs, index);
  return index;
}
function forgetExternalDir(dir) {
  _dirIndexCache.delete(path.resolve(String(dir || '')));
}

// "dir:/path/to/set" -> "/path/to/set", else null.
function parseDirSet(setName) {
  const m = /^dir:(.+)$/.exec(String(setName || ''));
  return m ? m[1].trim() : null;
}

// A data URI for one emoji from an external folder, or null for native.
function externalDataUri(dir, emoji) {
  const file = indexExternalDir(dir).get(canon(String(emoji || '')));
  if (!file) return null;
  try { return readAsDataUri(file); } catch { return null; }
}

// What the folder actually covers — for reporting back to whoever built it,
// since a missing file is otherwise a silent fallback to the native glyph.
function describeExternalDir(dir) {
  const index = indexExternalDir(dir);
  return { dir: path.resolve(String(dir || '')), count: index.size, keys: [...index.keys()] };
}

// 'native' means "use the OS emoji font" — there is no file to resolve.
// A font-backed set is NOT an image set: it draws glyphs, like native does.
function isImageSet(setName) {
  return !!EMOJI_SETS[setName] && !EMOJI_FONTS[setName];
}

// Packaged builds ship the emoji dir via extraResources; from source it sits
// next to this file.
function baseDir(dirname = __dirname) {
  return dirname.includes('.asar')
    ? path.join(process.resourcesPath, 'emoji')
    : path.join(dirname, 'emoji');
}

// "<set>/<file>" for an emoji, or null when the set is native/unknown.
function relPathFor(setName, emoji) {
  const set = EMOJI_SETS[setName];
  if (!set || !emoji) return null;
  return set.dir + '/' + set.file(emoji);
}

// Read a bundled asset by relative path and return a ready-to-use data URI —
// SVG text or base64 PNG by extension, so callers stay format-agnostic. Returns
// null on any read error, which every caller treats as "fall back to the native
// glyph". Path traversal is stripped: the relative path can come from a pref.
function readAsDataUri(full) {
  if (full.toLowerCase().endsWith('.png')) {
    return 'data:image/png;base64,' + fs.readFileSync(full).toString('base64');
  }
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(fs.readFileSync(full, 'utf-8'));
}

function dataUriForRelPath(relPath, dirname = __dirname) {
  if (!relPath) return null;
  const clean = String(relPath).replace(/\.\.[/\\]/g, '');
  const dir = baseDir(dirname);
  try {
    return readAsDataUri(path.join(dir, clean));
  } catch { /* fall through to the variation-selector retry */ }
  // OpenMoji keeps U+FE0F in ~1000 filenames but NOT all of them (☺️ ships as
  // 263A.svg, not 263A-FE0F.svg), so the one convention can't be right for every
  // emoji. Retry without the selector rather than dropping to the native glyph.
  const stripped = clean.replace(/-FE0F/gi, '');
  if (stripped !== clean) {
    try { return readAsDataUri(path.join(dir, stripped)); } catch { /* genuinely absent */ }
  }
  return null;
}

// The one-shot the panel wants: emoji + set → data URI (or null for native /
// an emoji this set doesn't ship).
function dataUriFor(setName, emoji, dirname = __dirname) {
  return dataUriForRelPath(relPathFor(setName, emoji), dirname);
}

module.exports = {
  IMAGE_EXTS,
  emojiKeyFromBasename,
  indexExternalDir,
  forgetExternalDir,
  parseDirSet,
  externalDataUri,
  describeExternalDir,
  EMOJI_FONTS,
  fontRelPathFor,
  fontBytesFor,
  EMOJI_SETS,
  emojiHex,
  isImageSet,
  baseDir,
  relPathFor,
  dataUriForRelPath,
  dataUriFor,
};
