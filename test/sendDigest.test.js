// Unit tests for lib/sendDigest.js's pure logic - window calculation,
// per-trust/per-category matching, HTML building, and the recipient
// security gate. sendDigestForSubscription() and collectDigestReports()
// themselves make real network/email calls and are intentionally not unit
// tested here - see test/subscriptionsApi.test.js for how the request
// pipeline around them is covered without a live network dependency.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { digestWindowStart, filterDigestReports, buildDigestHtml, digestSendAllowed } = require('../lib/sendDigest');

describe('digestWindowStart', () => {
  it('covers exactly one cycle back for a subscription that has never sent', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const since = digestWindowStart({ frequencyMinutes: 1440, lastSentAt: null }, now);
    assert.equal(since.toISOString(), '2026-01-01T12:00:00.000Z');
  });

  it('scales the never-sent window to the subscription\'s own frequency', () => {
    const now = new Date('2026-01-08T00:00:00Z');
    const since = digestWindowStart({ frequencyMinutes: 10080, lastSentAt: null }, now); // weekly
    assert.equal(since.toISOString(), '2026-01-01T00:00:00.000Z');
  });

  it('uses lastSentAt when present, regardless of frequency', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const since = digestWindowStart({ frequencyMinutes: 1440, lastSentAt: '2026-01-02T09:00:00Z' }, now);
    assert.equal(since.toISOString(), '2026-01-02T09:00:00.000Z');
  });
});

describe('filterDigestReports', () => {
  const since = new Date('2026-01-01T00:00:00Z');
  const prefs = {
    LEI1: { name: 'Company One', categories: ['Half-year Financial Report'] },
    LEI2: { name: 'Company Two', categories: ['Dividend Declaration', 'Net Asset Value(s)'] },
  };

  it("keeps a report matching its own LEI's selected category, published after since", () => {
    const reports = [{ lei: 'LEI1', category: 'Half-year Financial Report', publishedAt: '2026-01-02T00:00:00Z' }];
    assert.equal(filterDigestReports(reports, prefs, since).length, 1);
  });

  it('drops a report for a category not selected for that LEI, even if another LEI does select it', () => {
    const reports = [{ lei: 'LEI1', category: 'Dividend Declaration', publishedAt: '2026-01-02T00:00:00Z' }];
    assert.equal(filterDigestReports(reports, prefs, since).length, 0);
  });

  it('drops a report published before since', () => {
    const reports = [{ lei: 'LEI1', category: 'Half-year Financial Report', publishedAt: '2025-12-31T00:00:00Z' }];
    assert.equal(filterDigestReports(reports, prefs, since).length, 0);
  });

  it('drops a report published exactly at since (strictly after only)', () => {
    const reports = [{ lei: 'LEI1', category: 'Half-year Financial Report', publishedAt: since.toISOString() }];
    assert.equal(filterDigestReports(reports, prefs, since).length, 0);
  });

  it('drops a report for a LEI with no prefs entry at all', () => {
    const reports = [{ lei: 'UNKNOWN', category: 'Half-year Financial Report', publishedAt: '2026-01-02T00:00:00Z' }];
    assert.equal(filterDigestReports(reports, prefs, since).length, 0);
  });

  it('matches category case-insensitively', () => {
    const reports = [{ lei: 'LEI1', category: 'half-year financial report', publishedAt: '2026-01-02T00:00:00Z' }];
    assert.equal(filterDigestReports(reports, prefs, since).length, 1);
  });

  it('keeps only the matching subset across multiple LEIs and categories', () => {
    const reports = [
      { lei: 'LEI1', category: 'Half-year Financial Report', publishedAt: '2026-01-02T00:00:00Z' }, // keep
      { lei: 'LEI1', category: 'Portfolio Update', publishedAt: '2026-01-02T00:00:00Z' }, // drop: not selected for LEI1
      { lei: 'LEI2', category: 'Net Asset Value(s)', publishedAt: '2026-01-03T00:00:00Z' }, // keep
      { lei: 'LEI2', category: 'Half-year Financial Report', publishedAt: '2026-01-03T00:00:00Z' }, // drop: not selected for LEI2
    ];
    const kept = filterDigestReports(reports, prefs, since);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map((r) => r.lei).sort(), ['LEI1', 'LEI2']);
  });
});

describe('buildDigestHtml', () => {
  const prefs = { LEI1: { name: 'Company One', categories: [] } };

  it('states the total count and window label', () => {
    const html = buildDigestHtml([], prefs, 'since 1 Jan 2026');
    assert.match(html, /0 new reports since 1 Jan 2026\./);
  });

  it('pluralises "report" correctly for exactly one', () => {
    const html = buildDigestHtml([{ lei: 'LEI1', title: 'T', category: 'NAV', publishedAt: '2026-01-01T00:00:00Z' }], prefs, 'since X');
    assert.match(html, /1 new report since X\./);
  });

  it('groups reports by company name, newest first within a group', () => {
    const reports = [
      { lei: 'LEI1', title: 'Older', category: 'NAV', publishedAt: '2026-01-01T00:00:00Z', url: null },
      { lei: 'LEI1', title: 'Newer', category: 'NAV', publishedAt: '2026-01-02T00:00:00Z', url: null },
    ];
    const html = buildDigestHtml(reports, prefs, 'since X');
    assert.match(html, /<h3>Company One<\/h3>/);
    assert.ok(html.indexOf('Newer') < html.indexOf('Older'), 'newest report should render before the older one');
  });

  it('links the title when a report has a url, and escapes untrusted text', () => {
    const reports = [{ lei: 'LEI1', title: '<script>alert(1)</script>', category: 'NAV', publishedAt: '2026-01-01T00:00:00Z', url: 'https://example.com/x' }];
    const html = buildDigestHtml(reports, prefs, 'since X');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'a raw script tag must never appear unescaped');
    assert.match(html, /<a href="https:\/\/example\.com\/x">&lt;script&gt;/);
  });

  it('falls back to the LEI itself as a heading when no name is known', () => {
    const html = buildDigestHtml([{ lei: 'UNKNOWNLEI', title: 'T', category: 'NAV', publishedAt: '2026-01-01T00:00:00Z' }], {}, 'since X');
    assert.match(html, /<h3>UNKNOWNLEI<\/h3>/);
  });
});

describe('digestSendAllowed', () => {
  const ORIGINAL = { APP_PASSWORD: process.env.APP_PASSWORD, NOTIFY_EMAIL_TO: process.env.NOTIFY_EMAIL_TO };

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('allows any address once APP_PASSWORD is set', () => {
    process.env.APP_PASSWORD = 'secret';
    delete process.env.NOTIFY_EMAIL_TO;
    assert.equal(digestSendAllowed('anyone@example.com'), true);
  });

  it('without APP_PASSWORD, only allows the fixed NOTIFY_EMAIL_TO address', () => {
    delete process.env.APP_PASSWORD;
    process.env.NOTIFY_EMAIL_TO = 'fixed@example.com';
    assert.equal(digestSendAllowed('fixed@example.com'), true);
    assert.equal(digestSendAllowed('someone-else@example.com'), false);
  });

  it('matches NOTIFY_EMAIL_TO case-insensitively', () => {
    delete process.env.APP_PASSWORD;
    process.env.NOTIFY_EMAIL_TO = 'Fixed@Example.com';
    assert.equal(digestSendAllowed('fixed@example.com'), true);
  });

  it('denies everything when neither APP_PASSWORD nor NOTIFY_EMAIL_TO is set', () => {
    delete process.env.APP_PASSWORD;
    delete process.env.NOTIFY_EMAIL_TO;
    assert.equal(digestSendAllowed('anyone@example.com'), false);
  });
});
