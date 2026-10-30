// calls-conformance.test.mjs: Phase 4 of the calls library. The conformance
// suite's own logic, run against fake bots (the live runs are
// scripts/provider-test.mjs), and the Playwright host's page-script bundler.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { runConformance, heardClip } = require('../packages/calls/conformance/suite.js');
const { bundlePageScript } = require('../packages/calls/hosts/playwright/bundle.js');

const MEET = 'https://meet.google.com/abc-defg-hij';
const WHATSAPP = 'https://call.whatsapp.com/voice/AbCdEfGh1234';

// A bot that does everything right, with hooks to make one thing go wrong.
function fakeBot(name, others, { hostCapabilities, failJoin, deaf, chatLost } = {}) {
  const inbox = [];
  let listening = '';
  return {
    name, hostCapabilities,
    inbox,
    async join() { if (failJoin) throw new Error('lobby'); },
    async participants() { return [name, ...others().map((o) => o.name)]; },
    startListening() { listening = ''; },
    hear(text) { listening += ' ' + text; },
    async heard(test) { return !deaf && test(listening) ? listening.trim() : null; },
    async playClip() { for (const o of others()) o.hear('Hello, everyone! I am an AI assistant joining this meeting.'); },
    async sendChat(text) { if (!chatLost) for (const o of others()) o.inbox.push(text); },
    async chatContains(needle) { return inbox.includes(needle); },
    async share() { return true; },
    async stopShare() { return true; },
    async leave() { return true; },
  };
}
function pair(optsA = {}, optsB = {}) {
  const bots = [];
  bots.push(fakeBot('Ada', () => [bots[1]], optsA), fakeBot('Ben', () => [bots[0]], optsB));
  return bots;
}
const steps = (results, status) => results.filter((r) => r.status === status).map((r) => `${r.step}:${r.bot}`);

test('a platform that does everything passes every step, both ways', async () => {
  const { results, failed } = await runConformance({ url: MEET, bots: pair() });
  assert.equal(failed, 0);
  assert.deepEqual(steps(results, 'pass'), [
    'join:Ada', 'join:Ben', 'roster:Ada', 'roster:Ben', 'hear:Ben', 'hear:Ada',
    'chat:Ada', 'chat:Ben', 'share:Ada', 'shareStop:Ada', 'leave:Ada', 'leave:Ben',
  ]);
});

test('a host gap is skipped and says so, never failed', async () => {
  const { results, failed } = await runConformance({ url: MEET, bots: pair({ hostCapabilities: { share: false } }) });
  assert.equal(failed, 0);
  const s = results.find((r) => r.step === 'share');
  assert.equal(s.status, 'skip');
  assert.match(s.note, /not supported on this host/);
});

test('a platform gap is skipped from the capability table', async () => {
  // A WhatsApp call has no platform captions (the bot hears through STT).
  const { results, failed } = await runConformance({ url: WHATSAPP, bots: pair() });
  assert.equal(failed, 0);
  const h = results.find((r) => r.step === 'hear');
  assert.equal(h.status, 'skip');
  assert.match(h.note, /whatsapp has no captions/);
});

test('a bot that hears nothing fails hear, and the rest still runs', async () => {
  const { results, failed } = await runConformance({ url: MEET, bots: pair({ deaf: true }), hearTimeoutMs: 10 });
  assert.equal(failed, 1);
  assert.deepEqual(steps(results, 'fail'), ['hear:Ada']);
  assert.ok(steps(results, 'pass').includes('leave:Ben'));
});

test('a lost chat message fails only the chat step of the bot that never got it', async () => {
  const { results } = await runConformance({ url: MEET, bots: pair({ chatLost: true }) });
  assert.deepEqual(steps(results, 'fail'), ['chat:Ben']);
});

test('a failed join stops the run before anything else is attempted', async () => {
  const { results, failed } = await runConformance({ url: MEET, bots: pair({}, { failJoin: true }) });
  assert.equal(failed, 1);
  assert.deepEqual(results.map((r) => r.step), ['join', 'join']);
});

test('hearing the clip takes two of its words, so a stray one does not pass', () => {
  assert.ok(heardClip('hello everyone, I am an AI assistant'));
  assert.ok(heardClip('an assistant is joining'));
  assert.ok(!heardClip('the meeting starts now'));
  assert.ok(!heardClip(''));
});

test('the bundler turns the Meet provider into one script a plain page can run', () => {
  const src = bundlePageScript(require.resolve('../packages/calls/hosts/playwright/page-host.js'));
  assert.ok(!/\brequire\(/.test(src.replace(/\/\/.*$/gm, '')), 'no require() left for the page to choke on');
  // It parses, and lists the provider and what it imports.
  new vm.Script(src);
  for (const marker of ['GoogleMeetProvider', 'const MEET = ', 'CALL_EVENTS = {']) assert.ok(src.includes(marker), marker);
});

test('the bundler refuses a require a page cannot satisfy', () => {
  assert.throws(() => bundlePageScript(require.resolve('../packages/calls/hosts/playwright/index.js')), /can't run in a page/);
});
