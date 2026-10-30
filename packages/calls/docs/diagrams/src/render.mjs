// render.mjs: renders the diagram sources in ./ (JSX, as written in the design
// doc) to ../<name>.svg, standalone, with light and dark palettes.
//
//   for n in architecture classes-and-contracts call-console-mockup; do
//     npx esbuild@0.24.0 $n.jsx --loader:.jsx=jsx --jsx-factory=__jsx --format=cjs > /tmp/$n.cjs
//     node render.mjs /tmp/$n.cjs ../$n.svg
//   done
//
// The renderer, bundled for docs only; nothing in the library uses it.

import { readFileSync, writeFileSync } from 'node:fs';

// SVG attributes that keep camelCase; everything else becomes kebab-case.
const KEEP = new Set(['viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'preserveAspectRatio']);
const kebab = (k) => (KEEP.has(k) ? k : k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Theme tokens → CSS custom properties defined in the SVG's own <style>.
const TOKENS = {
  '--cds-chart-axis': 'edge',
  '--cds-chart-grid': 'grid',
  '--cds-chart-categorical-1': 'accent',
  '--cds-text-primary': 'ink',
  '--cds-text-secondary': 'quiet',
  '--cds-chart-reference-tint': 'tint',
};
const STYLE = `
  svg { --edge: #8c959f; --grid: #d0d7de; --accent: #0969da; --ink: #1f2328; --quiet: #59636e; --tint: #f6f8fa;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  @media (prefers-color-scheme: dark) {
    svg { --edge: #6e7681; --grid: #3d444d; --accent: #4493f8; --ink: #e6edf3; --quiet: #9198a1; --tint: #161b22; }
  }`;
const COLOR_ATTRS = new Set(['fill', 'stroke']);

class Markup { constructor(s) { this.s = s; } }
function h(tag, props, ...children) {
  if (typeof tag === 'function') return tag({ ...props, children });
  const attrs = [];
  const style = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || k === 'key' || k.startsWith('data-claude')) continue;
    const name = kebab(k);
    const m = typeof v === 'string' && v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (m && COLOR_ATTRS.has(name)) {
      // var() in a presentation attribute isn't reliable; in style it is.
      style.push(`${name}:var(--${TOKENS[m[1]] || m[1].slice(2)})`);
      continue;
    }
    attrs.push(`${name}="${esc(v)}"`);
  }
  if (style.length) attrs.push(`style="${style.join(';')}"`);
  const inner = children.flat(Infinity).filter((c) => c !== false && c != null).map((c) => (c instanceof Markup ? c.s : esc(c))).join('');
  return new Markup(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${tag}>`);
}

const [, , compiled, out] = process.argv;
const src = readFileSync(compiled, 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', '__jsx', src)(mod, mod.exports, h);
let svg = (mod.exports.default || mod.exports)().s;
svg = svg.replace(/^<svg /, '<svg xmlns="http://www.w3.org/2000/svg" ').replace(/^(<svg[^>]*>)/, `$1<style>${STYLE}\n</style>`);
writeFileSync(out, svg + '\n');
console.log('wrote', out, svg.length, 'bytes');
