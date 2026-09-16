// Exports outlive the page that produced them, so the two things that matter
// are that the format is right for the tool that will open it, and that the
// indicative caveat travels with the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dealingListCsv, cashflowsCsv, calendarIcs, csvField, foldLine, icsText } = require('../lib/exports');

const result = {
  settlement: '2026-09-16',
  curveDate: '2026-09-15',
  holdings: [
    {
      name: '0 1/8% Treasury Gilt 2028',
      isin: 'GB00BMBL1D50',
      coupon: 0.125,
      redemption: '2028-01-31',
      nominal: 20000,
      cleanPrice: 94.031,
      accrued: 0.229,
      cost: 18852.0,
      priceSource: 'derived',
      fundsLiability: '2028-03-31',
    },
  ],
  coverage: [
    { date: '2028-03-31', amount: 20000, covered: true },
    { date: '2030-03-31', amount: 15000, covered: false },
  ],
  cashflows: [
    { date: '2027-01-31', amount: 12.5, gross: 12.5 },
    { date: '2028-01-31', amount: 20012.5, gross: 20012.5 },
  ],
  totals: { cost: 18852.0 },
};

// --- CSV -------------------------------------------------------------------

test('a field containing a comma is quoted', () => {
  assert.equal(csvField('0 1/8%, Treasury'), '"0 1/8%, Treasury"');
});

test('quotes inside a field are doubled', () => {
  assert.equal(csvField('say "hello"'), '"say ""hello"""');
});

// Spreadsheets treat a leading =, +, - or @ as a formula. Nothing in a ladder
// should begin that way, which is exactly why it must not be left to chance.
test('a field that looks like a formula is kept as text', () => {
  assert.equal(csvField('=1+1'), "'=1+1");
  assert.equal(csvField('-5'), "'-5");
  assert.equal(csvField('@x'), "'@x");
});

test('the dealing list has a header and one row per holding', () => {
  const lines = dealingListCsv(result).split('\r\n');
  assert.match(lines[0], /^Gilt,ISIN,Coupon %/);
  assert.match(lines[1], /GB00BMBL1D50/);
  assert.match(lines[1], /94\.03/);
});

test('the dealing list uses CRLF and ends on a record boundary', () => {
  const out = dealingListCsv(result);
  assert.ok(out.includes('\r\n'));
  assert.ok(out.endsWith('\r\n'));
});

// A column of prices with no provenance is exactly the thing that gets
// mistaken for dealable once it has left the page.
test('the dealing list carries the curve date and the indicative caveat', () => {
  const out = dealingListCsv(result);
  assert.match(out, /2026-09-15/);
  assert.match(out, /Indicative only/);
  assert.match(out, /not dealable/);
});

test('the cashflow export lines inflows up against liabilities by date', () => {
  const lines = cashflowsCsv(result).trim().split('\r\n');
  assert.equal(lines[0], 'Date,Cash in (after tax),Cash in (gross),Liability due');
  // Four distinct dates: two inflows and two liabilities, none shared.
  assert.equal(lines.length, 5);
  const due = lines.find((l) => l.startsWith('2030-03-31'));
  assert.equal(due, '2030-03-31,,,15000.00', 'a liability with no inflow leaves the inflow columns empty');
});

// --- iCalendar -------------------------------------------------------------

test('the calendar is a well-formed VCALENDAR', () => {
  const ics = calendarIcs(result);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.match(ics, /VERSION:2\.0/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4, 'two inflows and two liabilities');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, (ics.match(/END:VEVENT/g) || []).length);
});

test('events are all-day, with an exclusive end date', () => {
  const ics = calendarIcs(result);
  assert.match(ics, /DTSTART;VALUE=DATE:20280131/);
  assert.match(ics, /DTEND;VALUE=DATE:20280201/, 'an all-day DTEND is the following day');
});

// A subscribed calendar is re-fetched forever. Random UIDs would duplicate
// every entry on every refresh instead of updating it.
test('UIDs are stable across regenerations', () => {
  const a = calendarIcs(result, { now: new Date('2026-09-16T10:00:00Z') });
  const b = calendarIcs(result, { now: new Date('2026-09-17T10:00:00Z') });
  const uids = (ics) => (ics.match(/^UID:.*$/gm) || []).map((l) => l.trim());
  assert.deepEqual(uids(a), uids(b));
  assert.notEqual(a, b, 'but DTSTAMP does move');
});

test('an uncovered liability says so in the event', () => {
  const ics = calendarIcs(result);
  assert.match(ics, /NOT fully covered/);
});

test('iCalendar special characters are escaped, backslash first', () => {
  assert.equal(icsText('a,b;c'), 'a\\,b\;c');
  assert.equal(icsText('a\\b'), 'a\\\\b');
  assert.equal(icsText('one\ntwo'), 'one\\ntwo');
});

// RFC 5545 §3.1. The continuation space counts against the next line's budget,
// which is the part that is easy to get wrong by one.
test('long lines are folded to 75 octets with a leading space', () => {
  const folded = foldLine(`DESCRIPTION:${'x'.repeat(200)}`).split('\r\n');
  assert.equal(folded[0].length, 75);
  for (const line of folded.slice(1)) {
    assert.ok(line.startsWith(' '), 'continuations begin with a single space');
    assert.ok(line.length <= 75);
  }
  // Unfolding is "drop the CRLF and the single space that follows it", so the
  // original line has to come back exactly.
  const unfolded = folded[0] + folded.slice(1).map((line) => line.slice(1)).join('');
  assert.equal(unfolded, `DESCRIPTION:${'x'.repeat(200)}`);
});

test('a short line is left alone', () => {
  assert.equal(foldLine('SUMMARY:short'), 'SUMMARY:short');
});
