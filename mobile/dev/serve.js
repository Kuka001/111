#!/usr/bin/env node
// Development server for the web UI: serves mobile/www as-is and injects
// mobile/dev/mock-bridge.js before app.js, so the app runs in a desktop browser
// against an in-memory backend that follows the LocalBackendServer contract.
//
//   npm run dev                 -> http://localhost:5173/
//   http://localhost:5173/?engine=17&long=1   (see mock-bridge.js for switches)
//
// Unlike the legacy server/ (whose /api/updates/apply overwrites mobile/www
// with unsigned files from GitHub), this server never writes anything.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 5173);
const WWW = path.join(__dirname, '..', 'www');
const DEV = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function safeJoin(root, urlPath) {
  const target = path.normalize(path.join(root, urlPath));
  return target.startsWith(root) ? target : null;
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

  if (urlPath === '/' || urlPath === '/index.html') {
    const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
    const injected = html.replace(
      /<script src="app\.js"><\/script>/,
      '<script src="/__dev/mock-bridge.js"></script>\n  <script src="app.js"></script>'
    );
    return send(res, 200, injected, TYPES['.html']);
  }

  const root = urlPath.startsWith('/__dev/') ? DEV : WWW;
  const rel = urlPath.startsWith('/__dev/') ? urlPath.slice('/__dev'.length) : urlPath;
  const file = safeJoin(root, rel);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
}).listen(PORT, () => {
  console.log(`AGY Roleplay UI dev server: http://localhost:${PORT}/  (mock bridge, engine 18; ?engine=17 for legacy)`);
});
