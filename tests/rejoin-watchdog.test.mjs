// rejoin-watchdog.test.mjs — a rejoin is not a call ending.
//
// The call-ended watchdog (#417) fires when the in-call UI has been missing for
// ~12 consecutive seconds, which rescues the app from a ghost state after
// everyone leaves. A deliberate leave-and-rejoin looks identical from the DOM:
// the Leave button disappears while the page tears down, navigates and rejoins.
//
// Measured on a rename 2026-08-04 (the bot was "Anton"):
//
//   20:21:58  Leave call requested by agent          ← rename: step 1
//   20:22:00  Join call requested by agent: … Anton  ← rename: step 2
//   20:22:07  Call status: in-call                   ← back in, correctly named
//   20:22:10  Call ended — in-call UI gone for 12s   ← watchdog kills it
//   20:22:11  entering after-call work
//
// Three seconds after a successful rejoin, a healthy call was declared over. The
// counter had carried across the join instead of starting from zero. Because it
// is a race against how fast the new page renders, renames "always seemed a
// little sketchy" rather than plainly broken.
//
// Run: node --test tests/rejoin-watchdog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');

test('every join resets the call-ended watchdog', () => {
  assert.match(provider, /let resetCallEndedWatchdog = \(\) => \{\};/);
  // Called at the TOP of autoJoin, before any waiting: the whole point is that
  // the counter must not be carrying the previous call's absence.
  const fn = provider.slice(provider.indexOf('async function autoJoin(botName)'));
  const head = fn.slice(0, 400);
  assert.match(head, /resetCallEndedWatchdog\(\);/);
  assert.ok(head.indexOf('resetCallEndedWatchdog()') < head.indexOf('await'),
    'reset before the join does any waiting');
});

test('the reset clears all three pieces of state', () => {
  // _leaveGoneTicks alone is not enough: _callEndedFired is a one-shot latch, so
  // a bot that survived one false trigger could never trigger a real one, and
  // _everInCall stale-true lets ticks start accruing before admission.
  const fn = provider.slice(provider.indexOf('  resetCallEndedWatchdog = () => {'));
  const body = fn.slice(0, fn.indexOf('\n  };'));
  assert.match(body, /_everInCall = false;/);
  assert.match(body, /_leaveGoneTicks = 0;/);
  assert.match(body, /_callEndedFired = false;/);
});

test('the reset is visible in the log when it mattered', () => {
  // Silent state changes are how this went unnoticed. Logged only when there was
  // something to clear, so a normal first join stays quiet.
  const fn = provider.slice(provider.indexOf('  resetCallEndedWatchdog = () => {'));
  const body = fn.slice(0, fn.indexOf('\n  };'));
  assert.match(body, /if \(_leaveGoneTicks \|\| _callEndedFired \|\| _everInCall\)/);
  assert.match(body, /watchdog reset \(join starting\)/);
});

test('the watchdog still ends a genuinely dead call', () => {
  // The rescue this exists for: after everyone leaves, Meet collapses its UI and
  // the app used to keep retrying captions for minutes. Resetting on JOIN must
  // not weaken that — a leave with no rejoin still accrues ticks and fires.
  assert.match(provider, /_leaveGoneTicks >= 12 && !_callEndedFired/);
  assert.match(provider, /if \(hasLeave\) \{ _everInCall = true; _leaveGoneTicks = 0; \}/);
});

test('the preload forwards EVERY argument, not just the first', () => {
  // `send: (channel, data) => ...` silently dropped the second payload, so
  // api.send('join-meet', url, { onboardingCall: true }) reached main as
  // (url, undefined) and the guided setup ran an ordinary /join-call. Nothing
  // errored: the bot joined and behaved normally, just not as a setup call.
  //
  // It only bit when a call was ALREADY detected — the create-a-call path
  // carries the flag differently — which is why it passed its first test.
  const preload = readFileSync(join(root, 'electron-app/preload-panel.js'), 'utf8');
  assert.match(preload, /send: \(channel, \.\.\.args\) => ipcRenderer\.send\(channel, \.\.\.args\)/);
  assert.doesNotMatch(preload, /send: \(channel, data\) =>/);
});

test('the setup button still asks for the onboarding flow', () => {
  const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.match(panelJs, /api\.send\('join-meet', existing, \{ onboardingCall: true \}\)/);
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /ipcMain\.on\('join-meet', \(_event, meetUrl, opts\)/);
  assert.match(main, /onboardingCall: !!\(opts && opts\.onboardingCall\)/);
});

test('a caption language is saved to the bot that chose it', () => {
  // Meet stores "Language of the meeting" against the shared browser session,
  // not the bot. Observed: a bot set to German left Meet in German, and every
  // bot created afterwards started in German — an unset captionLanguage means
  // "leave whatever Meet already has". The German bot had saved nothing either,
  // so it was only still German by coincidence.
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('onSetCaptionLanguage: async'));
  const body = fn.slice(0, fn.indexOf('\n  onSetShareAudio'));
  assert.match(body, /store\.set\('captionLanguage', result\.language\)/);
  // The RESOLVED tag, not the requested one: "es" resolves to "es-ES", and
  // saving the request would re-walk the dialog on every join.
  assert.doesNotMatch(body, /store\.set\('captionLanguage', want\)/);
  // Non-fatal: failing to persist must not fail the language change itself.
  assert.match(body, /catch \(err\)[\s\S]{0,120}Could not save captionLanguage/);
});

test('the watchdog stands down when WE clicked Leave', () => {
  // The join-side reset was in the wrong instance. On a rename the OLD page keeps
  // ticking while the NEW one loads — measured 2026-08-04: the Leave button
  // vanished at 21:01:15.5 and the old script fired "in-call UI gone for 12s" at
  // 21:01:26.8, nine seconds AFTER the rejoin had started and reset the new
  // instance. The bot was kicked straight back out of the call it had just
  // rejoined, then took ~30s to come back.
  //
  // The signal that distinguishes a ghost from a rename is whether WE left, and
  // that is known in the leaving page at the moment it clicks.
  assert.match(provider, /let markDeliberateLeave = \(\) => \{\};/);
  assert.match(provider, /_leaveGoneTicks >= 12 && !_callEndedFired && !_leftOnPurpose/);
  // Set BEFORE the click, so no tick can slip through in between.
  const h = provider.slice(provider.indexOf("ipcRenderer.on('trigger-leave-call'"));
  const body = h.slice(0, h.indexOf('\n});'));
  assert.match(body, /markDeliberateLeave\(\);/);
  assert.ok(body.indexOf('markDeliberateLeave()') < body.indexOf('clicked'),
    'stand down before clicking Leave');
  // A fresh join puts it back on the hook — otherwise one rename would disable
  // ghost detection for the rest of the session.
  const reset = provider.slice(provider.indexOf('  resetCallEndedWatchdog = () => {'));
  assert.match(reset.slice(0, reset.indexOf('\n  };')), /_leftOnPurpose = false;/);
});

test('no step asks for a bare number', () => {
  // Confirmed at two different steps: "one" produced nothing in the captions,
  // while "option one", "number one" and "Deutsch" all came through. Stan's fix
  // is better than an instruction: LABEL the entries "Option 1", so the reader
  // says "option one" without being told.
  const skill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');
  assert.match(skill, /Never ask anyone to say a bare number/);
  assert.match(skill, /label the entries \*\*"Option 1", "Option 2"\*\*/);
  assert.match(skill, /someone reading "Option 3" says "option three" without being told/);
  // The voice step is where it was first noticed, so it says so.
  const voice = skill.slice(skill.indexOf('### 4c. Voice'), skill.indexOf('### 4d.'));
  assert.match(voice, /Option 1/);
});

test('the language step does not depend on a bare number', () => {
  // Tested live 2026-08-04: repeating "one" produced NOTHING in the captions,
  // while "Deutsch" came through immediately and "number one" also worked. A
  // single short word is the least reliable thing a caption engine can settle
  // on — and it was the one thing the step asked for.
  //
  // The language NAME is better on both counts: it transcribes, and it is
  // already written in the user's own language on the board, so it needs no
  // English at all. Numbers stay as a fallback, spoken as "number five".
  const skill = readFileSync(join(root, 'mcp-server/onboarding-call-skill.md'), 'utf8');
  const step = skill.slice(skill.indexOf('### 4a. Language'), skill.indexOf('### 4b. Name'));
  assert.match(step, /say the language's name, as written on the board/);
  assert.match(step, /"Deutsch" and "option three" both transcribe; "three" does not/);
});
