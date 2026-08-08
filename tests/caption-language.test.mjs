// caption-language.test.mjs — the bot can change the language it HEARS in.
//
// Captions are the bot's ears: it reads the room from Meet's caption region
// rather than transcribing audio. Set to the wrong language, Meet emits nonsense
// from correct speech and the agent answers the nonsense — it doesn't fall
// silent, it becomes confidently wrong. Meet has no host-level control (each
// participant sets their own), so the bot must drive its own Settings dialog.
//
// The DOM walk itself isn't unit-testable without a live Meet, so these pin the
// selector contract and the plumbing. DOM captured live 2026-07-29.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEET } = require('../electron-app/meet-selectors.js');
const { CALL_COMMANDS, CALL_EVENTS } = require('../electron-app/call-provider.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('the selectors key on roles and accessible names, never on generated classes', () => {
  const s = MEET.captionLanguage;
  // Meet's classes ("aqdrmf-rymPhb-ibnC6b", "rHGeGc-O1htCb") and jsnames rotate on
  // every React rebuild. Pinning to one is what made the old speaking-indicator
  // detection go deaf, and it would do the same here.
  for (const [k, v] of Object.entries(s)) {
    assert.equal(typeof v, 'string', `${k} should be a string`);
    assert.ok(!/aqdrmf|rHGeGc|O68mGe|jsname/.test(v),
      `${k} must not depend on a generated class or jsname: ${v}`);
  }
  assert.match(s.combobox, /role="combobox"/);
  assert.match(s.listbox, /role="listbox"/);
  assert.match(s.option, /role="option"/);
  // Lowercased, because the code compares against a lowercased accessible name.
  assert.equal(s.comboboxLabel, s.comboboxLabel.toLowerCase());
  assert.equal(s.captionsTabText, s.captionsTabText.toLowerCase());
});

test('options are matched by data-value, the one durable hook in that subtree', () => {
  // Each <li role="option"> carries the BCP-47 tag in data-value ("es-ES",
  // "cmn-Hans-CN"). That is semantic and stable where every class around it is
  // generated, so it is what the match keys on.
  const fn = codeOnly(provider.slice(provider.indexOf('async function setCaptionLanguage')));
  assert.match(fn, /getAttribute\('data-value'\)/, 'must read data-value');
  // Scope to the option matcher. Elsewhere in the flow aria-label is read for a
  // different reason (naming the combobox), so a whole-function ordering check
  // would compare the wrong two things.
  const pick = fn.slice(fn.indexOf('const pickOption'), fn.indexOf('_settingsDialogInProgress = true'));
  assert.ok(pick.length > 0, 'pickOption should still exist');
  const dataValueAt = pick.indexOf('data-value');
  const ariaLabelAt = pick.indexOf('aria-label');
  assert.ok(dataValueAt > 0, 'pickOption must key on data-value');
  assert.ok(ariaLabelAt > dataValueAt,
    'data-value must be tried BEFORE the display label, which is localised prose');
});

test('the listbox is resolved via aria-controls, not by searching inside the combobox', () => {
  // The wrapper carries data-is-menu-hoisted and data-is-menu-deferred: Meet may
  // portal the listbox elsewhere in the document, and may not render it at all
  // until opened. Searching within the combobox would find nothing in either case.
  const fn = codeOnly(provider.slice(provider.indexOf('async function setCaptionLanguage')));
  assert.match(fn, /getAttribute\('aria-controls'\)/,
    'must follow aria-controls to the popup');
  assert.match(fn, /getElementById/, 'aria-controls is an id reference');
});

test('the accessible name follows aria-labelledby', () => {
  // Meet labels this combobox by reference, not with aria-label, so reading the
  // attribute alone finds an empty string and the dropdown is never located.
  const fn = codeOnly(provider.slice(provider.indexOf('async function setCaptionLanguage')));
  assert.match(fn, /aria-labelledby/);
});

test('the settings-dialog guard is shared, not named for studio sound', () => {
  // #416: an abandoned Settings dialog covers the caption region and the bot goes
  // deaf with nobody there to close it. The sweeper's safety net holds off while a
  // flow is legitimately driving the dialog — so a SECOND flow must set the same
  // flag, which means it cannot be named after the first one.
  assert.ok(!/_studioSoundInProgress/.test(provider),
    'the old single-purpose flag name should be gone');
  assert.match(provider, /_settingsDialogInProgress/);
  // Both flows set it, and both release it.
  const sets = provider.match(/_settingsDialogInProgress = true/g) || [];
  const clears = provider.match(/_settingsDialogInProgress = false/g) || [];
  assert.equal(sets.length, 2, 'setStudioSound and setCaptionLanguage both guard');
  assert.ok(clears.length >= 3, 'each flow clears it in a finally, plus the declaration');
});

test('the flow closes the dialog and verifies it went', () => {
  const fn = codeOnly(provider.slice(provider.indexOf('async function setCaptionLanguage')));
  assert.match(fn, /dialogGone/, 'must verify closure, not fire one hopeful click');
  assert.match(fn, /for \(let attempt = 0; attempt < 5 && !dialogGone\(\)/);
});

test('the command and its result event are registered end to end', () => {
  assert.equal(CALL_COMMANDS.setCaptionLanguage, 'set-caption-language');
  assert.equal(CALL_EVENTS.captionLanguageResult, 'caption-language-result');
  // Allowlisted in main, or sendCallCmd drops it.
  assert.match(main, /CALL_COMMANDS\.setCaptionLanguage,/);
  // The provider replies with the outcome rather than fire-and-forget.
  assert.match(provider, /ipcRenderer\.send\(CALL_EVENTS\.captionLanguageResult/);
  // local-server dispatches the sync meta action and names the result.
  assert.match(server, /action === 'set-caption-language'/);
  assert.match(server, /results\.setCaptionLanguage = await this\.onSetCaptionLanguage/);
  // MCP exposes it and reads the same result key.
  assert.match(mcp, /"set_caption_language"/);
  assert.match(mcp, /data\.results\?\.setCaptionLanguage/);
});

test('it refuses out of a call, where the setting does not exist', () => {
  // "Language of the meeting" is a per-call Meet setting. Asking for it with no
  // call open should say so rather than half-walk a dialog that is not there.
  const h = main.slice(main.indexOf('onSetCaptionLanguage:'), main.indexOf('onSetShareAudio:'));
  assert.match(h, /callStatus !== 'in-call'/);
  assert.match(codeOnly(h), /Provide a language/, 'an empty language is rejected up front');
});

test('Slack reports caption language as unsupported rather than pretending', () => {
  // A huddle has no caption region to read, so there is nothing to set. Returning
  // a cheerful true would be a lie the agent cannot detect.
  const slack = readFileSync(join(root, 'electron-app/slack-provider.js'), 'utf8');
  const fn = slack.slice(slack.indexOf('async setCaptionLanguage'));
  assert.match(fn, /ok: false/);
});

test('the previous language comes from the selected option, not the combobox text', () => {
  // combo.textContent looked obvious and was wrong: Meet stacks three hidden
  // duplicate label spans inside the combobox, so it returned
  // "Language of the meetingLanguage of the meeting…English" with the real
  // answer buried at the end. Seen live 2026-07-30 in the first working run.
  const fn = codeOnly(provider.slice(provider.indexOf('async function setCaptionLanguage')));
  assert.ok(!/before = \(combo\.textContent/.test(fn),
    'must not read the combobox textContent — it concatenates hidden label spans');
  assert.match(fn, /MEET\.captionLanguage\.selectedOption/,
    'must read the aria-selected option instead');
});

// --- per-bot preference -----------------------------------------------------

test('captionLanguage is a preference, defaulting to "leave Meet alone"', () => {
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  const p = PREFERENCES.captionLanguage;
  assert.ok(p, 'the preference should exist');
  assert.equal(p.type, 'string');
  // NOT 'en-US'. Defaulting to a real language would make every existing bot
  // start rewriting a Meet account setting it had never touched, on upgrade,
  // without anyone asking. Empty = opt in.
  assert.equal(p.default, '');
});

test('the preference is applied when captions go live, once per call', () => {
  // captions-ready, not join: before it, the caption region and the Settings
  // dialog that owns the language may not be there to drive.
  assert.match(main, /captionsReady[\s\S]{0,200}applyCaptionLanguagePref\(\)/);
  const fn = main.slice(main.indexOf('function applyCaptionLanguagePref'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // Two distinct guards, because they stop two different things. The latch
  // records what is already live (so a language that's set doesn't get set
  // again); the in-flight flag covers the seconds DURING a walk, when the latch
  // hasn't been written yet and captions-ready can fire repeatedly.
  assert.match(body, /captionLanguageAlreadyApplied\(room, want\)/,
    'must not re-walk the Settings dialog for a language that is already live');
  assert.match(body, /_captionLanguageInFlight/,
    'must not start a second walk while one is still running');
  assert.match(codeOnly(body), /if \(!want\) return/,
    'an unset preference must leave Meet alone');
});

test('a failed caption-language change stays retryable', () => {
  // It must not wedge off for the rest of the call. This used to need an
  // explicit un-latch on the failure path; now the latch is only WRITTEN on
  // success, which gets the same guarantee with nothing to forget.
  const fn = main.slice(main.indexOf('onSetCaptionLanguage: async'));
  const body = fn.slice(0, fn.indexOf('\n  },\n'));
  const record = body.indexOf('_captionLanguageApplied = {');
  assert.ok(record > 0, 'the applied language must be recorded somewhere');
  // The recording sits inside the ok branch, not after it.
  const okBranch = body.indexOf('if (result && result.ok)');
  assert.ok(okBranch > 0 && okBranch < record, 'the latch must be written only on success');
  assert.match(body.slice(record), /^_captionLanguageApplied = \{ room: [^}]*resolved: result\.language/,
    'record the tag Meet resolved to, since that is what gets reapplied later');
});

test('changing the preference mid-call takes effect immediately', () => {
  const apply = main.slice(main.indexOf("} else if (key === 'captionLanguage')"));
  const block = apply.slice(0, apply.indexOf("} else if (key === 'studioSound')"));
  assert.match(block, /callStatus === 'in-call'/);
  assert.match(block, /onSetCaptionLanguage/);
});

test('the settings picker offers only Meet non-BETA languages, plus leave-as-is', () => {
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
  const sel = panel.slice(panel.indexOf('id="captionLanguage"'));
  const block = sel.slice(0, sel.indexOf('</select>'));
  const values = [...block.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(values.includes(''), 'must offer "leave as Meet has it"');
  for (const tag of ['de-DE', 'es-ES', 'en-GB', 'ja-JP']) {
    assert.ok(values.includes(tag), `expected ${tag} in the picker`);
  }
  // Every non-empty entry should look like a BCP-47 tag, not a display name.
  for (const v of values.filter(Boolean)) {
    assert.match(v, /^[a-z]{2}-[A-Z]{2}$/, `${v} should be a BCP-47 tag`);
  }
});

test('the onboarding wizard asks for the language alongside the voice', () => {
  // A newcomer who works in German shouldn't discover mid-call that the bot is
  // listening in English. It belongs in the same step as the voice: one is how
  // the bot speaks, the other how it hears.
  const html = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');
  const voiceStep = html.slice(html.indexOf('data-step="voice"'), html.indexOf('data-step="claude"'));
  assert.match(voiceStep, /id="captionLanguage"/, 'the picker belongs in the voice step');

  const js = readFileSync(join(root, 'electron-app/renderer/onboarding.js'), 'utf8');
  // Saved unconditionally, same as before — no guard needed now that every
  // option is a real language (no more falsy "don't change it" choice to skip).
  assert.match(js, /set-config', 'captionLanguage', \$\('captionLanguage'\)\.value/);
  // And prefilled, so re-running the wizard doesn't silently reset it.
  assert.match(js, /savedVoiceCfg\.captionLanguage/);
});

test('the wizard forces a real language choice, unlike the Settings picker', () => {
  // #see onboarding.html's captionLanguage note: an unset language is what
  // caused real problems in the field. The wizard is a one-time first-run
  // choice, so — unlike the Settings picker, which legitimately offers
  // "leave Meet alone" for later changes — it doesn't offer that escape hatch,
  // and defaults to English rather than landing on nothing selected.
  const html = readFileSync(join(root, 'electron-app/renderer/onboarding.html'), 'utf8');
  const voiceStep = html.slice(html.indexOf('data-step="voice"'), html.indexOf('data-step="claude"'));
  assert.doesNotMatch(voiceStep, /<option value="">/, 'the wizard must not offer an unset/leave-as-is language');
  assert.match(voiceStep, /<option value="en-US">English<\/option>/);

  const js = readFileSync(join(root, 'electron-app/renderer/onboarding.js'), 'utf8');
  assert.match(js, /savedVoiceCfg\.captionLanguage \|\| 'en-US'/,
    'an unset saved preference should default the picker to English, not nothing');
});
