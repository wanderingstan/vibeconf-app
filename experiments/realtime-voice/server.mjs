// Zero-dependency local dev server. Serves public/ and routes /api/* to the
// same handlers Vercel would run, so local and deployed behave identically.
//
//   OPENAI_API_KEY=sk-... node server.mjs
//
// Also reads a .env file in this directory if one exists.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const envFile = path.join(dir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.warn('\n  ⚠  OPENAI_API_KEY is not set — /api/session will return 500.\n');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.svg': 'image/svg+xml', '.json': 'application/json' };

const routes = {
  '/api/session': require('./api/session.js'),
  '/api/deep': require('./api/deep.js'),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  const handler = routes[url.pathname];
  if (handler) return handler(req, res);

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(dir, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

const port = process.env.PORT || 3005;
server.listen(port, () => {
  console.log(`\n  Realtime Pepper → http://localhost:${port}\n`);
  console.log(`  deep model: ${process.env.ANTHROPIC_API_KEY ? (process.env.DEEP_MODEL || 'claude-sonnet-5') : 'stub (set ANTHROPIC_API_KEY to wire it up)'}\n`);
});
