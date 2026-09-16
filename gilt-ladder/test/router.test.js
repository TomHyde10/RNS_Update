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

// validateRequest is exercised directly rather than over HTTP: it is the only
// thing standing between a mistyped quote and a confidently wrong ladder, and
// it runs before the curve is ever fetched, so none of this needs the network.
describe('observed price validation', () => {
  const ok = { liabilities: [{ date: '2030-06-30', amount: 1000 }] };

  it('accepts a well-formed quote', () => {
    const problems = giltLadder.validateRequest({
      ...ok,
      observedPrices: [{ isin: 'GB00BMBL1D50', clean: 96.42 }],
    });
    assert.deepEqual(problems, []);
  });

  it('accepts a lowercase ISIN, since that is what gets pasted', () => {
    const problems = giltLadder.validateRequest({
      ...ok,
      observedPrices: [{ isin: 'gb00bmbl1d50', clean: 96.42 }],
    });
    assert.deepEqual(problems, []);
  });

  it('rejects a malformed ISIN', () => {
    const problems = giltLadder.validateRequest({ ...ok, observedPrices: [{ isin: 'NOPE', clean: 96 }] });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /invalid ISIN/);
  });

  // A price in pence, and a nominal amount pasted into the price column: the
  // two mistakes that would otherwise produce a plausible-looking ladder off a
  // price wrong by two orders of magnitude.
  it('rejects prices outside the plausible band for £100 nominal', () => {
    for (const clean of [0.9642, 9642, 0, -5]) {
      const problems = giltLadder.validateRequest({
        ...ok,
        observedPrices: [{ isin: 'GB00BMBL1D50', clean }],
      });
      assert.equal(problems.length, 1, `expected ${clean} to be rejected`);
      assert.match(problems[0], /clean price must be between/);
    }
  });

  it('rejects a non-array and over-long price lists', () => {
    assert.match(giltLadder.validateRequest({ ...ok, observedPrices: 'x' })[0], /must be an array/);
    const many = Array.from({ length: 201 }, () => ({ isin: 'GB00BMBL1D50', clean: 96 }));
    assert.match(giltLadder.validateRequest({ ...ok, observedPrices: many })[0], /at most 200/);
  });

  it('leaves requests with no quotes alone', () => {
    assert.deepEqual(giltLadder.validateRequest(ok), []);
  });
});
