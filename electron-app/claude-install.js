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

module.exports = { installCommandFor, knownClaudePaths, detectClaude };
