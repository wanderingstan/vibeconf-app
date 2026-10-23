# Felt puppet

An original fuzzy teal felt puppet in the style of classic TV puppetry: ping-pong
ball eyes, orange felt brows and nose, a yarn hair tuft and a striped sweater.
**Generated art**, made with `/emoji-set` (`mcp-server/emoji-set-skill.md`),
which drives Google's Gemini image model through the `nanobanana` MCP server.
Made and approved by Stan in call `cro-arkh-xya-20261020T193244Z`. Not vendored
from a third-party emoji project, so there is no upstream licence to carry.

**Curated set (23 PNGs)**: the avatar's face vocabulary, the same scheme as
redpanda: the modes (🙂 🤐 😶), activity faces (🤔 🧑‍💻 😄 😑 😐 🫤 🙋 🫥), the
impairment faces (🙉 🥴), the idle-mood fidgets (😉 😏 😛 🙃 😌 😊 🥱), plus ☺️ 😔
and 🤭. Anything outside the set falls back to the native glyph, the same way
fluent3d's and redpanda's gaps do.

🤭 was generated on a white background and keyed to transparency by a flood fill
from the corners (not a global colour key, which would also have eaten the white
eyes). It is framed wider than the rest, showing more of the torso.

The matching background is `backgrounds/presets/felt-puppet-sky.png` (a felt
sky with two clouds).

Files are 256x256 PNG, pngquant'd, named by the canonical hex codepoint,
hyphen-joined for ZWJ sequences (`1f9d1-200d-1f4bb.png`), the same scheme as
fluent3d and redpanda.
