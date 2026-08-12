---
name: emoji-set
description: Generate a themed avatar emoji set (plus matching call background) with nanobanana, and switch the bot to it
argument-hint: "\"<theme description>\" [slug]   — or:  add <slug> <emoji> [<emoji> ...]"
disable-model-invocation: true
allowed-tools: Bash Read Write mcp__nanobanana__generate_image mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__list_call_instances
---

Generate a full replacement set of avatar-face images (a "skin" for the bot, like the
bundled `fluent3d` set) from a user-supplied theme, plus a matching call background, then
point the running bot at them.

Two forms:

```
/emoji-set "<theme description>"  [slug]     → create a brand-new set
/emoji-set add <slug> <emoji> [<emoji> ...]   → add specific emoji(s) to an existing set
```

If `$ARGUMENTS` doesn't clearly match either form, ask the user for a theme description —
it's whatever they'd hand an illustrator: a subject, an outfit/era, a mood, a palette. The
Taylor-Swift "Lover era" example this skill was built from:

> create an image of taylor swift, closeup of her face. Her facial expression is {emoji}
> she is dressed from the "Lover" era. Custom, high-leg Versace bodysuit that is fully
> encrusted in iridescent sequins that transition between shades of pastel pink, blue,
> gold, and purple. Keywords: Pastel, cotton candy, iridescent, shimmering, joyful.
> background is pure white, studio shoot.

Pick a short kebab-case `slug` from the theme if none is given (e.g. `taylor-swift-lover`).

## Where sets live

`~/Library/Application Support/Vibeconferencing/emoji-sets/<slug>/` — a sibling of the
app's `profiles/` directory. Create it with `mkdir -p`. Nothing else needs to exist there
in advance; this skill treats it as a flat folder of images.

## Step 1: Figure out which emoji this bot actually needs

Don't hardcode a list — the bot's states can change. Get the live one:

```
grep -oP "'[\x{1F000}-\x{1FFFF}\x{2600}-\x{27BF}][\x{FE0F}\x{200D}\x{1F000}-\x{1FFFF}]*'" \
  electron-app/page-inject.js electron-app/renderer/panel.js | sort -u
```

If that comes up empty (grep's PCRE unicode support varies by platform), fall back to
reading `electron-app/page-inject.js` (the `VirtualCamera` class, mode/activity/call-status
emoji) and `electron-app/renderer/panel.js` (idle-fidget faces) directly. As of this
skill's writing that's 21 glyphs:

| Emoji | Codepoint | Role |
|---|---|---|
| 🙂 | 1f642 | mode: active |
| 🤐 | 1f910 | mode: passive |
| 😶 | 1f636 | mode: silent |
| 😑 | 1f611 | ticking |
| 🤔 | 1f914 | thinking |
| 🧑‍💻 | 1f9d1-200d-1f4bb | working (ZWJ) |
| 😄 | 1f604 | speaking |
| 🙋 | 1f64b | yielding |
| 🫥 | 1fae5 | idle/joining/waiting/left ("not really there") |
| 😔 | 1f614 | IDLE |
| 😐 | 1f610 | HEARING |
| 🫤 | 1fae4 | SETTLING |
| 🙉 | 1f649 | deaf |
| 🥴 | 1f974 | impaired (captions off) |
| 😉 😏 😛 🙃 😌 😊 🥱 | 1f609 1f60f 1f61b 1f643 1f60c 1f60a 1f971 | idle-mood fidgets |

Filenames are lowercase hex codepoints, `-`-joined for ZWJ sequences, `.png` extension —
e.g. `1f642.png`, `1f9d1-200d-1f4bb.png`. (Other spellings work too — literal glyph,
uppercase+FE0F, `emoji_u`-prefixed — see `electron-app/emoji-assets.js` — but lowercase hex
is what the bundled `fluent3d` set uses, so match it.)

## Step 2: Generate the anchor image

Generate **one** base image first — a neutral-ish expression (🙂 or 😐 works well) — with
`mcp__nanobanana__generate_image`, `aspect_ratio: "1:1"`. Get the framing right here because
every other frame inherits it:

- Zoom out enough that the **top of the head and the chin are both fully in frame**, with a
  little shoulder/outfit visible. A tight face-only crop looks wrong once you can't see hair
  or chin — this was the #1 mistake generating the reference set for this skill.
- Ask for a **flat, single-color background** ("pure white, studio shoot" worked well) —
  needed for the best-effort transparency step later.
- Bake the theme's styling into the prompt once here; every derived frame will inherit it
  automatically by being edited *from* this image rather than re-describing the outfit each
  time.

Save it as `<set-dir>/_anchor.png` and also save the theme description as
`<set-dir>/_theme.txt` (plain text, just the prompt you used) — both are reused by the
"add more emoji later" flow in Step 5.

## Step 3: Derive every other state from the anchor

For each remaining glyph, call `generate_image` in **edit mode**: pass `_anchor.png` (or
the previous frame — anchor is usually safer, less drift) as `input_image_path_1`, and
instruct it to change *only* the specific thing, e.g.:

> Edit this image so her eyes are fully closed, as if blinking. Keep absolutely everything
> else identical: same hair, same hairstyle and position, same facial expression otherwise,
> same head angle, same outfit, same lighting, same background, same framing. The only
> change should be the eyes going from open to closed.

This holds hair/pose/outfit far more consistent than independent generations do — no
face-landmark alignment step is needed. Some per-frame drift is normal and fine (it reads
as a charming stop-motion/magazine-cutout look, not a bug) — don't chase pixel-perfect
alignment.

**Two exceptions:**

- **🧑‍💻 (working)** — zoom out enough to actually show a laptop in frame, and have the
  laptop screen/lid **partially obscure the face** (raised up in front, like mid-typing).
  The point of this state is to signal "the bot is busy and may not respond to you" — a
  laptop that's merely visible in the background doesn't read that way, but one blocking
  part of the face does. It's fine, and expected, that this one breaks face-size/alignment
  with the rest of the set.
- **🫥 (not really there)** — a literal "dotted line face" doesn't read as an expression.
  Reinterpret it as a **ghostly / faded / half-present** variant that fits the theme (for
  the reference set, a desaturated black-and-white "different-era" look worked well). Best
  effort: if `magick`/`convert` (ImageMagick) is on `PATH`, reduce its alpha —
  `magick <file> -channel A -evaluate multiply 0.45 +channel <file>` — after the background
  removal step below. If ImageMagick isn't available, skip this — an opaque ghost frame is
  a fine fallback, not a failure.

Save each result as `<set-dir>/<codepoint>.png`.

## Step 4: Best-effort background removal (optional, skip freely)

Not required — a flat-colored square behind each face can look fine, even funky-charming.
If `magick`/`convert` is available (`command -v magick`), key out the flat background on
each face file:

```
magick <file> -fuzz 8% -transparent white <file>
```

(Tune the fuzz percent if edges look chewed up — hair against a flat background rarely
keys perfectly, and that's OK for this look.) If ImageMagick isn't installed, don't try to
install anything for this — just ship the opaque versions and move on.

## Step 5: Generate the matching background

The bot's Meet-call background is **1280×720 (16:9), cover-fitted**. Generate one more
image with `generate_image`, `aspect_ratio: "16:9"`, reusing the theme's keywords/mood but
describing a scene/sky/setting rather than a face — no need to force exact pixel dimensions,
cover-fit handles any 16:9 source. Save as `<set-dir>/background.png`.

## Step 6: Wire it up

```
set_preference emojiSet "dir:<absolute path to set-dir>"
set_preference avatarBackgroundSvg "file:<absolute path to background.png>"
```

If no bot/call session is available to call these against, just tell the user the set is
ready and give them the two commands/paths to apply later — don't block on it.

Report what you built: the set directory, how many of the 21 glyphs got real art vs. fell
back, and the background path.

## Step 7 (only for `add <slug> <emoji>...`): extending an existing set

Resolve `<slug>` to `~/.../emoji-sets/<slug>/`. Read `_theme.txt` for the original prompt
and reuse `_anchor.png` as the edit-mode reference (same process as Step 3) for each new
emoji requested. Save into the same directory with the correct codepoint filename.

The running app **caches** directory listings per absolute path, so a newly added file
won't show up until the cache is invalidated. Re-issuing the *same* preference value forces
a re-index:

```
set_preference emojiSet "dir:<absolute path to set-dir>"
```
