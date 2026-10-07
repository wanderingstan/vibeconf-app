// #805: --config=<path.json>, the only configuration route that works on a box
// with no screen. The behaviour that matters is what it REFUSES, so most of
// this file is about rejection rather than the happy path.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { applyConfigFile, checkConfigObject, OPERATOR_KEYS, REFUSED_KEYS, nearestKey } =
  require(join(root, 'electron-app/config-file.js'));
const { APP_LEVEL_KEYS } = require(join(root, 'electron-app/config-scope.js'));
const { PREFERENCES } = require(join(root, 'electron-app/preferences-schema.js'));

function fakeStore() {
  const written = [];
  return { written, set(k, v) { written.push([k, v]); } };
}
function writeCfg(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'vcfg-'));
  const p = join(dir, 'config.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}
const quiet = { log: () => {} };

test('a valid file applies every setting, coerced by the schema', () => {
  const store = fakeStore();
  // "true" as a STRING is what a shell-generated file tends to contain; the
  // schema's coercion is the reason this is accepted rather than rejected.
  applyConfigFile(writeCfg({ botName: 'Nova', remoteLogging: 'true' }), store, quiet);
  assert.deepStrictEqual(store.written.find(([k]) => k === 'botName'), ['botName', 'Nova']);
  assert.deepStrictEqual(store.written.find(([k]) => k === 'remoteLogging'), ['remoteLogging', true]);
});

test('the two API keys ARE settable here — this is the point of the flag', () => {
  // #797 snag 10: Nova was handed an ElevenLabs key, set a "preference", and
  // kept speaking through espeak, because ttsApiKey is deliberately absent
  // from preferences-schema.js and so invisible to set_preference.
  const store = fakeStore();
  applyConfigFile(writeCfg({ ttsApiKey: 'sk-test', realtimeApiKey: 'sk-rt' }), store, quiet);
  assert.deepStrictEqual(store.written.sort(), [['realtimeApiKey', 'sk-rt'], ['ttsApiKey', 'sk-test']]);
});

test('a secret value is never echoed, though its key name is', () => {
  const lines = [];
  applyConfigFile(writeCfg({ ttsApiKey: 'sk-SHOULD-NOT-APPEAR' }), fakeStore(), { log: (m) => lines.push(m) });
  const all = lines.join('\n');
  assert.ok(!all.includes('sk-SHOULD-NOT-APPEAR'), 'the key value leaked into the log');
  assert.ok(all.includes('ttsApiKey'), 'the key NAME should be logged, to confirm it took');
  assert.ok(all.includes('<redacted>'));
});

test('one bad key rejects the WHOLE file — no partial application', () => {
  // A half-applied config is the worst outcome on an unattended box: it runs,
  // looks healthy, and matches no file anyone can inspect.
  const store = fakeStore();
  assert.throws(
    () => applyConfigFile(writeCfg({ botName: 'Nova', nonsenseKey: 1 }), store, quiet),
    /nonsenseKey/,
  );
  assert.strictEqual(store.written.length, 0, 'nothing may be written when anything failed');
});

test('a near-miss key names the key it meant (the #158 silent-default trap)', () => {
  const { errors } = checkConfigObject({ ttsAPIKey: 'sk-x' });
  assert.match(errors[0], /ttsAPIKey/);
  assert.match(errors[0], /did you mean 'ttsApiKey'\?/);
  assert.strictEqual(nearestKey('ttsAPIKey'), 'ttsApiKey');
  assert.strictEqual(nearestKey('botNam'), 'botName');
});

test('an out-of-range value is rejected by the schema, not clamped', () => {
  const { ok, errors } = checkConfigObject({ ackVolume: 5 });
  assert.strictEqual(ok, false);
  assert.match(errors[0], /ackVolume/);
  assert.match(errors[0], /max/i);
});

test('credentials and trust decisions are refused, each with a reason', () => {
  for (const key of ['vcSessionToken', 'dangerousMode']) {
    const { ok, errors } = checkConfigObject({ [key]: 'x' });
    assert.strictEqual(ok, false, `${key} must not be settable from a file`);
    assert.match(errors[0], new RegExp(key));
    assert.ok(errors[0].length > key.length + 30, `${key} should say WHY, not just refuse`);
  }
});

test('every app-level key is a deliberate decision, not an omission', () => {
  // The guard that matters for the future: a key added to APP_LEVEL_KEYS later
  // must be classified on purpose. Without this, a new secret silently becomes
  // either writable or unreachable depending on whether it reached the schema.
  for (const key of APP_LEVEL_KEYS) {
    const classified = OPERATOR_KEYS.has(key) || REFUSED_KEYS.has(key) || !!PREFERENCES[key];
    assert.ok(classified,
      `'${key}' is app-level but unclassified: add it to OPERATOR_KEYS, REFUSED_KEYS, or the schema`);
  }
});

test('malformed input fails with a message that says which file', () => {
  const p = writeCfg('{ not json');
  assert.throws(() => applyConfigFile(p, fakeStore(), quiet), (e) =>
    /not valid JSON/.test(e.message) && e.message.includes(p));
  assert.throws(() => applyConfigFile(writeCfg([1, 2]), fakeStore(), quiet), /JSON object/);
  assert.throws(() => applyConfigFile('/nope/missing.json', fakeStore(), quiet), /cannot read/);
  assert.throws(() => applyConfigFile(writeCfg({ ttsApiKey: '  ' }), fakeStore(), quiet), /non-empty string/);
});

test('main.js applies the file before anything reads a preference, and exits on failure', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /if \(cliArgs\.config\)/);
  assert.match(main, /applyConfigFile\(cliArgs\.config, store\)/);
  assert.match(main, /app\.exit\(1\)/, 'a bad config must be a non-zero exit, not a warning');
  // Ordering: it must land after the store exists and before the window opens.
  assert.ok(main.indexOf('store = new ScopedStore') < main.indexOf('applyConfigFile'),
    'the store must exist first');
  // #158: the space form has to warn rather than be silently dropped.
  assert.match(main, /KNOWN_VALUE_FLAGS = new Set\(\[[^\]]*'config'/);
});
