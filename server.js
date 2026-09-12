#!/usr/bin/env node

// Minimal static file server (no dependencies) that serves ./public at the
// root and ./assets at /assets, so the browser viewer can fetch the PDF and
// the generated form-schema.json over http:// instead of file://.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSETS_DIR = path.join(ROOT, 'assets');
const PORT = process.env.PORT || 4000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  const [baseDir, relativePath] = urlPath.startsWith('/assets/')
    ? [ASSETS_DIR, urlPath.slice('/assets/'.length)]
    : [PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '')];

  const filePath = path.join(baseDir, relativePath);

  // Prevent escaping the target directory.
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Serving at http://localhost:${PORT}`);
});
