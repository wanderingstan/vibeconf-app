// whiteboard-history.test.mjs — read_whiteboard must be able to see the board's
// prior versions, not just the current one (#380).
//
// The sync server has kept up to 50 prior versions all along (Redis list,
// newest first), but nothing exposed them to the agent, which reasoned from
// local state and concluded, wrongly, that overwritten boards were gone.
// The fix follows the existing layering: MCP tool option -> local-server
// passthrough -> sync server, routed by ROOM CODE like the rest of
// whiteboard sync.
//
// Run: node --test tests/whiteboard-history.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

// --- local-server passthrough ---

test('local server exposes a whiteboard-history passthrough', () => {
  assert.match(local, /url\.pathname === '\/api\/whiteboard-history' && req\.method === 'GET'/,
    'the MCP server talks only to the local server, so history needs a local route');
});

test('the passthrough hits the sync server by room code, same base URL as the rest of sync', () => {
  // The upstream endpoint takes the ROOM CODE, not a call id — easy to get
  // wrong, so pin the exact URL shape.
  assert.match(local, /\$\{base\}\/api\/room\/\$\{encodeURIComponent\(room\)\}\/whiteboard-history/);
  const route = local.slice(local.indexOf("'/api/whiteboard-history'"));
  assert.match(route.slice(0, 2000), /getWebsiteUrl\(\)/,
    'must route through the same website base URL existing whiteboard sync uses');
});

test('no room and no sync server are reported, not thrown', () => {
  const route = local.slice(local.indexOf("'/api/whiteboard-history'"));
  assert.match(route.slice(0, 1200), /success: false, error: 'no-room'/);
  assert.match(route.slice(0, 1200), /success: false, error: 'no-sync-server'/);
});

test('an unreachable sync server becomes a JSON error with a timeout bound', () => {
  const route = local.slice(local.indexOf("'/api/whiteboard-history'"));
  assert.match(route.slice(0, 3000), /AbortSignal\.timeout\(/,
    'without a timeout a dead sync server hangs the tool call');
  assert.match(route.slice(0, 3000), /sync server unreachable: \$\{err\.message\}/);
});

// --- MCP tool option ---

test('history is an option on read_whiteboard, not a second tool', () => {
  // Issue #380 explicitly prefers extending the tool the agent already
  // reaches for over adding one more tool to know about.
  assert.doesNotMatch(mcp, /read_whiteboard_history/);
  const tool = mcp.slice(mcp.indexOf('"read_whiteboard"'));
  assert.match(tool.slice(0, 3000), /history: z\.boolean\(\)\.optional\(\)/);
  assert.match(tool.slice(0, 3000), /version: z\.number\(\)\.optional\(\)/);
});

test('the tool description says history exists', () => {
  // Without this the agent cannot know to ask: it reasons from local state
  // and declares earlier boards unrecoverable.
  const desc = mcp.slice(mcp.indexOf('"read_whiteboard"'), mcp.indexOf('"read_whiteboard"') + 1200);
  assert.match(desc, /50 prior versions/);
  assert.match(desc, /NOT lost/);
});

test('the history fetch goes through the local server passthrough', () => {
  assert.match(mcp, /\$\{BASE_URL\}\/api\/whiteboard-history\?room=\$\{encodeURIComponent\(roomId\)\}/,
    'MCP -> local server -> sync server; the tool must not call the website directly');
});

test('version: N returns one entry in full; a miss lists what exists', () => {
  const tool = mcp.slice(mcp.indexOf('"read_whiteboard"'));
  assert.match(tool, /Number\(e\.version\) === Number\(version\)/);
  assert.match(tool, /No stored prior version \$\{version\}/);
  assert.match(tool, /Whiteboard version \$\{hit\.version\}/);
});

test('empty history and fetch failure come back as tool-result text, not throws', () => {
  const tool = mcp.slice(mcp.indexOf('"read_whiteboard"'));
  assert.match(tool, /No prior whiteboard versions are stored for this room yet/);
  assert.match(tool, /Could not fetch whiteboard history/);
  assert.match(tool, /Error contacting local server/);
});

test('the listing is previews, not 50 full boards', () => {
  // Response-size convention: neighbors truncate (get_room_info slices the
  // board to 500 chars); a 50-entry listing must not dump full content.
  const tool = mcp.slice(mcp.indexOf('"read_whiteboard"'));
  assert.match(tool, /\.slice\(0, 200\)/,
    'each history entry should carry a bounded preview; full content is version: N');
});
