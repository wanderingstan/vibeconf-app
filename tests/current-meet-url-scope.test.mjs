// current-meet-url-scope.test.mjs — currentMeetUrl / detectedMeetUrl are ONE
// module-level variable each.
//
// Seen live 2026-10-15: "Unhandled promise rejection: currentMeetUrl is not
// defined" when a --meet-url launch landed on Google's sign-in page. The vars
// were declared with `let` inside app.whenReady(), but the leave teardown, the
// MCP /join-call path, joinMeetUrl and the #347 guest fallback (identity
// challenge, join as guest) live at module scope and saw no declaration. In
// sloppy mode their writes created a second, implicit global; a --meet-url
// launch only ever set the inner copy, so the guest fallback's read of the
// never-created global threw and the guest join never happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const main = fs.readFileSync(path.join(__dirname, '../electron-app/main.js'), 'utf-8');

for (const name of ['currentMeetUrl', 'detectedMeetUrl']) {
  test(`${name} is declared exactly once, at module scope`, () => {
    const decls = main.match(new RegExp(`^[ \\t]*(?:let|var|const)\\s+${name}\\b`, 'gm')) || [];
    assert.equal(decls.length, 1, `expected one declaration of ${name}, found ${decls.length}`);
    // Column 0 = top level of the CommonJS module. An indented declaration is
    // what shadowed it inside app.whenReady() and caused the bug.
    assert.match(main, new RegExp(`^let ${name} = null;`, 'm'));
  });
}

test('the declaration precedes every module-level reader and writer', () => {
  const decl = main.search(/^let currentMeetUrl = null;/m);
  const teardown = main.indexOf('function performLeaveTeardown(');
  const joinMeetUrl = main.indexOf('function joinMeetUrl(');
  assert.ok(decl > 0 && teardown > 0 && joinMeetUrl > 0);
  assert.ok(decl < teardown, 'declared before the leave teardown that resets it');
  assert.ok(decl < joinMeetUrl, 'declared before joinMeetUrl that sets it');
});

test('the #347 guest fallback reads the shared currentMeetUrl', () => {
  const guard = main.indexOf('if (currentMeetUrl && guestFallbackTriedFor !== currentMeetUrl)');
  assert.ok(guard > 0, 'guest fallback guard present');
  assert.match(main.slice(guard, guard + 1500), /loadMeetURL\(currentMeetUrl, \{ guestFallback: true \}\)/);
  // The fallback sits inside app.whenReady(); it must not have its own copy
  // anywhere between the module-level declaration and the read.
  const decl = main.search(/^let currentMeetUrl = null;/m);
  assert.doesNotMatch(main.slice(decl + 1, guard), /\b(?:let|var|const)\s+currentMeetUrl\b/);
});

test('the --meet-url auto-join sets the same variable the guest fallback reads', () => {
  const i = main.indexOf("if (cliArgs['meet-url']) {");
  assert.ok(i > 0);
  assert.match(main.slice(i, i + 300), /currentMeetUrl = meetUrl;/);
});

test('a failed join forgets currentMeetUrl so the browser-tab poll resumes', () => {
  // pollForMeet early-returns while currentMeetUrl is set; a failed join never
  // reaches performLeaveTeardown, so the Error path must clear it itself.
  const i = main.indexOf("if (status.startsWith('Error')) {");
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf("} else if (status.startsWith('Notice:')) {", i));
  assert.match(body, /localServer\.clearRoom\(\);[\s\S]*currentMeetUrl = null;/);
});
