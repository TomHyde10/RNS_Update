const watchlist = require('../config/watchlist');

// Confirmed against the real Ticker API reference (https://developers.ticker.app/api-reference):
//   GET https://api.tickerapp.net/v2/disclosures/sources/rns/items
//   x-api-key: <key>
// Response envelope: { data: [...items], meta: { paging: { pageSize, nextCursor, latestCursor } } }
const BASE_URL = 'https://api.tickerapp.net/v2';
const RNS_ITEMS_ENDPOINT = `${BASE_URL}/disclosures/sources/rns/items`;

// Matched case-insensitively against an item's headline and category names to
// recognise "financial report" style disclosures (results, trading updates,
// etc.) among the general RNS feed. The Ticker/FCA category *codes* aren't
// matched directly here because their exact meanings aren't confirmed by the
// docs excerpt available — matching on the human-readable category name and
// headline text is more robust than guessing at code semantics.
const FINANCIAL_REPORT_KEYWORDS = [
  'annual report',
  'annual financial report',
  'final results',
  'interim results',
  'interim report',
  'half-year',
  'half year results',
  'preliminary results',
  'trading statement',
  'trading update',
  'financial report',
];

function categoryNames(item) {
  return Array.isArray(item.category) ? item.category.map((c) => c && c.name).filter(Boolean) : [];
}

function textOf(item) {
  return [item.headline, ...categoryNames(item)].filter(Boolean).join(' ').toLowerCase();
}

function isFinancialReport(item) {
  const text = textOf(item);
  return FINANCIAL_REPORT_KEYWORDS.some((kw) => text.includes(kw));
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
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 2000;
    if (retryAfterHeader) {
      await sleep(Number.isNaN(retryAfterMs) ? 2000 : retryAfterMs);
      return requestWithRetry(url, headers, retriesLeft - 1);
    }
  }

  return response;
}

async function fetchReports({ pageSize } = {}) {
  const apiKey = process.env.TICKER_API_KEY;
  if (!apiKey) {
    return { status: 500, body: { error: 'TICKER_API_KEY is not configured on the server.' } };
  }

  const watchedIsins = watchlist.map((c) => c.isin).filter(Boolean);
  if (watchedIsins.length === 0) {
    return { status: 200, body: { watchlist, scanned: 0, count: 0, reports: [] } };
  }

  // pageSize is capped per-plan at 50/100/200 - clamp to the widest common
  // tier and let the API itself reject/clamp further if the plan is smaller.
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);

  const params = new URLSearchParams({
    isins: watchedIsins.join(','),
    pageSize: String(size),
  });
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

  const reports = items.filter(isFinancialReport).map(normalise);

  return {
    status: 200,
    body: {
      watchlist,
      scanned: items.length,
      count: reports.length,
      reports,
      paging: data.meta && data.meta.paging ? data.meta.paging : null,
    },
  };
}

module.exports = { fetchReports };
