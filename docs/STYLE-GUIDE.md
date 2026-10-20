# Style guide: the app and the website

One visual system for vibeconferencing.com and the desktop app's windows.
Decided 2026-09-06 (Seth + Stan): the **Fluent palette + Syne**. Site first,
app after, no piecemeal.

This document is the written form of a system that until now lived only in
code and PR descriptions. The code is still the source of truth; when this
page and the code disagree, fix one of them.

| Where the tokens live | What it covers |
| --- | --- |
| `src/theme.ts` in [wanderingstan/vibeconferencing](https://github.com/wanderingstan/vibeconferencing) | the site (MUI theme, `FLUENT` tokens exported) |
| `electron-app/renderer/panel.css` (`:root` block) | the app's windows; `about.html`, `app-settings.html`, `onboarding.html` repeat the same block inline |
| `electron-app/renderer/fonts.css` | the vendored fonts |

History: site restyle in vibeconferencing PR 536 (merged 2026-09-15);
app windows in vibeconf-app PR 713 (merged 2026-09-25); the palette and type
comparison that fed both is parked on vibeconferencing PR 538, "not for merge",
with a token map at `public/design/app/`.

## Where the palette comes from

The colours are measured off the Fluent 3D emoji faces the bot wears
(k-means over 119 faces, vibeconferencing PR 537). That is why nothing is
pure: the set's darkest pixel is `#3F2831`, so the ink is plum, not black, and
the ground is lemon cream, not white. The faces are lit from the upper right,
so every shadow in the system falls **down and to the left**.

## Colour tokens

| Token | Hex | Use |
| --- | --- | --- |
| `--cream` | `#FFF4DA` | page and window ground |
| `--paper` | `#FFFDF7` | cards, panels, secondary buttons |
| `--paper-lo` | `#FFE7B3` | hover on paper, chips, disabled primary |
| `--ink` | `#4A3140` | text, borders, the strongest line |
| `--ink-soft` | `#6B5566` | secondary text, hints (passes contrast) |
| `--ink-faint` | `#9A8798` | decorative only; fails contrast for body text |
| `--pink` | `#E62776` | brand accent: rules, borders, checkmarks, the ✦, focus rings |
| `--pink-deep` | `#B31199` | filled buttons and hover; error text |
| `--magenta` | `#9F0BA4` | links, mono eyebrows |
| `--line` | `#F1D9A4` | hairlines, dividers, card borders |
| `--go` | `#44CE81` | app only: the button that **starts** a call |
| `--go-deep` | `#3BBE74` | hover on `--go` |

Contrast rules that shaped the table:

- Filled buttons on the site rest on `--pink-deep`, not `--pink`. Cream on
  pink is 3.91:1, under WCAG AA. Cream on pink-deep is 5.56:1, on magenta
  6.28:1. Hot pink stays where contrast is not read.
- The call-green exception (Stan, 2026-09-24): pink on the call button read as
  hang-up. Green means call, red means hang up, the way every phone draws it.
  `--go` is the Fluent set's own green. Label it in ink (5.8:1), never cream.
- Otherwise there is no green. A success state is a glyph plus a word in ink,
  not a colour.

Shadows are soft plum, never a hard black offset:

| | site (`theme.ts`) | app (`panel.css`) |
| --- | --- | --- |
| `shadow` | `-1px 2px 8px rgba(74,49,64,.24)` | `-1px 2px 6px rgba(74,49,64,.20)` |
| `shadow-lo` | `-1px 1px 4px rgba(74,49,64,.18)` | `-1px 1px 3px rgba(74,49,64,.14)` |

## Type

| Role | Family | Weights | Fallback stack |
| --- | --- | --- | --- |
| Display | Syne | 700, 800 | Futura, Trebuchet MS, sans-serif |
| Body | DM Sans | 400, 500, 600, 700 | Avenir Next, -apple-system, sans-serif |
| Mono | JetBrains Mono | 400, 500 | ui-monospace, Menlo, monospace |

- **Syne** is for names, headings, and button labels. Headings are 800 at
  display sizes with `-0.02em` tracking, 700 below that. Buttons are 700,
  sentence case, no uppercase transform.
- **DM Sans** is everything else people read.
- **JetBrains Mono** is for fine print and eyebrows: 10 to 11px, 500 or 700,
  uppercase, tracked `.06em` on the site and `.18em` in the app.
- The **mono eyebrow** is the strongest brand tell at app scale. In the app
  it is magenta with a pink `✦` before it. Section headers in the app's
  windows are eyebrows, not headings.

Loading: the site fetches all three from Google Fonts. The app **vendors**
them (latin woff2, about 280 KB, in `electron-app/renderer/fonts/`) so every
window paints the same offline and on first launch, with no request to
Google. If you add a weight, add it to `fonts.css` and the site's font link
both.

Known gap: the shared whiteboard blocks external font loading, so brand type
silently falls back there (vibeconf-app issue 704). Brand type on the board is
an opt-in preset, never the default (vibeconferencing issue 541).

## Shape and lines

| | Site | App |
| --- | --- | --- |
| Corner radius | 4px | 5 to 6px (controls want a touch more); buttons are pills |
| Primary border | 2px ink | 1.5px ink (2px reads heavy at native density) |
| Hairline | 2px `--line` dividers | 1px `--line` |
| Button hover | shadow drops to `shadow-lo`, nudges `translate(-1px, 1px)` | background shifts to the next ground |
| Focus ring | MUI default | 2px `--pink` outline, 1px offset |

Site components (from `theme.ts`): outlined inputs with a 2px ink border on
white; chips in mono, uppercase, on paper-lo with a 1.5px ink border; links
in magenta, always underlined, 1.5px thick, 3px offset; the app bar is ink
with cream text.

## The app: Layer 1 only

The app's windows take the site's grounds, ink lines, palette, and mono
eyebrows, and keep the bot's face big. They do **not** take the site's
billboard type, seals, or grain. At app density those read as noise.

- **Native controls stay native.** Selects, checkboxes, and text fields keep
  their shape; only colour, border, and type change.
- **One primary per window.** Everything else is `.secondary` (paper, ink
  text). A second filled button is a bug, not emphasis.
- **State is a glyph plus a word**, in ink or pink-deep. No traffic lights.
- **The window is the bot** (Stan, 2026-09-07). The user's avatar artwork
  fills the main panel. The chrome on top of it (name, gear) sits on a
  translucent ink chip with light text (`--on-art: #FFF4DA`) and a tight
  black outline, so it reads on any artwork, including near-white. This is
  the one surface in the app that is not cream.
- Long bot names step down from 26px to a 15px floor before the ellipsis
  (`fitBotName()` in `panel.js`). Syne is wider than the old Google Sans.
- The Brain and Troubleshooting windows are cream like everything else, with
  no developer-surface special case.
- The app icon is untouched.

Not yet restyled, as of PR 713: `call-recording-window.html`,
`call-recording-merge-window.html`, and `idle.html`.

## What stays dark

The room / call view on the site keeps `src/darkTheme.ts` (Google Meet-style
dark, Google Sans + Roboto). It goes out as video among camera tiles, and so
do the whiteboard renderer and the other on-air surfaces. Do not bring cream
into anything a Meet participant sees as a tile.

## Writing

No em-dashes anywhere, in copy or comments. Use commas, colons, or
parentheses. Lowercase wordmark on the site. Sentence case on buttons.
