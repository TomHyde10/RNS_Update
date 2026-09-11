// Unit tests for lib/fetchReports.js's NSM caching logic - in particular
// the "delta fetch" behaviour added so a stale-but-present cache only asks
// NSM for what's new since it was last refreshed, instead of re-fetching
// everything every time the Refresh button is clicked (or the TTL simply
// expires). mergeItems()/itemKey()/catchUpSize() are pure and tested
// directly; fetchForLeiCached()'s actual decision-making (full fetch vs.
// cache hit vs. delta fetch) is exercised end-to-end through fetchReports()
// with global.fetch mocked, so no real network/NSM/Postgres dependency.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { mergeItems, itemKey, catchUpSize } = require('../lib/fetchReports');

describe('itemKey', () => {
  it('prefers disclosure_id when present', () => {
    assert.equal(itemKey({ disclosure_id: 'd1', _id: 'x1' }), 'd1');
  });

  it('falls back to _id when there is no disclosure_id', () => {
    assert.equal(itemKey({ _id: 'x1' }), 'x1');
  });

  it('falls back to a composite key when neither id is present', () => {
    const item = { lei: 'LEI1', type: 'NAV', publication_date: '2026-01-01', headline: 'H' };
    assert.equal(itemKey(item), 'LEI1|NAV|2026-01-01|H');
  });
});

describe('mergeItems', () => {
  it('keeps items only the old page knows about', () => {
    const old = [{ disclosure_id: '1', submitted_date: '2026-01-01T00:00:00Z' }];
    const merged = mergeItems(old, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].disclosure_id, '1');
  });

  it('adds items only the fresh page knows about', () => {
    const fresh = [{ disclosure_id: '2', submitted_date: '2026-01-02T00:00:00Z' }];
    const merged = mergeItems([], fresh);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].disclosure_id, '2');
  });

  it('the fresh copy wins on a collision (e.g. a republished filing)', () => {
    const old = [{ disclosure_id: '1', headline: 'Old headline', submitted_date: '2026-01-01T00:00:00Z' }];
    const fresh = [{ disclosure_id: '1', headline: 'Amended headline', submitted_date: '2026-01-01T00:00:00Z' }];
    const merged = mergeItems(old, fresh);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].headline, 'Amended headline');
  });

  it('sorts the merged result newest-first', () => {
    const old = [{ disclosure_id: '1', submitted_date: '2026-01-01T00:00:00Z' }];
    const fresh = [{ disclosure_id: '2', submitted_date: '2026-01-03T00:00:00Z' }];
    const merged = mergeItems(old, fresh);
    assert.deepEqual(merged.map((i) => i.disclosure_id), ['2', '1']);
  });
});

describe('catchUpSize', () => {
  it('floors at one day for a gap under 24h', () => {
    assert.equal(catchUpSize(60 * 1000), 100); // resultsPerCompany(1) = max(100, 15)
  });

  it('scales up with a longer gap', () => {
    assert.equal(catchUpSize(10 * 24 * 60 * 60 * 1000), 150); // resultsPerCompany(10) = max(100, 150)
  });

  it('is capped the same way resultsPerCompany caps a full fetch', () => {
    assert.equal(catchUpSize(200 * 24 * 60 * 60 * 1000), 1000); // resultsPerCompany(200) = min(1000, 3000)
  });
});

describe('fetchReports caching end-to-end (mocked NSM, in-memory cache)', () => {
  let fetchReports;
  const originalFetch = global.fetch;
  const originalTtl = process.env.NSM_CACHE_TTL_MINUTES;
  const originalDbUrl = process.env.DATABASE_URL;
  const LEI = 'AAAAAAAAAAAAAAAAAAAA';

  before(() => {
    // Forces the in-memory cache path (never touches Postgres). A whole
    // number of minutes, deliberately - NSM_CACHE_TTL_MINUTES is parsed
    // with parseInt(), which truncates "0.01" down to 0, not a fast TTL;
    // staleness is instead simulated below by advancing Date.now(), not by
    // shrinking the TTL. CACHE_TTL_MS is computed once at module load from
    // this env var, hence the require.cache reset.
    delete process.env.DATABASE_URL;
    process.env.NSM_CACHE_TTL_MINUTES = '1';
    delete require.cache[require.resolve('../lib/fetchReports')];
    ({ fetchReports } = require('../lib/fetchReports'));
  });

  after(() => {
    global.fetch = originalFetch;
    if (originalTtl === undefined) delete process.env.NSM_CACHE_TTL_MINUTES;
    else process.env.NSM_CACHE_TTL_MINUTES = originalTtl;
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    delete require.cache[require.resolve('../lib/fetchReports')];
  });

  function nsmItem(headline, id, when) {
    return {
      lei: LEI,
      company: 'Test Co',
      headline,
      type: 'Half-year Financial Report',
      disclosure_id: id,
      publication_date: when.toISOString(),
      submitted_date: when.toISOString(),
    };
  }

  it('a cold cache does one full-size fetch and caches the result', async () => {
    const now = new Date();
    let calls = 0;
    let capturedSize;
    global.fetch = async (url, opts) => {
      calls++;
      capturedSize = JSON.parse(opts.body).size;
      return { ok: true, json: async () => ({ hits: { hits: [{ _source: nsmItem('Old report', 'id-1', now) }] } }) };
    };

    const { status, body } = await fetchReports({ leis: LEI, days: 30, categories: 'Half-year Financial Report' });
    assert.equal(status, 200);
    assert.equal(calls, 1);
    assert.equal(capturedSize, 450); // resultsPerCompany(30) = max(100, 30*15)
    assert.equal(body.count, 1);
    assert.equal(body.cachedLeis, undefined);
    assert.equal(body.deltaLeis, undefined);
  });

  it('a fresh cache (within the TTL) is served with no NSM call at all', async () => {
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('must not hit NSM for a fresh cache'); };

    const { body } = await fetchReports({ leis: LEI, days: 30, categories: 'Half-year Financial Report' });
    assert.equal(calls, 0);
    assert.equal(body.count, 1);
    assert.deepEqual(body.cachedLeis, [LEI]);
  });

  it('a stale cache does a smaller delta fetch and merges it with what was already cached', async () => {
    // Simulates the TTL lapsing by moving Date.now() forward past it,
    // rather than actually waiting a minute in real time - fetchedAt was
    // itself recorded with Date.now(), so this is consistent with what a
    // real elapsed minute would look like to isFresh().
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 61 * 1000;

    try {
      const now = new Date();
      let calls = 0;
      let capturedSize;
      global.fetch = async (url, opts) => {
        calls++;
        capturedSize = JSON.parse(opts.body).size;
        return { ok: true, json: async () => ({ hits: { hits: [{ _source: nsmItem('New report', 'id-2', now) }] } }) };
      };

      const { body } = await fetchReports({ leis: LEI, days: 30, categories: 'Half-year Financial Report' });
      assert.equal(calls, 1, 'a delta refresh should still only take one NSM request per company');
      assert.ok(capturedSize < 450, `a delta fetch should ask for far fewer items than the original full fetch (got ${capturedSize})`);
      assert.deepEqual(body.deltaLeis, [LEI]);
      assert.equal(body.cachedLeis, undefined);

      // The old, still-good report must survive a delta merge alongside
      // the newly-fetched one - that's the whole point of not re-fetching it.
      const titles = body.reports.map((r) => r.title).sort();
      assert.deepEqual(titles, ['New report', 'Old report']);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('falls back to serving the stale cache as-is when the delta fetch itself fails', async () => {
    // Stale relative to the merged cache written by the previous test
    // (whose fetchedAt was itself faked to realDateNow() + 61s).
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 122 * 1000;

    try {
      global.fetch = async () => ({ ok: false, status: 503, text: async () => 'NSM unavailable' });

      const { body } = await fetchReports({ leis: LEI, days: 30, categories: 'Half-year Financial Report' });
      // Both reports from the last successful (delta-merged) cache should
      // still come back, rather than this company failing outright over a
      // refresh that was only ever meant to be a nice-to-have.
      const titles = body.reports.map((r) => r.title).sort();
      assert.deepEqual(titles, ['New report', 'Old report']);
      assert.deepEqual(body.cachedLeis, [LEI]);
      assert.equal(body.deltaLeis, undefined);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('a delta refresh triggered by a smaller window keeps the cache usable for the original wider one', async () => {
    // A separate LEI so this test doesn't depend on the cache state left
    // behind by the ones above.
    const LEI2 = 'BBBBBBBBBBBBBBBBBBBB';
    const realDateNow = Date.now;

    try {
      // 1) Cold, wide fetch (days=30 -> size 450).
      const now = new Date();
      global.fetch = async () => ({ ok: true, json: async () => ({ hits: { hits: [{ _source: nsmItem('Wide report', 'w-1', now) }] } }) });
      await fetchReports({ leis: LEI2, days: 30, categories: 'Half-year Financial Report' });

      // 2) Stale, then a narrower request (days=1 -> size 100) triggers a
      // delta refresh - this used to shrink the cache's recorded size down
      // to 100, which would wrongly force step 3 below into a full re-fetch.
      Date.now = () => realDateNow() + 61 * 1000;
      global.fetch = async () => ({ ok: true, json: async () => ({ hits: { hits: [{ _source: nsmItem('Narrow report', 'n-1', now) }] } }) });
      const narrow = await fetchReports({ leis: LEI2, days: 1, categories: 'Half-year Financial Report' });
      assert.deepEqual(narrow.body.deltaLeis, [LEI2]);

      // 3) Stale again, back to the original wide window - should still be
      // recognised as covered and take another cheap delta fetch, not a
      // full 450-item re-fetch.
      Date.now = () => realDateNow() + 122 * 1000;
      let capturedSize;
      global.fetch = async (url, opts) => {
        capturedSize = JSON.parse(opts.body).size;
        return { ok: true, json: async () => ({ hits: { hits: [] } }) };
      };
      const wide = await fetchReports({ leis: LEI2, days: 30, categories: 'Half-year Financial Report' });
      assert.deepEqual(wide.body.deltaLeis, [LEI2], 'should still be a delta fetch, not a full re-fetch');
      assert.ok(capturedSize < 450, `expected a small catch-up fetch, not a full re-fetch (got size ${capturedSize})`);
    } finally {
      Date.now = realDateNow;
    }
  });
});
