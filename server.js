// Minimal local dev server: serves the static frontend and mounts /api/reports,
// so the site can be run with just `node server.js` (no Vercel CLI needed).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { fetchReports } = require('./lib/fetchReports');

const PORT = process.env.PORT || 3000;

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html' },
  '/index.html': { file: 'index.html', type: 'text/html' },
  '/style.css': { file: 'style.css', type: 'text/css' },
  '/app.js': { file: 'app.js', type: 'text/javascript' },
};

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);

  if (parsed.pathname === '/api/reports') {
    const { status, body } = await fetchReports({ isins: parsed.searchParams.get('isins') });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  const staticEntry = STATIC_FILES[parsed.pathname];
  if (!staticEntry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  fs.readFile(path.join(__dirname, staticEntry.file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': staticEntry.type });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`RNS Update running at http://localhost:${PORT}`);
});
