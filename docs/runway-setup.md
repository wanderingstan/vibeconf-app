# Runway photoreal faces & the orchestrated room — setup

> **Status: DRAFT — drafted from code analysis, not yet verified by a live run.**
> Seth / Coltrane: please verify the keys, paths, and steps below against a real
> setup and correct anything wrong. Tracking the rough edges as #297 (hardcoded
> `~/.seth` paths) and #298 (mic/camera teardown).

This covers the Runway integration merged into `main`: opt-in **photoreal video
avatars** for bots (a Runway face replaces the emoji on the virtual camera), and
the broader **orchestrated room** (multiple AI seats with a floor-conductor).

The whole feature is **opt-in** behind `VIBECONF_RUNWAY=1` — without it, the app
behaves exactly as before (emoji avatar). Normal users need none of this.

## Two tiers

| Tier | What you get | What you need |
|---|---|---|
| **1. A face on one bot** | Runway photoreal avatar instead of emoji | Runway API key + a LiveKit server + ElevenLabs (already in base) |
| **2. Full orchestrated room** | Multiple AI seats + floor-conductor + generative canvas | Tier 1 **plus** the `spirit-avatar-proto` repo, a FAL key, and the pm2 stack |

## Prerequisites (accounts / infra)

- **Runway ML account** with API access (creates `realtime_sessions`). → `RUNWAY_API_KEY`
- **A LiveKit server** — cloud (free tier exists) or self-hosted. The avatar video
  + lip-sync audio flow through a LiveKit room. → `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- **ElevenLabs** — already required by the base app for TTS (no new dependency).
- **(Tier 2 only)** A **FAL** account (`FAL_API_KEY`) for generative media in the
  region-canvas, and the **`spirit-avatar-proto`** repo (the conductor brain).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VIBECONF_RUNWAY` | yes (gate) | `1` turns the Runway face on for this app instance |
| `RUNWAY_API_KEY` | yes | Runway ML API key |
| `LIVEKIT_URL` | yes | LiveKit server URL |
| `LIVEKIT_API_KEY` | yes | LiveKit API key |
| `LIVEKIT_API_SECRET` | yes | LiveKit API secret |
| `RUNWAYML_BASE_URL` | no | defaults to `https://api.dev.runwayml.com` |
| `FAL_API_KEY` | Tier 2 | generative media (region-canvas) |
| `CONDUCTOR_PATH` | Tier 2 | path to the `spirit-avatar-proto` conductor |

**Where the app looks for keys** (current behavior — see #297 to de-hardcode):
1. process env vars, then
2. `~/.seth/vault/credentials.env`, then
3. (Runway key only) `~/Projects/standalone/spirit-avatar-proto/.env.local`.

If you're not Seth, **just export the env vars** (or put them in an env file the
launch script sources) — you do not need a `~/.seth` vault.

The seat/bot must be named to a known Runway avatar: **`SAL`**, **`SOLIENNE`**, or
**`coltrane`** (the recognized avatar IDs).

## Tier 1 — a single bot with a face

1. Set the env: `VIBECONF_RUNWAY=1` + `RUNWAY_API_KEY` + `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.
2. Launch the app for a known seat (e.g. `VIBECONF_PROFILE=sal`, bot name `SAL`).
3. Sign the profile into Google, join a Meet.
4. ~8s after join, the app provisions a Runway session and the face replaces the
   emoji on the virtual camera. (Sessions auto-renew ~every 4 min.)

## Tier 2 — the orchestrated room

Entry point: `scripts/launch-orchestrated-room.sh` (header comments document the
human workflow). It brings up two Electron seats (SAL on `:7865`, SOLIENNE on
`:7866`) and a smoke check. For the full stack with durable process management:

```
pm2 start scripts/ecosystem.orchestrated-room.config.cjs
#   conductor-service  :7870  — floor-lock authority (needs spirit-avatar-proto)
#   region-canvas      :7871  — collaborative whiteboard + FAL generative media
#   seat-sal           :7865
#   seat-solienne      :7866
```

Then, per seat, point a Claude Code session at it:

```
SAL:      VIBECONF_BASE_URL=http://127.0.0.1:7865  VIBECONF_BOT_NAME=SAL
SOLIENNE: VIBECONF_BASE_URL=http://127.0.0.1:7866  VIBECONF_BOT_NAME=SOLIENNE
```

The conductor owns the floor; each seat's loop calls
`conductor.utterance() → maySpeak() → vet() → speak() → spoke()` to avoid talk-over.

pm2 is **not** strictly required (`launch-orchestrated-room.sh` uses nohup), but
the ecosystem config gives auto-restart.

## How a Runway face gets into the call (architecture)

```
VirtualMic (master audio, page-inject.js)
  ├─ clone → Meet getUserMedia        (Meet hears the bot's TTS)
  └─ clone → window.__vibeMicTrack()  → runway-avatar.js → LiveKit publish
                                       → Runway worker lip-syncs the TTS
                                       → avatar video track
                                       → window.__vibeSetAvatarVideo(el)
                                       → VirtualCamera.drawImage(video)  (replaces emoji)
```

`scripts/runway-session.mjs` provisions the LiveKit room + Runway realtime session
and mints tokens; `electron-app/main.js` (`setRunwayFace` / `loadRunwayEnv`) drives
it on join and renews/recovers it; `extension/runway-avatar.js` runs the LiveKit
connection in the Meet page. On leave, `stopAllRunwayFaces` tears down sessions.

## Known rough edges
- **#297** — keys/conductor read from hardcoded `~/.seth` / `~/Projects/standalone`
  paths; env-var override works, but the defaults should be de-Seth'd.
- **#298** — `mic.destroy()`/`camera.destroy()` aren't called on leave (minor leak
  over many join/leave cycles).
- Runway sessions expire in ~5–7 min; auto-renewal + loss-recovery handle it, but
  watch for `[runway-avatar] lost` / re-establish churn on flaky networks.
