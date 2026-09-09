// screenshot-returns-image.test.mjs — a screenshot the agent can SEE.
//
// get_call_screenshot used to return only a path, so actually looking cost two
// further round trips: one turn to emit the file read, another to receive it,
// each re-processing the whole call's context. In a long call that costs far
// more than the ~1800 tokens of the picture itself. Stan, 2026-09-09:
// "just *telling* the agent to take a screenshot is using the LLM to activate
// a screenshot toolcall and wasting tokens, right?"
//
// The path is still returned, because some uses only want the file — saving a
// screenshot into the call folder for after-call work, or uploading it. This
// pins BOTH halves, and the degradation rule: a file that cannot be read still
// returns the path rather than failing, because a screenshot the agent cannot
// see is a degraded answer, not an error.
//
// Asserted against the source, because standing up the MCP server needs a
// running app; the shape of the returned content is the contract.
//
// Run: node --test tests/screenshot-returns-image.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'mcp-server', 'server.js'), 'utf8');

// Pull screenshotResult out of the server source and run it for real, so these
// are tests of the function rather than of a copy of it.
function loadHelper() {
  const at = src.indexOf('function screenshotResult(');
  assert.ok(at > 0, 'screenshotResult must exist');
  const end = src.indexOf('\n}\n', at) + 3;
  const body = src.slice(at, end);
  const fn = new Function('readFileSync', 'MAX_INLINE_BYTES',
    `${body}; return screenshotResult;`);
  return (p, label, maxBytes = 12 * 1024 * 1024) => fn(readFileSync, maxBytes)(p, label);
}

const screenshotResult = loadHelper();

test('a readable screenshot comes back as an IMAGE, not just a path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

  const out = screenshotResult(file, 'Saved to');
  const kinds = out.content.map((c) => c.type);
  assert.ok(kinds.includes('image'), `expected an image block, got ${kinds.join(',')}`);

  const img = out.content.find((c) => c.type === 'image');
  assert.equal(img.mimeType, 'image/png');
  assert.equal(Buffer.from(img.data, 'base64').toString('hex'), '89504e4701020304',
    'the bytes must be the file, base64-encoded');
});

test('the path is returned as well — some uses only want the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, Buffer.from([1, 2, 3]));

  const out = screenshotResult(file, 'Saved to');
  const text = out.content.find((c) => c.type === 'text');
  assert.ok(text, 'a text block must be present');
  assert.match(text.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'and it must carry the absolute path, for saving or uploading the file');
});

test('an unreadable file degrades to the path, it does not fail', () => {
  const out = screenshotResult('/nonexistent/definitely/not/here.png', 'Saved to');
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0].type, 'text');
  assert.match(out.content[0].text, /not\/here\.png/);
});

test('an empty capture is not returned as an image', () => {
  // A 0-byte PNG read back as "the call looks like nothing" is worse than the
  // path alone — the same rule the app applies when the capture comes back empty.
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  const file = join(dir, 'empty.png');
  writeFileSync(file, Buffer.alloc(0));

  const out = screenshotResult(file, 'Saved to');
  assert.deepEqual(out.content.map((c) => c.type), ['text']);
});

test('an oversized file degrades to the path rather than being inlined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shot-'));
  const file = join(dir, 'big.png');
  writeFileSync(file, Buffer.alloc(2048));

  const out = screenshotResult(file, 'Saved to', 1024);   // cap below the file size
  assert.deepEqual(out.content.map((c) => c.type), ['text']);
});

test('both screenshot tools use the helper, so neither can drift back to path-only', () => {
  for (const tool of ['get_call_screenshot', 'get_shared_screenshot']) {
    const at = src.indexOf(`"${tool}"`);
    assert.ok(at > 0, `${tool} must exist`);
    const body = src.slice(at, at + 3000);
    assert.match(body, /screenshotResult\(data\.path/, `${tool} must return via screenshotResult`);
  }
});

test('the descriptions no longer tell the agent to go and read the file', () => {
  // The instruction was correct for the old shape and is actively misleading
  // now: following it would cost the round trip this change removes.
  assert.doesNotMatch(src, /read the file with your normal image-reading tool/);
});
