// ui-history-capture.test.mjs — #615: a visual changelog of the app's own UI.
//
// The signature comparison is the only real logic here and it gets real tests.
// The endpoint and the capture itself need a live Electron window, so those are
// pinned by source assertions — the point being that the three ends (main's
// handler, the local-server route, the shell script) agree on one path, one
// method and one field name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SIGNATURE_SIDE, signatureFromBitmap, signatureDistance, DEFAULT_THRESHOLD } =
  require('../electron-app/ui-signature.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = fs.readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const script = fs.readFileSync(join(root, 'scripts/capture-ui-history.sh'), 'utf8');

// A BGRA bitmap of `side^2` pixels, every pixel the same grey.
function flat(v, side = SIGNATURE_SIDE) {
  return Buffer.from(Array.from({ length: side * side }, () => [v, v, v, 255]).flat());
}

test('a signature is one hex byte per pixel of the downscaled frame', () => {
  const sig = signatureFromBitmap(flat(0x40));
  assert.equal(sig.length, SIGNATURE_SIDE * SIGNATURE_SIDE * 2);
  assert.match(sig, /^[0-9a-f]+$/);
  assert.equal(sig, '40'.repeat(SIGNATURE_SIDE * SIGNATURE_SIDE));
});

test('identical frames are distance zero', () => {
  assert.equal(signatureDistance(signatureFromBitmap(flat(0x80)), signatureFromBitmap(flat(0x80))), 0);
});

test('distance is the mean per-pixel brightness difference', () => {
  const d = signatureDistance(signatureFromBitmap(flat(0x10)), signatureFromBitmap(flat(0x1a)));
  assert.equal(d, 10, '0x1a - 0x10 = 10, on every pixel');
});

test('the noise this exists to ignore stays under the threshold', () => {
  // THE WHOLE POINT. A clock digit, a ticking timer and anti-aliasing move a
  // handful of pixels by a little. If that cleared the threshold, a frame would
  // be kept every single night and the directory would stop being a changelog.
  const a = flat(0x80);
  const b = Buffer.from(a);
  for (let p = 0; p < 12; p++) {            // 12 of 256 pixels...
    for (const c of [0, 1, 2]) b[p * 4 + c] = 0xd0;  // ...change a lot
  }
  const d = signatureDistance(signatureFromBitmap(a), signatureFromBitmap(b));
  assert.ok(d > 0, 'it is not blind — the change is measured');
  assert.ok(d <= DEFAULT_THRESHOLD, `mean ${d} must not trip the ${DEFAULT_THRESHOLD} threshold`);
});

test('a real restyle clears the threshold comfortably', () => {
  // A redesign changes tone across the whole surface, not twelve pixels.
  const d = signatureDistance(signatureFromBitmap(flat(0x30)), signatureFromBitmap(flat(0xc0)));
  assert.ok(d > DEFAULT_THRESHOLD * 5, `mean ${d} should dwarf the threshold`);
});

test('a different capture SIZE is incomparable, not merely different', () => {
  // Different signature length means the window was captured at another size.
  // Scoring that as a number would be inventing a measurement; Infinity keeps
  // the frame instead, which is the honest outcome.
  const small = signatureFromBitmap(flat(0x80, 4), 4);
  const full = signatureFromBitmap(flat(0x80));
  assert.equal(signatureDistance(small, full), Infinity);
  for (const bad of ['', 'abc', null, undefined, 42]) {
    assert.equal(signatureDistance(bad, full), Infinity, String(bad));
  }
});

test('the threshold is a named constant, not an inline number', () => {
  // It WILL be retuned once there are weeks of frames to tune against, and a
  // magic number buried in a comparison is how that never happens.
  assert.ok(Number.isFinite(DEFAULT_THRESHOLD) && DEFAULT_THRESHOLD > 0);
  assert.match(script, /UI_DIFF_THRESHOLD:-\d+/, 'the script takes the same knob from the env');
});

test('main, the server route and the script agree on the interface', () => {
  assert.match(main, /onCaptureUi: async/);
  assert.match(main, /const UI_SURFACES = \{/);
  assert.match(server, /url\.pathname === '\/api\/ui-capture' && req\.method === 'GET'/);
  assert.match(server, /this\.onCaptureUi\(/);
  assert.match(script, /\/api\/ui-capture\?surface=/);
  // The fields the script reads must be the ones main returns.
  for (const field of ['path', 'signature', 'appVersion']) {
    assert.match(main, new RegExp(`${field}:`), `main returns ${field}`);
    assert.ok(script.includes(`"${field}"`), `script reads ${field}`);
  }
});

test('an unopened window is a 409, not a 500', () => {
  // "That window is not open right now" is the caller asking for something
  // unavailable, not a fault — a capture script has to tell those apart to know
  // whether retrying is worth anything.
  const i = server.indexOf("'/api/ui-capture'");
  assert.match(server.slice(i, i + 900), /res\.writeHead\(409/);
});

test('the script authenticates, and reads the token rather than being given it', () => {
  // #356 bearer-gates the local server, and the token is regenerated per run —
  // one passed in by hand is stale the moment the app restarts.
  assert.match(script, /Authorization: Bearer/);
  assert.match(script, /\.vibeconferencing\/local-tokens/);
});

test('the script compares against the last KEPT frame', () => {
  // Not the last captured one: sub-threshold changes would otherwise accumulate
  // night after night and a redesign could arrive entirely unrecorded.
  assert.match(script, /\*\.sig/);
  assert.match(script, /sort \| tail -1/);
});

test('every kept frame records the app version beside it', () => {
  // "When did this change, and what shipped that day" has to be answerable from
  // the folder alone, months later, with nobody around who remembers.
  assert.match(script, /-v\$version\.png/);
  assert.match(script, /history\.jsonl/);
  assert.match(script, /"appVersion"/);
});
