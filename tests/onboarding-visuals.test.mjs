// onboarding-visuals.test.mjs — show the options, don't list them.
//
// The guided setup asked people to pick an emoji set from the words
// "fluent3d, twemoji, openmoji, noto, native", and a background from eight
// filenames. Both are questions a picture answers instantly, on a call where a
// whiteboard is already being shared.
//
// Run: node --test tests/onboarding-visuals.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

test('the app can hand the agent real paths to its own sample art', () => {
  // The agent cannot construct these: every emoji set names its files
  // differently (1f642.png / 1F642.svg / emoji_u1f642.svg), and a packaged
  // build resolves them somewhere else entirely.
  const v = new LocalServer({ port: 0 }).visualAssets();
  assert.ok(v.emojiSets.length >= 3, `expected several emoji sets, got ${v.emojiSets.length}`);
  assert.ok(v.backgrounds.length >= 5, `expected the preset backgrounds, got ${v.backgrounds.length}`);
  for (const e of v.emojiSets) {
    assert.ok(existsSync(e.path), `${e.set} sample missing at ${e.path}`);
    assert.equal(e.emoji, '🙂');
  }
  for (const b of v.backgrounds) {
    assert.ok(existsSync(b.path), `${b.name} missing at ${b.path}`);
  }
  assert.ok(v.backgrounds.some((b) => b.name === 'forest'), 'the named presets should be there');
});

test("only image sets are listed — 'native' has no file", () => {
  // Shipping a path for the OS font would put a broken image on the board.
  const v = new LocalServer({ port: 0 }).visualAssets();
  assert.ok(!v.emojiSets.some((e) => e.set === 'native'));
  assert.match(mcp, /native.*no file.*operating system/i, 'the tool must say so in words');
});

test('several images can go on one board, so a grid is possible', () => {
  // image_path handles ONE image appended after the text, which cannot express
  // "eight backgrounds in a table". Local paths written into the markdown are
  // registered and rewritten in place, so the agent controls the layout.
  const fn = mcp.slice(mcp.indexOf('const localImg ='));
  const body = fn.slice(0, fn.indexOf('if (image_path)'));
  assert.match(body, /matchAll\(localImg\)/);
  assert.match(body, /api\/whiteboard-asset/);
  assert.match(body, /content\.replace\(localImg/);
  // A path that will not register is left alone rather than deleted: a broken
  // image is visible and findable; a silently dropped one looks like a choice.
  assert.match(body, /seen\.has\(p\) \? .* : whole/);
});

test('the same image is registered once, not per occurrence', () => {
  const fn = mcp.slice(mcp.indexOf('const localImg ='));
  const body = fn.slice(0, fn.indexOf('if (image_path)'));
  assert.match(body, /if \(seen\.has\(p\)\) continue;/);
});

test('the docs no longer forbid what now works', () => {
  // The old text said "do not embed local images here — use image_path", which
  // was true when it was written and is the reason nobody tried a grid.
  const desc = mcp.slice(mcp.indexOf('content: z.string().optional()'));
  const line = desc.slice(0, desc.indexOf('\n'));
  assert.doesNotMatch(line, /Do not embed local images/);
  assert.match(line, /!\[city\]\(\/abs\/path\/city\.svg\)/, 'show the exact syntax');
  assert.match(line, /Base64 data URIs are still not supported/, 'the real limit stays stated');
});

test('the skill shows the emoji sets and the background grid', () => {
  assert.match(skill, /Show the sets, do not list them/);
  assert.match(skill, /list_visual_assets/);
  // The grid's last cell is the custom path — the presets are a menu, not a
  // limit, and nobody discovers "describe your own" from eight filenames.
  assert.match(skill, /…or describe one/);
  assert.match(skill, /Tell me the image you'd like/);
  assert.match(skill, /One grid, all of them at once/);
  // And the tool is actually allowed, or the agent cannot call it.
  assert.match(skill, /allowed-tools:.*mcp__vibeconferencing__list_visual_assets/);
});

test('the skill version was bumped, or nobody gets any of this', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const m = main.match(/const SKILL_VERSION = '(\d+)'/);
  assert.ok(m && Number(m[1]) >= 39, `SKILL_VERSION is ${m && m[1]}, expected >= 39`);
});

test('both grids restyle before drawing, because markdown cannot size an image', () => {
  // Observed on a real call: the fluent3d PNG rendered several hundred pixels
  // wide beside a tiny noto SVG, which reads as "these sets differ in quality"
  // rather than "these are the same face drawn four ways". The background grid
  // had it worse — uneven images AND ragged columns, because the table sizes
  // itself around whatever the widest image happens to be.
  //
  // set_whiteboard_style is the only lever: the whiteboard is rendered by the
  // website, so its stylesheet is not ours to patch, and markdown has no way to
  // size an image.
  assert.match(skill, /Size the images first — this is not optional/);
  assert.match(skill, /table-layout: fixed/, 'the part that equalises the columns');
  // Emoji are square glyphs: fix the HEIGHT. Backgrounds are 16:9 scenes: fix
  // the WIDTH. Applying the emoji rule to backgrounds leaves ragged columns,
  // which is exactly what the second screenshot showed.
  assert.match(skill, /table img \{ height: 84px/, 'emoji sized by height');
  assert.match(skill, /table img \{ width: 100%/, 'backgrounds sized by width');
  assert.match(skill, /Restyle for these before drawing the grid/);
});

test("native is a real cell showing the real character", () => {
  // It has no file because it IS the machine's own emoji font — so the honest
  // preview is the character itself, drawn by the machine. A footnote saying
  // "native — whatever this computer uses" describes the option instead of
  // showing it, which is the thing this whole step is fixing.
  assert.match(skill, /Include `native` as a real cell, not a footnote/);
  assert.match(skill, /class="native-face">🙂</);
  assert.match(skill, /\.native-face \{ font-size: 68px/, 'sized to match its neighbours');
  assert.match(mcp, /put the character itself/, 'the tool says so too');
});
