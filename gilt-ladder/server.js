// Gilt Ladder: static frontend plus a small JSON API. Plain node:http, no
// framework - the whole surface is three GETs and one POST.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Some Northflank plans mount secrets as FILES rather than environment
// variables. For each optional value, fall back to reading /etc/secrets/<NAME>
// when the env var is unset. A real env var always wins.
const SECRET_FILE_DIR = process.env.SECRET_FILE_DIR || '/etc/secrets';
for (const key of ['APP_USERNAME', 'APP_PASSWORD']) {
  if (process.env[key]) continue;
  try {
    process.env[key] = fs.readFileSync(path.join(SECRET_FILE_DIR, key), 'utf8').trim();
  } catch {
    // Not configured - the app runs unauthenticated, which is the default.
  }
}

const { getCurve } = require('./lib/curveStore');
const { load: loadUniverse, activeAt } = require('./lib/universe');
const { buildLadder, DEFAULTS } = require('./lib/ladder');
const { toISO, addBusinessDays } = require('./lib/calendar');

const PORT = process.env.PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LIABILITIES = 200;

// Fail at startup rather than on the first request: a malformed universe is a
// deployment error, and there is nothing useful this service can do without one.
const universe = loadUniverse();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

function authorised(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true;

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  const pass = rest.join(':');

  const expectedUser = process.env.APP_USERNAME || 'gilt';
  // timingSafeEqual needs equal lengths, so compare digests rather than the
  // raw values.
  const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return (
    crypto.timingSafeEqual(digest(user), digest(expectedUser)) &&
    crypto.timingSafeEqual(digest(pass), digest(expected))
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  // Resolve and confirm containment rather than trusting the request path.
  const file = path.resolve(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function validateRequest(body) {
  const problems = [];
  if (!Array.isArray(body.liabilities) || !body.liabilities.length) {
    problems.push('liabilities must be a non-empty array');
  } else if (body.liabilities.length > MAX_LIABILITIES) {
    problems.push(`at most ${MAX_LIABILITIES} liabilities`);
  } else {
    body.liabilities.forEach((l, i) => {
      if (!l || !/^\d{4}-\d{2}-\d{2}$/.test(String(l.date))) problems.push(`liability ${i + 1}: invalid date`);
      if (!(Number(l.amount) > 0)) problems.push(`liability ${i + 1}: amount must be positive`);
    });
  }

  const rate = body.marginalRate;
  if (rate != null && !(Number(rate) >= 0 && Number(rate) < 1)) {
    problems.push('marginalRate must be between 0 and 1');
  }
  if (body.portfolioValue != null && !(Number(body.portfolioValue) >= 0)) {
    problems.push('portfolioValue must be positive');
  }
  if (body.lotSize != null && !(Number(body.lotSize) > 0)) {
    problems.push('lotSize must be positive');
  }
  return problems;
}

async function handleLadder(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: 'invalid JSON body', details: err.message });
    return;
  }

  const problems = validateRequest(body);
  if (problems.length) {
    sendJson(res, 400, { error: 'invalid request', details: problems });
    return;
  }

  let curveEntry;
  try {
    curveEntry = await getCurve();
  } catch (err) {
    sendJson(res, 503, { error: 'no yield curve available', details: err.message });
    return;
  }

  const settlement = toISO(addBusinessDays(curveEntry.curve.date, DEFAULTS.settlementBusinessDays));

  try {
    const result = buildLadder({
      liabilities: body.liabilities,
      portfolioValue: body.portfolioValue == null ? null : Number(body.portfolioValue),
      marginalRate: Number(body.marginalRate || 0),
      lotSize: body.lotSize == null ? DEFAULTS.lotSize : Number(body.lotSize),
      bufferBusinessDays:
        body.bufferBusinessDays == null ? DEFAULTS.bufferBusinessDays : Number(body.bufferBusinessDays),
      settlement,
      curve: curveEntry.curve,
      universe: activeAt(universe, settlement),
    });

    sendJson(res, 200, {
      ...result,
      // Provenance travels with every result: prices are curve-derived and
      // indicative, and the UI states that rather than letting a number that
      // looks like a price imply it is dealable.
      provenance: {
        priceBasis: 'derived from the Bank of England nominal gilt spot curve',
        curveDate: curveEntry.curve.date,
        curveFetchedAt: curveEntry.fetchedAt,
        curveStale: Boolean(curveEntry.stale),
        universeSource: universe.source,
        universeAsOf: universe.asOf,
        indicative: true,
      },
    });
  } catch (err) {
    sendJson(res, 400, { error: 'could not build ladder', details: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  if (!authorised(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Gilt Ladder"' });
    res.end('Authentication required');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'POST' && url.pathname === '/api/ladder') {
      await handleLadder(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/universe') {
      sendJson(res, 200, {
        source: universe.source,
        asOf: universe.asOf,
        count: universe.gilts.length,
        gilts: universe.gilts,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/curve') {
      const entry = await getCurve();
      sendJson(res, 200, {
        date: entry.curve.date,
        fetchedAt: entry.fetchedAt,
        stale: Boolean(entry.stale),
        error: entry.error || null,
        points: entry.curve.points,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, universe: universe.source, gilts: universe.gilts.length });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'internal error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Gilt Ladder on http://localhost:${PORT}`);
    if (universe.source === 'sample') {
      console.warn('WARNING: running on the SAMPLE gilt universe - see config/gilts.js');
    }
    // Warm the curve so the first real request is not the one that waits.
    getCurve().catch((err) => console.warn(`initial curve fetch failed: ${err.message}`));
  });
}

module.exports = { server, validateRequest };
