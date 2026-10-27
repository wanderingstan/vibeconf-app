// whiteboard-images.js: find local image references in update_whiteboard
// markdown so they can be registered with the app's asset server and rewritten
// to http://127.0.0.1:PORT/asset/{token} URLs.
//
// Handles the shapes an agent actually writes for a path with spaces, e.g.
// "/Volumes/Archive/Family Archives/thumbs/675.jpg":
//   ![a](/abs/path.png)                  plain path
//   ![a](</abs/with space.png>)          CommonMark angle brackets
//   ![a](/abs/with space.png)            raw spaces (not valid markdown, but
//                                        written all the time; we fix it up)
//   ![a](file:///abs/with%20space.png)   file URL, percent-decoded
// The old pattern stopped at the first space, so a path with one was never
// registered and the board showed a broken image.
//
// Lives in mcp-server/ (it ships as extraResources and cannot import from
// electron-app/; see tests/mcp-server-has-no-electron-app-imports.test.mjs).

import { fileURLToPath } from "node:url";

// ![alt](<target>) or ![alt](target) where target runs to the closing paren.
const LOCAL_IMG = /!\[([^\]]*)\]\(\s*(?:<([^>\n]+)>|([^)\n]+?))\s*\)/g;

// Turn a markdown image target into an absolute local path, or null when it
// is not a local file (http:, data:, relative, or a malformed file URL).
export function localImagePath(target) {
  // Drop a markdown title: ![a](/x.png "caption").
  const t = String(target || "").trim().replace(/\s+(["'])[^"']*\1$/, "");
  if (/^file:/i.test(t)) {
    try { return fileURLToPath(t); } catch { return null; }
  }
  if (t.startsWith("/")) return t;
  return null;
}

// Every local image reference in `content`: [{ whole, alt, path }].
export function findLocalImages(content) {
  const out = [];
  for (const m of String(content || "").matchAll(LOCAL_IMG)) {
    const p = localImagePath(m[2] ?? m[3]);
    if (p) out.push({ whole: m[0], alt: m[1], path: p });
  }
  return out;
}

// Replace each registered local image with its asset URL. `urls` maps path to
// URL; paths missing from it are left exactly as written.
export function rewriteLocalImages(content, urls) {
  return String(content || "").replace(LOCAL_IMG, (whole, alt, angled, bare) => {
    const p = localImagePath(angled ?? bare);
    return p && urls.has(p) ? `![${alt}](${urls.get(p)})` : whole;
  });
}
