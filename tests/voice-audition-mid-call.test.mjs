// voice-audition-mid-call.test.mjs — no audible voice audition while in a call.
//
// The bug this pins (#394): the Settings panel's unified voice dropdown played
// a local audition sample on EVERY pick, including mid-call — disruptive when
// the human is also listening to the live call, and redundant because the new
// voice speaks the bot's very next line anyway. The fix gates the sample on
// `callActive` (main's callStatusMeansInCall — true from joining through
// in-call), still sends update-tts-config so the voice actually changes, and
// shows a brief inline note in place of the sound.
//
// Source-asserted like the other renderer files here — panel.js runs only
// inside Electron, so these are regex pins against the source.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');

// The dropdown's change handler, from its listener to the next top-level
// listener registration — the region where every provider branch lives.
const handler = panelJs.slice(
  panelJs.indexOf("unifiedVoiceSelect?.addEventListener('change'"),
  panelJs.indexOf("refreshVoicesBtn?.addEventListener"),
);

test('the change handler never calls previewVoiceSample directly', () => {
  assert.ok(handler.length > 0, 'change handler not found');
  // Every branch must go through the callActive-gated wrapper instead.
  assert.ok(!handler.includes('previewVoiceSample('),
    'a dropdown branch still auditions unconditionally — mid-call picks must stay silent (#394)');
  assert.equal((handler.match(/auditionVoice\(/g) || []).length, 3,
    'expected all three provider branches (vb/el/mac) to audition via the gated wrapper');
});

test('the gate skips the sample mid-call but the voice change still goes out', () => {
  // The wrapper: not in a call → audible sample; in a call → visual note only.
  const gate = panelJs.slice(
    panelJs.indexOf('function auditionVoice('),
    panelJs.indexOf("unifiedVoiceSelect?.addEventListener('change'"),
  );
  assert.ok(/if \(!callActive\) \{ previewVoiceSample\(opts\); return; \}/.test(gate),
    'auditionVoice must preview only when no call is active');
  // update-tts-config is sent from the branches, not the wrapper — the pick
  // must take effect mid-call even though the sample is skipped.
  assert.equal((handler.match(/api\.send\('update-tts-config'/g) || []).length, 3,
    'every provider branch must still send update-tts-config');
});

test('mid-call feedback is a transient note near the dropdown, with no em-dash', () => {
  assert.ok(panelHtml.includes('id="voiceSetNote"'), 'panel.html needs the #voiceSetNote element');
  const copy = /voiceSetNote\.textContent = "([^"]+)"/.exec(panelJs)?.[1];
  assert.ok(copy, 'auditionVoice should set the note text');
  assert.ok(!/[—–]/.test(copy), 'no em/en dashes in user-facing copy');
  // Transient: it clears itself rather than sticking around as stale UI.
  assert.ok(/_voiceSetNoteTimer = setTimeout\(/.test(panelJs), 'the note must clear after a delay');
});
