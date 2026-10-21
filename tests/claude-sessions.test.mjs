// claude-sessions.test.mjs: reading the user's recent Claude Code sessions for
// the app window's Sessions list.
//
// Run: node --test tests/claude-sessions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listRecentSessions, sessionExcerpt, messageText } = require('../electron-app/claude-sessions.js');

const jl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cc-sessions-'));
  const write = (folder, id, body, ageSec) => {
    mkdirSync(join(root, folder), { recursive: true });
    const f = join(root, folder, `${id}.jsonl`);
    writeFileSync(f, body);
    const t = Date.now() / 1000 - ageSec;
    utimesSync(f, t, t);
    return f;
  };
  return { root, write };
}

test('lists sessions newest first, with the title, last prompt and folder from the end of each file', () => {
  const { root, write } = fixture();
  write('-a', 'old', jl({ type: 'user', cwd: '/w/a', message: { content: 'hi' } }, { type: 'custom-title', customTitle: 'Old one' }), 3600);
  write('-b', 'new', jl(
    { type: 'user', cwd: '/w/b', message: { content: 'first' } },
    { type: 'custom-title', customTitle: 'Draft name' },
    { type: 'custom-title', customTitle: 'VA pension' },
    { type: 'last-prompt', lastPrompt: 'here is the missing check' },
  ), 10);
  const list = listRecentSessions({ root });
  assert.deepEqual(list.map((s) => s.id), ['new', 'old']);
  assert.equal(list[0].title, 'VA pension', 'the latest title wins: it is re-appended as the session goes');
  assert.equal(list[0].lastPrompt, 'here is the missing check');
  assert.equal(list[0].cwd, '/w/b');
});

test('falls back to the agent name, and skips what the app excludes (a bot\'s own session)', () => {
  const { root, write } = fixture();
  write('-bot', 'bot', jl({ type: 'user', cwd: '/Vibeconferencing/profiles/Default/agent', message: { content: 'x' } }, { type: 'custom-title', customTitle: 'Jimmy' }), 5);
  write('-c', 'c', jl({ type: 'user', cwd: '/w/c', message: { content: 'x' } }, { type: 'agent-name', agentName: 'Session Cam App' }), 20);
  const list = listRecentSessions({ root, exclude: (cwd) => cwd.includes('/Vibeconferencing/profiles/') });
  assert.deepEqual(list.map((s) => [s.id, s.title]), [['c', 'Session Cam App']]);
});

test('only the tail of a big transcript is read, with the head as the fallback for the title', () => {
  const { root, write } = fixture();
  const filler = jl(...Array.from({ length: 4000 }, (_, i) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i} `.repeat(10) }] } })));
  write('-big', 'big', jl({ type: 'custom-title', customTitle: 'Early title', cwd: '/w/big' }) + filler, 1);
  const [s] = listRecentSessions({ root });
  assert.equal(s.title, 'Early title');
  assert.equal(s.cwd, '/w/big');
  assert.ok(s.sizeBytes > 128 * 1024);
});

test('limit counts what is shown, after exclusions', () => {
  const { root, write } = fixture();
  for (let i = 0; i < 5; i++) write(`-${i}`, `s${i}`, jl({ type: 'user', cwd: `/w/${i}`, message: { content: 'x' } }), i);
  assert.equal(listRecentSessions({ root, limit: 3 }).length, 3);
  assert.deepEqual(listRecentSessions({ root }), listRecentSessions({ root, limit: 8 }));
  assert.deepEqual(listRecentSessions({ root: join(root, 'nope') }), [], 'no projects folder: an empty list, not a throw');
});

test('the excerpt is the last few lines of conversation, without tool traffic or harness wrappers', () => {
  const { root, write } = fixture();
  const f = write('-e', 'e', jl(
    { type: 'user', cwd: '/w', message: { content: 'can you add a Sessions list?' }, timestamp: 't1' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Yes, building it now.' }] }, timestamp: 't2' },
  ), 1);
  assert.deepEqual(sessionExcerpt(f), [
    { role: 'user', text: 'can you add a Sessions list?', at: 't1' },
    { role: 'assistant', text: 'Yes, building it now.', at: 't2' },
  ]);
  assert.equal(messageText({ message: { content: [{ type: 'tool_result' }] } }), null);
});

// ── Wiring: the Sessions list in the app window ──

import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the app window lists sessions, leaving out bots\' own, and marks one a bot already resumes', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /exclude: \(cwd\) => \(cwd \+ path\.sep\)\.startsWith\(profiles\)/);
  assert.match(sup, /bot: owners\.get\(x\.id\) \|\| null,/);
  assert.match(sup, /ipcMain\.handle\('supervisor:sessions', \(\) => listSessions\(\)\);/);
});

test('Create bot adopts the session by id, in its folder, with the choices made', () => {
  const sup = read('electron-app/supervisor-app.js');
  const fn = sup.slice(sup.indexOf('async function createBotFromSession('));
  assert.match(fn.slice(0, 1500), /seedNewBot\(paths\.profilesRoot, profile, \{ adopt: \{ workdir: s\.cwd, session: s\.id, botName: overrides\.botName \|\| s\.title \}, overrides \}\);/);
  assert.match(fn.slice(0, 1500), /if \(picked\) Object\.assign\(overrides, picked\.config\);/, 'any provider\'s voice, as its own settings');
});

test('seedNewBot lets choices made before the bot exists win over the random ones', async () => {
  const { mkdtempSync: mk, readFileSync: rd } = await import('node:fs');
  const { seedNewBot } = require('../electron-app/new-bot.js');
  const root = mk(join(tmpdir(), 'nb-'));
  seedNewBot(root, 'bot1', { adopt: { workdir: '/w/site', session: 'ad86c168-eac9-4f3d-931c-81cc465b26a0', botName: 'pr-482-refactor' }, overrides: { botName: 'VC Website', emojiSet: 'redpanda' }, log: { log() {}, warn() {} } });
  const cfg = JSON.parse(rd(join(root, 'bot1', 'agent', 'config.json'), 'utf8'));
  assert.equal(cfg.botName, 'VC Website');
  assert.equal(cfg.emojiSet, 'redpanda');
  assert.equal(cfg.claudeWorkDir, '/w/site');
  assert.equal(cfg.agentSession, 'ad86c168-eac9-4f3d-931c-81cc465b26a0');
  assert.equal(cfg.agentSessionAuto, false, 'pinned: the first launch must not swap it for a fresh session');
});

// ── Voices and names for a bot made from a session ──

test('a new bot\'s random voice comes from the best provider there is; built-in only when alone, and only good ones', () => {
  const { pickRandomVoice, goodSystemVoices } = require('../electron-app/voice-catalog.js');
  const el = { id: 'el:1', provider: 'elevenlabs' };
  const vb = { id: 'vb:1', provider: 'voicebox' };
  const os = { id: 'os:Daniel', provider: 'system' };
  assert.equal(pickRandomVoice([os, vb, el], () => 0).id, 'el:1');
  assert.equal(pickRandomVoice([os, vb], () => 0).id, 'vb:1');
  assert.equal(pickRandomVoice([os], () => 0).id, 'os:Daniel');
  assert.equal(pickRandomVoice([]), null, 'nothing to pick: the app default applies');
  const good = goodSystemVoices([
    { name: 'Ava (Premium)', tier: 0 }, { name: 'Zoe (Enhanced)', tier: 1 },
    { name: 'Daniel', tier: 2 }, { name: 'Fred', tier: 2 }, { name: 'Bad News', tier: 2 },
  ]).map((v) => v.name);
  assert.deepEqual(good, ['Ava (Premium)', 'Zoe (Enhanced)', 'Daniel']);
});

test('the built-in whitelist is the bot picker\'s, one list', () => {
  const { WHITELISTED_SYSTEM_STANDARD } = require('../electron-app/voice-catalog.js');
  const panel = read('electron-app/renderer/panel.js');
  const m = panel.match(/const WHITELISTED_MACOS_STANDARD = (\[[^\]]*\]);/);
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), WHITELISTED_SYSTEM_STANDARD);
});

test('the bot\'s own voice listing goes through the same catalog', () => {
  const main = read('electron-app/main.js');
  assert.match(main, /return require\('\.\/voice-catalog\.js'\)\.listElevenLabsVoices\(apiKey \|\| store\?\.get\('ttsApiKey'\)\);/);
  assert.match(main, /return require\('\.\/voice-catalog\.js'\)\.listSystemVoices\(\);/);
});

test('a session name is tidied, then used only if it works in a call', () => {
  const { botNameFromSession, tidySessionTitle } = require('../electron-app/addressable-name.js');
  assert.equal(tidySessionTitle('Fleet supervisor (#301) [draft]'), 'Fleet supervisor');
  assert.equal(botNameFromSession('Jimmy 🤖'), 'Jimmy');
  assert.equal(botNameFromSession('VC Website'), 'VC Website');
  assert.equal(botNameFromSession('Super Selfie Dance App (Fable)'), null, 'too long: replaced, not shortened');
  assert.equal(botNameFromSession('pr-482-refactor'), null);
});

test('naming is an app preference, a human name by default', () => {
  const { PREFERENCES } = require('../electron-app/preferences-schema.js');
  assert.equal(PREFERENCES.sessionBotNames.default, 'human');
  assert.deepEqual(PREFERENCES.sessionBotNames.enum, ['human', 'session']);
  const { isAppLevel } = require('../electron-app/config-scope.js');
  assert.ok(isAppLevel('sessionBotNames'), 'one setting for the machine, shown in App Settings');
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /if \(\(store\.get\('sessionBotNames'\) \|\| 'human'\) === 'session' && s\) \{/);
});
