#!/usr/bin/env node
// check-em-dashes.mjs: fail if an em-dash (—) shows up in the app's own copy.
//
// Stan doesn't want them in text the app puts in front of a person, so this
// guards the paths that hold that text: everything the renderer draws, plus the
// handful of non-renderer files that carry user-facing strings. Comments inside
// those files are guarded too, because "is this string user-visible?" is not
// decidable from the outside, and a file-level rule is the only one that can't
// be quietly worked around.
//
// The rest of the repo (code comments in main.js, tests/, scripts/, docs/) is
// deliberately NOT covered yet. See #EM-DASH-SWEEP.
//
// Bypass, for the cases where an em-dash IS the point (matching one in someone
// else's data, quoting a string verbatim): put `em-dash-ok` in a comment on the
// same line, or on the line directly above. Whole-run escape hatch:
// ALLOW_EM_DASHES=1.
//
// CI (the copy-lint job in .github/workflows/build.yml) is what actually
// enforces this. There is also an OPT-IN pre-commit hook in .githooks, but it
// is deliberately not auto-installed: core.hooksPath shadows a global hooks
// path, and a hook blocks commits on branches that predate this cleanup.
//
// Usage:
//   node scripts/check-em-dashes.mjs            # check every guarded path
//   node scripts/check-em-dashes.mjs a.js b.js  # check only these (pre-commit)

import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const EM_DASH = '—'
const MARKER = 'em-dash-ok'

// Guarded paths, as prefixes relative to the repo root. A file counts as
// guarded when its path starts with one of these.
const GUARDED = [
  'electron-app/renderer/',
  'electron-app/agent-liveness.js',
  'electron-app/elevenlabs-errors.js',
]

// Guarded, but vendored or generated from something outside the guard. Nothing
// here today; kept so the exclusion has an obvious home when one shows up.
const EXCLUDED = []

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

const isGuarded = (rel) =>
  GUARDED.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p)) &&
  !EXCLUDED.some((p) => rel === p || rel.startsWith(p))

function guardedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', ...GUARDED], { cwd: root, encoding: 'utf8' })
  return out.split('\0').filter(Boolean).filter(isGuarded)
}

function toRel(arg) {
  const abs = path.resolve(arg)
  return path.relative(root, abs).split(path.sep).join('/')
}

function isBinary(abs) {
  try {
    if (!statSync(abs).isFile()) return true
  } catch {
    return true // deleted or unreadable: nothing to check
  }
  return false
}

const args = process.argv.slice(2)
const files = args.length ? args.map(toRel).filter(isGuarded) : guardedFiles()

const violations = []
for (const rel of files) {
  const abs = path.join(root, rel)
  if (isBinary(abs)) continue
  let lines
  try {
    lines = readFileSync(abs, 'utf8').split('\n')
  } catch {
    continue
  }
  lines.forEach((line, i) => {
    if (!line.includes(EM_DASH)) return
    if (line.includes(MARKER)) return
    if (i > 0 && lines[i - 1].includes(MARKER)) return
    violations.push({ file: rel, line: i + 1, text: line.trim() })
  })
}

if (!violations.length) process.exit(0)

if (process.env.ALLOW_EM_DASHES === '1') {
  console.warn(`em-dash check: ${violations.length} found, allowed via ALLOW_EM_DASHES=1`)
  process.exit(0)
}

console.error(`\nEm-dashes (${EM_DASH}) are not allowed in the app's copy.\n`)
for (const v of violations) {
  const shown = v.text.length > 100 ? v.text.slice(0, 100) + '…' : v.text
  console.error(`  ${v.file}:${v.line}  ${shown}`)
}
console.error(`
${violations.length} found. Rewrite with a comma, colon, semicolon, parentheses,
or two sentences.

If an em-dash is genuinely the point (matching one in someone else's data,
quoting a string verbatim), add \`${MARKER}\` in a comment on that line or the
line above. To skip the whole check once: ALLOW_EM_DASHES=1, or commit with
--no-verify.
`)
process.exit(1)
