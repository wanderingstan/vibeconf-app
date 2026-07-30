// agent-liveness.js — is an agent actually driving this bot? (#38)
//
// A bot whose agent has died looks exactly like one that is listening politely:
// resting face, in the call, saying nothing. It is the last of the four silences
// in #155 with no face, and the only one that is a real malfunction rather than
// the system working as designed.
//
// The heartbeat already exists and did not need inventing. `wait_for_speech` is
// CAPPED at 55s (mcp-server/server.js: `Math.min(55, timeout_seconds || 55)`),
// so an agent running the conversation loop must call back at least that often
// even in a silent room. That cap is what makes this safe: a quiet call still
// checks in, so silence never reads as death. Treat it as load-bearing — raising
// it raises this detector's floor with it.
//
// NOT to be confused with HEARTBEAT_INTERVAL_MS in main.js, which is the
// 15-minute app→backend ping reporting the install as online to the website. It
// says nothing about whether an agent is attached.
//
// DELIBERATELY THIN — this is an interim reading, not an architecture. MCP
// 2026-07-28 (#113) models a call as a long-running Task with real state on the
// server, which gives us attachment as a fact instead of an inference from
// request timing. When that lands, the right change is to delete the inference
// and read the Task's state; the face and the thresholds below are the only
// things worth keeping. So: no reconnect logic, no backoff, no session
// bookkeeping here. Two timestamps and a threshold.

// Two missed cycles. One missed cycle is ordinary — an agent mid-tool-call, or
// synthesising a long reply, legitimately goes quiet past 55s — so alarming at
// one would put 🫥 on the face of a bot that is merely thinking. Two is the
// point where "busy" stops being the simpler explanation.
const AGENT_AWAY_MS = 120_000;

// Below this the agent is between waits (the loop's own turnaround), which is
// normal and not worth distinguishing to the user.
const AGENT_SETTLING_MS = 5_000;

// → 'live' | 'settling' | 'busy' | 'away' | 'never'
//
// 'never' is a genuinely different failure from 'away' and worth keeping apart:
// it means the agent never attached at all (a launch that failed, a terminal
// that is not authenticated — #137), where 'away' means it was here and stopped.
// The user-facing distinction is "it never started" vs "it died".
function classifyAgent({ activeWaiters = 0, lastAgentActivityAt = null, now = Date.now() } = {}) {
  if (activeWaiters > 0) return 'live';
  if (!lastAgentActivityAt) return 'never';
  const quietMs = now - lastAgentActivityAt;
  if (quietMs < AGENT_SETTLING_MS) return 'settling';
  if (quietMs < AGENT_AWAY_MS) return 'busy';
  return 'away';
}

// The only states worth putting on the bot's face. 'busy' deliberately isn't
// one: a thinking agent is working correctly, and a face that flickers to
// "something is wrong" every time the bot takes a long turn would train people
// to ignore it.
function agentIsAbsent(state) {
  return state === 'away' || state === 'never';
}

// One sentence for the Troubleshooting readout, where the finer states DO matter
// because someone is already debugging.
function agentLabel(state, { quietSecs = 0, waiters = 0 } = {}) {
  switch (state) {
    case 'live': return `listening (${waiters} waiter${waiters === 1 ? '' : 's'})`;
    case 'settling': return `between waits (${quietSecs}s)`;
    case 'busy': return `idle ${quietSecs}s — agent may be processing or speaking`;
    case 'away': return `stale — agent likely stopped the wait_for_speech loop`;
    case 'never': return 'no wait_for_speech yet — agent may not have started the loop';
    default: return state;
  }
}

module.exports = {
  AGENT_AWAY_MS,
  AGENT_SETTLING_MS,
  classifyAgent,
  agentIsAbsent,
  agentLabel,
};
