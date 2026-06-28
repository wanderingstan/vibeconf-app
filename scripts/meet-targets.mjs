// meet-targets.mjs — named Google Meet test fixtures.
//
// The two kinds matter because Meet renders the **chat input differently**, and
// our chat send/read code has to handle both (see #281 / #278):
//   • open-guest meet           → chat input is a <textarea>
//   • Workspace, chat-history-ON → chat input is a contenteditable <div role=textbox>
//
// `meet-test.mjs --target <name>` resolves the room from here. `--room` still
// overrides for ad-hoc runs.
//
// Identity: the default meet is open-guest, so a logged-out test profile joins
// unattended. The Workspace meet is invite-only, so its test profiles must be
// **signed into a bot Google account that's invited** (Settings → "Sign in to
// Google as bot") — that makes the workspace target SEMI-automated, not the
// fully-unattended path the default is.

export const MEET_TARGETS = {
  default: {
    room: 'paz-sqoa-npe',
    kind: 'open-guest',
    signedIn: false,
    chatInput: 'textarea',
    note: 'Open guest meet — no Google login, no admission. Fully unattended CI.',
  },
  workspace: {
    room: 'fgh-xite-ant',
    kind: 'workspace-history-on',
    signedIn: true,
    chatInput: 'contenteditable',
    note: "Workspace meet with chat history / Gemini ON — contenteditable chat input. "
        + "Test profiles must be signed into bot Google accounts invited to this meet "
        + "(Settings → Sign in to Google as bot). Semi-automated. Ideally swap `room` for "
        + 'a dedicated PERSISTENT Workspace meet (this code was a live call and may rotate).',
  },
};

export function resolveTarget(name) {
  const t = MEET_TARGETS[name];
  if (!t) {
    throw new Error(`Unknown meet target "${name}". Known: ${Object.keys(MEET_TARGETS).join(', ')}`);
  }
  return { name, ...t };
}
