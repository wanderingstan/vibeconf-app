// voice-name-override.test.mjs — speak(voice: 'George') must work.
//
// Measured live 2026-08-04, three dead utterances in one guided setup call:
//   ElevenLabs API error 404: voice_id 'Chris' was not found
//   ElevenLabs API error 404: voice_id 'River' was not found
//   ElevenLabs API error 404: voice_id 'George' was not found
//
// speak()'s voice override matched macOS voices BY NAME and Voicebox profiles
// BY NAME, then passed anything else through as an ElevenLabs voice_id. So the
// two providers a bot is least likely to use accepted names, and the default
// one silently required an opaque 20-character token.
//
// The bot went silent rather than erring anywhere the user could see it, which
// is the failure shape this codebase keeps having to design against.
//
// Run: node --test tests/voice-name-override.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('the ElevenLabs branch resolves a name, like the other two providers', () => {
  const block = main.slice(main.indexOf('if (systemVoiceNameSet.has(voice))'));
  const body = block.slice(0, block.indexOf('\n    }'));
  assert.match(body, /systemVoiceNameSet\.has\(voice\)/, 'macOS matches by name');
  assert.match(body, /voiceboxProfileNameSet\.has\(voice\)/, 'Voicebox matches by name');
  assert.match(body, /voiceId: resolveElevenLabsVoice\(voice\)/,
    'and ElevenLabs must too — it was the only one that did not');
  assert.doesNotMatch(body, /voiceId: voice\b/, 'no raw pass-through left');
});

test('a name that is not known falls back to treating it as an id', () => {
  // Ids are opaque 20-character tokens that cannot collide with a readable
  // name, so a miss is safe and keeps working for anyone passing a real id —
  // including every existing stored preference.
  const fn = main.slice(main.indexOf('function resolveElevenLabsVoice'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /elevenLabsIdByName\.get\(String\(voice\)\.toLowerCase\(\)\) \|\| voice/);
});

test('the lookup is case-insensitive', () => {
  // "george" is what someone says out loud; "George" is what the API lists.
  const fn = main.slice(main.indexOf('function warmElevenLabsVoiceNames'));
  assert.match(fn.slice(0, 900), /full\.toLowerCase\(\)/, 'keys are stored lowercased');
  const res = main.slice(main.indexOf('function resolveElevenLabsVoice'));
  assert.match(res.slice(0, 300), /String\(voice\)\.toLowerCase\(\)/, 'and looked up lowercased');
});

test('the name cache is warmed at startup, beside the other two', () => {
  // The other two name sets are warmed in the same place. Missing this one is
  // exactly how the asymmetry survived.
  assert.match(main, /warmElevenLabsVoiceNames\(\);/);
  const warm = main.indexOf('warmElevenLabsVoiceNames();');
  const vb = main.indexOf('voiceboxProfileNameSet = new Set(ps.map');
  assert.ok(Math.abs(warm - vb) < 1200, 'warmed alongside the Voicebox names, not somewhere unrelated');
});

test('an empty cache cannot make things worse', () => {
  // Warming is async and best-effort: if it fails or has not finished, resolve
  // returns the input unchanged, which is precisely the old behaviour.
  const fn = main.slice(main.indexOf('async function warmElevenLabsVoiceNames'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(voices && voices\.length\)/, 'never install an empty map');
  assert.match(body, /catch/, 'a failed warm must not throw at startup');
});

test('the leading name resolves, not just the full label', () => {
  // The first version of this fix matched the API's name EXACTLY, which is
  // correct against the API and useless against a real account. Live data:
  //
  //   "Chris - Charming, Down-to-Earth"
  //   "River - Relaxed, Neutral, Informative"
  //   "George - Warm, Captivating Storyteller"
  //   "Jessica - Playful, Bright, Warm"
  //
  // Those are labels, not names. Nobody says one aloud, and an agent told to
  // "use George" sends "George" — so all four still 404'd after the fix, for
  // four more silent utterances.
  const fn = main.slice(main.indexOf('async function warmElevenLabsVoiceNames'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /full\.split\(\/\\s\+\[-–—\]\\s\+\/\)\[0\]/, 'index the leading name too');
  assert.match(body, /map\.set\(full\.toLowerCase\(\), v\.id\)/, 'and keep the full label working');
});

test('a short name cannot be stolen by a later voice', () => {
  // Two voices could share a leading name. First wins — deterministic (API
  // order) rather than whichever happened to be last — and the loser is still
  // reachable by its full label.
  const fn = main.slice(main.indexOf('async function warmElevenLabsVoiceNames'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /!map\.has\(short\)/);
});

test('the same algorithm resolves the four names that failed live', () => {
  // A unit check of the exact rule, against the exact strings from the account
  // that broke. Written from the API response, not invented.
  const REAL = [
    ['Chris - Charming, Down-to-Earth', 'id-chris'],
    ['River - Relaxed, Neutral, Informative', 'id-river'],
    ['George - Warm, Captivating Storyteller', 'id-george'],
    ['Jessica - Playful, Bright, Warm', 'id-jessica'],
  ];
  const map = new Map();
  for (const [full, id] of REAL) {
    map.set(full.toLowerCase(), id);
    const short = full.split(/\s+[-–—]\s+/)[0].trim().toLowerCase();
    if (short && short !== full.toLowerCase() && !map.has(short)) map.set(short, id);
  }
  const resolve = (v) => map.get(String(v).toLowerCase()) || v;
  assert.equal(resolve('Chris'), 'id-chris');
  assert.equal(resolve('george'), 'id-george', 'casing must not matter');
  assert.equal(resolve('Jessica - Playful, Bright, Warm'), 'id-jessica', 'full label still works');
  assert.equal(resolve('nPczCjzI2devNBz1zQrb'), 'nPczCjzI2devNBz1zQrb', 'a real id passes through');
});

test('the onboarding call shares the whiteboard before writing to it', () => {
  // Reported live: the bot walked the entire setup writing to a board nobody
  // could see. update_whiteboard sets CONTENT ONLY — share_whiteboard is what
  // presents it — and the skill said "the board is the primary UI for every
  // step" without ever putting it on screen.
  //
  // Invisible from the agent's side, which is why it needs to be an explicit
  // numbered step rather than a line in a list: every tool call succeeds.
  const skill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');
  const share = skill.indexOf('share_whiteboard`');
  const update = skill.indexOf('`update_whiteboard` with that step');
  assert.ok(share > -1 && share < update, 'the share must come BEFORE the first update');
  assert.match(skill, /^## Step 3: Put the whiteboard on screen/m, 'its own step, not a footnote');
  assert.match(skill, /Once per call, not once per step/, 're-sharing interrupts the presentation');
  // Renumbering must be complete — two "Step 4"s would send the agent to the
  // wrong place on an early exit.
  const steps = [...skill.matchAll(/^## Step (\d)/gm)].map((m) => m[1]);
  assert.deepEqual(steps, ['1', '2', '3', '4', '5']);
  assert.doesNotMatch(skill, /^### 3[a-g]\./m, 'subsections follow their parent step');
});
