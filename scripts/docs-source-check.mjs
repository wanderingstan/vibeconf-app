#!/usr/bin/env node
// docs-source-check.mjs — verify that documentation claims still match code.
//
// Usage:
//   node scripts/docs-source-check.mjs          # check README.md and docs/*.md
//   node scripts/docs-source-check.mjs --report # also show annotation coverage
//
// Put one or more annotations directly above a claim:
//   <!-- source: electron-app/main.js /const DEFAULT_PORT = 7865;/ -->
// Use <!-- unverified --> when a claim cannot be backed by code yet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_CANDIDATE = /<!--\s*source\b.*?(?:-->|$)/g;
const SOURCE_FORMAT = /^<!--\s*source:\s+(.+?)\s+\/(.*)\/\s*-->$/;
const UNVERIFIED = /<!--\s*unverified\s*-->/g;

function discoverDocFiles(repoRoot) {
  const files = [];
  if (fs.existsSync(path.join(repoRoot, 'README.md'))) files.push('README.md');

  const docsDir = path.join(repoRoot, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.posix.join('docs', entry.name));
      }
    }
  }
  return files.sort();
}

function parseSourceAnnotation(raw) {
  const match = raw.match(SOURCE_FORMAT);
  if (!match) {
    return { error: 'malformed source annotation; use <!-- source: path /regex/ -->' };
  }

  const sourcePath = match[1].trim();
  const pattern = match[2];
  if (!sourcePath || !pattern) {
    return { error: 'malformed source annotation; use <!-- source: path /regex/ -->' };
  }

  try {
    return { sourcePath, pattern, regex: new RegExp(pattern) };
  } catch (error) {
    return {
      sourcePath,
      pattern,
      error: 'invalid regex; fix /' + pattern + '/: ' + error.message,
    };
  }
}

function sourcePathError(repoRoot, sourcePath) {
  if (path.isAbsolute(sourcePath)) {
    return 'source path must be repo-relative; remove the leading directory separator';
  }

  const relative = path.relative(repoRoot, path.resolve(repoRoot, sourcePath));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    return 'source path must stay inside the repo; use a repo-relative path';
  }
  return null;
}

function checkAnnotation(annotation, repoRoot, sourceCache) {
  const parsed = parseSourceAnnotation(annotation.raw);
  const base = {
    docPath: annotation.docPath,
    line: annotation.line,
    raw: annotation.raw,
    sourcePath: parsed.sourcePath ?? null,
    pattern: parsed.pattern ?? null,
  };

  if (parsed.error) return { ...base, status: 'fail', message: parsed.error };

  const unsafePath = sourcePathError(repoRoot, parsed.sourcePath);
  if (unsafePath) return { ...base, status: 'fail', message: unsafePath };

  const absoluteSourcePath = path.resolve(repoRoot, parsed.sourcePath);
  if (!sourceCache.has(absoluteSourcePath)) {
    try {
      sourceCache.set(absoluteSourcePath, {
        text: fs.readFileSync(absoluteSourcePath, 'utf8'),
      });
    } catch (error) {
      sourceCache.set(absoluteSourcePath, { error });
    }
  }

  const source = sourceCache.get(absoluteSourcePath);
  if (source.error) {
    const message = source.error.code === 'ENOENT'
      ? 'source file not found; update the path'
      : 'source file could not be read; fix its path or permissions: ' + source.error.message;
    return { ...base, status: 'fail', message };
  }

  if (!parsed.regex.test(source.text)) {
    return {
      ...base,
      status: 'fail',
      message: 'regex did not match; update the claim or pattern',
    };
  }
  return { ...base, status: 'pass', message: 'matched' };
}

export function checkDocs({ repoRoot, docPaths } = {}) {
  if (!repoRoot) throw new TypeError('checkDocs requires repoRoot');

  const root = path.resolve(repoRoot);
  const documents = docPaths ? [...docPaths].sort() : discoverDocFiles(root);
  const annotations = [];
  const docFiles = [];
  let unverified = 0;

  for (const docPath of documents) {
    const text = fs.readFileSync(path.resolve(root, docPath), 'utf8');
    const lines = text.split(/\r?\n/);
    let sourceCount = 0;
    let unverifiedCount = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const sourceMatches = [...lines[index].matchAll(SOURCE_CANDIDATE)];
      const unverifiedMatches = [...lines[index].matchAll(UNVERIFIED)];
      sourceCount += sourceMatches.length;
      unverifiedCount += unverifiedMatches.length;

      for (const match of sourceMatches) {
        annotations.push({ docPath, line: index + 1, raw: match[0] });
      }
    }

    unverified += unverifiedCount;
    docFiles.push({
      path: docPath,
      sourceCount,
      unverifiedCount,
      annotationCount: sourceCount + unverifiedCount,
    });
  }

  const sourceCache = new Map();
  const checks = annotations.map((annotation) => (
    checkAnnotation(annotation, root, sourceCache)
  ));
  const pass = checks.filter((check) => check.status === 'pass').length;

  return {
    checks,
    docFiles,
    checked: checks.length,
    pass,
    fail: checks.length - pass,
    unverified,
  };
}

function annotationLabel(check) {
  if (!check.sourcePath || check.pattern == null) return check.raw;
  return check.sourcePath + ' /' + check.pattern + '/';
}

export function renderResults(result, { report = false } = {}) {
  const lines = result.checks.map((check) => {
    const location = check.docPath + ':' + check.line;
    const suffix = check.status === 'pass' ? '' : ' — ' + check.message;
    return check.status.toUpperCase() + ' ' + location + ' ' + annotationLabel(check) + suffix;
  });

  if (report) {
    if (lines.length) lines.push('');
    lines.push('Coverage:');
    for (const doc of result.docFiles) {
      const annotationWord = doc.annotationCount === 1 ? 'annotation' : 'annotations';
      lines.push(
        '  ' + doc.path + ': ' + doc.annotationCount + ' ' + annotationWord
        + ' (' + doc.sourceCount + ' source, ' + doc.unverifiedCount + ' unverified)',
      );
    }
  }

  if (lines.length) lines.push('');
  lines.push(
    'Summary: ' + result.checked + ' annotations checked, ' + result.pass + ' pass, '
    + result.fail + ' fail, ' + result.unverified + ' explicit unverified',
  );
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--report');
  if (unknown.length) {
    console.error(
      'Unknown option ' + unknown[0]
      + '; use node scripts/docs-source-check.mjs [--report]',
    );
    process.exitCode = 1;
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkDocs({ repoRoot });
  console.log(renderResults(result, { report: args.includes('--report') }));
  if (result.fail > 0) process.exitCode = 1;
}

const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
const isMain = process.argv[1]
  && modulePath === fs.realpathSync(process.argv[1]);
if (isMain) main();
