// svg-resolver.js — Inline external image references in an SVG as data URIs.
//
// Background SVGs reach the renderer where canvas tainting rules apply: any
// non-data: image source either fails to load (file://) or taints the canvas
// (cross-origin https), and a tainted canvas breaks captureStream — the bot
// video freezes. We resolve every <image> href on the Node side first, where
// we can fs.readFile and fetch() without any of those restrictions, then hand
// the renderer a fully-self-contained SVG.

const fs = require('fs');
const path = require('path');

const HREF_ATTR_RE = /\s(?:xlink:href|href)\s*=\s*(["'])([^"']+)\1/g;
const SCRIPT_TAG_RE = /<script\b[^>]*>[\s\S]*?<\/script>/gi;

function extFromContentType(ct) {
  if (!ct) return 'png';
  const lower = ct.toLowerCase();
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpeg';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('svg')) return 'svg+xml';
  return 'png';
}

function extFromPath(p) {
  const e = path.extname(p).slice(1).toLowerCase();
  if (e === 'jpg') return 'jpeg';
  if (['png', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) {
    return e === 'svg' ? 'svg+xml' : e;
  }
  return 'png';
}

async function resolveRef(href) {
  if (href.startsWith('data:')) return href;

  if (href.startsWith('file://') || href.startsWith('/') || href.startsWith('~/')) {
    let p = href.replace(/^file:\/\//, '');
    if (p.startsWith('~/')) p = path.join(require('os').homedir(), p.slice(2));
    const buf = await fs.promises.readFile(p);
    return `data:image/${extFromPath(p)};base64,${buf.toString('base64')}`;
  }

  if (href.startsWith('http://') || href.startsWith('https://')) {
    const res = await fetch(href);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${href}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:image/${extFromContentType(res.headers.get('content-type'))};base64,${buf.toString('base64')}`;
  }

  // Unknown scheme: leave untouched. Renderer will likely fail, fall back to default.
  return href;
}

// Resolve every image href in the SVG concurrently. Returns the rewritten SVG.
// Throws on any irrecoverable error; caller should fall back to default.
async function resolveSvg(svg) {
  if (typeof svg !== 'string') throw new Error('SVG must be a string');

  // Strip <script> tags defensively. We trust the agent, but the SVG is
  // injected into the page DOM via drawImage of an SVG data: URI; while
  // drawImage doesn't execute scripts, this prevents accidental copy-paste
  // into other surfaces (panel preview, etc).
  let sanitized = svg.replace(SCRIPT_TAG_RE, '');

  // Collect distinct hrefs and resolve them in parallel.
  const hrefs = new Set();
  for (const m of sanitized.matchAll(HREF_ATTR_RE)) {
    const href = m[2];
    if (!href.startsWith('data:') && !href.startsWith('#')) hrefs.add(href);
  }

  if (hrefs.size === 0) return sanitized;

  const resolved = {};
  await Promise.all([...hrefs].map(async (href) => {
    try {
      resolved[href] = await resolveRef(href);
    } catch (err) {
      console.warn('[svg-resolver] Failed to resolve', href + ':', err.message);
      // Leave original — renderer will skip the missing image but the rest
      // of the SVG still renders.
      resolved[href] = href;
    }
  }));

  return sanitized.replace(HREF_ATTR_RE, (full, q, href) => {
    const r = resolved[href];
    return r ? ` href=${q}${r}${q}` : full;
  });
}

module.exports = { resolveSvg };
