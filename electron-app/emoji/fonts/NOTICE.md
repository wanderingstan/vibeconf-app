# Bundled emoji fonts

The same artwork the app used to ship as thousands of SVGs, in colour-font form.
**The licences are unchanged — this is the same art, redistributed differently,
and the attribution below is required.**

## twemoji.ttf — Twemoji
Colour build (COLR/CPAL) from **mozilla/twemoji-colr**
— https://github.com/mozilla/twemoji-colr

- Artwork: **CC-BY 4.0** — https://creativecommons.org/licenses/by/4.0/
- Copyright 2019 Twitter, Inc and other contributors.

## openmoji.ttf — OpenMoji
`OpenMoji-color-glyf_colr_1.ttf` from the OpenMoji font release
— https://openmoji.org / https://github.com/hfg-gmuend/openmoji

- **CC BY-SA 4.0** — https://creativecommons.org/licenses/by-sa/4.0/
- "All emojis designed by OpenMoji – the open-source emoji and icon project."

## noto.ttf — Noto Color Emoji
`Noto-COLRv1.ttf` from **googlefonts/noto-emoji**
— https://github.com/googlefonts/noto-emoji

- **Apache License 2.0** / OFL — see the repo.
- Copyright Google Inc.

## Why fonts

Three sets were ~11,900 files and 76MB; as fonts they are three files and 8.4MB.
They render in colour on a canvas — verified inside a real Meet page, where the
worry was CSP. It never applies: a FontFace built from an ArrayBuffer has no URL
for `font-src` to check.

fluent3d is NOT here. Its 3D style is rendered raster art with no font
equivalent, so it stays as PNGs in `../fluent3d/`.

One `🙂` per set also survives in `../twemoji/`, `../openmoji/` and `../noto/`:
`list_visual_assets` hands those paths to the whiteboard for the setup call's
picker, and the whiteboard renders on the website, which cannot use a font we
bundle here.
