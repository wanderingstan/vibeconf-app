# Platforms

One API, and behind it one provider per platform. This page is what each
provider can do today, read from the provider code. "Yes" means the
endpoint works as documented; anything else says how it falls short.

## Meetings the bot joins

You send a join action with the link; the bot clicks through the
platform's pre-join and waits to be admitted.

| | Google Meet | Zoom | Microsoft Teams | Slack huddles | WhatsApp call link |
| --- | --- | --- | --- | --- | --- |
| Join | `join` with a Meet code or URL | `join-zoom` with a `zoom.us/j/…` link, passcode included | `join-teams` with a `teams.live.com/meet/…` or `teams.microsoft.com/…` link | `join-slack` with the huddle URL | `join-whatsapp` with a `call.whatsapp.com/video\|voice/…` link |
| Admission | The host admits the bot | Waiting room, when the meeting has one | Guest lobby, an organizer admits | The app must be signed in to the workspace | The bot must be signed in to WhatsApp |
| Room id | the Meet code | `zoom-<meeting>` | `teams-<id>` | `slack-<team>-<channel>` | `whatsapp-link-<token>` |
| Create a new call | `POST /api/call/start` | | | | |
| Hearing | Captions | Captions | Captions | Captions | On-device transcription |
| `set-caption-language` | Yes | Returns `ok: false`, not wired yet | Returns `ok: false`, not wired yet | No caption language to set | No captions |
| Speak | Yes | Yes | Yes | Yes | Yes |
| Chat read and send | Yes | Yes | Yes | Yes, the huddle thread | The 1:1 chat |
| Camera on and off | Yes | Yes | Yes | Yes | Yes |
| Screen share (board or URL) | Yes | Yes | Yes | Yes | Yes, the board |
| Share audio mute | Yes | Yes | Not handled | Not handled | Not handled |
| See others' shares | Yes | Yes | Yes | No | No |
| Studio sound | Yes | No | No | No | No |
| Record | Yes, one track per participant | Yes | Yes | Yes | Yes |
| Reactions | No platform has a reactions endpoint | | | | |

Zoom and Teams are newer than Meet and Slack and are marked experimental in
the app. The share-automation actions (`share-click`, `share-type`,
`eval-share` and friends) act on the bot's own share window, so they work
the same on every platform.

## Calls the bot answers

Someone calls the bot and it picks up, if the caller is on the allowlist
set in the app's settings. There is no join action. The room is
`telegram-<user id>`, `whatsapp-<number>` or `phone-<number>` for as long as
the call lasts, and the poll and speak endpoints work on it as on any
meeting. Afterwards the room is gone: polling it returns `410 callEnded`.

| | Telegram | WhatsApp | Phone (Twilio) |
| --- | --- | --- | --- |
| How it rings | A 1:1 call to the bot's Telegram account | A 1:1 call to the bot's WhatsApp account | A call to the bot's Twilio number, after a passcode |
| Who may call | Allowlist by Telegram user id | Allowlist by phone number | Allowlist by phone number, then a keypad passcode, both checked on Twilio's side |
| Hearing | On-device transcription of the call audio | On-device transcription | On-device transcription |
| Speak | Yes | Yes | Yes |
| Chat | The 1:1 Telegram chat with the caller | The 1:1 WhatsApp chat with the caller | No |
| Camera | No (Telegram Web cannot add video on the answering side) | Yes, for a video call | No |
| Screen share | No | Yes, the board, through WhatsApp's share menu | No |
| Record | Yes | Yes | Yes |

These three have no captions, so the bot hears them through the app's own
speech-to-text rather than by reading the platform's captions. That is
the `captions: false` case in `call-provider.js`.

## Planned

- **FaceTime** links, a call the bot joins. Planned.
- **Discord**, a call the bot answers. Planned.

## Where this comes from

`electron-app/call-provider.js` is the interface every provider
implements, and `PROVIDER_CAPABILITIES` there is the one capability flag
the app checks at runtime. The rows above come from the provider files:
`google-meet-provider.js`, `zoom-provider.js`, `teams-provider.js`,
`slack-provider.js`, `telegram-call.js`, `whatsapp-call.js`,
`twilio-call.js`. When a cell here and the code disagree, the code is
right and this page needs a fix.
