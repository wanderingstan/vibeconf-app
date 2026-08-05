# Twemoji

These SVG emoji graphics are **Twemoji** by Twitter, vendored from
https://github.com/twitter/twemoji (release v14.0.2, `assets/svg`).

- Graphics: **CC-BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- Copyright 2019 Twitter, Inc and other contributors.

Filenames are the emoji's hyphen-joined hex Unicode codepoints (Twemoji
convention; the `fe0f` variation selector is dropped except in ZWJ sequences).
Re-fetch with `scripts/fetch-emoji.sh twemoji`.

---

**This directory now holds ONE sample face**, not the set. The full artwork ships as a colour font in `../fonts/twemoji.ttf` — same licence, same attribution, see `../fonts/NOTICE.md`. The sample survives because `list_visual_assets` gives the whiteboard a file path per set for the setup call's picker, and the whiteboard renders on the website, which cannot use a font bundled here.
