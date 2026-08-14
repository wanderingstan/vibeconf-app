// tool-result-honesty.test.mjs — #199, #253, #243.
//
// One shape, three places: a tool result that reports the ATTEMPT rather than
// the OUTCOME. This is worse than an ordinary bug because the agent believes it
// and acts on it, and every human downstream trusts the agent.
//
//   #199  speak returned "Spoken" while the app was queueing until in-call.
//         ~8 minutes of the stranger drill went into hunting TTS keys and
//         captions while the app sat wedged at 'navigating'.
//   #253  speak returned success while playback failed. A farewell "played"
//         into an empty room; the failure was a log line nobody read.
//   #243  the app reported 'waiting-to-be-admitted' when the bot had never
//         knocked — it was sitting on Meet's signed-out name form. A host spent
//         ~9 minutes of a live call hunting an admit prompt that could not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const local = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');

test('#199: speech queued until in-call is reported as queued, not spoken', () => {
  // The app queues because the virtual mic is not connected to the other
  // participants until 'in-call' — speaking earlier plays into the void.
  assert.match(local, /queuedUntilInCall = true;/);
  assert.match(local, /queuedUntilInCall: true, callStatus: this\.callStatus/);
  // And the MCP layer must SAY so, before the generic success line.
  assert.match(server, /tx\?\.queuedUntilInCall/);
  const q = server.indexOf('tx?.queuedUntilInCall');
  // #360 renamed the success line "Spoken" → "Speaking" (it answers at
  // dispatch time and must not claim delivery).
  const spoken = server.indexOf('`Speaking: "${text}"`');
  assert.ok(spoken > 0, 'the generic success return should say "Speaking", not "Spoken"');
  assert.ok(q < spoken, 'the queued check must come before the generic success return');
  assert.match(server, /QUEUED, not spoken/);
  // It must also say what to do, or the agent repeats itself into the void.
  assert.match(server, /do NOT repeat it/i);
});

test('#253: a playback failure is recorded, not just logged', () => {
  // Playback happens AFTER the speak POST has answered, so it cannot be returned
  // inline without making speak block on synthesis. Recorded two ways instead.
  assert.match(local, /notePlaybackFailure\(reason\)/);
  assert.match(local, /takeRecentPlaybackFailure/);
  // The site that used to fail silently.
  const i = main.indexOf('Meet view not available for audio playback');
  assert.ok(i > 0);
  assert.match(main.slice(i, i + 500), /notePlaybackFailure/,
    'the silent resolve() is what let a farewell play into an empty room');
  assert.match(main.slice(i, i + 500), /resolve\(false\)/, 'and callers should be able to tell');
});

test('#253: the next speak tells the agent its previous speech was not heard', () => {
  // The moment that matters: the agent is about to build on a reply the room
  // never got.
  assert.match(local, /previousPlaybackFailed: f/);
  assert.match(server, /previousPlaybackFailed/);
  assert.match(server, /Your PREVIOUS speech was NOT heard/);
  // Prepended to BOTH success paths, or the warning is lost on whichever the
  // call happens to take.
  const warned = (server.match(/priorWarning \+/g) || []).length;
  assert.ok(warned >= 2, `expected the warning on both success returns, saw ${warned}`);
});

test('#253: a stale failure is not re-reported forever', () => {
  // A failure from ten minutes and three calls ago is noise, not news.
  // Anchor on the DEFINITION, not the name: the call site appears earlier in the
  // file, so a bare indexOf lands on the wrong one.
  const fn = local.slice(local.indexOf('takeRecentPlaybackFailure(maxAgeMs'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /maxAgeMs/);
  assert.match(body, /this\._playbackFailure = null;/, 'consumed once');
});

test('#243: a pre-join stall stops the app claiming a knock that never happened', () => {
  // "Waiting to be admitted..." is sent when the join button is CLICKED. On the
  // signed-out pre-join, an empty name field makes that button inert, so the
  // claim outlives the failure with nothing to correct it.
  assert.match(provider, /stuckOnJoinUISeconds/);
  assert.match(provider, /const STUCK_ON_JOIN_UI_SECONDS = \d+/);
  assert.match(provider, /NOT waiting to be admitted/);
  // The specific, actionable cause — this is the case that actually happened.
  assert.match(provider, /Meet is asking for a name and the field is empty/);
  // And the instruction that saves the host nine minutes.
  assert.match(provider, /Do not tell anyone to look for an admit prompt/);
});

test('#243: the notice rides the agent-visible channel, not just the log', () => {
  // 'Notice:' statuses land in localServer.addError, which the agent reads.
  // A console line would have changed nothing — the old failure WAS logged.
  const i = provider.indexOf('NOT waiting to be admitted');
  const before = provider.slice(Math.max(0, i - 200), i);
  assert.match(before, /sendStatus\('Notice: /);
  assert.match(main, /status\.startsWith\('Notice:'\)/);
  assert.match(main, /localServer\.addError\(status\.slice\('Notice:'\.length\)\.trim\(\)\)/);
});
