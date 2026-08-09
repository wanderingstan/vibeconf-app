#!/usr/bin/env node

// preferences-schema.js is CommonJS and has no Electron or app-startup side effects,
// so this generator can require it directly. Calling its describe() helper with an
// empty store also keeps preference scope tied to config-scope.js, the same source the
// running app uses, instead of duplicating the app-level key list here.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PREFERENCES, describe } = require('../electron-app/preferences-schema.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'docs/preferences.md');
export const BEGIN_MARKER = '<!-- BEGIN GENERATED -->';
export const END_MARKER = '<!-- END GENERATED -->';

export const DEFAULT_PREAMBLE = `# Preferences

<!-- This preamble is the only hand-editable section of this page. -->

Every persisted setting the bot exposes to agents lives in \`electron-app/preferences-schema.js\`. Anything not in that schema, including auth cookies and API keys, is invisible to the agent even when it lives in the same \`config.json\`.

Use \`list_preferences\` to read the current values and \`set_preference({key, value})\` to change one. The schema is authoritative; regenerate the reference below with \`node scripts/generate-preferences-doc.mjs\`.`;

const CONSTRAINT_FIELDS = [
  ['enum', 'one of'],
  ['enumPattern', 'or matching'],
  ['min', 'minimum'],
  ['max', 'maximum'],
  ['minItems', 'minimum items'],
  ['maxLength', 'maximum length'],
  ['pattern', 'pattern'],
];

function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function markdownCode(value) {
  const text = String(value);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longestRun + 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

function valueCode(value) {
  const rendered = value instanceof RegExp ? value.toString() : JSON.stringify(value);
  return markdownCode(rendered === undefined ? String(value) : rendered);
}

function tableCell(value) {
  return value.replaceAll('|', '\\|');
}

function constraintsFor(spec) {
  return CONSTRAINT_FIELDS.flatMap(([field, label]) => {
    if (spec[field] == null) return [];
    const value = field === 'enum'
      ? spec[field].map((item) => valueCode(item)).join(', ')
      : valueCode(spec[field]);
    return [`${label} ${value}`];
  });
}

export function preferenceEntries() {
  const scopes = new Map(describe(() => undefined).map((entry) => [entry.key, entry.scope]));
  return Object.entries(PREFERENCES).map(([name, spec]) => ({
    name,
    spec,
    scope: scopes.get(name),
  }));
}

function renderPreference({ name, spec, scope }, headingLevel) {
  const constraints = constraintsFor(spec);
  const rows = [
    ['Type', markdownCode(spec.type)],
    ['Default', valueCode(spec.default)],
    ['Scope', scope],
    ['Requires restart', spec.requiresRestart === true ? 'yes' : 'no'],
    ['Constraints', constraints.length ? constraints.join('; ') : 'none'],
    ['Description', spec.description],
  ];
  return [
    `${'#'.repeat(headingLevel)} \`${name}\``,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${tableCell(value)} |`),
  ].join('\n');
}

export function renderGeneratedReference(entries = preferenceEntries()) {
  const hasCategories = entries.some(({ spec }) => (
    typeof spec.category === 'string' && spec.category.trim() !== ''
  ));

  if (!hasCategories) {
    const sorted = [...entries].sort((a, b) => compareNames(a.name, b.name));
    return [
      '## Preference reference',
      '',
      ...sorted.flatMap((entry) => [renderPreference(entry, 3), '']),
    ].join('\n').trimEnd();
  }

  const groups = new Map();
  for (const entry of entries) {
    const category = typeof entry.spec.category === 'string' && entry.spec.category.trim()
      ? entry.spec.category.trim()
      : 'Uncategorized';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(entry);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => compareNames(a, b))
    .flatMap(([category, group]) => [
      `## ${category}`,
      '',
      ...group
        .sort((a, b) => compareNames(a.name, b.name))
        .flatMap((entry) => [renderPreference(entry, 3), '']),
    ])
    .join('\n')
    .trimEnd();
}

export function extractPreamble(existing) {
  if (typeof existing !== 'string') return DEFAULT_PREAMBLE;
  const markerIndex = existing.indexOf(BEGIN_MARKER);
  return markerIndex === -1 ? DEFAULT_PREAMBLE : existing.slice(0, markerIndex).trimEnd();
}

export function generateDocument(existing) {
  const preamble = extractPreamble(existing);
  return `${preamble}\n\n${BEGIN_MARKER}\n\n${renderGeneratedReference()}\n\n${END_MARKER}\n`;
}

function formatDiff(actual, expected, displayPath) {
  const oldLines = actual.split('\n');
  const newLines = expected.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const contextBefore = oldLines.slice(contextStart, prefix).map((line) => ` ${line}`);
  const removed = oldLines.slice(prefix, oldLines.length - suffix).map((line) => `-${line}`);
  const added = newLines.slice(prefix, newLines.length - suffix).map((line) => `+${line}`);
  const trailingSource = suffix > 0 ? oldLines : newLines;
  const trailingEnd = suffix > 0 ? oldEnd : newEnd;
  const trailingStart = suffix > 0 ? oldLines.length - suffix : newLines.length - suffix;
  const contextAfter = trailingSource.slice(trailingStart, trailingEnd).map((line) => ` ${line}`);

  return [
    `--- ${displayPath}`,
    `+++ ${displayPath} (generated)`,
    `@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`,
    ...contextBefore,
    ...removed,
    ...added,
    ...contextAfter,
  ].join('\n');
}

export function updatePreferencesDoc({ outputPath = DEFAULT_OUTPUT_PATH, check = false } = {}) {
  const existing = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  const generated = generateDocument(existing || undefined);

  if (check) {
    if (existing === generated) return true;
    const displayPath = path.relative(ROOT, outputPath) || outputPath;
    process.stderr.write(`${displayPath} is stale. Run: node scripts/generate-preferences-doc.mjs\n`);
    process.stderr.write(`${formatDiff(existing, generated, displayPath)}\n`);
    return false;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated);
  return true;
}

function parseArgs(args) {
  let check = false;
  let outputPath = DEFAULT_OUTPUT_PATH;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--output') {
      const value = args[index + 1];
      if (!value) throw new Error('--output needs a path');
      outputPath = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { check, outputPath };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const ok = updatePreferencesDoc(parseArgs(process.argv.slice(2)));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
