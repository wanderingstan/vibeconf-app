// ui-icons.test.mjs — the panel's chrome icons.
//
// renderer/ui-icons.css is GENERATED from the bundled OpenMoji art. Nothing at
// runtime regenerates it, so the committed file is what actually ships: if
// someone edits it by hand, or bumps the emoji assets without re-running the
// generator, the app quietly renders stale icons. The first test re-runs the
// generator in memory and fails on any difference.
//
// The rest pin the reason the icons exist at all — that the panel's chrome no
// longer depends on the OS emoji font — and, just as importantly, the two places
// where emoji were deliberately KEPT.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS, MIRRORED, VENDORED, buildCss, iconSvg, cssUrl } from '../scripts/gen-ui-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const CSS_PATH = 'electron-app/renderer/ui-icons.css';
const css = read(CSS_PATH);
const panelHtml = read('electron-app/renderer/panel.html');
const panelJs = read('electron-app/renderer/panel.js');
const panelCss = read('electron-app/renderer/panel.css');

test('the committed ui-icons.css matches what the generator produces', () => {
  assert.strictEqual(
    css,
    buildCss(),
    `${CSS_PATH} is out of date — run: node scripts/gen-ui-icons.mjs`,
  );
});

test('every icon resolves to real outline art, not an empty shell', () => {
  for (const [name, cp] of Object.entries(ICONS)) {
    const svg = iconSvg(cp);
    // A <g id="line"> that survived extraction has actual geometry in it. An
    // empty group would still be valid SVG and would render as nothing at all.
    assert.match(svg, /<(path|circle|rect|line|polyline|polygon|ellipse)\b/, `${name} has no geometry`);
    assert.match(svg, /viewBox="0 0 72 72"/, `${name} lost its viewBox`);
    // The colour layer must NOT come along — it would defeat the mask, which
    // paints the whole opaque area with currentColor.
    assert.ok(!svg.includes('id="color"'), `${name} dragged the colour layer in`);
    assert.ok(css.includes(`.ui-icon-${name} {`), `${name} is missing its CSS rule`);
  }
});

test('vendored icons are real art with a CSS rule', () => {
  // The gear is not OpenMoji — it's Octicons' gear-24, pasted in because that
  // set draws for the 24px box this panel actually uses. Same requirements as
  // the extracted glyphs: real geometry, a viewBox so the mask can scale it,
  // and no colour layer to fight the currentColor fill.
  for (const [name, svg] of Object.entries(VENDORED)) {
    assert.match(svg, /<(path|circle|rect|line|polyline|polygon|ellipse)\b/, `${name} has no geometry`);
    assert.match(svg, /viewBox="0 0 \d+ \d+"/, `${name} lost its viewBox`);
    assert.ok(!svg.includes('id="color"'), `${name} dragged the colour layer in`);
    assert.ok(css.includes(`.ui-icon-${name} {`), `${name} is missing its CSS rule`);
  }
  // And the gear specifically must not fall back to OpenMoji's ⚙ (U+2699),
  // whose toothed hairline rim is illegible at this size.
  assert.ok(VENDORED.gear, 'the gear is no longer vendored');
  assert.ok(!Object.keys(ICONS).includes('gear'), 'the gear is being drawn from OpenMoji again');
});

test('the eyes are mirrored so they look toward the button', () => {
  // OpenMoji draws 👀 glancing left, away from the control it sits beside.
  const flipped = iconSvg(ICONS.eyes, { mirror: true });
  // Both halves matter: scale(-1,1) alone reflects about x=0 and would put the
  // glyph off the canvas entirely, leaving an empty icon that still validates.
  assert.match(flipped, /transform="translate\(72,0\) scale\(-1,1\)"/);
  assert.ok(css.includes('translate(72,0) scale(-1,1)'), 'the shipped eyes icon is not mirrored');
  // And only that one — a flip applied to the gear or the clipboard would be a
  // bug nobody notices until they read the artwork closely.
  assert.deepStrictEqual([...MIRRORED], ['eyes']);
  for (const [name, cp] of Object.entries(ICONS)) {
    if (name === 'eyes') continue;
    assert.ok(!iconSvg(cp, { mirror: false }).includes('scale(-1,1)'), `${name} should not be flipped`);
  }
});

test('data URIs are escaped so they survive a CSS url()', () => {
  // "#" is the one that bites: unescaped, everything after stroke="#000" is
  // parsed as a URL fragment and the icon silently disappears.
  const url = cssUrl('<svg fill="#000"><path d="M0 0"/></svg>');
  assert.ok(!url.includes('#'), 'unescaped # would truncate the data URI');
  assert.ok(!url.includes('<'), 'unescaped < is not valid in a url()');
  assert.ok(url.startsWith('url("data:image/svg+xml,'), 'wrong data URI prefix');
});

test('icons are masks painted with currentColor, not fixed-colour images', () => {
  // This is what lets one asset work on the dark panel, in a hover state, and
  // in the blue "current bot" menu row. An <img> would be stuck at black.
  assert.match(css, /background-color:\s*currentColor/);
  assert.match(css, /-webkit-mask:\s*var\(--ui-icon\)/);
  assert.match(css, /[^-]mask:\s*var\(--ui-icon\)/);
});

test('panel chrome uses the icon classes, not emoji characters', () => {
  for (const [name, glyph] of [
    ['gear', '⚙'],
    ['eyes', '\u{1F440}'],
    ['construction', '\u{1F6A7}'],
    ['screen', '\u{1F5A5}'],
    ['speaker', '\u{1F50A}'],
  ]) {
    assert.ok(panelHtml.includes(`ui-icon-${name}`), `panel.html lost the ${name} icon`);
    // Comments still talk about the glyphs — strip them before checking that no
    // LIVE markup renders one.
    //
    // The call-feedback row is a DELIBERATE exception, agreed for the
    // troubleshooting window only: those seven buttons are scanned mid-call, and
    // colour plus instant recognition matters more there than OS-independent
    // rendering. It is a debug surface, not product chrome. Excluded by region
    // rather than by weakening the rule, so the rest of the panel stays covered
    // — including the 🔊 speaker glyph, which appears in both places.
    const markup = panelHtml
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<div class="fb-row">[\s\S]*?<\/div>/, '');
    assert.ok(!markup.includes(glyph), `panel.html still renders the ${glyph} character`);
  }
  // The gear was an HTML entity rather than a literal, so it needs its own check.
  assert.ok(!panelHtml.includes('&#9881;'), 'panel.html still renders the ⚙ entity');
  // The two profile-menu items are built in JS, not markup.
  assert.match(panelJs, /uiIcon\('folder', 'lead'\)/);
  assert.match(panelJs, /uiIcon\('clipboard', 'lead'\)/);
});

test('the stylesheet is actually loaded, and before panel.css', () => {
  // Match the <link> tags, not any mention of the filename — the markup has a
  // comment explaining the order, which names panel.css before the first link.
  const sheets = [...panelHtml.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]);
  assert.ok(sheets.includes('ui-icons.css'), 'panel.html does not load ui-icons.css');
  assert.ok(
    sheets.indexOf('ui-icons.css') < sheets.indexOf('panel.css'),
    'ui-icons.css must come first so panel.css can size the icons',
  );
});

test('standalone icon buttons get an explicit pixel box', () => {
  // Their font-size was chosen for an emoji glyph's em box, which these outlines
  // do not share — left on 1.15em they render noticeably too large.
  assert.match(panelCss, /button\.agent-gear \.ui-icon \{[^}]*width:\s*\d+px/);
  assert.match(panelCss, /button\.join-more \.ui-icon \{[^}]*width:\s*\d+px/);
});

test('the share button keeps its icon when the label flips', () => {
  // The old code rewrote textContent, which would now delete the icon element
  // along with the word.
  assert.match(panelJs, /\.share-window-label/);
  assert.ok(
    !/shareWindowToggleBtn\.textContent\s*=/.test(panelJs),
    'setting textContent on the share button would wipe out its icon',
  );
});

test('colour-coded status dots are still emoji', () => {
  // 🟢/🔴/🟡/⚪ carry their meaning IN the colour. Rendered through the
  // monochrome mask they would all be one indistinguishable grey blob, so they
  // are deliberately excluded from ICONS.
  for (const dot of ['\u{1F7E2}', '\u{1F534}', '\u{1F7E1}', '⚪']) {
    assert.ok(panelJs.includes(dot), `the ${dot} status dot went missing`);
  }
  for (const cp of ['1F7E2', '1F534', '1F7E1', '26AA']) {
    assert.ok(!Object.values(ICONS).includes(cp), `U+${cp} must not be a monochrome icon`);
  }
});

test('the bot\'s own face is left to the user\'s emoji set', () => {
  // The face is rendered in-call and in the avatar via the emojiSet preference
  // (emoji-assets.js). It is content, not chrome — the user picks its style.
  assert.match(panelHtml, /agentAvatarEmoji/);
  assert.ok(!/ui-icon/.test(panelHtml.split('agentAvatarEmoji')[1].slice(0, 200)));
});
