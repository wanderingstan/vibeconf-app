// svg-cover.js — make an INLINE <svg> behave like `object-fit: cover`.
//
// The panel's bot-box avatar is a square (54×54). Backgrounds are authored
// landscape (the virtual camera is 16:9), so a landscape SVG dropped into a
// square box needs to be scaled up and center-cropped — not letterboxed.
//
// `object-fit` does NOT apply to inline <svg>. It only affects replaced
// elements (<img>, <video>, <canvas>). We inject the background via innerHTML,
// so the CSS rule `.agent-avatar-bg svg { object-fit: cover }` was inert, and
// the SVG fell back to its default preserveAspectRatio of "xMidYMid meet" —
// which is `contain`. Hence the letterboxing.
//
// The SVG-native spelling of cover is `preserveAspectRatio="xMidYMid slice"`.
// "meet" = fit entirely inside (contain); "slice" = fill and overflow (cover).
// xMidYMid centers the overflow, which is what the eye expects.
//
// Same decision as drawCover() in page-inject.js (#428), which does this by hand
// on a canvas because there the source is a rasterized image. Two renderers, one
// rule: preserve aspect, fill the box, crop the overflow, keep it centered.
//
// preserveAspectRatio has NO effect without a viewBox — the SVG just stretches
// to the CSS width/height. So when the author omitted one but gave width/height,
// we synthesize a viewBox from them. If we can't establish intrinsic dimensions
// at all, we leave the element alone rather than guess.

(function attach(root) {
  const COVER = 'xMidYMid slice';

  function coverFitSvg(svgEl) {
    if (!svgEl || svgEl.tagName?.toLowerCase() !== 'svg') return false;

    if (!svgEl.getAttribute('viewBox')) {
      // Only bare numbers/px make a meaningful viewBox; "100%" tells us nothing.
      const num = (v) => {
        const m = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(v || '');
        return m ? Number(m[1]) : null;
      };
      const w = num(svgEl.getAttribute('width'));
      const h = num(svgEl.getAttribute('height'));
      if (!w || !h) return false; // no intrinsic aspect — nothing to preserve
      svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }

    // Author intent is overridden on purpose: the avatar tile decides its own
    // fit, exactly as a CSS `object-fit` on an <img> would.
    svgEl.setAttribute('preserveAspectRatio', COVER);
    // Let CSS own the box. A width/height baked into the SVG would otherwise
    // win over `width:100%; height:100%` in some engines.
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    return true;
  }

  // Convenience: apply to the first <svg> inside a container (what the panel has).
  function coverFitFirstSvg(container) {
    const svgEl = container && container.querySelector && container.querySelector('svg');
    return coverFitSvg(svgEl);
  }

  root.coverFitSvg = coverFitSvg;
  root.coverFitFirstSvg = coverFitFirstSvg;
  // Node (tests) — the renderer loads this as a classic <script>, where `module`
  // does not exist.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { coverFitSvg, coverFitFirstSvg, COVER };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
