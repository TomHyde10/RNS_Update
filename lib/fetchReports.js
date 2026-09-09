const watchlist = require('../config/watchlist');

// Confirmed from the user-supplied example:
//   curl -H "X-Api-Key: <key>" https://api.tickerapp.net/v2/disclosures/sources/rns/items?pageSize=1
// Everything else about the response shape below is a best-effort guess —
// developers.ticker.app was unreachable from the build environment (network
// egress policy), so field names couldn't be confirmed against the real
// docs. Use the "raw JSON" debug panel on the page to see what the API
// actually returns and adjust the field lookups below if needed.
const RNS_ITEMS_ENDPOINT = 'https://api.tickerapp.net/v2/disclosures/sources/rns/items';

// Matched case-insensitively against whatever title/category-like fields an
// item has, to recognise "financial report" style disclosures among all RNS
// announcements (results, trading updates, etc. all come through the same
// feed).
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
  'financial report',
];

function textOf(item) {
  return [item.title, item.headline, item.category, item.type, item.subtype]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isFinancialReport(item) {
  const text = textOf(item);
  return FINANCIAL_REPORT_KEYWORDS.some((kw) => text.includes(kw));
}

function isinOf(item) {
  return item.isin || item.issuer?.isin || item.company?.isin || null;
}

function normalise(item) {
  const isin = isinOf(item);
  const watched = watchlist.find((c) => c.isin === isin);
  return {
    isin,
    company: (watched && watched.name) || (item.issuer && item.issuer.name) || (item.company && item.company.name) || isin,
    title: item.title || item.headline || '(untitled)',
    category: item.category || item.type || null,
    publishedAt: item.publishedAt || item.date || item.releasedAt || null,
    url: item.url || item.link || item.documentUrl || null,
    raw: item,
  };
}

async function fetchReports({ pageSize } = {}) {
  const apiKey = process.env.TICKER_API_KEY;
  if (!apiKey) {
    return { status: 500, body: { error: 'TICKER_API_KEY is not configured on the server.' } };
  }

  const size = Math.min(Math.max(parseInt(pageSize, 10) || 200, 1), 500);
  const requestUrl = `${RNS_ITEMS_ENDPOINT}?pageSize=${size}`;

  let response;
  try {
    response = await fetch(requestUrl, { headers: { 'X-Api-Key': apiKey } });
  } catch (err) {
    return { status: 502, body: { error: 'Failed to reach Ticker API', details: String(err) } };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    return {
      status: response.status,
      body: { error: `Ticker API returned ${response.status}`, details: details.slice(0, 2000) },
    };
  }

  const data = await response.json();
  const items = Array.isArray(data) ? data : data.items || data.data || data.results || [];

  const watchedIsins = new Set(watchlist.map((c) => c.isin));
  const reports = items
    .filter((item) => watchedIsins.has(isinOf(item)) && isFinancialReport(item))
    .map(normalise);

  return {
    status: 200,
    body: { watchlist, scanned: items.length, count: reports.length, reports },
  };
}

module.exports = { fetchReports };
