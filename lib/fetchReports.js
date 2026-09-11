const watchlist = require('../config/watchlist');
const cacheStore = require('./cacheStore');

// Confirmed by capturing the real browser request/response from
// data.fca.org.uk's National Storage Mechanism (NSM) search page - this is
// an undocumented, reverse-engineered endpoint (no public API docs, no key),
// so it could change or start blocking non-browser traffic without notice.
// No API key needed, and critically, company_lei actually filters
// server-side (confirmed: every hit for a given LEI is that one company).
// That means one request per watched company is enough - no multi-page
// pagination workaround needed.
const NSM_SEARCH_URL = 'https://api.data.fca.org.uk/search?index=nsm-search';
const NSM_ARTEFACT_BASE = 'https://data.fca.org.uk/artefacts/';

const DEFAULT_WINDOW_DAYS = 7;

// Scales with the requested window since the real capture showed roughly
// 1-2 filings/day for one company - 15/day gives comfortable headroom for a
// busier issuer, capped so a long window can't request an enormous page.
const RESULTS_PER_DAY_ESTIMATE = 15;
const MAX_RESULTS_PER_COMPANY = 1000;

function resultsPerCompany(windowDays) {
  return Math.min(MAX_RESULTS_PER_COMPANY, Math.max(100, windowDays * RESULTS_PER_DAY_ESTIMATE));
}

// Confirmed exact values of the `type` field for the two report kinds we
// care about (e.g. the 08/09/2026 Fidelity European Trust filing came back
// with "type": "Half-year Financial Report", "type_code": "IR"). This is an
// exact match against a real confirmed value, not a keyword-substring
// guess.
const REPORT_TYPES = new Set(['Half-year Financial Report', 'Annual Financial Report']);

// Standard LEI (ISO 17442) format: 20 alphanumeric characters.
const LEI_RE = /^[A-Z0-9]{20}$/;

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

function parseWindowDays(days) {
  const n = parseInt(days, 10);
  if (Number.isNaN(n)) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.max(n, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
}

// Accepts a comma-separated string or array of category names to match
// against the response's `type` field (case-insensitive, exact match - the
// confirmed real values are things like "Half-year Financial Report" and
// "Net Asset Value(s)"). Falls back to REPORT_TYPES when nothing usable is
// given, so an empty/malformed value doesn't silently return everything.
// Returns both the original-cased list (for display) and a lowercased set
// (for matching).
function parseCategories(categories) {
  const raw = Array.isArray(categories) ? categories : String(categories || '').split(',');
  const cleaned = raw.map((s) => String(s).trim()).filter(Boolean);
  const list = cleaned.length ? cleaned : [...REPORT_TYPES];
  return { list, set: new Set(list.map((s) => s.toLowerCase())) };
}

// Mimics a browser request in case the server enforces Origin/Referer
// server-side as informal bot filtering (CORS itself is browser-enforced
// only and doesn't apply to a server-to-server request, but we can't
// confirm from here whether there's an additional check behind it).
const BROWSER_LIKE_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/plain, */*',
  origin: 'https://data.fca.org.uk',
  referer: 'https://data.fca.org.uk/',
  'user-agent': 'Mozilla/5.0 (compatible; rns-update/1.0)',
};

function parseLeis(leis) {
  const raw = Array.isArray(leis) ? leis : String(leis || '').split(',');
  const cleaned = raw.map((s) => String(s).trim().toUpperCase()).filter((s) => LEI_RE.test(s));
  return [...new Set(cleaned)];
}

// Matches the exact timestamp format seen in a real captured request
// (no fractional seconds - JS's default toISOString() includes
// milliseconds, which this API's date parsing may not accept; a live
// request with a millisecond-bearing "to" returned a 404 "Unable to search
// the data", so this strips them to match the one shape known to work).
function toIsoNoMillis(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function dateCutoff(windowDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - windowDays);
  return d;
}

function documentUrlOf(item) {
  return item.download_link ? `${NSM_ARTEFACT_BASE}${item.download_link}` : item.html_link || null;
}

function normalise(item) {
  const watched = watchlist.find((c) => c.lei === item.lei);
  return {
    lei: item.lei || null,
    company: (watched && watched.name) || item.company || item.lei,
    title: item.headline || item.type || '(untitled)',
    category: item.type || null,
    publishedAt: item.publication_date || item.document_date || item.submitted_date || null,
    url: documentUrlOf(item),
    id: item.disclosure_id || item._id || null,
    raw: item,
  };
}

// One request per watched company. This mirrors a real captured browser
// request as closely as possible - including `from: null` on both
// dateCriteria entries - rather than supplying our own lower bound, since
// this is an undocumented API and deviating from the one known-working
// shape is exactly what caused a live 404 (see toIsoNoMillis above). The
// last-N-days window is instead enforced afterwards, client-side, using the
// dates already present on each returned item (sorted newest-first, so a
// week's worth is always within the first `size` results for a normal
// filing volume). company_lei's value array format (["", "<LEI>",
// "disclose_org", "related_org"]) was also captured verbatim - the leading
// empty string and the two flag strings are unexplained in any docs (there
// are none), so they're kept exactly as observed rather than guessed at.
function buildRequestBody(lei, toIso, size) {
  return {
    from: 0,
    size,
    sort: 'submitted_date',
    sortorder: 'desc',
    criteriaObj: {
      criteria: [
        { name: 'company_lei', value: ['', lei, 'disclose_org', 'related_org'] },
        { name: 'latest_flag', value: 'Y' },
      ],
      dateCriteria: [
        { name: 'publication_date', value: { from: null, to: toIso } },
        { name: 'submitted_date', value: { from: null, to: toIso } },
      ],
    },
  };
}

async function fetchForLei(lei, toIso, size) {
  let response;
  try {
    response = await fetch(NSM_SEARCH_URL, {
      method: 'POST',
      headers: BROWSER_LIKE_HEADERS,
      body: JSON.stringify(buildRequestBody(lei, toIso, size)),
    });
  } catch (err) {
    return { lei, error: `Failed to reach the NSM search API: ${err}` };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    return { lei, error: `NSM search API returned ${response.status}`, details: details.slice(0, 2000) };
  }

  const data = await response.json();
  const hits = data.hits && Array.isArray(data.hits.hits) ? data.hits.hits : [];
  return { lei, items: hits.map((h) => h._source).filter(Boolean) };
}

// Caches each company's raw NSM results for CACHE_TTL_MS, keyed by LEI - a
// refresh (or another visitor) within the TTL reuses the cached items
// instead of hitting NSM again, cutting request volume for a personal
// watchlist that gets checked repeatedly through the day. Keyed only by
// LEI, not by the requested window/categories, because the day window and
// category filters are both applied afterwards in fetchReports() against
// the same raw item list - so a cache entry fetched with a large enough
// `size` already covers a smaller, later request for the same LEI. A
// request asking for a bigger `size` than what's cached (e.g. someone
// widens the time period) is treated as a miss and re-fetched.
//
// Backed by Postgres (lib/cacheStore.js) when DATABASE_URL is set, so the
// cache survives a Render free-tier web service spinning down and cold-
// starting again - without persistence, a cold start wipes the cache and
// re-hits NSM for every watched company at once. With no DATABASE_URL, this
// falls back to the original in-memory Map - zero setup required, same as
// before. Either way this only helps within one deployment's process/DB:
// still largely ineffective on Vercel's serverless functions without a
// DATABASE_URL, since each invocation can start fresh with no shared memory.
const parsedCacheTtlMinutes = parseInt(process.env.NSM_CACHE_TTL_MINUTES, 10);
// Explicit 0 disables caching (every request is a miss); anything else
// invalid/unset falls back to the 10-minute default. `|| 10` would have
// silently turned an explicit 0 back into 10, since 0 is falsy in JS.
const CACHE_TTL_MINUTES = Number.isNaN(parsedCacheTtlMinutes) ? 10 : parsedCacheTtlMinutes;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;
const nsmCache = new Map(); // lei -> { items, size, fetchedAt } - used only when cacheStore is disabled

function isFresh(cached, size) {
  return cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.size >= size;
}

async function fetchForLeiCached(lei, toIso, size) {
  if (cacheStore.enabled) {
    try {
      const cached = await cacheStore.getCached(lei);
      if (isFresh(cached, size)) return { lei, items: cached.items, cached: true };
    } catch (err) {
      // A DB hiccup shouldn't take down report loading - fall through to a
      // fresh NSM fetch as if this were a cache miss.
      console.error(`nsm_cache read failed for ${lei}:`, err.message || err);
    }
  } else if (isFresh(nsmCache.get(lei), size)) {
    return { lei, items: nsmCache.get(lei).items, cached: true };
  }

  const result = await fetchForLei(lei, toIso, size);
  if (!result.error) {
    if (cacheStore.enabled) {
      try {
        await cacheStore.setCached(lei, result.items, size);
      } catch (err) {
        console.error(`nsm_cache write failed for ${lei}:`, err.message || err);
      }
    } else {
      nsmCache.set(lei, { items: result.items, size, fetchedAt: Date.now() });
    }
  }
  return result;
}

async function fetchReports({ leis, days, categories } = {}) {
  const requestedLeis = parseLeis(leis);
  const effectiveLeis = requestedLeis.length ? requestedLeis : watchlist.map((c) => c.lei).filter(Boolean);

  if (effectiveLeis.length === 0) {
    return { status: 200, body: { leis: [], scanned: 0, count: 0, reports: [] } };
  }

  const windowDays = parseWindowDays(days);
  const { list: categoryList, set: categorySet } = parseCategories(categories);
  const cutoff = dateCutoff(windowDays);
  const toIso = toIsoNoMillis(new Date());
  const size = resultsPerCompany(windowDays);

  const results = await Promise.all(effectiveLeis.map((lei) => fetchForLeiCached(lei, toIso, size)));

  const failed = results.filter((r) => r.error);
  if (failed.length === results.length) {
    // Every company's request failed - surface it as a hard error rather
    // than silently returning an empty report list.
    return { status: 502, body: { error: 'NSM search API request failed for every company.', details: failed } };
  }

  const itemDate = (item) => {
    const raw = item.publication_date || item.document_date || item.submitted_date;
    return raw ? new Date(raw) : null;
  };

  const matchesCategory = (item) => typeof item.type === 'string' && categorySet.has(item.type.toLowerCase());

  const allItems = results.flatMap((r) => r.items || []);
  const withinWindow = allItems.filter((item) => {
    const d = itemDate(item);
    return d && !Number.isNaN(d.getTime()) && d >= cutoff;
  });
  const reports = withinWindow.filter(matchesCategory).map(normalise);

  const scannedItems = withinWindow.map((item) => ({
    lei: item.lei,
    company: item.company,
    headline: item.headline,
    type: item.type,
    url: documentUrlOf(item),
    publishedAt: item.publication_date || item.document_date || null,
    matchedReportType: matchesCategory(item),
  }));

  const cachedLeis = results.filter((r) => r.cached).map((r) => r.lei);

  return {
    status: 200,
    body: {
      leis: effectiveLeis,
      dateFrom: cutoff.toISOString(),
      days: windowDays,
      categories: categoryList,
      scanned: withinWindow.length,
      count: reports.length,
      reports,
      scannedItems,
      failedLeis: failed.length ? failed : undefined,
      cachedLeis: cachedLeis.length ? cachedLeis : undefined,
    },
  };
}

// Used by /api/notify to authoritatively re-derive a report's content
// server-side instead of trusting whatever the client's POST body claims
// (see lib/sendNotification.js) - refetches the real NSM items for `lei`
// and returns the one matching `id` (disclosure_id/_id), or, for the
// handful of items with no id, a title+publishedAt match (same fields
// reportKey() in app.js falls back to client-side). Returns null on no
// match, so the caller can only ever send an email built from a filing NSM
// actually returned - never attacker-authored text or an attacker-chosen
// attachment URL.
async function findReport({ lei, id, title, publishedAt }) {
  const [cleanLei] = parseLeis(lei);
  if (!cleanLei) return null;

  const toIso = toIsoNoMillis(new Date());
  const size = resultsPerCompany(MAX_WINDOW_DAYS);
  const result = await fetchForLeiCached(cleanLei, toIso, size);
  if (result.error) return null;

  const match = (result.items || []).find((item) => {
    const n = normalise(item);
    if (n.id) return id != null && String(n.id) === String(id);
    return id == null && title === n.title && publishedAt === n.publishedAt;
  });

  return match ? normalise(match) : null;
}

module.exports = { fetchReports, findReport, parseLeis, parseWindowDays, parseCategories, LEI_RE, MAX_WINDOW_DAYS };
