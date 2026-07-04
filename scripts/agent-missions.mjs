// agent-missions.mjs — mission catalog for the real-agent fuzzing test (#267 item 5).
//
// Each MISSION is a "quasi-fuzzing" scenario: a real Claude agent per bot is
// given a natural-language MISSION prompt, joins the call, behaves
// non-deterministically, and leaves. An LLM judge then grades the transcript +
// session log (+ measured talk-over) against the mission's RUBRIC.
//
// Extensible by design: add an object to MISSIONS to add a scenario. Per-mission
// rubrics travel with the mission, so growing the catalog is additive.
//
// A mission is either SYMMETRIC (every bot gets the same `prompt`) or ROLE-BASED
// (`roles: [{label, prompt}]`, assigned round-robin by bot index) — role-based
// missions let us test turn-taking (a host that leads, a guest that yields).
//
// Placeholders substituted per bot: {peer} (the other bot's name), {room}, {role}.

export const MISSIONS = [
  {
    key: 'smoke',
    title: 'Basic multi-bot smoke — join, exercise features, converse, leave',
    // SYMMETRIC: both bots run the same script. Note: two bots running identical
    // lines at once will naturally overlap — that's expected here, so the smoke
    // rubric does NOT grade talk-over. Use the 'turn-taking' mission for that.
    prompt: [
      'You are a test agent in a live video call with another bot named {peer}.',
      'Complete this short mission, then leave cleanly:',
      '1. Greet the room by speaking one short sentence.',
      '2. Put a whiteboard up with the current date as a heading, and share it.',
      '3. Ask {peer} one simple question out loud, then wait briefly for a reply.',
      '4. Send one chat message so chat is exercised.',
      "5. Say a brief goodbye and LEAVE the call (use the leave tool — don't linger).",
      'Keep it quick and natural. Do not loop or repeat steps. Do not wait for long silences.',
    ].join('\n'),
    rubric: [
      'A PASS requires ALL of the following, judged from the transcript + session log:',
      '- Both bots actually JOINED the call (reached in-call), not stuck in a waiting room.',
      '- Each bot SPOKE at least once and the other bot HEARD it (speech shows up in the peer’s transcript).',
      '- The whiteboard/share feature was exercised (a share started).',
      '- At least one CHAT message was sent.',
      '- Both bots LEFT cleanly at the end (a leave action; no ghost/lingering).',
      'It is a FAIL if any of: a bot never joined; a bot spoke but was never heard (deaf); ',
      'the agent looped or repeated the same action many times; two near-duplicate answers ',
      'to one prompt (double-response); or it errored/hung without leaving. ',
      'This is a SYMMETRIC mission (both bots run the same script at once), so DO NOT ',
      'penalize simultaneous speech / talk-over here — set avoided_talk_over=true regardless.',
    ].join('\n'),
  },
  {
    key: 'turn-taking',
    title: 'Turn-taking — host leads, guest yields; grades talk-over (#343)',
    // ROLE-BASED: bot 0 hosts, bot 1 is the guest. Designed so a well-behaved run
    // has clean turns; talk-over here is a REAL failure (surfaces #343).
    roles: [
      {
        label: 'host',
        prompt: [
          'You are HOSTING a short live call with a guest bot named {peer}.',
          'Run it as clean turns — never talk while {peer} is talking; yield and wait for silence.',
          '0. FIRST, wait until {peer} is actually in the call and able to hear you before you say',
          "   anything — don't greet an empty room. Check who's present with get_room_info (or",
          '   read_transcripts, which lists Members); if you are alone, wait and re-check until',
          '   {peer} has joined. Only then begin.',
          '1. Greet, then INVITE {peer} to introduce themselves and STOP talking — listen.',
          '2. After {peer} finishes, ask them ONE short question, then WAIT for their spoken answer.',
          '3. Briefly acknowledge their answer.',
          '4. Wrap up with a one-line goodbye and LEAVE the call.',
          'Do not narrate over {peer}. Keep your own turns short. Do not loop.',
        ].join('\n'),
      },
      {
        label: 'guest',
        prompt: [
          'You are a GUEST in a short live call hosted by {peer}.',
          'Only speak when it is your turn — do NOT speak while {peer} is speaking; wait for silence.',
          "0. FIRST confirm the host {peer} is actually present (check with get_room_info, or",
          '   read_transcripts which lists Members). Do not speak into an empty room.',
          '1. Wait for {peer} to greet and invite you before you say anything.',
          '2. When invited, introduce yourself briefly (one or two sentences), then stop and listen.',
          '3. When {peer} asks you a question, answer it out loud, then let {peer} wrap up.',
          '4. When {peer} says goodbye, say a brief goodbye and LEAVE the call.',
          'Yield whenever {peer} is talking. Keep your turns short. Do not loop.',
        ].join('\n'),
      },
    ],
    rubric: [
      'A PASS requires ALL of:',
      '- Both bots JOINED and each was HEARD by the other at least once (not deaf).',
      '- They largely TOOK TURNS: the guest waited to be invited, and neither spoke over the ',
      '  other for a large fraction of the call.',
      '- Both LEFT cleanly.',
      'Use the measured TALK-OVER stat provided below as the primary evidence for turn-taking: ',
      'set avoided_talk_over=false (and FAIL) if the bots were BOTH speaking for a large ',
      'fraction of the time (say, talk-over over ~35% of speaking time), or if the guest ',
      'clearly did not wait for the host. Minor incidental overlap is fine. ',
      'Also FAIL on: a bot never joined; deaf (spoke but never heard); looping/repeating; ',
      'double-responses; or hanging without leaving.',
    ].join('\n'),
  },
  // Future missions go here.
];

export function getMission(keyOrIndex) {
  if (keyOrIndex == null) return MISSIONS[0];
  const byKey = MISSIONS.find((m) => m.key === keyOrIndex);
  if (byKey) return byKey;
  const idx = Number(keyOrIndex);
  if (Number.isInteger(idx) && MISSIONS[idx]) return MISSIONS[idx];
  throw new Error(`unknown mission "${keyOrIndex}" — known: ${MISSIONS.map((m) => m.key).join(', ')}`);
}

const sub = (s, ctx) =>
  (s || '')
    .replaceAll('{peer}', ctx.peer ?? 'the other bot')
    .replaceAll('{room}', ctx.room ?? '')
    .replaceAll('{role}', ctx.role ?? '');

// The prompt for bot #index in this mission (role-based → round-robin roles;
// symmetric → the shared prompt). Returns { prompt, role }.
export function promptForBot(mission, index, ctx) {
  if (Array.isArray(mission.roles) && mission.roles.length) {
    const role = mission.roles[index % mission.roles.length];
    return { prompt: sub(role.prompt, { ...ctx, role: role.label }), role: role.label };
  }
  return { prompt: sub(mission.prompt, ctx), role: 'peer' };
}

// The mission rubric, substituted (mission-level, same for all bots).
export function renderRubric(mission, ctx) {
  return sub(mission.rubric, ctx);
}
