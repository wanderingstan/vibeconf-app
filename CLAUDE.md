# CLAUDE.md — vibeconf-app

Operating notes for Claude sessions and agents working in this repo. Keep it
concise and accurate; extend as new gotchas are found.

## Building & notarizing the macOS app

The Mac `.dmg` is built **locally** — CI (`.github/workflows/release.yml`) only
builds the Windows/Linux installers, because notarization needs Apple Developer
credentials that aren't in GitHub secrets. Signing uses the
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

See `README.md` → *Build from source* for the generic build steps, and
`.github/workflows/release.yml` for the tag-triggered release flow and
clean-semver versioning convention.
