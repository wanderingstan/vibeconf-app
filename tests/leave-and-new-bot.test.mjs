// leave-and-new-bot.test.mjs — two long-standing papercuts.
//
// 1. leave_call cut the bot off mid-goodbye. speak() returns when text is
//    QUEUED, not when it is heard, so the usual `speak("Bye!")` → `leave_call`
//    pair landed milliseconds apart and the goodbye died in the teardown. From
//    the room it read as the bot hanging up on you.
//
// 2. "New bot" prompted for a name. That prompt is a fossil: it asked for the
//    profile DIRECTORY, from back when that was also the bot's name. It isn't
//    any more, so it made people name the bot twice — the first time in a field
//    that only accepts [A-Za-z0-9._-].
//
// Run: node --test tests/leave-and-new-bot.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

test('leaving waits for speech that is still playing', async () => {
  const s = new LocalServer({ port: 0 });
  s.speakingAloud = true;
  const done = s.waitForSpeechDrain(2000, 10);
  setTimeout(() => { s.speakingAloud = false; }, 120);
  const r = await done;
  assert.equal(r.drained, true);
  assert.ok(r.waited >= 100, `should have waited for the audio, waited ${r.waited}ms`);
});

test('…and for speech still queued behind it', async () => {
  // Two different states, both meaning "not finished": pendingBotSpeech is text
  // awaiting its turn, speakingAloud is audio playing right now (#368).
  const s = new LocalServer({ port: 0 });
  s.pendingBotSpeech = [{ text: 'one more thing' }];
  const done = s.waitForSpeechDrain(2000, 10);
  setTimeout(() => { s.pendingBotSpeech = []; }, 120);
  const r = await done;
  assert.equal(r.drained, true);
  assert.ok(r.waited >= 100);
});

test('a silent bot leaves immediately', async () => {
  // The common case must not pay for the fix.
  const s = new LocalServer({ port: 0 });
  const r = await s.waitForSpeechDrain(2000, 10);
  assert.deepEqual(r, { waited: 0, drained: true });
});

test('a stuck voice cannot make leave_call hang forever', async () => {
  // A bot that will not hang up is worse than one that clips its goodbye.
  const s = new LocalServer({ port: 0 });
  s.speakingAloud = true; // never clears
  const r = await s.waitForSpeechDrain(180, 10);
  assert.equal(r.drained, false, 'reports honestly that it gave up');
  assert.ok(r.waited >= 180 && r.waited < 1500, `bounded, waited ${r.waited}ms`);
});

test('the leave route actually awaits the drain', async () => {
  // The helper existing is not the fix; calling it before onLeaveCall is.
  const src = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
  const block = src.slice(src.indexOf("if (data.meta?.action === 'leave')"));
  const body = block.slice(0, block.indexOf('\n    }'));
  assert.match(body, /await this\.waitForSpeechDrain\(\)/);
  assert.ok(body.indexOf('waitForSpeechDrain') < body.indexOf('this.onLeaveCall()'),
    'wait BEFORE tearing the call down');
});

test('new bot: no prompt, auto-named, opens on Settings', () => {
  const add = panelJs.slice(panelJs.indexOf("add.textContent = '＋ New bot…'"));
  const handler = add.slice(0, add.indexOf('profileMenu.appendChild(add)'));
  assert.match(handler, /api\.invoke\('create-new-bot'\)/);
  assert.doesNotMatch(handler, /inlinePrompt/, 'the name prompt is the thing being removed');

  assert.match(main, /ipcMain\.handle\('create-new-bot'/);
  const h = main.slice(main.indexOf("ipcMain.handle('create-new-bot'"));
  assert.match(h.slice(0, 300), /nextBotProfileName\(\)/);
  assert.match(h.slice(0, 300), /openSettings: true/);
});

test('auto-naming fills the first gap rather than counting up forever', () => {
  // Deleting bot3 and adding a bot should reuse bot3, not creep to bot4.
  const fn = main.slice(main.indexOf('function nextBotProfileName'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /for \(let i = 2;/, 'starts at 2 — the default profile is 1');
  assert.match(body, /if \(!taken\.has\(candidate\)\) return candidate/);
  assert.match(body, /toLowerCase\(\)/, 'case-insensitive, since these are directory names');
  assert.match(body, /i < 1000/, 'bounded');
});

test('the settings hand-off does not masquerade as a pop-out', () => {
  // 'screen' is the pop-out marker (IS_POPOUT_WINDOW). Reusing it here would
  // suppress this panel's height reporting and freeze the main window's size —
  // the bug that made the troubleshooting column vanish, in a new place.
  assert.match(main, /search: 'startScreen=settings'/);
  assert.doesNotMatch(main, /search: 'screen=settings'/);
  assert.match(panelJs, /get\('startScreen'\) === 'settings'/);
});

test('a new bot gets a real NAME, not just a folder', () => {
  // bot3 is a directory. Without a seeded name the bot introduces itself as
  // "Unnamed bot" — a worse first impression than any random name, and one the
  // user has to fix before the thing is usable.
  const fn = main.slice(main.indexOf('function seedNewBotName'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /randomBotName\(\{ taken \}\)/, 'drawn from the spinner pool');
  assert.match(body, /botName/);
  // Written to the profile config, NOT passed as --bot-name: that flag is a
  // launch-time override with its own provenance tag ("Alice [launch name]")
  // and does not persist, and this has to be the bot's real stored name.
  assert.match(body, /config\.json/);
  assert.doesNotMatch(body, /--bot-name/);
});

test('seeding never clobbers an existing config', () => {
  // Directory names are allocated first-gap, so bot3 may be a REUSED folder
  // that still holds something the user cares about.
  const fn = main.slice(main.indexOf('function seedNewBotName'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /if \(existing\.botName\) return;/);
  assert.match(body, /\{ \.\.\.existing, botName \}/, 'merge, never overwrite the file');
});

test('a new bot does not take a name another bot is already using', () => {
  // Two bots with one name is not just confusing: MCP routes by name, so it
  // makes "drive Alice" ambiguous.
  const { randomBotName } = require('../electron-app/bot-names.js');
  const taken = ['Jimmy', 'Alice', 'Samantha', 'Codex'];
  for (let i = 0; i < 200; i++) {
    const n = randomBotName({ taken });
    assert.ok(!taken.map((t) => t.toLowerCase()).includes(n.toLowerCase()), `drew a taken name: ${n}`);
  }
});

test('naming failure is not fatal', () => {
  // An unnamed bot is still a working bot, and it lands on the page where that
  // gets fixed. Throwing here would block creating the bot at all.
  const fn = main.slice(main.indexOf('function seedNewBotName'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.match(body, /catch \(err\)/);
  assert.match(body, /console\.warn/);
});

test('both create-a-bot entry points behave identically', () => {
  // A menu item and a switcher entry that both say "new bot" must not disagree
  // about what that means — the prompt was only half the problem.
  assert.match(main, /label: 'New Bot',/);
  assert.doesNotMatch(main, /label: 'New Bot…'/, 'no ellipsis: nothing is asked');
  assert.match(main, /webContents\.send\('new-bot'\)/);
  const handler = panelJs.slice(panelJs.indexOf("api.on('new-bot'"));
  assert.match(handler.slice(0, 400), /api\.invoke\('create-new-bot'\)/);
  assert.doesNotMatch(panelJs, /new-profile-prompt/, 'the old prompt path is gone');
});

test('every row in the bot menu highlights on hover', () => {
  // "＋ New bot…" was the only entry without a hover handler, so the one item
  // that CREATES something looked inert while the passive ones (open folder,
  // open logs) lit up. Asserted across all four rather than for that one item,
  // since the bug was an inconsistency, not a missing feature.
  for (const v of ['row', 'folder', 'logs', 'add']) {
    assert.match(panelJs, new RegExp(`\\b${v}\\.onmouseenter = \\(\\) => \\{ ${v}\\.style\\.background = '#3c4043'; \\};`),
      `${v} should highlight on hover`);
    assert.match(panelJs, new RegExp(`\\b${v}\\.onmouseleave = \\(\\) => \\{ ${v}\\.style\\.background = ''; \\};`),
      `${v} should clear the highlight`);
  }
});

test('the dev launcher encodes what went wrong by hand', () => {
  // Four failure modes, all of which cost a confusing test round during live
  // testing, and none of which failed loudly at the time.
  const sh = readFileSync(join(root, 'scripts/dev.sh'), 'utf8');
  // 1. The parent Claude session's identity leaks into the app, which turns off
  //    Claude Code's transcript saving — a dev-only difference that presents as
  //    a product bug.
  assert.match(sh, /-u CLAUDE_CODE_CHILD_SESSION/);
  assert.doesNotMatch(sh, /-u CLAUDE_CONFIG_DIR/, 'a CLAUDE_* wildcard would break real config');
  // 2. A worktree needs BOTH node_modules. Missing mcp-server's meant every
  //    spawned agent got an MCP server that died on ERR_MODULE_NOT_FOUND, so
  //    the bot joined with no tools and fell back to launching the installed app.
  assert.match(sh, /for d in electron-app mcp-server/);
  // 3. Killing the app mid-call drops the bot and kills its agent.
  //
  //    Two follow-on bugs, both found by using the thing:
  //
  //    (a) --stop skipped the check entirely. The guard went on the START path
  //        only, while --stop is the command actually reached for, so the one
  //        command whose whole job is killing the app was the one that never
  //        asked whether it should.
  //    (b) "busy" was a local guess — the literal string 'in-call' — which let
  //        through a bot mid-JOIN and, worse, an agent in after-call-work still
  //        writing its wrap-up. call-phase.js already defines this; the script
  //        asks it rather than keeping a second opinion.
  assert.match(sh, /guard_busy\(\) \{/);
  assert.match(sh, /call-phase\.js/, 'busy-ness comes from the app, not a copy');
  assert.doesNotMatch(sh, /STATUS" = "in-call"/, 'no hand-rolled phase check');
  // BOTH entry points must guard.
  const stopBlock = sh.slice(sh.indexOf('if [ "$STOP" = 1 ]'));
  assert.match(stopBlock.slice(0, 200), /guard_busy "stopping"/);
  const startBlock = sh.slice(sh.indexOf('if [ -n "$(running_pid)" ]; then'));
  assert.match(startBlock.slice(0, 200), /guard_busy 'restarting'/);
  assert.match(sh, /--force/, 'the escape hatch survives');
  // If node can't answer, fall back to a copy of the same list rather than
  // failing open — failing open is how this class of bug started.
  assert.match(sh, /BUSY_FALLBACK="navigating joining waiting-to-be-admitted in-call after-call-work"/);
  // 4. Detached with a known log, or it dies with the shell / blocks it.
  assert.match(sh, /nohup env/);
  assert.match(sh, /disown/);
});
