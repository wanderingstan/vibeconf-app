// whiteboard-e2e-vision-skip.test.mjs — a check that could not run is not a pass (#627).
//
// The whiteboard-e2e lane's vision step is the ONLY assertion anywhere that a
// VIEWER can see a share, rather than that the sender thinks it sent one. On a
// host with neither the `claude` CLI nor ANTHROPIC_API_KEY it recorded
// `nonceVisible = true` with an honest note — and only the ✅ survived into a
// digest or a glance. On the nightly's own machine it had never once run.
//
// The live lane needs two bots in a real Meet, so what is pinned here is the
// thing that makes its result mean something: a skip is its own outcome, it
// never reads as green, and it reaches the record the digest is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, skip, report } from '../scripts/meet-test-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = fs.readFileSync(join(root, 'scripts/whiteboard-e2e-test.mjs'), 'utf8');
const nightly = fs.readFileSync(join(root, 'scripts/scheduled-meet-test.sh'), 'utf8');
const digest = fs.readFileSync(join(root, 'scripts/notify-nightly.mjs'), 'utf8');

// report() and record() write to stdout; capture it so the assertions can read
// what a human would have read.
function captureReport(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { const r = fn(); return { r, text: out.join('\n') }; }
  finally { console.log = orig; }
}

test('an unrunnable vision check is recorded as skipped, not as a pass', () => {
  // The exact call the lane makes when neither credential is present.
  assert.match(e2e, /skip\(b\.name, 'nonceVisible'/);
  // And it must not be able to reach the old shape again.
  assert.doesNotMatch(e2e, /record\([^)]*'nonceVisible',\s*true/);
  assert.match(e2e, /import \{[^}]*\bskip\b[^}]*\} from '\.\/meet-test-lib\.mjs'/);
});

test('a skipped step never counts as a failure, and never reads as green', () => {
  record('Alice', 'shareEngaged', true, 'sharing confirmed');
  skip('Jimmy', 'nonceVisible', 'vision UNAVAILABLE (no claude CLI + no ANTHROPIC_API_KEY)');
  const { r, text } = captureReport(() => report());

  // Not a failure: the run's exit code (fails > 0) must be unchanged by a skip.
  assert.equal(r.fails, 0, 'a skip is not a failure');
  assert.equal(r.skips, 1, 'and it is counted, not swallowed');

  // Not a pass either: neither the step line nor the verdict may read green.
  const stepLine = text.split('\n').find((l) => l.includes('nonceVisible'));
  assert.ok(stepLine, 'the skipped step is still printed');
  assert.ok(!stepLine.includes('✅'), `skipped step printed as a pass: ${stepLine}`);
  assert.ok(stepLine.includes('⏭️'), `skipped step needs its own glyph: ${stepLine}`);
  assert.doesNotMatch(text, /✅ PASS — all steps green/,
    'a run with an unrun check is not "all steps green"');
  assert.match(text, /PASS WITH GAPS/);
  assert.match(text, /skipped steps:\s+1/);
});

test('the skip reaches the nightly record and the digest', () => {
  // A gap only anybody reads about if it survives into the results file the
  // Telegram digest is built from.
  const lane = nightly.slice(nightly.indexOf('=== whiteboard end-to-end'));
  assert.match(lane, /svskips=\$\(grep -oE 'skipped steps: \+\[0-9\]\+'/);
  assert.match(lane, /"skips":"%s"/);
  assert.match(lane, /"\$svskips"/);
  assert.match(digest, /r\.skips !== undefined && Number\(r\.skips\) > 0/);
});
