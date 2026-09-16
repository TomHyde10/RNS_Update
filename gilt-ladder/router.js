// Gilt Ladder, mounted inside the RNS server at MOUNT. Serves its own static
// frontend and a small JSON API from under that prefix; authentication is
// the host server's job (server.js checks Basic Auth before routing here).
const fs = require('fs');
const path = require('path');

const { getCurve } = require('./lib/curveStore');
const { load: loadUniverse, activeAt, ISIN_RE } = require('./lib/universe');
const { buildLadder, DEFAULTS } = require('./lib/ladder');
const { toISO, addBusinessDays } = require('./lib/calendar');

const MOUNT = '/gilt-ladder';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 256 * 1024;
const MAX_LIABILITIES = 200;
const MAX_OBSERVED_PRICES = 200;
const MAX_EXISTING_HOLDINGS = 200;
// A conventional gilt's clean price per £100 nominal. The band is wide on
// purpose - a 0.5% 2061 has traded in the 20s and a high-coupon long gilt can
// sit well above par - but it still catches the two mistakes that matter: a
// price entered in pence, and a nominal amount pasted into the price column.
const MIN_CLEAN_PRICE = 1;
const MAX_CLEAN_PRICE = 250;
// The DMO universe is a committed file refreshed by hand, so the one failure
// it has is going quietly out of date: a gilt issued since the last export
// cannot be chosen, and nothing about a stale file looks different from a
// fresh one. A few gilts are issued or redeemed a year, so half a year without
// a refresh is worth saying out loud.
const UNIVERSE_STALE_DAYS = 180;

function universeStaleness(asOf, now = Date.now()) {
  if (!asOf) return null;
  const ageDays = Math.floor((now - Date.parse(`${asOf}T00:00:00Z`)) / 86400000);
  if (ageDays < UNIVERSE_STALE_DAYS) return null;
  return {
    type: 'stale-universe',
    ageDays,
    message:
      `The gilt universe was last exported from the DMO ${ageDays} days ago (${asOf}). ` +
      'Any gilt issued since then cannot be selected - re-run `npm run gilt:build-universe`.',
  };
}

// A malformed universe is a deployment error, but it must not take the RNS
// app down with it: record the failure and answer every gilt route with it.
let universe = null;
let universeError = null;
try {
  universe = loadUniverse();
} catch (err) {
  universeError = err;
  console.error(`Gilt Ladder disabled: ${err.message}`);
}

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

function serveStatic(res, subPath) {
  const name = subPath === '/' ? 'index.html' : subPath.slice(1);
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

  if (body.existingHoldings != null) {
    if (!Array.isArray(body.existingHoldings)) {
      problems.push('existingHoldings must be an array');
    } else if (body.existingHoldings.length > MAX_EXISTING_HOLDINGS) {
      problems.push(`at most ${MAX_EXISTING_HOLDINGS} existing holdings`);
    } else {
      body.existingHoldings.forEach((h, i) => {
        const where = `existingHoldings[${i}]`;
        if (!h || typeof h !== 'object') {
          problems.push(`${where}: not an object`);
          return;
        }
        if (!ISIN_RE.test(String(h.isin).trim().toUpperCase())) {
          problems.push(`${where}: invalid ISIN ${JSON.stringify(h.isin)}`);
        }
        if (!(Number(h.nominal) > 0)) problems.push(`${where}: nominal must be positive`);
      });
    }
  }

  if (body.accruedIncomeScheme != null && !['auto', true, false].includes(body.accruedIncomeScheme)) {
    problems.push("accruedIncomeScheme must be 'auto', true or false");
  }

  if (body.observedPrices != null) {
    if (!Array.isArray(body.observedPrices)) {
      problems.push('observedPrices must be an array');
    } else if (body.observedPrices.length > MAX_OBSERVED_PRICES) {
      problems.push(`at most ${MAX_OBSERVED_PRICES} observed prices`);
    } else {
      body.observedPrices.forEach((p, i) => {
        const where = `observedPrices[${i}]`;
        if (!p || typeof p !== 'object') {
          problems.push(`${where}: not an object`);
          return;
        }
        if (!ISIN_RE.test(String(p.isin).trim().toUpperCase())) {
          problems.push(`${where}: invalid ISIN ${JSON.stringify(p.isin)}`);
        }
        const clean = Number(p.clean);
        if (!Number.isFinite(clean) || clean < MIN_CLEAN_PRICE || clean > MAX_CLEAN_PRICE) {
          problems.push(
            `${where}: clean price must be between ${MIN_CLEAN_PRICE} and ${MAX_CLEAN_PRICE} per £100 nominal`
          );
        }
      });
    }
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
      observedPrices: body.observedPrices || [],
      existingHoldings: body.existingHoldings || [],
      accruedIncomeScheme:
        body.accruedIncomeScheme == null ? DEFAULTS.accruedIncomeScheme : body.accruedIncomeScheme,
      settlement,
      curve: curveEntry.curve,
      universe: activeAt(universe, settlement),
    });

    const stale = universeStaleness(universe.asOf);
    if (stale) result.warnings.push(stale);

    sendJson(res, 200, {
      ...result,
      // Provenance travels with every result: prices are curve-derived and
      // indicative, and the UI states that rather than letting a number that
      // looks like a price imply it is dealable.
      provenance: {
        priceBasis:
          result.pricing.pricedRungs > 0
            ? 'quoted clean prices you supplied where given, otherwise derived from the Bank of England nominal gilt spot curve'
            : 'derived from the Bank of England nominal gilt spot curve',
        curveDate: curveEntry.curve.date,
        curveFetchedAt: curveEntry.fetchedAt,
        curveStale: Boolean(curveEntry.stale),
        universeSource: universe.source,
        universeAsOf: universe.asOf,
        // Stays true even when every rung was bought at a quoted price: the
        // intermediate coupons are still valued off the curve, and nothing
        // here accounts for dealing costs or commission.
        indicative: true,
      },
    });
  } catch (err) {
    sendJson(res, 400, { error: 'could not build ladder', details: err.message });
  }
}

// True when `pathname` belongs to the Gilt Ladder rather than to RNS.
const owns = (pathname) => pathname === MOUNT || pathname.startsWith(`${MOUNT}/`);

async function handle(req, res, url) {
  // The frontend uses relative URLs so it works under any mount point, which
  // only resolves correctly from a directory-style URL with a trailing slash.
  if (url.pathname === MOUNT) {
    res.writeHead(301, { Location: `${MOUNT}/${url.search}` });
    res.end();
    return;
  }

  const subPath = url.pathname.slice(MOUNT.length);

  try {
    if (subPath === '/api/health' && req.method === 'GET') {
      sendJson(res, universeError ? 503 : 200, universeError
        ? { ok: false, error: universeError.message }
        : { ok: true, universe: universe.source, gilts: universe.gilts.length });
      return;
    }

    if (subPath.startsWith('/api/') && universeError) {
      sendJson(res, 503, { error: 'gilt universe is invalid', details: universeError.message });
      return;
    }

    if (req.method === 'POST' && subPath === '/api/ladder') {
      await handleLadder(req, res);
      return;
    }

    if (req.method === 'GET' && subPath === '/api/universe') {
      sendJson(res, 200, {
        source: universe.source,
        asOf: universe.asOf,
        count: universe.gilts.length,
        gilts: universe.gilts,
      });
      return;
    }

    if (req.method === 'GET' && subPath === '/api/curve') {
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

    if (req.method === 'GET') {
      serveStatic(res, subPath);
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'internal error' });
  }
}

// Called once the host server is listening: warns about sample data and warms
// the curve so the first real request is not the one that waits for the Bank.
function start() {
  if (universeError) return;
  if (universe.source === 'sample') {
    console.warn('WARNING: Gilt Ladder is running on the SAMPLE gilt universe - see gilt-ladder/config/gilts.js');
  }
  getCurve().catch((err) => console.warn(`Gilt Ladder initial curve fetch failed: ${err.message}`));
}

module.exports = { MOUNT, owns, handle, start, validateRequest, universeStaleness };
