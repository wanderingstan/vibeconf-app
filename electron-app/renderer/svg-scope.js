// svg-scope.js: give each inline copy of an SVG its own id namespace.
//
// The panel injects the SAME background SVG into several places at once: the
// masthead tile, the Bot Settings heading tile, and the Settings background
// preview. Inline SVG ids are DOCUMENT-global, so every copy after the first
// re-declares the same ids, and `url(#sky)` / `<use href="#cloud">` in EVERY
// copy resolve to the first match in document order.
//
// That would be harmless if the first match always painted. It doesn't: the
// masthead copy lives inside #mainScreen, which is display:none while the
// Settings screen is up, and a paint server inside a display:none subtree
// paints nothing. So a background whose sky is `fill="url(#sky)"` renders as
// EMPTY on the Settings screen while its literal-fill shapes render normally,
// the reported "black sky and no clouds", with the hills still there.
//
// Rewriting ids per copy removes the collision entirely, which is more robust
// than trying to control which copy happens to be visible.
//
// Only ids DEFINED in this SVG are rewritten, so a reference to something
// outside it (rare, but legal) is left alone rather than silently repointed.

(function attach(root) {
  const ID_ATTR_RE = /(\sid\s*=\s*)(["'])([^"']+)\2/g;
  const URL_REF_RE = /url\((["']?)#([^)"']+)\1\)/g;
  const HREF_REF_RE = /(\s(?:xlink:)?href\s*=\s*)(["'])#([^"']+)\2/g;

  function scopeSvgIds(svg, scope) {
    if (typeof svg !== 'string' || !svg.trim() || !scope) return svg;

    // Collect what this SVG actually defines before rewriting anything.
    const defined = new Set();
    for (const m of svg.matchAll(ID_ATTR_RE)) defined.add(m[3]);
    if (!defined.size) return svg;

    const renamed = (id) => scope + '-' + id;

    return svg
      .replace(ID_ATTR_RE, (full, pre, q, id) =>
        defined.has(id) ? `${pre}${q}${renamed(id)}${q}` : full)
      // Paint servers, masks, clips, filters: `fill="url(#sky)"` and friends.
      .replace(URL_REF_RE, (full, q, id) =>
        defined.has(id) ? `url(${q}#${renamed(id)}${q})` : full)
      // <use href="#cloud">, and the legacy xlink spelling.
      .replace(HREF_REF_RE, (full, pre, q, id) =>
        defined.has(id) ? `${pre}${q}#${renamed(id)}${q}` : full);
  }

  // Stable per-element namespace: the same tile keeps its scope across
  // re-renders, so repainting doesn't churn ids on every 60s tick.
  let seq = 0;
  function scopeForElement(el) {
    if (!el) return null;
    if (!el.dataset.svgScope) el.dataset.svgScope = 'vbg' + (++seq);
    return el.dataset.svgScope;
  }

  root.scopeSvgIds = scopeSvgIds;
  root.scopeForElement = scopeForElement;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { scopeSvgIds, scopeForElement };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
