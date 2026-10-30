# CLAUDE.md — vibeconf-app

Operating notes for Claude sessions and agents working in this repo. Keep it
concise and accurate; extend as new gotchas are found.

## Building & notarizing the macOS app

Release builds for all three platforms run in CI
(`.github/workflows/release.yml`), macOS included: the Mac job signs and
notarizes from five repo secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and fails loudly if the .app
comes out un-notarized. That workflow's header is the reference for the secrets
and how to regenerate them.

Building the Mac **locally** is still supported, and is the fallback when
Apple's notarization service is down or a secret has lapsed. Signing uses the
`Developer ID Application: Stanley James (PNPVJ6J7X2)` cert in the login keychain.

- `pnpm dist` (in `electron-app/`) — signed **and notarized** `.dmg`.
- `pnpm dist:fast` — `-c.mac.notarize=false`, signed only; for quick local iteration.

### Notarization auth: legacy Apple ID + app-specific password

This project authenticates with Apple's notarization service using the **older
Apple ID + app-specific password** method — **NOT** an App Store Connect API
`.p8` key, and **NOT** a `notarytool`/`store-credentials` keychain profile.
electron-builder (via `@electron/notarize`) auto-detects three environment
variables at build time:

| var | notes |
| --- | --- |
| `APPLE_ID` | the Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com → **Sign-In and Security → App-Specific Passwords**. Regenerate there if revoked. |
| `APPLE_TEAM_ID` | `PNPVJ6J7X2` (fixed to the Developer team) |

With the vars unset, notarization is **skipped with a warning** (not an error) —
you silently get a signed-but-un-notarized app. Do not mistake that for success.

On the **Mac mini** (the always-on build/test host) these three are set in
**`~/.zshrc`**. The actual secret lives only there — do not copy the password into
this repo, logs, or any committed file.

### ⚠️ Automation gotcha (this cost real debugging time)

`~/.zshrc` is sourced **only for interactive shells**. Non-interactive shells —
the Claude Code Bash tool, and the nightly LaunchAgent's `zsh -lc` — do **not**
source it. So from automation:

- `env | grep APPLE` comes back **empty**, which looks like "no notarization
  creds on this machine" — but they ARE here, just in `~/.zshrc`.
- A `pnpm dist` launched that way notarizes nothing (silent skip, as above).

To build from an agent / script, load the creds first:

```sh
cd electron-app
source ~/.zshrc      # brings APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID into the env
pnpm dist            # now actually signs + notarizes
```

(Or export the three vars inline for that one command.) To replicate on another
Mac: add the same three exports to that machine's shell profile with a
currently-valid app-specific password; `APPLE_TEAM_ID` copies over as-is; no
`notarytool store-credentials` step is used by this project.

### The calls library is a linked package

The calling layer lives in `packages/calls` (`@vibeconferencing/calls`);
`electron-app/node_modules/@vibeconferencing/calls` is a **symlink** to it, so
edits there show up in the app with no reinstall. Two consequences:

- A worktree whose `electron-app/node_modules` is itself a symlink to another
  checkout's resolves the package to **that** checkout's `packages/calls`, not
  this one's. Give a worktree its own install (`pnpm install`, fast from the
  store) before testing library changes in it.
- electron-builder 25 refuses to pack anything whose real path is outside
  `electron-app/`. `before-pack.js` swaps the link for a copy during the pack and
  `after-pack.js` (or process exit) restores it. If a build was killed hard and
  the link is a plain folder, `pnpm install` puts it back.

See `README.md` → *Build from source* for the generic build steps, and
`.github/workflows/release.yml` for the tag-triggered release flow and
clean-semver versioning convention.
