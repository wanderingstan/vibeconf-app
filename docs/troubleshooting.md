# Troubleshooting

When something's off, the fastest path to a diagnosis is usually:

1. **`get_room_info`** from your agent — shows participants, speaker state, errors, screen-share status, the local server URL, the session log path.
2. **`get_session_log`** with a `grep` filter — pulls recent lines from the Electron app's session log so you can post-mortem without needing terminal access.
3. **Session log file directly** — `~/Library/Application Support/Vibeconferencing/logs/session-{ts}.log` (or `…/profiles/<name>/logs/…` for a profiled instance).

If you're filing an issue, include the session log path + the rough time the symptom happened. That's enough for someone to reproduce or diagnose.

## App won't launch

| Symptom | Likely cause | Fix |
|---|---|---|
| Launches and immediately quits | Another instance is already running (single-instance lock). | Quit the existing app (Cmd-Q on its panel window) or use `--profile=<name>` to launch as a separate profile. |
| Source build: "Electron failed to install correctly" | pnpm skipped Electron's binary download. | From `electron-app/`: `node node_modules/.pnpm/electron@*/node_modules/electron/install.js` |
| macOS blocks signed DMG | Quarantine bit set. | Right-click the app → Open the first time. |
| Source build: macOS asks about an unidentified developer | Source builds aren't signed. | Right-click → Open. Or run from terminal. |

## Sign-in / auth

| Symptom | Likely cause | Fix |
|---|---|---|
| OAuth completes but you land on vibeconferencing.com instead of the app | Old build with the broken OAuth handoff. | Upgrade to v0.6.1 or later. The handoff was fixed for fresh installs. |
| Sign-in works but the whiteboard pane is empty for viewers | Viewer mode requires the whiteboard sync to be wired. | Check the user-facing whiteboard at `<websiteUrl>/room/<roomId>?mode=whiteboard` directly — if that loads, the bot's local-server isn't seeing remote updates. May indicate sync polling isn't running. Look at session log for `[sync]` lines. |
| Want to test against a Vercel preview branch | Custom website host. | Set `websiteUrl` pref to `https://vibeconferencing-git-BRANCH-lets-vibe.vercel.app`. Restart the app. |

## Bot doesn't join Meet

| Symptom | Likely cause | Fix |
|---|---|---|
| Sits at "Waiting to be admitted" | You haven't clicked Admit in your browser yet. | Admit the bot from your Meet window. |
| Bot navigated but didn't click "Join now" | Pre-join UI changed or didn't match selectors. | Click "Join now" manually. File an issue if it persists — Meet UI changes occasionally. |
| `join_call` succeeds but Meet says "Can't join" | Wrong Meet URL, or call requires sign-in to a specific Google account. | Confirm the URL in `get_room_info`'s `detectedMeetUrls`. Sign the profile into the appropriate Google account. |

## Bot doesn't hear me

| Symptom | Likely cause | Fix |
|---|---|---|
| Captions are off in Meet | The bot reads captions to "hear" — without them it gets nothing. | The bot auto-enables CC on join. If it didn't, manually click the CC button in Meet. |
| Other participants' names show up in captions but yours doesn't | Google account-level caption setting. | Check your own Meet captions are working for others first. |
| Captions arrive but `wait_for_speech` never resolves | Silence threshold not reached, or background noise keeps DOMSpeakerTracker alive. | Speak a full sentence and pause. If still stuck, check session log for `[silence]` and `[speech-start]` entries. Background-noise cases are an active issue (see #187). |

## Bot speaks over humans

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot interrupts mid-sentence | Captions briefly dropped → silence detector treats it as silence → bot fires. | See issue #187. Workaround: speak shorter sentences with explicit pauses. Caption-dropout detection is being worked on (#187 / PR #201). |
| Bot says "got it" repeatedly during one utterance | Multiple caption turns interpreted as separate finished thoughts. | The #178 snapshot model should prevent this. If it's happening, check session log for accumulating `[transcript]` entries. |

## Whiteboard

| Symptom | Likely cause | Fix |
|---|---|---|
| `update_whiteboard` returns success but the shared screen doesn't change | Screen Recording permission is denied → the share window can't render. | System Settings → Privacy & Security → Screen & System Audio Recording → enable Vibeconferencing. Re-launch the app. |
| `share_whiteboard` succeeds, then nothing visible to other participants | Meet picker dialog wasn't acknowledged, or the wrong window was selected. | When sharing, Meet asks which window. The whiteboard window should be the only Vibeconferencing window in that list. |
| Whiteboard shows blank to other bots in the same room | Other bot's local-server isn't seeing remote whiteboard updates. | Fixed in #202. Confirm you're on a build that includes it. |
| Whiteboard URL loaded via `update_whiteboard({url: …})` doesn't render | Site uses iframe-blocking CSP. | Try the site in a normal browser tab first. If it blocks framing, you can't use it as a whiteboard URL. |

## Multiple bots / profiles

| Symptom | Likely cause | Fix |
|---|---|---|
| Second app instance quits immediately | Missing `--profile=…` flag — single-instance lock. | Always launch the secondary instance with `--profile=<name>`. See [multi-bot.md](multi-bot.md). |
| Port already in use error | Two instances competing for the same `--local-port`. | Pick distinct ports (`--local-port=7866`, `--local-port=7867`, etc.). |
| Wrong bot responds when I `wait_for_speech` | MCP server's `VIBECONF_BASE_URL` points at the wrong app instance. | `get_room_info`'s `Local server:` field is ground truth. If it's wrong, update the MCP config and restart the agent. |
| Both bots show the same name in Meet | Same Google login across profiles. | Sign each profile into a different account, or set different `botName` prefs. |
| Claude Code's MCP config keeps getting rewritten by the default app | The default-profile app rewrites it on every launch. | Run the *secondary* bot from a profiled instance (which skips the rewrite), or use Codex / another MCP client for the secondary. |

## TTS / audio

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot's voice sounds robotic | macOS system TTS voice quality varies a lot. | Pick a different voice from `list_voices` / panel People pane. Or set up ElevenLabs (`ttsApiKey` + `ttsVoiceId` prefs). |
| Bot speech cuts off mid-word | Barge-in deferral cancelled mid-utterance. | Expected behavior when you start speaking. The interrupted text is shown as a subtitle on the avatar. |
| No audio from bot at all in Meet | Virtual mic not granted, or audio device permission issue. | Check Mic permission in System Settings → Privacy & Security. Re-launch. |
| You hear the bot in your speakers locally but not other participants | Wrong audio routing — the virtual mic isn't connected to Meet's input. | Check Meet's mic selector (top bar in Meet) — it should show "Default" or a virtual mic device. |

## Performance

| Symptom | Likely cause | Fix |
|---|---|---|
| Meet view feels laggy | Chromium-side, usually the avatar render loop. | Try lowering the avatar canvas FPS in `extension/page-inject.js`'s `config.fps` if running from source. |
| Local-server polling thrashes CPU | The MCP agent is calling `wait_for_speech` in a tight loop instead of long-polling. | Make sure the agent uses `wait_for_speech` (which blocks server-side) rather than polling `read_transcripts` every second. |

## When things are weird and you can't tell why

1. `get_room_info` from the agent — check the `errors` field and `callStatus`.
2. `get_session_log({lines: 200, grep: 'error|warn|fail'})` — scan recent errors.
3. Cross-reference the timestamps in the log with what you saw happen.
4. If two bots are involved, get both their session log paths from each `get_room_info` and compare.

## Filing a useful bug report

Include:

- Symptom: what you saw vs what you expected
- App version (panel header) and whether DMG or source build
- Time of the call (so the session log timestamp is searchable)
- Session log path from `get_room_info` (or the relevant snippet via `get_session_log`)
- If multi-bot: the other instance's `Local server:` URL and profile name
- For UI issues: a `get_call_screenshot` of the moment

Filed at [github.com/wanderingstan/vibeconferencing/issues](https://github.com/wanderingstan/vibeconferencing/issues).
