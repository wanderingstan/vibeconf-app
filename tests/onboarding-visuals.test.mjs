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

test('the native cell names the platform only when it is known', () => {
  // First pass here forbade naming the platform outright. That was wrong: the
  // agent runs on the same machine as the app and its environment states the
  // OS, so "whatever this Mac already uses (Apple's own)" is BETTER than a
  // generic label — it tells the user what they will actually get.
  //
  // The rule that survives is narrower: do not GUESS. An invented OS or font
  // vendor is a confident-sounding error in the first minute of use.
  assert.match(skill, /do not guess/i);
  assert.match(skill, /whatever this machine already uses/, 'the fallback when it is unknown');
  assert.match(skill, /your environment tells you its platform/);
  // The tool description stays neutral — it has no machine to speak of.
  assert.match(mcp, /operating system's own emoji font/);
});


test('a rejoin cancels the pending after-call teardown', () => {
  // leave_call arms a timer (afterCallWorkSeconds, 300 by default) that ends the
  // agent when the wrap-up window expires. Nothing cleared it on a JOIN, so an
  // agent that left and came back inside that window was carrying its own
  // execution date: the timer fired mid-call, tore the call down and killed the
  // agent, with no cause visible from inside the room.
  //
  // This is what makes leave-then-rejoin viable, and leave-then-rejoin is the
  // only way to change the Meet display name — Meet takes it at join (#249).
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('onJoinCall: (meetCode, botName)'));
  const body = fn.slice(0, fn.indexOf('logSessionHeaderUpdate'));
  assert.match(body, /clearTimeout\(_afterCallWorkTimer\)/);
  assert.match(body, /_afterCallWorkTimer = null/);
});

test('both skills give the rename flow in the order that works', () => {
  // A guided setup renamed the bot and the tile kept the old name. The agent
  // would not leave and rejoin (correctly — leaving alone ends its session), so
  // it joined again WITHOUT leaving and left a zombie participant.
  //
  // Leave-then-rejoin is fine; the order is the whole thing.
  const joinSkill = readFileSync(join(root, 'mcp-server/join-call-skill.md'), 'utf8');
  for (const [name, text] of [['onboarding', skill], ['join-call', joinSkill]]) {
    assert.match(text, /Leave BEFORE (you )?rejoin/i, `${name} must state the order`);
    assert.match(text, /zombie/, `${name} should say what going the other way costs`);
    assert.match(text, /after-call work window/, `${name} should explain why it is safe`);
  }
  // And promptness matters: the window is finite.
  assert.match(skill, /rejoin as the very next tool call/);
});


test('the naming step offers options before testing one', () => {
  // Every new bot now gets a seeded name so it is never "Unnamed bot" — which
  // made the skill's "if a name was already chosen, skip to the check" branch
  // fire ALWAYS. The bot opened with "let's check that Bjorn works", so the name
  // read as decided before the user had seen a single alternative.
  assert.match(skill, /Offer names first/);
  assert.match(skill, /suggest_bot_names/);
  assert.match(skill, /placeholder, not a choice/);
  // Order matters, not just presence.
  const offer = skill.indexOf('suggest_bot_names');
  const check = skill.indexOf('check the name actually works');
  assert.ok(offer > -1 && check > offer, 'suggest, then verify — not the other way round');
});

test('the naming step does not explain the machinery', () => {
  // "so we can hear how Google's live transcript renders it back" is true and
  // irrelevant: the user did not ask, cannot act on it, and it turns picking a
  // name into a technical decision instead of a fun one.
  const step = skill.slice(skill.indexOf('### 4a. Name'), skill.indexOf('### 4b'));
  assert.match(step, /Keep the reason to yourself/);
  assert.match(step, /Do NOT explain transcription, captions, or Google Meet/);
  assert.match(step, /make sure I catch it when you say it/, 'give the words to use instead');
  // The agent still needs to KNOW why, or it cannot do the check.
  assert.match(step, /read_transcripts/);
});

test('suggested names come from the curated pool, minus the taken ones', () => {
  // Not invented on the spot: the pool exists BECAUSE names differ in how
  // reliably the bot hears itself addressed, which is not visible from a name.
  // And two bots answering to one name makes MCP routing by name ambiguous.
  const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const route = server.slice(server.indexOf("'/api/name-suggestions'"));
  const body = route.slice(0, route.indexOf('return;'));
  assert.match(body, /randomBotName/);
  assert.match(body, /this\.getTakenBotNames\(\)/);
  assert.match(body, /\[\.\.\.taken, \.\.\.picks\]/, 'no repeats within one list either');
  assert.match(mcp, /suggest_bot_names/);
});
