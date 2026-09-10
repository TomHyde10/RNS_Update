const watchlist = require('../config/watchlist');

// Confirmed against the real Ticker API reference (https://developers.ticker.app/api-reference):
//   GET https://api.tickerapp.net/v2/disclosures/sources/rns/items
//   x-api-key: <key>
// Response envelope: { data: [...items], meta: { paging: { pageSize, nextCursor, latestCursor } } }
const BASE_URL = 'https://api.tickerapp.net/v2';
const RNS_ITEMS_ENDPOINT = `${BASE_URL}/disclosures/sources/rns/items`;

const DEFAULT_WINDOW_DAYS = 7;

// Matched case-insensitively against an item's headline and category names to
// recognise half-year and annual report disclosures specifically (not the
// wider RNS feed, which also carries trading updates, director dealings,
// AGM notices, etc.). "Final results" / "preliminary results" are included
// because UK issuers commonly announce annual results under those RNS
// category names before the full Annual Report & Accounts follows. The
// Ticker/FCA category *codes* aren't matched directly because their exact
// meanings aren't confirmed by the docs excerpt available — matching on the
// human-readable category name and headline text is more robust than
// guessing at code semantics.
const REPORT_KEYWORDS = [
  'annual report',
  'annual financial report',
  'annual results',
  'final results',
  'preliminary results',
  'half-year',
  'half year',
  'half yearly',
  'interim results',
  'interim report',
];

const ISIN_RE = /^[A-Z0-9]{12}$/;

function categoryNames(item) {
  return Array.isArray(item.category) ? item.category.map((c) => c && c.name).filter(Boolean) : [];
}

function textOf(item) {
  return [item.headline, ...categoryNames(item)].filter(Boolean).join(' ').toLowerCase();
}

function isHalfYearOrAnnualReport(item) {
  const text = textOf(item);
  return REPORT_KEYWORDS.some((kw) => text.includes(kw));
}

function isinOf(item) {
  return (item.issuer && item.issuer.instrument && item.issuer.instrument.isin) || null;
}

function symbolOf(item) {
  return (item.issuer && item.issuer.instrument && item.issuer.instrument.symbol && item.issuer.instrument.symbol.mnemonic) || null;
}

// The "publication" array's item shape isn't specified in the docs excerpt
// available (shown only as `[...]`) — this defensively tries the field names
// most such APIs use. Check the "Raw JSON" debug panel once real data comes
// back and adjust if the guess is wrong.
function documentUrlOf(item) {
  const pub = Array.isArray(item.publication) && item.publication.length ? item.publication[0] : null;
  if (!pub) return null;
  if (typeof pub === 'string') return pub;
  return pub.url || pub.link || pub.href || pub.documentUrl || null;
}

function normalise(item) {
  const isin = isinOf(item);
  const watched = watchlist.find((c) => c.isin === isin);
  return {
    isin,
    symbol: symbolOf(item),
    company: (watched && watched.name) || (item.issuer && item.issuer.name) || isin,
    title: item.headline || '(untitled)',
    category: categoryNames(item).join(', ') || null,
    publishedAt: item.timestamp || null,
    url: documentUrlOf(item),
    rnsId: item.rnsId || null,
    raw: item,
  };
}

// Accepts an array, a comma-separated string, or repeated values already
// split by the caller; normalises to a deduped list of upper-cased ISINs.
// Silently drops anything that doesn't look like an ISIN (2 letters + 9
// alphanumeric + 1 check digit) rather than erroring, so one typo in a
// user-managed list doesn't break the whole request.
function parseIsins(isins) {
  const raw = Array.isArray(isins) ? isins : String(isins || '').split(',');
  const cleaned = raw.map((s) => String(s).trim().toUpperCase()).filter((s) => ISIN_RE.test(s));
  return [...new Set(cleaned)];
}

function defaultDateFrom() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - DEFAULT_WINDOW_DAYS);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry(url, headers, retriesLeft = 1) {
  const response = await fetch(url, { headers });

  if (response.status === 429 && retriesLeft > 0) {
    // Could be the per-second throttle (recoverable) or the weekly quota
    // (won't clear until reset) - a Retry-After header suggests the former,
    // so back off once and retry; otherwise fail fast rather than spin.
    const retryAfterHeader = response.headers.get('retry-after');
    if (retryAfterHeader) {
      const retryAfterMs = parseInt(retryAfterHeader, 10) * 1000;
      await sleep(Number.isNaN(retryAfterMs) ? 2000 : retryAfterMs);
      return requestWithRetry(url, headers, retriesLeft - 1);
    }
  }

  return response;
}

async function fetchReports({ isins, pageSize, dateFrom } = {}) {
  const apiKey = process.env.TICKER_API_KEY;
  if (!apiKey) {
    return { status: 500, body: { error: 'TICKER_API_KEY is not configured on the server.' } };
  }

  const requestedIsins = parseIsins(isins);
  const effectiveIsins = requestedIsins.length ? requestedIsins : watchlist.map((c) => c.isin).filter(Boolean);

  if (effectiveIsins.length === 0) {
    return { status: 200, body: { isins: [], scanned: 0, count: 0, reports: [] } };
  }

  // pageSize is capped per-plan at 50/100/200 - clamp to the widest common
  // tier and let the API itself reject/clamp further if the plan is smaller.
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const from = dateFrom || defaultDateFrom();

  // The docs list two equivalent forms for this filter - repeated singular
  // `isin=A&isin=B` and comma-separated plural `isins=A,B`. Send both, since
  // we have no way to confirm from here which one the live API actually
  // honours; harmless if only one is recognised.
  const params = new URLSearchParams();
  effectiveIsins.forEach((isin) => params.append('isin', isin));
  params.set('isins', effectiveIsins.join(','));
  params.set('pageSize', String(size));
  params.set('dateFrom', from);
  const requestUrl = `${RNS_ITEMS_ENDPOINT}?${params.toString()}`;

  let response;
  try {
    response = await requestWithRetry(requestUrl, { 'x-api-key': apiKey });
  } catch (err) {
    return { status: 502, body: { error: 'Failed to reach Ticker API', details: String(err) } };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    if (response.status === 429) {
      return {
        status: 429,
        body: {
          error: 'Ticker API rate limit hit (per-second throttle or weekly quota).',
          details: details.slice(0, 2000),
        },
      };
    }
    return {
      status: response.status,
      body: { error: `Ticker API returned ${response.status}`, details: details.slice(0, 2000) },
    };
  }

  const data = await response.json();
  const items = Array.isArray(data.data) ? data.data : [];

  // Belt-and-braces: don't rely solely on the server having applied the
  // isin/isins query filter - re-check each item's ISIN against the
  // requested list here too, so a server-side filter that's ignored or
  // behaves differently than documented can't leak unrelated issuers'
  // disclosures into the results.
  const isinSet = new Set(effectiveIsins);
  const reports = items
    .filter((item) => isinSet.has(isinOf(item)))
    .filter(isHalfYearOrAnnualReport)
    .map(normalise);

  // Diagnostic view of every item Ticker returned for this request, before
  // any filtering - lets the UI show *why* an expected disclosure is
  // missing (not returned by Ticker at all vs. returned but not matching
  // REPORT_KEYWORDS) instead of just an empty list.
  const scannedItems = items.map((item) => ({
    isin: isinOf(item),
    headline: item.headline || null,
    category: categoryNames(item),
    timestamp: item.timestamp || null,
    matchedIsin: isinSet.has(isinOf(item)),
    matchedReportType: isHalfYearOrAnnualReport(item),
  }));

  return {
    status: 200,
    body: {
      isins: effectiveIsins,
      dateFrom: from,
      scanned: items.length,
      count: reports.length,
      reports,
      scannedItems,
      paging: data.meta && data.meta.paging ? data.meta.paging : null,
    },
  };
}

module.exports = { fetchReports, parseIsins, ISIN_RE };
