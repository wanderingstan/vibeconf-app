// claude-install.js — detect the `claude` CLI and provide the official install command.
//
// Why this exists: the app launches `claude "/join-call …"` in a Terminal, but a user
// without Claude Code just gets "command not found". This detects that up front and
// offers to install it (see launchClaudeTerminal in main.js).
//
// PATH gotcha: a GUI-launched Electron app on macOS gets a MINIMAL PATH from launchd —
// NOT your shell's PATH — so a bare `which claude` can report "missing" when it isn't
// (the native installer puts `claude` in ~/.local/bin). So detection checks known install
// locations first, then asks the user's LOGIN shell (which has their real PATH, the same
// one the Terminal we launch into sees).

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

// The official Claude Code install command per platform — the self-contained native
// installer (no Node prerequisite, auto-updates). See code.claude.com/docs/en/quickstart.
// Pure + testable.
function installCommandFor(platform = process.platform) {
  if (platform === 'win32') return 'irm https://claude.ai/install.ps1 | iex';   // Windows PowerShell
  return 'curl -fsSL https://claude.ai/install.sh | bash';                       // macOS / Linux
}

// Where the native installer / package managers commonly drop the binary — checked
// directly so a minimal GUI PATH can't produce a false "not installed".
function knownClaudePaths(home = os.homedir()) {
  return [
    path.join(home, '.local', 'bin', 'claude'),   // native installer (curl … | bash)
    '/opt/homebrew/bin/claude',                    // Homebrew (Apple Silicon)
    '/usr/local/bin/claude',                       // Homebrew (Intel) / npm global
    path.join(home, '.npm-global', 'bin', 'claude'),
  ];
}

// Resolve { installed: boolean, path: string|null }. Never rejects.
function detectClaude() {
  return new Promise((resolve) => {
    // 1) Known install paths (fast, no shell needed).
    for (const p of knownClaudePaths()) {
      try { if (fs.existsSync(p)) return resolve({ installed: true, path: p }); } catch { /* noop */ }
    }
    // 2) Ask the login shell — it has the user's real PATH.
    if (process.platform === 'win32') {
      execFile('where', ['claude'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        const p = String(stdout || '').split(/\r?\n/)[0].trim();
        resolve({ installed: !err && !!p, path: p || null });
      });
      return;
    }
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-lc', 'command -v claude'], { timeout: 5000 }, (err, stdout) => {
      const p = String(stdout || '').trim().split(/\r?\n/).pop();
      resolve({ installed: !err && !!p, path: p || null });
    });
  });
}

// Is that CLI actually SIGNED IN? (#137)
//
// Installed ≠ usable. A user who has just installed Claude Code has usually never
// logged in, so the Terminal we spawn sits at the auth prompt: the bot tile appears,
// the agent does nothing, and from the call an unauthenticated agent is
// indistinguishable from a crashed one. That misread cost a live call several minutes
// on Jul 29 before the user diagnosed it himself.
//
// `claude auth status` answers this as JSON, non-interactively, in well under a second.
// Two traps, both found by testing rather than reading:
//   1. It exits 0 whether or not you are logged in — so parse `loggedIn`, never $?.
//   2. Auth can come from the ENVIRONMENT (ANTHROPIC_API_KEY et al), so the answer
//      depends on whose env you ask in. A GUI Electron app has launchd's minimal env,
//      NOT the user's. We must ask the LOGIN SHELL — the same environment the Terminal
//      we're about to spawn will have — or we'd cheerfully tell a signed-in user to
//      sign in.
//
// Tri-state on purpose: true / false / null = "couldn't tell". Callers must only warn
// on an explicit false. A wrong "please sign in" shown to someone already signed in is
// worse than staying quiet, because it teaches people to ignore the warning.
function detectClaudeAuth({ timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const done = (authed, method = null) => resolve({ authed, method });
    if (process.platform === 'win32') return done(null); // no login-shell equivalent yet — see #468
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(shell, ['-lc', 'claude auth status'], { timeout: timeoutMs }, (err, stdout) => {
      const raw = String(stdout || '').trim();
      if (!raw) return done(null);
      // Be forgiving about anything a login shell prints before the JSON (motd, nvm chatter).
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) return done(null);
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (typeof parsed.loggedIn !== 'boolean') return done(null);
        return done(parsed.loggedIn, parsed.authMethod || null);
      } catch {
        return done(null); // unparseable (older CLI, changed format) — stay quiet
      }
    });
  });
}

module.exports = { installCommandFor, knownClaudePaths, detectClaude, detectClaudeAuth };
