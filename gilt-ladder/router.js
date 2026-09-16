// Gilt Ladder, mounted inside the RNS server at MOUNT. Serves its own static
// frontend and a small JSON API from under that prefix; authentication is
// the host server's job (server.js checks Basic Auth before routing here).
const fs = require('fs');
const path = require('path');

const { getCurve } = require('./lib/curveStore');
const { load: loadUniverse, activeAt, ISIN_RE } = require('./lib/universe');
const { buildLadder, DEFAULTS } = require('./lib/ladder');
const { toISO, addBusinessDays } = require('./lib/calendar');
const { expandedLength, validateRepeat, validateEscalation } = require('./lib/liabilities');
const { sealPlan, openPlan, normalizePlan } = require('./lib/planToken');
const planStore = require('./lib/planStore');
const { runRecosting, DEFAULT_THRESHOLD_PERCENT, DEFAULT_HOUR_UTC } = require('./lib/recost');
const { dealingListCsv, cashflowsCsv, calendarIcs } = require('./lib/exports');
const { runScenarios } = require('./lib/scenarios');

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
    // A series is counted before it is expanded, so an over-large request is
    // refused without first building the list it asked for.
  } else if (expandedLength(body.liabilities) > MAX_LIABILITIES) {
    problems.push(`at most ${MAX_LIABILITIES} liabilities once repeats are expanded`);
  } else {
    body.liabilities.forEach((l, i) => {
      if (!l || !/^\d{4}-\d{2}-\d{2}$/.test(String(l.date))) problems.push(`liability ${i + 1}: invalid date`);
      if (!(Number(l.amount) > 0)) problems.push(`liability ${i + 1}: amount must be positive`);
      problems.push(...validateRepeat(l && l.repeat, `liability ${i + 1}`));
      problems.push(...validateEscalation(l && l.escalation, `liability ${i + 1}`));
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

  if (body.otherIncome != null && !(Number(body.otherIncome) >= 0)) {
    problems.push('otherIncome must be zero or positive');
  }

  if (body.reinvestment != null && !['none', 'forward'].includes(body.reinvestment)) {
    problems.push("reinvestment must be 'none' or 'forward'");
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
      otherIncome: body.otherIncome == null ? null : Number(body.otherIncome),
      reinvestment: body.reinvestment == null ? DEFAULTS.reinvestment : body.reinvestment,
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

// What a move in rates would do to the cost of funding a plan, and what it has
// already done this month.
//
// Every scenario is the same buildLadder against a transformed curve rather
// than a duration approximation, which is the point: an approximation cannot
// show the ladder re-selecting different gilts, and rounding up to whole lots
// is not linear in anything.
async function handleScenarios(req, res) {
  const parsed = await readPlanBody(req, res);
  if (!parsed) return;

  let curveEntry;
  try {
    curveEntry = await getCurve();
  } catch (err) {
    sendJson(res, 503, { error: 'no yield curve available', details: err.message });
    return;
  }

  const build = (curve) => {
    const settlement = toISO(addBusinessDays(curve.date, DEFAULTS.settlementBusinessDays));
    return buildLadder({
      ...parsed.plan,
      settlement,
      curve,
      universe: activeAt(universe, settlement),
    });
  };

  let scenarios;
  try {
    scenarios = runScenarios(curveEntry.curve, build);
  } catch (err) {
    sendJson(res, 400, { error: 'could not build ladder', details: err.message });
    return;
  }

  // The BoE workbook carries one curve per business day of the current month
  // and the application used to keep only the last. Costing the plan against
  // each of them answers "how has this moved this month" with no extra data.
  const history = [];
  for (const curve of curveEntry.history || []) {
    try {
      const result = build(curve);
      history.push({ date: curve.date, cost: result.totals.cost, fullyFunded: result.fullyFunded });
    } catch {
      // A curve the plan cannot be built against is left out of the series
      // rather than breaking it - an early-month curve may predate a gilt.
    }
  }

  sendJson(res, 200, {
    ...scenarios,
    curveDate: curveEntry.curve.date,
    monthToDate: history,
    provenance: {
      priceBasis: 'derived from the Bank of England nominal gilt spot curve, shifted',
      indicative: true,
    },
  });
}

const sendFile = (res, status, contentType, filename, body) => {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    // `attachment` for the spreadsheets, since they are files to keep;
    // `inline` for the calendar, which a subscribing client reads in place.
    'Content-Disposition': `${contentType.startsWith('text/calendar') ? 'inline' : 'attachment'}; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

// Exports are built from a freshly-costed ladder rather than from whatever the
// page happens to be showing, so a file can never disagree with the plan it
// claims to be an export of.
//
// The calendar accepts a sealed plan token in `t` as well as a POST body: a
// calendar application subscribes by URL and cannot post anything.
async function handleExport(req, res, subPath, url) {
  let plan;

  if (req.method === 'GET') {
    const opened = openPlan(url.searchParams.get('t'));
    if (opened.error) {
      sendJson(res, opened.status, { error: opened.error });
      return;
    }
    plan = opened.plan;
  } else if (req.method === 'POST') {
    const parsed = await readPlanBody(req, res);
    if (!parsed) return;
    plan = parsed.plan;
  } else {
    sendJson(res, 405, { error: 'method not allowed' });
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
  let result;
  try {
    result = buildLadder({
      ...plan,
      settlement,
      curve: curveEntry.curve,
      universe: activeAt(universe, settlement),
    });
  } catch (err) {
    sendJson(res, 400, { error: 'could not build ladder', details: err.message });
    return;
  }

  if (subPath === '/api/export/dealing-list.csv') {
    sendFile(res, 200, 'text/csv; charset=utf-8', 'gilt-dealing-list.csv', dealingListCsv(result));
    return;
  }
  if (subPath === '/api/export/cashflows.csv') {
    sendFile(res, 200, 'text/csv; charset=utf-8', 'gilt-cashflows.csv', cashflowsCsv(result));
    return;
  }
  if (subPath === '/api/export/calendar.ics') {
    sendFile(res, 200, 'text/calendar; charset=utf-8', 'gilt-ladder.ics', calendarIcs(result));
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// A plan is only ever stored or sealed after it has passed exactly the same
// validation a build request does. A token is authenticated, which proves this
// server sealed it - not that what it sealed is still a plan this version is
// willing to run.
async function readPlanBody(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { error: 'invalid JSON body', details: err.message });
    return null;
  }

  const plan = normalizePlan(body.plan == null ? body : body.plan);
  const problems = validateRequest(plan);
  if (problems.length) {
    sendJson(res, 400, { error: 'invalid plan', details: problems });
    return null;
  }
  return { plan, label: body.label, id: body.id };
}

// Saved plans need a database; shareable links do not. Keeping them on
// separate routes means a deployment with no DATABASE_URL still shares plans
// rather than losing the feature wholesale.
async function handlePlans(req, res, subPath, url) {
  if (req.method === 'POST' && subPath === '/api/plan/share') {
    const parsed = await readPlanBody(req, res);
    if (!parsed) return;
    const { token, status, error } = sealPlan(parsed.plan);
    if (error) {
      sendJson(res, status, { error });
      return;
    }
    sendJson(res, 200, { token, path: `${MOUNT}/?plan=${token}` });
    return;
  }

  if (req.method === 'GET' && subPath === '/api/plan') {
    const { plan, status, error } = openPlan(url.searchParams.get('t'));
    if (error) {
      sendJson(res, status, { error });
      return;
    }
    sendJson(res, 200, { plan });
    return;
  }

  if (!planStore.enabled) {
    sendJson(res, 501, {
      error: "Saving plans isn't enabled on this deployment (DATABASE_URL isn't set). Use a shareable link instead.",
    });
    return;
  }

  const id = subPath.startsWith('/api/plans/') ? decodeURIComponent(subPath.slice('/api/plans/'.length)) : null;

  if (req.method === 'GET' && subPath === '/api/plans') {
    sendJson(res, 200, { plans: await planStore.list() });
    return;
  }

  if (req.method === 'POST' && subPath === '/api/plans') {
    const parsed = await readPlanBody(req, res);
    if (!parsed) return;
    try {
      sendJson(res, 200, { plan: await planStore.save(parsed) });
    } catch (err) {
      sendJson(res, 409, { error: err.message });
    }
    return;
  }

  if (id && req.method === 'GET') {
    const record = await planStore.get(id);
    sendJson(res, record ? 200 : 404, record ? { plan: record } : { error: 'no such plan' });
    return;
  }

  // Watching is toggled on its own route rather than through save(), so
  // ticking a box in a list cannot overwrite the plan with whatever the form
  // happened to hold.
  if (id && req.method === 'PATCH') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { error: 'invalid JSON body', details: err.message });
      return;
    }
    const record = await planStore.setAlerts(id, body.alertsEnabled);
    sendJson(res, record ? 200 : 404, record ? { plan: record } : { error: 'no such plan' });
    return;
  }

  if (id && req.method === 'DELETE') {
    const removed = await planStore.remove(id);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such plan' });
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
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

    if (req.method === 'POST' && subPath === '/api/scenarios') {
      await handleScenarios(req, res);
      return;
    }

    if (subPath.startsWith('/api/export/')) {
      await handleExport(req, res, subPath, url);
      return;
    }

    if (subPath.startsWith('/api/plan')) {
      await handlePlans(req, res, subPath, url);
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

// Costs a stored plan against the current curve. Only the total is wanted, but
// it comes from the same buildLadder every interactive request uses - a
// separate "quick" costing would be a second implementation to keep in step.
async function costPlan(plan) {
  const curveEntry = await getCurve();
  const settlement = toISO(addBusinessDays(curveEntry.curve.date, DEFAULTS.settlementBusinessDays));
  const result = buildLadder({
    ...plan,
    settlement,
    curve: curveEntry.curve,
    universe: activeAt(universe, settlement),
  });
  return {
    cost: result.totals.cost,
    fullyFunded: result.fullyFunded,
    curveDate: result.curveDate,
  };
}

// Re-costing runs on the host's interval, and the host supplies the transport:
// the Gilt Ladder requires no RNS code, so it states the policy and is handed
// the means to act on it. `send` is whatever the composition root wires in.
function checkRecosting({ send, thresholdPercent, hourUtc } = {}) {
  if (universeError || !planStore.enabled) return Promise.resolve(null);
  return runRecosting({
    store: planStore,
    costPlan,
    send,
    thresholdPercent: thresholdPercent == null ? DEFAULT_THRESHOLD_PERCENT : thresholdPercent,
    hourUtc: hourUtc == null ? DEFAULT_HOUR_UTC : hourUtc,
  }).catch((err) => {
    console.warn(`Gilt Ladder re-costing failed: ${err.message}`);
    return null;
  });
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

module.exports = { MOUNT, owns, handle, start, checkRecosting, costPlan, validateRequest, universeStaleness };
