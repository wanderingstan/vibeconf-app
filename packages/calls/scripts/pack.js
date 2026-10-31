#!/usr/bin/env node
// Build the tarball a developer would install: the public imports only. The repo's
// package.json also maps the internal folders, because the app still imports them
// (it moves to the public API after launch); those entries stop at this script.
//   node scripts/pack.js [output folder]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.resolve(process.argv[2] || process.cwd());
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'calls-pack-'));

for (const entry of pkg.files) {
  fs.cpSync(path.join(root, entry), path.join(staging, entry), { recursive: true });
}
fs.copyFileSync(path.join(root, 'README.md'), path.join(staging, 'README.md'));

const PUBLIC = ['.', './hosts/playwright', './hosts/electron', './conformance', './package.json'];
pkg.exports = Object.fromEntries(PUBLIC.map((k) => [k, pkg.exports[k]]));
delete pkg.devDependencies;
fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

const name = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: staging, encoding: 'utf8' }).trim();
fs.rmSync(staging, { recursive: true, force: true });
console.log(path.join(out, name));
