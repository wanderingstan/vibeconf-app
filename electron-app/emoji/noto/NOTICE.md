# Noto Emoji

SVG emoji from **Google Noto Emoji** — https://github.com/googlefonts/noto-emoji

- License: **Apache License 2.0** (the SVG sources) / emoji under OFL — see the repo.
- Copyright Google Inc.

Filenames are `emoji_u<lowercase hex>[_<hex>…].svg` (underscore-joined, FE0F
dropped except in ZWJ sequences). Re-fetch with `scripts/fetch-emoji.sh noto`.

---

**This directory now holds ONE sample face**, not the set. The full artwork ships as a colour font in `../fonts/noto.ttf` — same licence, same attribution, see `../fonts/NOTICE.md`. The sample survives because `list_visual_assets` gives the whiteboard a file path per set for the setup call's picker, and the whiteboard renders on the website, which cannot use a font bundled here.
