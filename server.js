// Minimal local dev server: serves the static frontend and mounts /api/reports,
// so the site can be run with just `node server.js` (no Vercel CLI needed).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { fetchReports } = require('./lib/fetchReports');
const { resolveIsins } = require('./lib/resolveIsin');
const { buildRssFeed } = require('./lib/buildFeed');
const { summariseReport } = require('./lib/summarise');
const watchlist = require('./config/watchlist');

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
    const { status, body } = await fetchReports({
      leis: parsed.searchParams.get('leis'),
      days: parsed.searchParams.get('days'),
      categories: parsed.searchParams.get('categories'),
    });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (parsed.pathname === '/api/resolve') {
    const isins = (parsed.searchParams.get('isins') || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (isins.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No isins provided' }));
      return;
    }

    const results = await resolveIsins(isins);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
    return;
  }

  if (parsed.pathname === '/api/feed') {
    const { status, body } = await fetchReports({
      leis: parsed.searchParams.get('leis'),
      days: parsed.searchParams.get('days'),
      categories: parsed.searchParams.get('categories'),
    });

    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    const siteUrl = `http://${req.headers.host}/`;
    const feedUrl = `http://${req.headers.host}${req.url}`;
    const xml = buildRssFeed({
      reports: body.reports,
      feedUrl,
      siteUrl,
      title: 'RNS Update',
      description: `Report disclosures for ${body.leis.length} compan${body.leis.length === 1 ? 'y' : 'ies'}, matching: ${body.categories.join(', ')}`,
    });
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(xml);
    return;
  }

  if (parsed.pathname === '/api/summarise' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const result = await summariseReport(body);
      res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (parsed.pathname === '/api/watchlist') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ companies: watchlist }));
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
