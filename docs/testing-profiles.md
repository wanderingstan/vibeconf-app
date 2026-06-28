# Testing profiles

The canonical set of **app profiles** used by the automated test fleet, what
backs each, and how to recreate them on a fresh machine.

> Background: an *app profile* is an isolated `userData` dir under
> `~/Library/Application Support/Vibeconferencing/profiles/<name>/`, launched
> with `--profile=<name>`. Since #282 each profile has exactly **one** session
> partition (`Partitions/session`) holding its single identity — one profile =
> one Google/Slack login. See [multi-bot.md](multi-bot.md) for the primitive and
> [testing.md](testing.md) for the test layers.

## The three test classes

All test profiles share a `test-` prefix so they sort together and guest-vs-
signed-in is obvious at a glance:

| Class | Profiles | Login | Account | Recreatable? |
|---|---|---|---|---|
| **Guest Meet** | `test-meet-guest-1..N` | none (logged out) | — | **100% automatic** — the fleet creates + reaps them |
| **Google Meet** | `test-meet-google-1..N` | Google, once | `1`=alice@spiritprotocol.io, `2`=jimmy@spiritprotocol.io | documented + `setup-test-profiles.sh`; pinned via `--meet-account-email` |
| **Slack** | `test-slack-1..N` | Slack, once | whatever you log into (no pin) | documented + `setup-test-profiles.sh` |

> **Google vs Slack accounts differ.** Google has a real account pin
> (`--meet-account-email` → `authuser=`), so the email *matters* and is set for
> you. **Slack has no pin** — you just open the profile, log into Slack, and pick
> the workspace; the profile uses whatever login lands in its partition. There's
> no account value to configure, only to optionally note for your own records.

The guest class is intentionally login-free so we keep exercising the
non-Google guest join path (the most open, unattended case) even after adding
signed-in profiles for invite-only / Workspace-history-on meets.

These are **separate from your real working bots** (the default profile, `codex`,
etc.) — the test fleet never touches those.

## Which meet each class targets

`scripts/meet-targets.mjs` defines the meets; the chat input differs by account:

| Target | Meet | Profiles | Chat input |
|---|---|---|---|
| `default` | `paz-sqoa-npe` (open guest) | `test-meet-guest-*` | `<textarea>` |
| `workspace` | `fgh-xite-ant` (Workspace, history on) | `test-meet-google-*` | contenteditable (internal acct) / `<textarea>` |

> Chat-UI note (#281/#283): the input shape depends on whether the signed-in
> account is **internal vs external** to the meet's Workspace, not just the meet.
> To cover both shapes, run one internal + one external account in the workspace
> target.

## Setup on a fresh machine

**Guest profiles need no setup** — `spawn-test-fleet.sh` creates them on demand.

**Signed-in profiles need a one-time human login.** Run the helper, which opens
each profile at its login page (Google accounts pre-pinned via
`--meet-account-email`):

```bash
scripts/setup-test-profiles.sh            # Google + Slack
scripts/setup-test-profiles.sh --google   # just the Meet (Google) profiles
scripts/setup-test-profiles.sh --slack    # just the Slack profiles

# Override accounts for your environment:
GTEST_EMAIL_DOMAIN=example.com \
SLACKTEST1_ACCOUNT=a@example.com SLACKTEST2_ACCOUNT=b@example.com \
  scripts/setup-test-profiles.sh
```

Then in each window:
- **Google**: click **“Sign in as bot”** in the panel and sign into the listed account.
- **Slack**: sign into the workspace in the embedded view.
- Need a specific state (accept an invite, switch workspace)? Use the app menu
  **“Navigate Webview…”** (⌘⇧L) to drive the embedded view anywhere within that
  profile's partition.

The login persists in the profile's `session` partition across runs.

## Running the fleet

```bash
scripts/spawn-test-fleet.sh 2                       # test-meet-guest-1/2  (guest)
scripts/spawn-test-fleet.sh 2 --google              # test-meet-google-1/2 (signed in)
scripts/spawn-test-fleet.sh 2 --slack --slack-url=… # test-slack-1/2
scripts/spawn-test-fleet.sh 2 --kill                # reap (also drops ghost participants)
```

Ports are `7901, 7902, …` (`BASE_PORT` + index), distinct from the real bots on
`7865/66`. `--google` pins each profile's account and labels the bots
Alice/Jimmy to match. Drive a spawned fleet with `node scripts/meet-test.mjs`
(see [testing.md](testing.md)).

## Housekeeping

**Reclaim orphaned partitions.** Pre-#282 profiles still carry dead
`Partitions/{meet-guest,meet-account-default,slack}` dirs (the app only reads
`session` now). Safe to delete — logins were already invalidated by the rename,
so signed-in profiles re-login once regardless:

```bash
node scripts/cleanup-orphaned-partitions.mjs          # dry-run (shows sizes)
node scripts/cleanup-orphaned-partitions.mjs --apply   # delete
```

**Remove old-convention profiles.** If you have pre-rename test dirs (`test1`,
`gtest1`, `slacktest1`, …), they're superseded by the `test-*` names and can be
deleted wholesale:

```bash
cd ~/Library/Application\ Support/Vibeconferencing/profiles
rm -rf test[0-9]* gtest[0-9]* slacktest[0-9]*   # NOT bot2 / codex / other real bots
```

## Why these can't be fully scripted

The guest path is fully automatic. The signed-in paths require a human to
complete a Google/Slack login once (OAuth, 2FA, account chooser) — that can't be
headless. What *is* automated: profile creation, account pinning
(`--meet-account-email`), and the launch-to-login-page flow. So a fresh machine
is a short, guided one-time setup, not a from-scratch rebuild each run.
