// remote-log-shipping-check.test.mjs — the nightly lane that asks whether a
// COMPLETE log reached the server (#619).
//
// The checker itself talks to the filesystem and the network, so what is tested
// here is its JUDGEMENT: that it distinguishes the three states, and that the
// one it exists for — "the start of the session shipped and then it stopped" —
// cannot be mistaken for healthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(join(root, 'scripts/check-remote-log-shipping.mjs'), 'utf8');
const nightly = fs.readFileSync(join(root, 'scripts/scheduled-meet-test.sh'), 'utf8');

test('it compares the NEWEST lines, not merely whether anything arrived', () => {
  // The whole point. #619 always left the first few seconds on the server, so a
  // check asking "are there any lines?" passes against the exact bug it is for.
  assert.match(src, /serverNewest/);
  assert.match(src, /localNewest/);
  assert.match(src, /lagSec/);
  assert.match(src, /MAX_LAG_SEC/);
});

test('the three outcomes stay distinguishable', () => {
  // Telling #440 (never authorized) from #619 (stopped attempting) from healthy
  // is the thing that cost the most time on 2026-08-31 — both look identical
  // from outside, and the first diagnosis that day was the wrong one.
  for (const verdict of ['nothing-shipped', 'shipping-stalled', 'healthy']) {
    assert.ok(src.includes(`'${verdict}'`), `missing verdict: ${verdict}`);
  }
  // And the stalled case must name the tell that separates them.
  const i = src.indexOf("'shipping-stalled'");
  assert.match(src.slice(i, i + 600), /\[remote-log\] lines/,
    'say how to tell "refused" from "never attempted"');
});

test('"could not check" is exit 2, never a pass', () => {
  // Search the CODE, not the prose. The header comment now discusses the
  // 'unauthorized' verdict by name, so an indexOf on the bare string finds the
  // explanation rather than the call — the same trap that made the
  // no-hardcoded-locales scanner flag a file for documenting its own old bug.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // A skipped check that reads as green is the failure shape this whole area
  // keeps repeating — see the lane-ledger comments in the nightly.
  for (const skip of ['disabled', 'no-credential', 'unauthorized', 'api-unreachable', 'no-local-log']) {
    const i = code.indexOf(`'${skip}'`);
    assert.ok(i > 0, `missing skip verdict: ${skip}`);
    assert.match(code.slice(Math.max(0, i - 40), i), /done\(2,\s*$/,
      `${skip} must exit 2 (cannot check), not 0 (healthy)`);
  }
  assert.match(code, /done\(1, 'shipping-stalled'/, 'a stall is a failure, not a skip');
  assert.match(code, /done\(1, 'nothing-shipped'/);
});

test('it prefers the app\'s OWN credential', () => {
  // Reading with a shared admin token would prove the API works while the app's
  // path stays broken — which is precisely the gap being tested.
  assert.match(src, /vcSessionToken/);
  assert.match(src, /vc_session=\$\{sessionToken\}/);
  assert.match(src, /VIBECONF_LOGS_TOKEN/);
});

test('a session crossing midnight does not read as a day stale', () => {
  // Lines carry only HH:MM:SS; the date comes from the filename. Without a
  // rollover the longest sessions — the ones most worth checking — would all
  // fail spuriously.
  assert.match(src, /86400_000/);
  assert.match(src, /secs < prev - 3600_000/);
});

test('the nightly runs it as a ledgered lane, late', () => {
  assert.match(nightly, /LANES_ALL=\([^)]*\bremote-log\b/);
  assert.match(nightly, /lane_done remote-log/);
  assert.match(nightly, /check-remote-log-shipping\.mjs"? --json/);
  assert.match(nightly, /remote-log-results\.jsonl/);
  // It must run AFTER the lanes whose traffic it is checking for.
  assert.ok(nightly.indexOf('lane_done remote-log') > nightly.indexOf('lane_done linux'),
    'checking for this run\'s log before the run has happened proves nothing');
});
