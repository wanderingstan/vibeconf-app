// etiquette-nightly-lane.test.mjs — the etiquette suite, run unattended (#468).
//
// It had never been scheduled. That is how "it passed last night" came to be
// said out loud, in a call, about a suite nobody had run — the reds and greens
// were both imaginary.
//
// The lane cannot be exercised here (it needs two bots in a live Meet), so what
// is pinned is the thing that makes it worth having at all: that its results
// mean something, and that a truncated run cannot read as a clean one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const runner = fs.readFileSync(join(root, 'scripts/etiquette-nightly.sh'), 'utf8');
const nightly = fs.readFileSync(join(root, 'scripts/scheduled-meet-test.sh'), 'utf8');

test('one rule per FRESH fleet — the reason this is trustworthy at all', () => {
  // #494: the same build scored four reds in a ten-rule run and passed the same
  // rules in small groups. Failures tracked position in the run, not behaviour.
  // A nightly whose reds must be manually re-tested is the impression-based loop
  // the suite replaced, with a cron job attached.
  const loop = runner.slice(runner.indexOf('for rule in'));
  assert.match(loop, /spawn-test-fleet\.sh" 2 --kill/, 'kill the previous fleet');
  assert.match(loop, /etiquette-prep\.mjs/, 'prep between rules');
  assert.match(loop, /--only "\$rule"/, 'exactly one rule per invocation');
  // The kill must come BEFORE the spawn inside the loop body.
  assert.ok(loop.indexOf('--kill') < loop.indexOf('2 >/dev/null'), 'kill, then spawn');
});

test('a rule the budget cut off is recorded, and is not a pass', () => {
  // A truncated run that reads as clean is the exact failure the lane ledger in
  // scheduled-meet-test.sh exists to prevent, and it warns about at length.
  assert.match(runner, /row "\$rule" "not-run"/);
  assert.match(runner, /budget of \$\{BUDGET\}s exhausted/);
  // And a fleet that never came up is its own verdict, not a silent skip.
  assert.match(runner, /row "\$rule" "no-fleet"/);
});

test('exit codes distinguish "a rule failed" from "nothing ran"', () => {
  assert.match(runner, /\(\( FAILED \)\) && exit 1/);
  assert.match(runner, /\(\( RAN \)\) \|\| exit 2/, 'zero rules run is not success');
});

test('the rule list comes from the suite, not a second copy of it', () => {
  // A hardcoded list silently stops covering rules added later, which nobody
  // notices because the lane still reports green.
  assert.match(runner, /grep -oE .*id: .*etiquette-test\.mjs/);
  // And the extraction must actually work against the real file.
  const ids = execFileSync('bash', ['-c',
    `grep -oE "^    id: '[a-z0-9-]+'" '${join(root, 'scripts/etiquette-test.mjs')}' | sed -E "s/.*'(.*)'/\\1/"`],
    { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(ids.length >= 8, `expected the suite's rules, got ${ids.length}: ${ids}`);
  assert.ok(ids.includes('no-talk-over'));
});

test('the nightly runs it as a ledgered lane, and skips loudly', () => {
  assert.match(nightly, /LANES_ALL=\([^)]*\betiquette\b/);
  assert.match(nightly, /lane_done etiquette/);
  assert.match(nightly, /etiquette-nightly\.sh" --room/);
  // No minted room means no lane — but it must SAY so rather than vanish.
  assert.match(nightly, /etiquette SKIPPED — no VIBECONF_MEET_ROOM/);
});

test('it is budgeted, because the watchdog kills the whole run at 30 min', () => {
  // An open-ended lane here would take every lane after it down with it.
  assert.match(nightly, /--budget-sec \d+/);
  const m = nightly.match(/--budget-sec (\d+)/);
  assert.ok(Number(m[1]) <= 900, `${m[1]}s is too much of a 30-minute run`);
});

test('it runs after the room is minted, and before the fuzz lane', () => {
  const etiq = nightly.indexOf('lane_done etiquette');
  assert.ok(etiq > nightly.indexOf('lane_done join-route'), 'needs the minted room');
  assert.ok(etiq < nightly.indexOf('lane_done fuzz'), 'fuzz spawns its own fleet — keep them apart');
});
