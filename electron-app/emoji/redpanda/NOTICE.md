# Red Panda (claymation)

A claymation red-panda librarian character. **Generated art** — made with
`/emoji-set` (`mcp-server/emoji-set-skill.md`), which drives Google's Gemini
image model through the `nanobanana` MCP server. Not vendored from a third-party
emoji project, so unlike the other bundled sets there is no upstream licence to
carry: these files were produced for this app.

**Curated set (21 PNGs)** — exactly the avatar's face vocabulary, derived from
the bot's own states in `page-inject.js` and `renderer/panel.js` rather than a
fixed list: the three modes (🙂 🤐 😶), the activity faces (🤔 🧑‍💻 😄 😑 😐 🫤 🙋
🫥), the two impairment faces (🙉 🥴), and the idle-mood fidgets (😉 😏 😛 🙃 😌
😊 🥱). Anything outside that falls back to the native glyph, the same way
fluent3d's missing hand/person gestures do.

Files are PNG named by the canonical hex codepoint, hyphen-joined for ZWJ
sequences (`1f9d1-200d-1f4bb.png`) — the same scheme as fluent3d.

Re-generate, or add faces to it, with `/emoji-set`.
