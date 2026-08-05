import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { PREFERENCES, validate } = require('../electron-app/preferences-schema.js');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');

// emojiSet answers ONE question — how is the face drawn — so a machine-local
// font is encoded in it rather than living in a second preference with a
// precedence rule between them. Two settings that can disagree is a bug waiting
// to be filed; there is nothing to disagree with here.
test('emojiSet accepts a bundled set OR font:<Family>, and nothing else', () => {
  for (const ok of ['native', 'twemoji', 'fluent3d', 'font:UnifontExMono', 'font:Comic Sans MS']) {
    assert.equal(validate('emojiSet', ok).ok, true, `${ok} should be valid`);
  }
  for (const bad of ['bogus', 'font:', 'font:has;semicolon', 'font:quote"here', '']) {
    assert.equal(validate('emojiSet', bad).ok, false, `${bad} should be rejected`);
  }
  assert.ok(!('emojiFont' in PREFERENCES), 'no second preference — the font lives in emojiSet');
});

test('the error message names the font form, so a wrong guess is actionable', () => {
  const err = validate('emojiSet', 'bogus').error;
  assert.match(err, /native, twemoji/);
  assert.match(err, /font:/, 'a user told only the enum would never discover the font form');
});

test('a font family is sanitised before reaching a CSS font shorthand', () => {
  // ctx.font is CSS. A malformed shorthand is a SILENT no-op — the assignment is
  // ignored and the previous font stays — so an unsanitised name would render
  // the wrong face with nothing logged.
  assert.match(inject, /function sanitizeFontFamily/);
  assert.match(inject, /replace\(\/\[\^A-Za-z0-9 _-\]\/g, ''\)/);
  assert.match(panel, /function fontFamilyFromSet/);
  assert.match(panel, /replace\(\/\[\^A-Za-z0-9 _-\]\/g, ''\)/);
});

test('an uninstalled family falls back to a real face, not tofu', () => {
  // Both stacks are built as a list now — user font, then the bundled set's
  // font, then the OS emoji font — but the invariant is unchanged: something
  // that can actually draw a face is always last.
  const stack = inject.slice(inject.indexOf('function emojiFontStack'));
  assert.match(stack.slice(0, 600), /families\.push\('serif'\);/);
  assert.match(panel, /const NATIVE_EMOJI_STACK/);
  const pstack = panel.slice(panel.indexOf('function emojiFontStackFor'));
  assert.match(pstack.slice(0, 400), /parts\.push\(NATIVE_EMOJI_STACK\);/);
});

test('the panel understands the font form too', () => {
  // The panel draws its OWN avatar and switcher thumbnail. It not knowing the
  // font form is exactly how this was first spotted: the call showed the font
  // and the app's own picture of the bot did not.
  assert.match(panel, /if \(fontFamilyFromSet\(setName\) \|\| EMOJI_FONT_SETS\[setName\]\) return null;/,
    'glyphs — for a user font OR a bundled set font — must skip the image path');
  assert.match(panel, /emojiFontStackFor\(emojiSet\)/);
  // An unknown <select> value blanks the control, so a font needs a real option.
  assert.match(panel, /data-font-option/);
});

test('a font value resolves to the native draw path in the call', () => {
  const h = inject.slice(inject.indexOf("case 'set-emoji-set':"));
  const body = h.slice(0, h.indexOf('break;'));
  assert.match(body, /parseEmojiFontValue\(raw\)/);
  assert.match(body, /emojiSetGlobal = \(!asFont &&/,
    'a font must not also select a picture set — they answer the same question');
});

// A monochrome font has no colour of its own, so it drew in the canvas default:
// black. The colour rides in the same string for the same reason the family
// does — one value answering "how is the face drawn".
test('font:<Family> takes an optional hex colour', () => {
  for (const ok of ['font:UnifontExMono#ffcc00', 'font:UnifontExMono#fff', 'font:X#ffcc00aa']) {
    assert.equal(validate('emojiSet', ok).ok, true, `${ok} should be valid`);
  }
  for (const bad of ['font:UnifontExMono#zzz', 'font:UnifontExMono#', 'font:X#12']) {
    assert.equal(validate('emojiSet', bad).ok, false, `${bad} should be rejected`);
  }
});

test('the colour is strict hex before it reaches fillStyle', () => {
  // An invalid fillStyle is IGNORED SILENTLY, exactly like a malformed ctx.font,
  // so a loose parse would draw the previous colour with nothing logged.
  assert.match(inject, /\^font:\(\[\^#\]\+\)\(\?:#\(\[0-9A-Fa-f\]\{3,8\}\)\)\?\$/);
  assert.match(panel, /\^font:\(\[\^#\]\+\)\(\?:#\(\[0-9A-Fa-f\]\{3,8\}\)\)\?\$/);
  assert.match(inject, /if \(emojiFontColorGlobal\) ctx\.fillStyle = emojiFontColorGlobal;/);
});

test('avatar styling is module state, so a blink cannot wipe it', () => {
  // Regression: font and colour were paintAvatarEmoji PARAMETERS, and the blink
  // path repaints without them — so the styling applied on render and was wiped
  // by the first blink a second later, which read as "the colour does nothing".
  assert.match(panel, /let avatarFontStack = '';/);
  assert.match(panel, /let avatarFontColor = '';/);
  assert.match(panel, /function paintAvatarEmoji\(el, dataUri, emojiChar\) \{/,
    'no styling parameters — every repaint path must get it by construction');
  const fn = panel.slice(panel.indexOf('function paintAvatarEmoji'));
  assert.match(fn.slice(0, 400), /glyph\.style\.color = avatarFontColor \|\| '';/);
});

test('an agent-set face repaints the panel now, not on the 60s timer', () => {
  // The panel and the call disagreeing is what made the font look broken in the
  // first place; a minute of staleness is the same bug, just quieter.
  const h = panel.slice(panel.indexOf("if (message?.action !== 'config-updated') return;"));
  const body = h.slice(0, 1600);  // must reach past the comment block to the focus guard
  assert.match(body, /changed === 'emojiSet' \|\| changed === 'avatarBackgroundSvg'/);
  assert.ok(body.indexOf('renderAgentAvatar()') < body.indexOf('activeElement'),
    'the avatar is a picture, not a form control — it must repaint before the focus guard');
});

// --- bundled sets as colour fonts -------------------------------------------
// twemoji / openmoji / noto were ~11,900 SVGs and 76MB. The same artwork as
// COLR fonts is three files and 8.4MB, drawn as glyphs on the same code path as
// 'native'. Proven in the real Meet page before any of this was written: the
// font loads from bytes and renders in colour, and CSP never applies because a
// FontFace built from an ArrayBuffer has no URL to check.
test('the three big sets ship as fonts, and fluent3d does not', () => {
  const A = require('../electron-app/emoji-assets.js');
  assert.deepEqual(Object.keys(A.EMOJI_FONTS).sort(), ['noto', 'openmoji', 'twemoji']);
  assert.equal(A.EMOJI_FONTS.fluent3d, undefined,
    'fluent3d is rendered 3D raster art — no font exists for it');
  // A font-backed set is NOT an image set: it draws glyphs, like native.
  assert.equal(A.isImageSet('twemoji'), false);
  assert.equal(A.isImageSet('fluent3d'), true);
});

test('the font files are actually bundled', () => {
  for (const set of ['twemoji', 'openmoji', 'noto']) {
    const p = join(root, 'electron-app/emoji/fonts', `${set}.ttf`);
    assert.ok(existsSync(p), `${set}.ttf must ship`);
    assert.ok(statSync(p).size > 500_000, `${set}.ttf looks truncated`);
  }
});

test('font bytes are copied out of the pooled Buffer', () => {
  // Node's readFileSync returns a view into a SHARED arena. Handing .buffer
  // straight to FontFace would pass megabytes of unrelated memory with the
  // wrong length — a real bug, not a style nit.
  const src = readFileSync(join(root, 'electron-app/emoji-assets.js'), 'utf8');
  assert.match(src, /buf\.buffer\.slice\(buf\.byteOffset, buf\.byteOffset \+ buf\.byteLength\)/);
});

test('one sample image per set survives, for the whiteboard picker', () => {
  // list_visual_assets hands the whiteboard a file path per set, and the
  // whiteboard renders on the WEBSITE — which has no access to a font we
  // bundle. Deleting these would silently empty the setup call's picker grid.
  for (const rel of ['twemoji/1f642.svg', 'openmoji/1F642.svg', 'noto/emoji_u1f642.svg']) {
    assert.ok(existsSync(join(root, 'electron-app/emoji', rel)), `${rel} must survive`);
  }
});

test('the OpenMoji art the UI icons are generated from survives', () => {
  // scripts/gen-ui-icons.mjs lifts these from emoji/openmoji/. Deleting the set
  // wholesale broke the icon build — caught by its own test, kept here so the
  // dependency is visible from the emoji side too.
  for (const cp of ['1F440', '1F6A7', '1F5A5', '1F50A', '1F4C2', '1F4CB', '1F9E0']) {
    assert.ok(existsSync(join(root, 'electron-app/emoji/openmoji', `${cp}.svg`)),
      `${cp}.svg is used by gen-ui-icons.mjs`);
  }
});

test('a failed font load leaves a face, not tofu', () => {
  const fn = inject.slice(inject.indexOf('function _ensureEmojiFont'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /catch/, 'a broken font must not throw into the draw loop');
  // Not added to document.fonts on failure → the stack falls through to serif.
  assert.ok(body.indexOf('document.fonts.add') < body.indexOf('.catch('),
    'add only on success; the tail of the font stack is the fallback');
});

test('the bundled fonts carry their required attribution', () => {
  // Twemoji is CC-BY 4.0 and OpenMoji CC BY-SA 4.0: attribution is a LICENCE
  // CONDITION, not politeness. Deleting the sets took their NOTICE.md files with
  // them — the same artwork still ships, just as fonts, so the notices must too.
  const n = readFileSync(join(root, 'electron-app/emoji/fonts/NOTICE.md'), 'utf8');
  assert.match(n, /CC-BY 4\.0/, 'Twemoji');
  assert.match(n, /CC BY-SA 4\.0/, 'OpenMoji');
  assert.match(n, /Apache License 2\.0/, 'Noto');
  for (const s of ['twemoji', 'openmoji', 'noto']) {
    assert.match(n, new RegExp(`${s}\\.ttf`), `${s}.ttf must be named in the notice`);
    assert.ok(existsSync(join(root, 'electron-app/emoji', s, 'NOTICE.md')),
      `${s} keeps its own notice alongside its sample`);
  }
});
