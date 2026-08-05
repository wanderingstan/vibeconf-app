import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(inject, /px "\$\{emojiFontGlobal\}", serif/);
  assert.match(panel, /const NATIVE_EMOJI_STACK/);
  assert.match(panel, /`"\$\{fam\}", \$\{NATIVE_EMOJI_STACK\}`/);
});

test('the panel understands the font form too', () => {
  // The panel draws its OWN avatar and switcher thumbnail. It not knowing the
  // font form is exactly how this was first spotted: the call showed the font
  // and the app's own picture of the bot did not.
  assert.match(panel, /if \(fontFamilyFromSet\(setName\)\) return null;/,
    'a font is glyphs, so no image data URI — the glyph path must run');
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
