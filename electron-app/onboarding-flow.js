// onboarding-flow.js — pure logic for the first-run setup wizard.
//
// The wizard UI (renderer/onboarding.html) and the OS calls (permissions,
// AppleScript, config writes) live in main.js; this module holds the parts worth
// testing on their own: the step list, the permission model, which permissions
// each platform can even answer, and how a raw OS status becomes a simple
// granted/needed flag the UI renders.
//
// Shown once on first launch (guarded by the per-profile `onboardingComplete`
// flag, and by isDefaultInstance so profiles don't re-run it); re-runnable from
// the app menu.

// The permissions the app needs, in the order the wizard asks for them. `required`
// gates "you can finish" — mic + camera are hard requirements (audio pipeline +
// virtual-camera avatar); screen-recording (whiteboard sharing) and automation
// (reading the active Meet tab from Chrome/Brave/Safari) are recommended but the
// bot still joins, speaks, and listens without them.
//
// `platforms` is which OSes can actually ANSWER the question. A row we can't
// evaluate is worse than no row: it either states something untrue or sits
// permanently indeterminate, and the user can't tell which.
//
//   screen      — macOS only. Electron's getMediaAccessStatus is documented to
//                 "always return `granted` for `screen`" on Windows, so the row
//                 reported a constant, not a grant. Seen in the field on
//                 v0.8.0-beta4: the wizard claimed screen recording was already
//                 granted on a machine where that was not true.
//   automation  — macOS only. It's probed by running AppleScript, and `osascript`
//                 does not exist on Windows; the spawn failed with ENOENT and the
//                 row rendered as 'unknown' forever. NOTE this is not a statement
//                 that Meet detection can't work on Windows — it's planned via UI
//                 Automation (#19), which needs no consent grant at all, which is
//                 exactly why there is no permission here to ask for.
//   mic/camera  — macOS and Windows. getMediaAccessStatus is @platform
//                 win32,darwin; on Linux there is nothing to query.
//
// On Windows, mic/camera reflect the GLOBAL win32 privacy toggle rather than a
// per-app grant like macOS TCC, so "granted" is a weaker claim there. They're
// kept because that toggle being off is a real, fixable cause of silence.
const PERMISSIONS = [
  { key: 'microphone', label: 'Microphone', required: true, platforms: ['darwin', 'win32'],
    why: 'The bot speaks into the call through a virtual microphone.' },
  { key: 'camera', label: 'Camera', required: true, platforms: ['darwin', 'win32'],
    why: "The bot's avatar is shown as a virtual camera." },
  { key: 'screen', label: 'Screen Recording', required: false, platforms: ['darwin'],
    why: 'Lets the bot share its whiteboard onto the call. Optional.' },
  { key: 'automation', label: 'Browser Automation', required: false, platforms: ['darwin'],
    why: 'Lets the app read which Google Meet you have open in Chrome/Brave/Safari so `/join-call` needs no link. Optional.' },
];

// The permissions worth asking about on `platform`. An OS with no answerable
// permissions (Linux) yields an empty list, which correctly reports "nothing
// required is missing" rather than wedging the wizard on rows it can never
// satisfy.
function permissionsFor(platform = process.platform) {
  return PERMISSIONS.filter((p) => p.platforms.includes(platform));
}

// The wizard's steps, in order. `signin` (vibeconferencing.com) is skippable, but
// skipping disables the shared whiteboard — the wizard says so and lets you go on.
const STEPS = ['welcome', 'permissions', 'signin', 'logging', 'voice', 'bot', 'claude', 'done'];

// Normalize a raw permission status into { granted, needsAttention, status }.
// macOS media statuses: 'granted' | 'denied' | 'restricted' | 'not-determined'.
// Automation is probed indirectly (main.js runs a benign AppleScript), so it
// reports 'granted' | 'denied' | 'unknown' (browser not running / can't tell).
function normalizePermission(key, rawStatus) {
  const def = PERMISSIONS.find((p) => p.key === key) || { key, required: false };
  const status = rawStatus || 'not-determined';
  const granted = status === 'granted';
  return {
    key,
    label: def.label || key,
    required: !!def.required,
    why: def.why || '',
    status,
    granted,
    // 'denied'/'restricted' need a trip to System Settings (a re-prompt won't
    // show); 'not-determined'/'unknown' can still be resolved by a prompt/probe.
    needsSystemSettings: status === 'denied' || status === 'restricted',
  };
}

// Roll up a { key: rawStatus } map into per-permission rows + a can-finish flag.
// The wizard lets you finish once every REQUIRED permission is granted; optional
// ones being ungranted only shows a soft nudge.
function permissionsSummary(statusMap = {}, { platform = process.platform } = {}) {
  const rows = permissionsFor(platform).map((p) => normalizePermission(p.key, statusMap[p.key]));
  const missingRequired = rows.filter((r) => r.required && !r.granted);
  const missingOptional = rows.filter((r) => !r.required && !r.granted);
  return {
    rows,
    allRequiredGranted: missingRequired.length === 0,
    missingRequired: missingRequired.map((r) => r.key),
    missingOptional: missingOptional.map((r) => r.key),
  };
}

// An ElevenLabs key looks like `sk_...`; we only sanity-check shape (the real
// check is a test synth). Empty is valid — the user can skip and use the built-in
// system voices (macOS `say`, Windows SAPI; both confirmed working in the field).
function looksLikeElevenLabsKey(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' || /^sk_[A-Za-z0-9]{8,}$/.test(s);
}

// Step navigation helpers (kept pure so the renderer can't walk off the ends).
function nextStep(current) {
  const i = STEPS.indexOf(current);
  return i < 0 || i >= STEPS.length - 1 ? STEPS[STEPS.length - 1] : STEPS[i + 1];
}
function prevStep(current) {
  const i = STEPS.indexOf(current);
  return i <= 0 ? STEPS[0] : STEPS[i - 1];
}
function stepProgress(current) {
  const i = Math.max(0, STEPS.indexOf(current));
  return { index: i, total: STEPS.length, isFirst: i === 0, isLast: i === STEPS.length - 1 };
}

module.exports = {
  PERMISSIONS,
  STEPS,
  permissionsFor,
  normalizePermission,
  permissionsSummary,
  looksLikeElevenLabsKey,
  nextStep,
  prevStep,
  stepProgress,
};
