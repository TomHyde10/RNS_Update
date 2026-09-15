const test = require('node:test');
const assert = require('node:assert');
const {
  toISO,
  easterSunday,
  isBusinessDay,
  isBankHoliday,
  addBusinessDays,
  paymentDate,
  ruleBasedHolidays,
} = require('../lib/calendar');
const table = require('../config/bankHolidays');

test('Easter Sunday matches known dates', () => {
  const known = {
    2023: '2023-04-09',
    2024: '2024-03-31',
    2025: '2025-04-20',
    2026: '2026-04-05',
    2027: '2027-03-28',
  };
  for (const [year, iso] of Object.entries(known)) {
    assert.equal(toISO(easterSunday(Number(year))), iso, `Easter ${year}`);
  }
});

// The rule-based generator only runs for years beyond what gov.uk publishes,
// so it is never exercised against real data in normal use. This checks it
// against the published table for years where both exist - if the standing
// rules are wrong, the error would otherwise only appear decades out.
test('rule-based holidays reproduce the published table', () => {
  // Years where a holiday was MOVED by proclamation, so the standing rules
  // produce a date that was not a holiday and miss one that was. Nothing
  // derivable can reproduce these, so they are excluded wholesale:
  //   2020 - early May moved to Fri 8 May for the VE Day 75th anniversary
  //   2022 - spring moved to Thu 2 June for the Platinum Jubilee
  const displaced = new Set([2020, 2022]);

  // Years with an ADDITIONAL one-off holiday but no displacement: the rules
  // still produce every other date correctly, so only the extra is excused.
  const addedOneOffs = new Set(['2023-05-08']); // coronation of Charles III

  let checked = 0;
  for (let year = table.coveredFrom; year <= table.coveredTo; year++) {
    if (displaced.has(year)) continue;
    const published = [...table.dates]
      .filter((d) => d.startsWith(String(year)))
      .filter((d) => !addedOneOffs.has(d));
    const computed = ruleBasedHolidays(year);

    assert.deepEqual(
      [...computed].sort(),
      published.sort(),
      `rule-based calendar disagrees with gov.uk for ${year}`
    );
    checked++;
  }
  assert.ok(checked >= 6, `expected to check several years, only did ${checked}`);
});

test('weekend Christmas produces substitute days', () => {
  // 2021: Christmas Day was a Saturday, Boxing Day a Sunday -> 27th and 28th.
  assert.ok(isBankHoliday('2021-12-27'));
  assert.ok(isBankHoliday('2021-12-28'));
  assert.ok(!isBusinessDay('2021-12-27'));
});

test('business days skip weekends and bank holidays', () => {
  assert.ok(!isBusinessDay('2026-01-01')); // New Year's Day
  assert.ok(!isBusinessDay('2026-09-13')); // Sunday
  assert.ok(isBusinessDay('2026-09-14')); // Monday
});

test('addBusinessDays steps over a bank holiday', () => {
  // 2025-12-25 Thu and 2025-12-26 Fri are both holidays, so one business day
  // after Wednesday the 24th is Monday the 29th.
  assert.equal(toISO(addBusinessDays('2025-12-24', 1)), '2025-12-29');
  assert.equal(toISO(addBusinessDays('2025-12-29', -1)), '2025-12-24');
});

test('addBusinessDays is reversible', () => {
  for (const start of ['2026-03-02', '2026-08-28', '2027-01-04']) {
    for (const n of [1, 5, 7, 20]) {
      assert.equal(toISO(addBusinessDays(addBusinessDays(start, n), -n)), start, `${start} +${n}-${n}`);
    }
  }
});

test('payment date rolls forward off a non-business day', () => {
  assert.equal(toISO(paymentDate('2026-09-14')), '2026-09-14'); // a Monday, unchanged
  assert.equal(toISO(paymentDate('2026-09-13')), '2026-09-14'); // Sunday -> Monday
});
