// Unit tests for lib/dueDates.js's Half-year/Annual "due" estimation -
// pure date math, no network/DB dependency.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeDueInfo, classify, HALF_YEAR, ANNUAL, DUE_SOON_WINDOW_DAYS } = require('../lib/dueDates');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('classify', () => {
  it('is unknown with no prior filing at all', () => {
    assert.equal(classify(null, new Date(), 182, 90), 'unknown');
  });

  it('is ok well before the estimated deadline', () => {
    const lastFiledAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-10T00:00:00Z'); // 9 days in, deadline is 182+90 days out
    assert.equal(classify(lastFiledAt, now, 182, 90), 'ok');
  });

  it('is due-soon inside the warning window before the deadline', () => {
    const lastFiledAt = new Date('2026-01-01T00:00:00Z');
    const deadline = new Date(lastFiledAt.getTime() + (182 + 90) * DAY_MS);
    const now = new Date(deadline.getTime() - (DUE_SOON_WINDOW_DAYS - 1) * DAY_MS);
    assert.equal(classify(lastFiledAt, now, 182, 90), 'due-soon');
  });

  it('is overdue once past the estimated deadline', () => {
    const lastFiledAt = new Date('2025-01-01T00:00:00Z');
    const now = new Date('2026-06-01T00:00:00Z'); // well over a year later
    assert.equal(classify(lastFiledAt, now, 182, 90), 'overdue');
  });

  it('is due-soon (not yet overdue) exactly at the estimated deadline, since overdue is strictly past it', () => {
    const lastFiledAt = new Date('2026-01-01T00:00:00Z');
    const deadline = new Date(lastFiledAt.getTime() + (182 + 90) * DAY_MS);
    assert.equal(classify(lastFiledAt, deadline, 182, 90), 'due-soon');
  });
});

describe('computeDueInfo', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('tracks the most recent filing per category per company', () => {
    const reports = [
      { lei: 'LEI1', category: HALF_YEAR.category, publishedAt: '2026-01-01T00:00:00Z' },
      { lei: 'LEI1', category: HALF_YEAR.category, publishedAt: '2026-03-01T00:00:00Z' }, // newer - should win
      { lei: 'LEI1', category: ANNUAL.category, publishedAt: '2025-12-01T00:00:00Z' },
    ];
    const info = computeDueInfo(reports, now);
    assert.equal(info.LEI1.halfYear.lastFiledAt, '2026-03-01T00:00:00.000Z');
    assert.equal(info.LEI1.annual.lastFiledAt, '2025-12-01T00:00:00.000Z');
  });

  it('ignores categories other than Half-year/Annual entirely (not even an "unknown" entry)', () => {
    const reports = [{ lei: 'LEI1', category: 'Net Asset Value(s)', publishedAt: '2026-05-01T00:00:00Z' }];
    const info = computeDueInfo(reports, now);
    assert.equal(info.LEI1, undefined);
  });

  it('omits a LEI entirely when nothing at all was found for it', () => {
    const info = computeDueInfo([], now);
    assert.deepEqual(info, {});
  });

  it('keeps companies independent of each other', () => {
    const reports = [
      { lei: 'LEI1', category: ANNUAL.category, publishedAt: '2024-01-01T00:00:00Z' }, // stale -> overdue
      { lei: 'LEI2', category: ANNUAL.category, publishedAt: '2026-05-01T00:00:00Z' }, // recent -> ok
    ];
    const info = computeDueInfo(reports, now);
    assert.equal(info.LEI1.annual.status, 'overdue');
    assert.equal(info.LEI2.annual.status, 'ok');
  });
});
