// claude-cli-liveness.mjs — does this `claude` binary actually work?
//
// Split out of bot-pr-pipeline.mjs's preflight for #645. That preflight used to
// assert `claude CLI available` from nothing but a resolved path, and on the Mac
// mini it reported ✅ for a binary that answered every single invocation with
// "Not logged in · Please run /login". Six issues, six agents, six instant
// failures, and a green preflight the whole time.
//
// A path that resolves is a strictly weaker claim than "this can do work", and
// the gap between the two is the entire failure: a missing login and a working
// CLI look identical from the outside if all you test is `which`. So test the
// capability, not the artifact — run something trivial and require a zero exit
// with plausible output.
//
// The three failure modes are reported apart on purpose, because they are three
// different jobs for whoever reads the morning digest:
//   missing         — install it, or set CLAUDE_BIN
//   unauthenticated — a human has to sit at that keyboard and run `claude /login`
//   error/timeout   — something else is wrong; the first line of output says what
import { spawnSync } from 'child_process';

// Trivial on purpose: no tools, one turn, so nothing here can raise a permission
// prompt or wander off. It costs one round trip in a check that runs once a day.
export const LIVENESS_PROMPT = 'reply with OK';
export const LIVENESS_TIMEOUT_MS = 120000;

// Whatever the wording ends up being, an unauthenticated CLI names /login — that
// is the string the user is being told to type, so it is the stable part.
const NOT_LOGGED_IN = /not logged in|\/login\b/i;

const firstLine = (s) => s.split('\n').map((l) => l.trim()).find(Boolean) || '';

// `run` is the seam the tests drive; production passes nothing and gets spawnSync.
export function probeClaudeCli(bin, { timeoutMs = LIVENESS_TIMEOUT_MS, run = spawnSync } = {}) {
  if (!bin) return { ok: false, state: 'missing', detail: 'not found' };

  const r = run(bin, ['-p', LIVENESS_PROMPT, '--max-turns', '1'], { encoding: 'utf8', timeout: timeoutMs });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();

  // A killed-on-timeout spawnSync reports it as an ETIMEDOUT error on some node
  // versions and as a bare SIGTERM signal on others. Both mean the same thing,
  // and a check that hangs is a nightly that never finishes.
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
    return { ok: false, state: 'timeout', detail: `no answer in ${Math.round(timeoutMs / 1000)}s` };
  }
  if (r.error) return { ok: false, state: 'error', detail: r.error.message?.split('\n')[0] || 'could not be run' };

  // Checked before the exit code so the actionable case gets the actionable
  // label instead of being flattened into a generic non-zero exit.
  if (NOT_LOGGED_IN.test(out)) {
    return { ok: false, state: 'unauthenticated', detail: 'not logged in — run `claude /login` on this machine' };
  }
  if (r.status !== 0) {
    return { ok: false, state: 'error', detail: `exit ${r.status}${out ? `: ${firstLine(out)}` : ''}` };
  }
  // Zero exit and nothing to show for it is not a pass. "Plausible output" is
  // the other half of the claim; a CLI that succeeds silently did not do work.
  if (!out) return { ok: false, state: 'silent', detail: 'exit 0 but no output' };

  return { ok: true, state: 'live', detail: `answered: ${firstLine(out).slice(0, 60)}` };
}
