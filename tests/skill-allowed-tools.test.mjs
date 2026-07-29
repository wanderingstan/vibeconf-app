// skill-allowed-tools.test.mjs — every MCP tool must be reachable from the
// skills that drive a call.
//
// A skill's `allowed-tools:` frontmatter is a whitelist: a tool absent from it
// cannot be called, no matter that it is registered, implemented end-to-end and
// documented in the skill body. The failure is silent and confusing from the
// agent side — the bot reports "that isn't in my toolset" and works around it.
//
// This has now bitten twice:
//
//   #79/#82  set_share_audio shipped without a whitelist entry. Fixed by hand,
//            one tool, no guard against the next one.
//   Jul 28   a bot asked on a live call to mute a video it was sharing replied
//            "share audio isn't in my tool set, so it's stop or nothing" —
//            /call was still missing set_share_audio plus 7 others, and
//            /join-call was missing 3.
//
// Adding a tool to server.js and forgetting the frontmatter is the easy mistake;
// this test is the thing that catches it. If you add a tool and this fails, add
// it to both skills — or, if it genuinely belongs to only one, extend
// OWN_COMMAND_ONLY below with a reason.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'mcp__vibeconferencing__';

// The only legitimate reason for a tool to be missing: it IS the other command.
// Anything else absent is a bug, not a policy.
const OWN_COMMAND_ONLY = {
  'join-call-skill.md': ['start_call'],  // start_call creates a new Meet — that's /call
  'call-skill.md': ['join_call'],        // join_call enters an existing Meet — that's /join-call
};

function registeredTools() {
  const src = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
  return new Set([...src.matchAll(/^ {2}"([a-z_]+)",$/gm)].map((m) => m[1]));
}

function allowedTools(skillFile) {
  const src = readFileSync(join(root, 'mcp-server', skillFile), 'utf8');
  const line = src.match(/^allowed-tools: (.*)$/m);
  assert.ok(line, `${skillFile} has no allowed-tools frontmatter`);
  return new Set(
    line[1].split(/\s+/).filter((t) => t.startsWith(PREFIX)).map((t) => t.slice(PREFIX.length)),
  );
}

test('the tool registry is non-trivial — guards against a regex that silently matches nothing', () => {
  const reg = registeredTools();
  assert.ok(reg.size > 30, `expected 30+ registered tools, parsed ${reg.size}`);
  assert.ok(reg.has('set_share_audio'), 'sanity: the tool this test was written for');
});

for (const skillFile of Object.keys(OWN_COMMAND_ONLY)) {
  test(`${skillFile} whitelists every registered tool`, () => {
    const allowed = allowedTools(skillFile);
    const exempt = new Set(OWN_COMMAND_ONLY[skillFile]);
    const missing = [...registeredTools()].filter((t) => !allowed.has(t) && !exempt.has(t)).sort();

    assert.deepEqual(missing, [],
      `unreachable from ${skillFile}: ${missing.join(', ')}\n` +
      'Add them to the allowed-tools frontmatter (and bump SKILL_VERSION in main.js), ' +
      'or add to OWN_COMMAND_ONLY with a reason if the tool really belongs to the other command.');
  });

  test(`${skillFile} has no stale whitelist entries`, () => {
    const reg = registeredTools();
    const stale = [...allowedTools(skillFile)].filter((t) => !reg.has(t)).sort();
    assert.deepEqual(stale, [],
      `whitelisted but not registered in server.js: ${stale.join(', ')} — renamed or removed?`);
  });

  test(`${skillFile} does not whitelist the other command's entry point`, () => {
    const allowed = allowedTools(skillFile);
    for (const t of OWN_COMMAND_ONLY[skillFile]) {
      assert.equal(allowed.has(t), false,
        `${t} is the other command's entry point; whitelisting it here invites the wrong flow`);
    }
  });
}

test('set_share_audio is reachable from both skills — the Jul 28 regression', () => {
  for (const skillFile of ['join-call-skill.md', 'call-skill.md']) {
    assert.ok(allowedTools(skillFile).has('set_share_audio'),
      `${skillFile}: a bot sharing a video must be able to mute it without stopping the share`);
  }
});
