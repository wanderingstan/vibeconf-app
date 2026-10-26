// port-layout.test.mjs: one number moves the app's whole local port block.
//
// 127.0.0.1 is shared by every macOS user on a Mac. A second user (a dedicated
// bot account) running the app on the default ports collides with the primary
// user's bots, and each side's MCP scan finds the other's. VIBECONF_PORT_BASE
// (or `portBase` in the app-level config.json, for a Dock launch) moves the
// block. Most of what is tested here is the two promises that make that safe:
// unset changes NOTHING, and every place the app hands a port on carries the
// moved one.
//
// Run: node --test tests/port-layout.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const layout = require('../electron-app/port-layout.js');
const mcpLayout = await import('../mcp-server/port-layout.js');

// agent-integration.js requires electron at the top; stub it for plain node.
function loadAgentIntegration() {
  const Module = require('node:module');
  const realLoad = Module._load;
  Module._load = (req, ...rest) => (req === 'electron' ? { app: { isPackaged: false } } : realLoad(req, ...rest));
  try { return require('../electron-app/agent-integration.js'); } finally { Module._load = realLoad; }
}
const ai = loadAgentIntegration();

test('unset: the layout every installed config already names', () => {
  assert.deepEqual(layout.portLayout(), {
    base: 7865, supervisor: 7864, defaultBot: 7865,
    profileFirst: 7870, profileLast: 7899,
    scanFirst: 7865, scanLast: 7910,
    fleetFirst: 7901, fleetLast: 7916,
  });
  assert.deepEqual(layout.layoutFromEnv({}), layout.portLayout());
});

test('a base moves every port by the same amount', () => {
  assert.deepEqual(layout.portLayout(7965), {
    base: 7965, supervisor: 7964, defaultBot: 7965,
    profileFirst: 7970, profileLast: 7999,
    scanFirst: 7965, scanLast: 8010,
    fleetFirst: 8001, fleetLast: 8016,
  });
  assert.equal(layout.layoutFromEnv({ VIBECONF_PORT_BASE: '7965' }).profileFirst, 7970);
});

test('validation: whole numbers whose block fits in 1025..65535', () => {
  for (const ok of ['7965', 7965, ' 7965 ', '1026', '65484']) {
    assert.equal(layout.parsePortBase(ok).ok, true, `rejected ${JSON.stringify(ok)}`);
  }
  // 1025 would put the supervisor on 1024 (privileged); 65485 pushes the top
  // of the block past 65535.
  for (const bad of ['abc', '7865.5', '-1', '0', '1025', '65485', '70000', '7965x', '0x1f00']) {
    const r = layout.parsePortBase(bad);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(bad)}`);
    assert.ok(r.error.length > 10, 'should say why');
  }
});

test('precedence: env, then config, then the default', () => {
  assert.deepEqual(layout.resolvePortBase({ env: {} }), { base: 7865, source: 'default', warning: null });
  assert.equal(layout.resolvePortBase({ env: {}, configValue: 7965 }).source, 'config');
  assert.equal(layout.resolvePortBase({ env: {}, configValue: 7965 }).base, 7965);
  const both = layout.resolvePortBase({ env: { VIBECONF_PORT_BASE: '8065' }, configValue: 7965 });
  assert.deepEqual([both.base, both.source], [8065, 'env']);
  // An empty env var is "unset", not "invalid".
  assert.equal(layout.resolvePortBase({ env: { VIBECONF_PORT_BASE: '' }, configValue: 7965 }).base, 7965);
});

test('invalid falls back to 7865 and says so', () => {
  const env = layout.resolvePortBase({ env: { VIBECONF_PORT_BASE: 'banana' }, configValue: 7965 });
  assert.equal(env.base, 7865, 'a broken override lands on the well-known block, not on the config one');
  assert.match(env.warning, /VIBECONF_PORT_BASE/);
  const cfg = layout.resolvePortBase({ env: {}, configValue: 99999 });
  assert.equal(cfg.base, 7865);
  assert.match(cfg.warning, /portBase/);
});

test('applyPortBase folds the config into env, normalised both ways', () => {
  const quiet = () => {};
  const a = {};
  layout.applyPortBase({ env: a, configValue: 7965, log: quiet });
  assert.equal(a.VIBECONF_PORT_BASE, '7965', 'a Dock launch must hand the config value to every child');

  const b = {};
  layout.applyPortBase({ env: b, log: quiet });
  assert.ok(!('VIBECONF_PORT_BASE' in b), 'unset must stay unset');

  const c = { VIBECONF_PORT_BASE: 'nope' };
  const warnings = [];
  layout.applyPortBase({ env: c, log: (m) => warnings.push(m) });
  assert.ok(!('VIBECONF_PORT_BASE' in c), 'an invalid value is dropped so children do not re-warn');
  assert.equal(warnings.length, 1);

  const d = { VIBECONF_PORT_BASE: '7865' };
  layout.applyPortBase({ env: d, log: quiet });
  assert.ok(!('VIBECONF_PORT_BASE' in d), 'the default is the same as unset');
});

test('the MCP server\'s copy agrees with the app\'s on every input', () => {
  // Two copies because the packages cannot import each other (#708). This is
  // what keeps them from drifting.
  const inputs = [
    {}, { VIBECONF_PORT_BASE: '7965' }, { VIBECONF_PORT_BASE: '1026' }, { VIBECONF_PORT_BASE: '65484' },
    { VIBECONF_PORT_BASE: '65485' }, { VIBECONF_PORT_BASE: 'x' }, { VIBECONF_PORT_BASE: ' 20000 ' },
  ];
  for (const env of inputs) {
    assert.deepEqual(mcpLayout.layoutFromEnv(env), layout.layoutFromEnv(env), JSON.stringify(env));
    assert.deepEqual(mcpLayout.resolvePortBase({ env, configValue: 7965 }), layout.resolvePortBase({ env, configValue: 7965 }));
  }
  assert.deepEqual(mcpLayout.OFFSETS, layout.OFFSETS);
  assert.equal(mcpLayout.DEFAULT_PORT_BASE, layout.DEFAULT_PORT_BASE);
});

test('the MCP server takes its defaults from the layout, explicit values first', () => {
  const server = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
  assert.match(server, /process\.env\.VIBECONF_BASE_URL \|\| `http:\/\/127\.0\.0\.1:\$\{PORT_LAYOUT\.defaultBot\}`/);
  assert.match(server, /process\.env\.VIBECONF_PORT_RANGE \|\| `\$\{PORT_LAYOUT\.scanFirst\}-\$\{PORT_LAYOUT\.scanLast\}`/);
  assert.match(server, /process\.env\.VIBECONF_SUPERVISOR_PORT \|\| PORT_LAYOUT\.supervisor/);
});

test('supervisor port: base - 1, an explicit port still wins', () => {
  const { supervisorPort, supervisorUrl } = require('../electron-app/supervisor-port.js');
  assert.equal(supervisorPort({}), 7864);
  assert.equal(supervisorPort({ VIBECONF_PORT_BASE: '7965' }), 7964);
  assert.equal(supervisorPort({ VIBECONF_PORT_BASE: '7965', VIBECONF_SUPERVISOR_PORT: '7000' }), 7000);
  assert.equal(supervisorPort({ VIBECONF_PORT_BASE: '7965', VIBECONF_SUPERVISOR_PORT: 'junk' }), 7964);
  assert.equal(supervisorUrl({ VIBECONF_PORT_BASE: '7965' }), 'http://127.0.0.1:7964');
});

test('profile ports come from the moved range, and a stale one is reassigned once', () => {
  const pm = require('../electron-app/profile-manager.js');
  const dir = mkdtempSync(join(tmpdir(), 'vc-ports-'));
  const range = pm.profilePortRange({ VIBECONF_PORT_BASE: '7965' });
  assert.deepEqual(range, { first: 7970, last: 7999, keepFirst: 7965, keepLast: 8010 });

  assert.equal(pm.portForProfile(dir, 'jimmy', range), 7970);
  assert.equal(pm.portForProfile(dir, 'jimmy', range), 7970, 'stable across launches');

  // A registry written under the default block: those ports belong to the
  // other user's block now, so each is moved once and then remembered.
  writeFileSync(join(dir, 'profile-ports.json'), JSON.stringify({ jimmy: 7870, bob: 7871 }));
  assert.equal(pm.portForProfile(dir, 'jimmy', range), 7970);
  assert.equal(pm.portForProfile(dir, 'bob', range), 7971);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'profile-ports.json'), 'utf8')), { jimmy: 7970, bob: 7971 });
  assert.equal(pm.portForProfile(dir, 'bob', range), 7971);
});

test('with the base unset, an old registry is honoured exactly as before', () => {
  const pm = require('../electron-app/profile-manager.js');
  const dir = mkdtempSync(join(tmpdir(), 'vc-ports-'));
  const range = pm.profilePortRange({});
  assert.deepEqual([range.first, range.last], [pm.PROFILE_PORT_BASE, pm.PROFILE_PORT_MAX]);
  // 7866 predates the 7870-7899 range; it must keep working.
  writeFileSync(join(dir, 'profile-ports.json'), JSON.stringify({ old: 7866, jimmy: 7870 }));
  assert.equal(pm.portForProfile(dir, 'old', range), 7866);
  assert.equal(pm.portForProfile(dir, 'new', range), 7871);
});

test('~/.claude.json entry: unchanged when unset, moved and labelled when not', () => {
  const launcher = { command: '/bin/electron', env: { ELECTRON_RUN_AS_NODE: '1' } };
  const def = ai.buildClaudeMcpEntry({ launcher, mcpServerPath: '/x/server.js', botName: 'Pepper', defaultPort: 7865 });
  // Exactly the shape (and key order) the app has always written.
  assert.deepEqual(def, {
    command: '/bin/electron',
    args: ['/x/server.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', VIBECONF_ROOM_ID: '', VIBECONF_BOT_NAME: 'Pepper', VIBECONF_BASE_URL: 'http://127.0.0.1:7865' },
  });
  assert.equal(JSON.stringify(Object.keys(def.env)), JSON.stringify(['ELECTRON_RUN_AS_NODE', 'VIBECONF_ROOM_ID', 'VIBECONF_BOT_NAME', 'VIBECONF_BASE_URL']));

  const moved = ai.buildClaudeMcpEntry({ launcher, mcpServerPath: '/x/server.js', botName: 'Ted', defaultPort: 7965, portBase: 7965 });
  assert.equal(moved.env.VIBECONF_BASE_URL, 'http://127.0.0.1:7965', 'the shifted default bot, the stable fallback');
  assert.equal(moved.env.VIBECONF_PORT_BASE, '7965', 'so the server scans and asks this user\'s block');
});

test('needsUpdate: never flaps, and a base switch rewrites exactly once', () => {
  const launcher = { command: '/bin/electron', env: { ELECTRON_RUN_AS_NODE: '1' } };
  const entry = (port, base) => ai.buildClaudeMcpEntry({ launcher, mcpServerPath: '/x/server.js', botName: 'Ted', defaultPort: port, portBase: base });
  // What a pre-change build wrote: no VIBECONF_PORT_BASE key at all.
  const legacy = JSON.parse(JSON.stringify(entry(7865, 7865)));

  assert.equal(ai.claudeMcpEntryNeedsUpdate(legacy, entry(7865, 7865)), false, 'default install must not be rewritten');
  assert.equal(ai.claudeMcpEntryNeedsUpdate(undefined, entry(7865, 7865)), true);

  // Move the block: one write, then settled (written as JSON, read back).
  const want = entry(7965, 7965);
  assert.equal(ai.claudeMcpEntryNeedsUpdate(legacy, want), true);
  const written = JSON.parse(JSON.stringify(want));
  assert.equal(ai.claudeMcpEntryNeedsUpdate(written, want), false);

  // Same base URL but the PORT_BASE label missing (hand-edited, say): repaired.
  const unlabelled = { ...written, env: { ...written.env } };
  delete unlabelled.env.VIBECONF_PORT_BASE;
  assert.equal(ai.claudeMcpEntryNeedsUpdate(unlabelled, want), true);

  // And back to the default: one write that drops the key, then settled.
  assert.equal(ai.claudeMcpEntryNeedsUpdate(written, entry(7865, 7865)), true);
  assert.equal(ai.claudeMcpEntryNeedsUpdate(legacy, entry(7865, 7865)), false);
});

test('a spawned agent\'s pinned server carries the base when it is moved', () => {
  const launcher = { command: '/bin/electron', env: { ELECTRON_RUN_AS_NODE: '1' } };
  const args = { ownPath: '/dev/server.js', ownOk: true, launcher, botName: 'Ted', port: 7970 };
  assert.ok(!('VIBECONF_PORT_BASE' in ai.chooseAgentMcpServer(args).server.env), 'unset: unchanged');
  const moved = ai.chooseAgentMcpServer({ ...args, portBase: 7965 }).server.env;
  assert.equal(moved.VIBECONF_PORT_BASE, '7965');
  assert.equal(moved.VIBECONF_BASE_URL, 'http://127.0.0.1:7970', 'still pinned to the bot\'s real port');
  // The fallback (installed app's) server is re-pinned the same way.
  const inherited = { command: 'x', args: ['/app/server.js'], env: { VIBECONF_BASE_URL: 'http://127.0.0.1:7865' } };
  const fb = ai.chooseAgentMcpServer({ ...args, ownOk: false, inherited, fallbackOk: true, portBase: 7965 }).server.env;
  assert.equal(fb.VIBECONF_PORT_BASE, '7965');
});

test('the agent-activity hook\'s fallback port follows the base', () => {
  assert.equal(ai.agentHookContent(7865), ai.AGENT_HOOK_CONTENT, 'unset: the installed hook is not rewritten');
  assert.equal(ai.agentHookContent(), ai.AGENT_HOOK_CONTENT);
  const moved = ai.agentHookContent(7965);
  assert.match(moved, /process\.env\.VIBECONF_LOCAL_PORT \|\| '7965';/);
  assert.doesNotMatch(moved, /'7865'/);
  // Anything else about the hook is untouched.
  assert.equal(moved.replace("'7965'", "'7865'"), ai.AGENT_HOOK_CONTENT);
});

test('installed skills: ports localised, version stamped, only when moved', () => {
  const sample = 'curl http://127.0.0.1:7864/api/instances\nPORT=${PORT:-${VIBECONF_LOCAL_PORT:-7865}}\nnothing on 7864\n78650 stays';
  const def = layout.portLayout();
  assert.equal(ai.localizeSkillPorts(sample, def), sample);
  const moved = ai.localizeSkillPorts(sample, layout.portLayout(7965));
  assert.equal(moved, 'curl http://127.0.0.1:7964/api/instances\nPORT=${PORT:-${VIBECONF_LOCAL_PORT:-7965}}\nnothing on 7964\n78650 stays');

  assert.equal(ai.skillVersionStamp('71', def), '71', 'unset: nothing reinstalls');
  assert.equal(ai.skillVersionStamp('71', layout.portLayout(7965)), '71@7965');

  // The real skill sources name these ports; check the substitution reaches them.
  const newBot = readFileSync(join(root, 'mcp-server/call-new-bot-skill.md'), 'utf8');
  const out = ai.localizeSkillPorts(newBot, layout.portLayout(7965));
  assert.doesNotMatch(out, /\b786[45]\b/);
  assert.match(out, /127\.0\.0\.1:7964\/api\/instances/);
});

test('the Terminal command carries the base only when it is moved', () => {
  const { buildTerminalCommand } = require('../electron-app/launch-command.js');
  const plain = buildTerminalCommand({ workdir: '/w', port: 7870, innerCmd: 'claude' });
  assert.equal(buildTerminalCommand({ workdir: '/w', port: 7870, portBase: 7865, innerCmd: 'claude' }), plain);
  assert.equal(
    buildTerminalCommand({ workdir: '/w', port: 7970, portBase: 7965, innerCmd: 'claude' }),
    'cd \\"/w\\" && VIBECONF_LOCAL_PORT=7970 VIBECONF_PORT_BASE=7965 claude',
  );
});

test('portBase is settable from --config, validated, and app-level', () => {
  const { checkConfigObject } = require('../electron-app/config-file.js');
  const { isAppLevel } = require('../electron-app/config-scope.js');
  assert.ok(isAppLevel('portBase'), 'every bot and the app window must agree on it');
  const ok = checkConfigObject({ portBase: '7965' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.entries, [{ key: 'portBase', value: 7965, appLevel: true, secret: false }]);
  const bad = checkConfigObject({ portBase: 80 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /portBase/);
});

test('main.js resolves the base before the supervisor branch, from the base config', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const apply = main.indexOf("require('./port-layout.js').applyPortBase(");
  const branch = main.indexOf("require('./supervisor-app.js').start()");
  assert.ok(apply > 0 && apply < branch, 'the supervisor reads the layout too, so it must be settled first');
  assert.ok(apply < main.indexOf("app.setPath('userData'"), 'read from the BASE userData, before the profile swap');
  assert.match(main.slice(0, branch), /\.get\('portBase'\)/);
});
