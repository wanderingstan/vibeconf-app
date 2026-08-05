# OpenMoji

Color SVG emoji from **OpenMoji** — https://openmoji.org / https://github.com/hfg-gmuend/openmoji

- License: **CC BY-SA 4.0** — https://creativecommons.org/licenses/by-sa/4.0/
- "All emojis designed by OpenMoji – the open-source emoji and icon project."

Filenames are the emoji's **UPPERCASE** hex codepoints, hyphen-joined, fully
qualified (the `FE0F` variation selector is KEPT — the page-inject resolver has a
per-set naming rule for this). Vendored from the `openmoji-svg-color` release.
  Re-fetch with `scripts/fetch-emoji.sh openmoji`.

---

**This directory now holds ONE sample face**, not the set. The full artwork ships as a colour font in `../fonts/openmoji.ttf` — same licence, same attribution, see `../fonts/NOTICE.md`. The sample survives because `list_visual_assets` gives the whiteboard a file path per set for the setup call's picker, and the whiteboard renders on the website, which cannot use a font bundled here.
