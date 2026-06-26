// call-parity.e2e.test.mjs — the SAME call scenario run against each CallProvider
// (#267 provider-parity matrix), wrapped in node:test with fleet lifecycle hooks
// (#270 E2E-in-node:test). Proves the CallProvider abstraction holds: speak, chat
// round-trip, listen, and screen-share behave identically on Meet and Slack.
//
// This is the test that would have caught every Meet-ism we hand-found (room-code
// regex, optimistic sharing flag, missing ensureRoom): if a feature works on Meet
// but not Slack, the matching Slack test goes red.
//
// Meet runs unconditionally (open guest meet, no login). Slack runs only when
// VIBECONF_SLACK_TEST_URL is set AND the slacktest1/2 profiles are signed in:
//   VIBECONF_SLACK_TEST_URL=https://app.slack.com/client/T…/C… node --test "tests/e2e/*.e2e.test.mjs"
//
// Run:  pnpm test:e2e   (spawns + reaps its own fleet per provider via hooks)

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import { Bot, sleep } from '../../scripts/meet-test-lib.mjs';

const require = createRequire(import.meta.url);
const { SLACK } = require('../../electron-app/slack-selectors.js');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPAWN = join(REPO, 'scripts', 'spawn-test-fleet.sh');

// Provider matrix. Each entry knows how to boot its fleet and where the bots live.
const PROVIDERS = [
  {
    name: 'meet',
    spawnArgs: ['2'],
    killArgs: ['2', '--kill'],
    bots: [['Jimmy', 7901], ['Samantha', 7902]],
    room: 'paz-sqoa-npe',
    autoJoins: false, // Meet bots join via the HTTP API
  },
];
const SLACK_URL = process.env.VIBECONF_SLACK_TEST_URL;
if (SLACK_URL) {
  PROVIDERS.push({
    name: 'slack',
    spawnArgs: ['2', '--slack', `--slack-url=${SLACK_URL}`],
    killArgs: ['2', '--slack', '--kill'],
    bots: [['Jimmy', 7901], ['Samantha', 7902]],
    room: SLACK.roomCodeFromUrl(SLACK_URL),
    autoJoins: true, // Slack bots auto-join the huddle on launch
  });
}

function runSpawn(args) {
  execFileSync('zsh', [SPAWN, ...args], { cwd: REPO, stdio: 'inherit', timeout: 90_000 });
}

async function waitForInCall(bot, timeoutMs = 40_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await bot.status()).callStatus === 'in-call') return true; } catch { /* retry */ }
    await sleep(1000);
  }
  return false;
}

for (const p of PROVIDERS) {
  describe(`call provider: ${p.name}`, () => {
    let bots;

    before(async () => {
      runSpawn(p.killArgs); // clean any stranded fleet from a prior run
      runSpawn(p.spawnArgs);
      bots = p.bots.map(([name, port]) => new Bot(name, port, p.room));
      if (!p.autoJoins) for (const b of bots) await b.join();
      for (const b of bots) {
        const inCall = await waitForInCall(b);
        assert.ok(inCall, `${b.name} should reach in-call on ${p.name}`);
      }
    }, { timeout: 90_000 });

    after(() => { runSpawn(p.killArgs); }, { timeout: 30_000 });

    test('speak does not error', { timeout: 20_000 }, async () => {
      const data = await bots[0].speak('Parity check: can you hear me?');
      assert.notEqual(data?.results?.transcript?.reason, 'mode-silent');
    });

    test('chat round-trips between participants', { timeout: 30_000 }, async () => {
      const [a, b] = bots;
      const na = `parity-${p.name}-a`, nb = `parity-${p.name}-b`;
      await a.sendChat(na);
      await b.sendChat(nb);
      await sleep(2500);
      const aMsgs = (await a.readChat()).map((m) => m.text).join('\n');
      const bMsgs = (await b.readChat()).map((m) => m.text).join('\n');
      assert.match(aMsgs, new RegExp(nb), `${a.name} should see ${b.name}'s chat`);
      assert.match(bMsgs, new RegExp(na), `${b.name} should see ${a.name}'s chat`);
    });

    test('bot B hears bot A speak (captions → transcript)', { timeout: 40_000 }, async () => {
      const [a, b] = bots;
      // Drain prior transcript first — otherwise waitForSpeech returns instantly
      // on stale content (a false "heard"). This advances B's `since` window.
      await b.waitForSpeech({ wait: 3, silence: 1 });
      await a.speak('Parity listen check — the magic word is zucchini.');
      const { spoke } = await b.waitForSpeech({ wait: 18, silence: 2 });
      assert.ok(spoke, `${b.name} should hear ${a.name}'s NEW speech via captions on ${p.name}`);
    });

    test('screen share engages and stops', { timeout: 40_000 }, async () => {
      const a = bots[0];
      await a.updateWhiteboard(`# parity ${p.name}\n\nshare check`);
      const { sharing } = await a.shareWhiteboard();
      assert.ok(sharing, `share should engage on ${p.name}`);
      await sleep(1500);
      await a.stopSharing();
      let stillSharing = true;
      for (let i = 0; i < 10 && stillSharing; i++) { await sleep(500); try { stillSharing = !!(await a.status()).sharing; } catch { /* retry */ } }
      assert.ok(!stillSharing, `share should clear after stop on ${p.name}`);
    });
  });
}
