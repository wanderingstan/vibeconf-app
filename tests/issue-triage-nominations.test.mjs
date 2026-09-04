// issue-triage-nominations.test.mjs — the morning survey's bot nominations (#565 pool).
//
// The nomination list is the one part of the survey a human is asked to ACT on,
// and its value is entirely in being short. On 2026-09-03 two of five slots went
// to #586 and #611, both already carrying `good-for-bot` and already sitting in
// the pool printed further down the same report — a re-run of work already done,
// in the section least able to afford it.
//
// The script talks to `gh` and to the model, so both are stubbed here: a fake gh
// on PATH serves a fixed backlog, CLAUDE_BIN serves a fixed survey, and the run
// is --dry-run so nothing is written or sent. What is pinned is the filtering,
// not the model's judgement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/nightly-issue-triage.mjs');
const REPO = 'wanderingstan/vibeconf-app';

// #101 is already in the pool; #202 is not. A correct run nominates only #202.
const BACKLOG = [
  { number: 101, title: 'already tagged', labels: [{ name: 'good-for-bot' }], url: `https://github.com/${REPO}/issues/101`, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', body: '', comments: 0 },
  { number: 202, title: 'not yet tagged', labels: [], url: `https://github.com/${REPO}/issues/202`, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', body: '', comments: 0 },
];

const SURVEY = {
  headline: 'stub',
  top: [], clusters: [], duplicates: [], labels: [], stale: [],
  botReady: [
    { repo: REPO, issue: 101, scope: 'the tagged one', risk: 'low', why: 'stub' },
    { repo: REPO, issue: 202, scope: 'the untagged one', risk: 'low', why: 'stub' },
  ],
};

function runTriage(survey) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'triage-'));
  const bin = join(dir, 'bin');
  fs.mkdirSync(bin);
  // `gh issue list` serves the backlog; every other subcommand answers with an
  // empty array, which each caller already treats as "nothing here".
  fs.writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "issue list") cat ${JSON.stringify(join(dir, 'issues.json'))} ;;
  *) echo '[]' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(join(dir, 'issues.json'), JSON.stringify(BACKLOG));
  fs.writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'survey.json'))}\n`, { mode: 0o755 });
  fs.writeFileSync(join(dir, 'survey.json'), JSON.stringify(survey));

  const out = execFileSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_BIN: join(dir, 'claude'),
      VIBECONF_TRIAGE_DRYRUN: '1',
      VIBECONF_TRIAGE_REPOS: REPO,
      VIBECONF_RESULTS_DIR: join(dir, 'results'),
      VIBECONF_VAULT: join(dir, 'no-vault'),
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('an issue already tagged good-for-bot is not nominated again', () => {
  const out = runTriage(SURVEY);
  const sh = out.split('\n').filter((l) => l.includes('--add-label good-for-bot'));
  assert.equal(sh.length, 1, `expected one tag command, got:\n${sh.join('\n')}`);
  assert.match(sh[0], /issue edit 202\b/);
  assert.ok(!sh.some((l) => /issue edit 101\b/.test(l)),
    '#101 is already in the pool — re-proposing it spends a slot on a no-op');
});

test('when every nomination is already tagged, the report says so', () => {
  // The section is otherwise simply absent, and an absent heading reads as "the
  // model found nothing a bot could take" — a very different morning from
  // "everything it picked is already tagged and waiting".
  const out = runTriage({ ...SURVEY, botReady: [SURVEY.botReady[0]] });
  assert.ok(!out.includes('--add-label good-for-bot'), 'nothing left to tag');
  assert.match(out, /Nothing new — all 1 nomination was\s+already tagged/);
});

test('a nomination outside the fetched backlog survives the filter', () => {
  // "Not in the backlog" is not evidence of a label. Swallowing the number hides
  // a bad nomination from the human review the section exists to get.
  const out = runTriage({ ...SURVEY, botReady: [{ repo: REPO, issue: 999, scope: 'unknown', risk: 'low' }] });
  assert.match(out, /issue edit 999\b/);
});
