// Liability series: one row standing in for many. The failure that matters
// here is date drift - a series whose dates quietly slip by a day after the
// first short month funds the wrong dates for ever after.
const test = require('node:test');
const assert = require('node:assert/strict');
const { expand, expandedLength, validateRepeat, occurrenceDates, MAX_OCCURRENCES } = require('../lib/liabilities');

test('a liability with no repeat passes through untouched', () => {
  const input = [{ date: '2030-06-30', amount: 1000 }];
  assert.deepEqual(expand(input), input);
});

test('a yearly series lands on the same day each year', () => {
  assert.deepEqual(occurrenceDates('2027-09-30', 'year', 4), [
    '2027-09-30',
    '2028-09-30',
    '2029-09-30',
    '2030-09-30',
  ]);
});

// Each date is an offset from the FIRST, not a step off the previous one.
// Stepping iteratively would clamp 31 January to 28 February and then carry
// that 28th forward for ever; it must come back to the 31st in March.
test('end-of-month dates do not drift after a short month', () => {
  assert.deepEqual(occurrenceDates('2027-01-31', 'month', 4), [
    '2027-01-31',
    '2027-02-28',
    '2027-03-31',
    '2027-04-30',
  ]);
});

test('29 February in a leap year clamps without poisoning later dates', () => {
  assert.deepEqual(occurrenceDates('2028-02-29', 'year', 3), ['2028-02-29', '2029-02-28', '2030-02-28']);
});

test('every frequency steps by the right number of months', () => {
  assert.deepEqual(occurrenceDates('2027-01-31', 'quarter', 3), ['2027-01-31', '2027-04-30', '2027-07-31']);
  assert.deepEqual(occurrenceDates('2027-01-31', 'half-year', 3), ['2027-01-31', '2027-07-31', '2028-01-31']);
});

test('expansion keeps the amount and drops the repeat block', () => {
  const out = expand([{ date: '2027-09-30', amount: 12000, repeat: { every: 'year', count: 3 } }]);
  assert.equal(out.length, 3);
  for (const l of out) {
    assert.equal(l.amount, 12000);
    assert.equal(l.repeat, undefined, 'what comes out must be a plain dated amount');
  }
});

test('plain and repeating liabilities mix in one list', () => {
  const out = expand([
    { date: '2028-01-01', amount: 500 },
    { date: '2027-09-30', amount: 12000, repeat: { every: 'year', count: 2 } },
  ]);
  assert.equal(out.length, 3);
});

// Counting before expanding is what lets an over-large request be refused
// without first building the list it asked for.
test('the expanded length is known without expanding', () => {
  const list = [{ date: '2030-01-01', amount: 1 }, { date: '2030-01-01', amount: 1, repeat: { every: 'month', count: 12 } }];
  assert.equal(expandedLength(list), 13);
  assert.equal(expandedLength(list), expand(list).length);
});

test('a repeat of one is just a liability', () => {
  const out = expand([{ date: '2030-06-30', amount: 1000, repeat: { every: 'year', count: 1 } }]);
  assert.deepEqual(out, [{ date: '2030-06-30', amount: 1000 }]);
});

test('validation rejects an unknown frequency and a bad count', () => {
  assert.deepEqual(validateRepeat(null, 'l'), [], 'no repeat is not an error');
  assert.match(validateRepeat({ every: 'fortnight', count: 3 }, 'l')[0], /must be one of/);
  assert.match(validateRepeat({ every: 'year', count: 0 }, 'l')[0], /between 1 and/);
  assert.match(validateRepeat({ every: 'year', count: 2.5 }, 'l')[0], /whole number/);
  assert.match(validateRepeat({ every: 'year', count: MAX_OCCURRENCES + 1 }, 'l')[0], /between 1 and/);
});

// --- Escalation ------------------------------------------------------------
//
// School fees and care costs rise, and a nominal ladder built against today's
// figure silently under-funds them. This lets the amount be stated in today's
// money and uprated to the date it falls due - an assumption the user states
// and can see, applied to the liability side only. It is not index-linked gilt
// support and does not pretend to be: the assets stay nominal.

const { escalate, validateEscalation, MAX_ESCALATION } = require('../lib/liabilities');

test('no escalation leaves the amount exactly alone', () => {
  assert.equal(escalate(12000, 0, '2026-09-16', '2040-09-16'), 12000);
  assert.equal(escalate(12000, null, '2026-09-16', '2040-09-16'), 12000);
});

test('escalation compounds annually', () => {
  const ten = escalate(1000, 0.05, '2026-09-16', '2036-09-16');
  // Ten years and two leap days, on an ACT/365 year, so a shade over 10.
  assert.ok(Math.abs(ten - 1000 * 1.05 ** (3653 / 365)) < 1e-9);
  assert.ok(ten > 1600 && ten < 1660, `got ${ten}`);
});

test('a part year escalates by a part year', () => {
  const half = escalate(1000, 0.1, '2026-09-16', '2027-03-17');
  assert.ok(half > 1000 && half < 1050, `got ${half}`);
});

test('escalation may be negative, for a cost expected to fall', () => {
  assert.ok(escalate(1000, -0.02, '2026-09-16', '2036-09-16') < 1000);
});

// 3 entered where 0.03 was meant would compound a liability into the millions.
test('an escalation that is obviously a percentage is refused', () => {
  assert.deepEqual(validateEscalation(0.05, 'l'), []);
  assert.deepEqual(validateEscalation(null, 'l'), []);
  assert.match(validateEscalation(3, 'l')[0], /between/);
  assert.match(validateEscalation(MAX_ESCALATION + 0.01, 'l')[0], /between/);
  assert.match(validateEscalation('abc', 'l')[0], /between/);
});

test('a series carries its escalation onto every occurrence', () => {
  const out = expand([{ date: '2028-09-30', amount: 12000, escalation: 0.05, repeat: { every: 'year', count: 3 } }]);
  assert.equal(out.length, 3);
  for (const l of out) {
    assert.equal(l.escalation, 0.05);
    assert.equal(l.amount, 12000, 'the base amount, uprated later against a settlement date');
  }
});
