// The mount inside the RNS server: prefix ownership, the trailing-slash
// redirect the relative frontend URLs depend on, and that static files come
// from gilt-ladder/public rather than colliding with RNS's own /style.css and
// /app.js. Deliberately avoids /api/ladder and /api/curve, which need the
// Bank of England curve and so the network.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const giltLadder = require('../router');

describe('gilt-ladder router', () => {
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (!giltLadder.owns(url.pathname)) {
        res.writeHead(418);
        res.end('rns');
        return;
      }
      giltLadder.handle(req, res, url);
    });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://localhost:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('owns only its own prefix', () => {
    assert.equal(giltLadder.owns('/gilt-ladder'), true);
    assert.equal(giltLadder.owns('/gilt-ladder/api/universe'), true);
    assert.equal(giltLadder.owns('/gilt-ladderx'), false);
    assert.equal(giltLadder.owns('/style.css'), false);
    assert.equal(giltLadder.owns('/api/reports'), false);
  });

  it('redirects the bare mount to its trailing-slash form, keeping the query', async () => {
    const res = await fetch(`${base}/gilt-ladder?x=1`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/gilt-ladder/?x=1');
  });

  it('serves its own frontend, not the host app', async () => {
    const html = await fetch(`${base}/gilt-ladder/`).then((r) => r.text());
    assert.match(html, /<title>Gilt Ladder<\/title>/);

    const css = await fetch(`${base}/gilt-ladder/style.css`).then((r) => r.text());
    assert.equal(css, fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8'));
  });

  it('refuses paths that escape the public directory', async () => {
    const res = await fetch(`${base}/gilt-ladder/..%2frouter.js`);
    assert.notEqual(res.status, 200);
  });

  it('serves the universe from under the prefix', async () => {
    const body = await fetch(`${base}/gilt-ladder/api/universe`).then((r) => r.json());
    assert.equal(body.count, body.gilts.length);
    assert.ok(body.count > 0);
  });

  it('rejects an invalid ladder request before touching the curve', async () => {
    const res = await fetch(`${base}/gilt-ladder/api/ladder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liabilities: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects unsupported methods', async () => {
    const res = await fetch(`${base}/gilt-ladder/api/universe`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  });
});
