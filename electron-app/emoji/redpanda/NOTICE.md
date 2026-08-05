# Red Panda (claymation)

A claymation red-panda librarian character. **Generated art** — made with
`/emoji-set` (`mcp-server/emoji-set-skill.md`), which drives Google's Gemini
image model through the `nanobanana` MCP server. Not vendored from a third-party
emoji project, so unlike the other bundled sets there is no upstream licence to
carry: these files were produced for this app.

**Curated set (36 PNGs)** — the avatar's face vocabulary, derived from the bot's
own states in `page-inject.js` and `renderer/panel.js` rather than a fixed list:
the three modes (🙂 🤐 😶), the activity faces (🤔 🧑‍💻 😄 😑 😐 🫤 🙋 🫥), the two
impairment faces (🙉 🥴), the idle-mood fidgets (😉 😏 😛 🙃 😌 😊 🥱), and the
wider palette the agent reaches for when it `speak`s with an emoji (🤯 🤔 🧐 🫠
😬 💀 🎉 …). Anything outside the set falls back to the native glyph, the same
way fluent3d's missing hand/person gestures do.

The count is asserted by a test against the files on disk — it went stale within
a day of being written, when the speak palette was added and this paragraph was
not.

Files are PNG named by the canonical hex codepoint, hyphen-joined for ZWJ
sequences (`1f9d1-200d-1f4bb.png`) — the same scheme as fluent3d.

Re-generate, or add faces to it, with `/emoji-set`.
