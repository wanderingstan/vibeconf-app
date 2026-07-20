# Data, privacy, and permissions

Vibeconferencing is a beta that lets an AI agent hear and participate in a live call. This page describes the current desktop app's data paths so you can decide where it is appropriate to use.

## The short version

- The app reads Google Meet caption text and passes relevant turns to the MCP agent driving the call.
- The app writes local session logs that may contain transcript text and agent activity.
- Hosted room sync can send transcript entries and whiteboard state to the configured backend.
- Remote log shipping is optional and off by default.
- Voice may be local or may use ElevenLabs, depending on your settings.
- The app does not include its own general-purpose model. Your selected agent and model provider process the context used to answer or act.

## Meeting captions and agent context

For Google Meet, the app uses Meet's captions as the primary hearing path. Caption turns are held in the desktop app and made available to the driving agent through the local MCP server.

The driving agent decides what context to send to its model provider. If you configure an OpenAI-compatible endpoint for background comprehension or engagement classification, recent transcript context can also be sent to that endpoint. Review the policies and retention behavior of every model endpoint you configure.

## Local session logs

The app tees diagnostic output into per-session files under:

```text
~/Library/Application Support/Vibeconferencing/logs/
```

These logs can contain transcript fragments, agent activity, room state, errors, and configuration metadata. The app currently retains up to 100 prior session log files plus the active session. Treat them as sensitive meeting data and remove them when they are no longer needed.

## Hosted room sync and whiteboard

When a synced room is active, the desktop app sends participant transcript entries and whiteboard state to the configured sync service. The default service is `vibeconferencing.com`. Signing in enables hosted shared-whiteboard and room features.

The hosted backend is not part of this repository. The desktop app's `websiteUrl` and `syncBaseUrl` preferences can be changed to target a compatible service.

## Voice providers

- macOS system voices run locally.
- A configured local voice engine receives the text at the endpoint you choose.
- If you configure ElevenLabs, the text being spoken is sent to ElevenLabs using your API key.

## Remote diagnostics

Remote log shipping is off by default. If you enable it, the app can upload batches of session log lines to the configured backend. Those lines may contain transcript text. Disable remote logging when it is not required for an active debugging session.

## macOS permissions

| Permission | Why the app asks |
|---|---|
| Microphone | Supports the meeting audio and virtual-microphone path used for agent speech. |
| Camera | Presents the agent's avatar through the virtual-camera path. |
| Automation | Lets the app detect and focus Meet tabs in Chrome, Brave, or Safari. You can paste a Meet link instead. |
| Screen Recording | Lets the agent present its whiteboard. This is optional for a basic voice call. |

## Consent

The agent joins as a visible meeting participant, but visibility is not a substitute for every legal or organizational consent requirement. Tell participants what the agent can hear, where transcript data may go, and whether the call uses hosted sync or remote diagnostics.

Do not use the beta for confidential, regulated, or high-risk conversations until you have verified that its configured services and local retention match your requirements.
