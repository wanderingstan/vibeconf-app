#!/usr/bin/env node
// playwright-profile.mjs: open a Playwright conformance bot's Chrome profile so
// a person can sign it in (Slack, Google, Zoom) once. The profile is the one
// PlaywrightConformanceBot uses for that name, so the next
// `provider-test.mjs --host playwright` run starts signed in.
//
//   node scripts/playwright-profile.mjs --name Alice --url https://app.slack.com
//
// Sign in in the window, then close it. Nothing here touches credentials.

import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('../packages/calls/node_modules/playwright-core');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const name = arg('name', '');
const url = arg('url', 'about:blank');
if (!name) { console.error('--name is required (the bot name the conformance run uses, e.g. Alice)'); process.exit(2); }

// Same directory as PlaywrightConformanceBot's default.
const userDataDir = path.join(os.tmpdir(), 'vibeconf-calls-conformance', name);
console.log(`Opening ${name}'s profile (${userDataDir}). Sign in, then close the window.`);
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chrome', headless: false, viewport: null, chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'],
});
const page = context.pages()[0] || await context.newPage();
await page.goto(url);
await new Promise((resolve) => context.on('close', resolve));
console.log('Closed; the profile keeps the sign-in.');
