// Unit tests for lib/buildIcs.js - the .ics calendar feed builder behind
// /api/calendar.ics. Pure string formatting, no network dependency.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildIcsFeed, escapeIcsText, foldLine, toIcsDate } = require('../lib/buildIcs');

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma, and newline per RFC 5545', () => {
    assert.equal(escapeIcsText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
  });

  it('leaves ordinary text untouched', () => {
    assert.equal(escapeIcsText('Half-year Financial Report'), 'Half-year Financial Report');
  });
});

describe('foldLine', () => {
  it('leaves a short line alone', () => {
    assert.equal(foldLine('SUMMARY:short'), 'SUMMARY:short');
  });

  it('folds a line longer than 75 octets with a CRLF + single-space continuation', () => {
    const long = `SUMMARY:${'x'.repeat(100)}`;
    const folded = foldLine(long);
    assert.ok(folded.includes('\r\n '), 'must contain a folded continuation');
    // Unfolding (strip every CRLF+space) must reconstruct the original.
    assert.equal(folded.replace(/\r\n /g, ''), long);
  });
});

describe('toIcsDate', () => {
  it('formats an ISO date as YYYYMMDD in UTC', () => {
    assert.equal(toIcsDate('2026-03-05T10:00:00Z'), '20260305');
  });

  it('returns null for an unparseable date', () => {
    assert.equal(toIcsDate('not-a-date'), null);
  });
});

describe('buildIcsFeed', () => {
  const now = new Date('2026-06-01T12:00:00Z');

  it('wraps everything in a valid VCALENDAR with CRLF line endings', () => {
    const ics = buildIcsFeed({ reports: [], dueInfo: {}, now });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
    assert.match(ics, /VERSION:2\.0/);
  });

  it('adds one VEVENT per report, on its publish date', () => {
    const reports = [
      { lei: 'LEI1', company: 'Example Trust', title: 'Half-year Financial Report', category: 'Half-year Financial Report', publishedAt: '2026-01-15T09:00:00Z', url: 'https://example.com/a', id: 'ID1' },
    ];
    const ics = buildIcsFeed({ reports, dueInfo: {}, now });
    assert.match(ics, /BEGIN:VEVENT[\s\S]*DTSTART;VALUE=DATE:20260115[\s\S]*SUMMARY:Example Trust: Half-year Financial Report[\s\S]*END:VEVENT/);
  });

  it('skips a report with no usable publish date rather than emitting a broken VEVENT', () => {
    const reports = [{ lei: 'LEI1', company: 'Example Trust', title: 'T', category: 'NAV', publishedAt: null }];
    const ics = buildIcsFeed({ reports, dueInfo: {}, now });
    assert.ok(!ics.includes('BEGIN:VEVENT'));
  });

  it('adds one VEVENT per estimated due date, using the resolved display name', () => {
    const dueInfo = {
      LEI1: {
        halfYear: { lastFiledAt: '2026-01-01T00:00:00Z', status: 'ok', dueDate: '2026-07-01T00:00:00Z' },
        annual: { lastFiledAt: null, status: 'unknown', dueDate: null },
      },
    };
    const namesByLei = new Map([['LEI1', 'Example Trust']]);
    const ics = buildIcsFeed({ reports: [], dueInfo, namesByLei, now });
    assert.match(ics, /SUMMARY:Est\. Half-year Financial Report due - Example Trust/);
    assert.match(ics, /DTSTART;VALUE=DATE:20260701/);
    // annual has no dueDate (status 'unknown') - must not produce a VEVENT.
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  });

  it('falls back to the bare LEI when no display name is known', () => {
    const dueInfo = { LEI1: { halfYear: { dueDate: '2026-07-01T00:00:00Z', status: 'ok' }, annual: { dueDate: null, status: 'unknown' } } };
    const ics = buildIcsFeed({ reports: [], dueInfo, now });
    assert.match(ics, /SUMMARY:Est\. Half-year Financial Report due - LEI1/);
  });

  it('escapes untrusted text within a VEVENT', () => {
    const reports = [{ lei: 'LEI1', company: 'A, B; C', title: 'T', category: 'NAV', publishedAt: '2026-01-01T00:00:00Z' }];
    const ics = buildIcsFeed({ reports, dueInfo: {}, now });
    assert.match(ics, /SUMMARY:A\\, B\\; C: T/);
  });
});
