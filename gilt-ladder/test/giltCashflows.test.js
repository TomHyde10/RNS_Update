const test = require('node:test');
const assert = require('node:assert');
const { toISO } = require('../lib/calendar');
const { couponSchedule, couponPeriod, cashflows, exDivDate } = require('../lib/giltCashflows');
const { accruedInterest, isExDiv } = require('../lib/accrued');

// Synthetic gilts throughout: the maths is being tested, not any claim about
// a real gilt's terms.
const GILT = { name: '4% Test Gilt 2030', coupon: 4, redemption: '2030-01-31' };
const MONTH_END = { name: '3% Month End 2030', coupon: 3, redemption: '2030-03-31' };

test('coupon schedule runs semi-annually to redemption', () => {
  const dates = couponSchedule(GILT, '2028-06-01').map(toISO);
  assert.deepEqual(dates, ['2028-07-31', '2029-01-31', '2029-07-31', '2030-01-31']);
});

// End-of-month clamping must not compound. Stepping iteratively (Mar 31 ->
// Sep 30 -> Mar 30) would drift a day permanently after the first short
// month; anchoring every date to the redemption date prevents it.
test('month-end coupon dates do not drift', () => {
  const dates = couponSchedule(MONTH_END, '2027-01-01').map(toISO);
  assert.deepEqual(dates, [
    '2027-03-31',
    '2027-09-30',
    '2028-03-31',
    '2028-09-30',
    '2029-03-31',
    '2029-09-30',
    '2030-03-31',
  ]);
});

test('schedule is empty once redemption has passed', () => {
  assert.deepEqual(couponSchedule(GILT, '2030-01-31'), []);
  assert.deepEqual(couponSchedule(GILT, '2031-01-01'), []);
});

test('coupon period brackets the settlement date', () => {
  const { start, end, days } = couponPeriod(GILT, '2028-10-31');
  assert.equal(toISO(start), '2028-07-31');
  assert.equal(toISO(end), '2029-01-31');
  assert.equal(days, 184);
});

test('accrued interest is exact at a known fraction of the period', () => {
  // 2028-07-31 -> 2028-10-31 is 92 days of a 184-day period: exactly half a
  // coupon, so half of the 2.0 semi-annual payment.
  assert.equal(accruedInterest(GILT, '2028-10-31'), 1);
});

test('accrued interest is zero on a coupon date', () => {
  assert.equal(accruedInterest(GILT, '2029-01-31'), 0);
});

test('accrued interest goes negative inside the ex-dividend window', () => {
  const coupon = new Date(Date.UTC(2029, 0, 31));
  const xd = exDivDate(coupon);
  assert.ok(isExDiv(GILT, xd), 'xd date itself should be ex-dividend');
  assert.ok(accruedInterest(GILT, xd) < 0, 'accrued should be negative in xd');

  // The day before going xd it is still positive and near a full coupon.
  const dayBefore = new Date(xd.getTime() - 86400000);
  assert.ok(!isExDiv(GILT, dayBefore));
  assert.ok(accruedInterest(GILT, dayBefore) > 1.8);
});

test('a buyer settling ex-dividend does not receive that coupon', () => {
  const xd = exDivDate(new Date(Date.UTC(2029, 0, 31)));
  const flows = cashflows(GILT, xd);
  const skipped = flows.find((f) => f.couponDate === '2029-01-31');
  assert.equal(skipped, undefined, 'the xd coupon should not appear at all');

  // The following coupon is unaffected.
  const next = flows.find((f) => f.couponDate === '2029-07-31');
  assert.equal(next.coupon, 2);
});

test('redemption pays principal plus the final coupon', () => {
  const flows = cashflows(GILT, '2029-09-01');
  const final = flows[flows.length - 1];
  assert.equal(final.couponDate, '2030-01-31');
  assert.equal(final.principal, 100);
  assert.equal(final.coupon, 2);
  assert.equal(final.amount, 102);
});

test('cash flows report the business day the money actually arrives', () => {
  // 2027-09-30 is a Thursday; 2026-03-31 is a Tuesday. Pick a redemption whose
  // coupon lands at a weekend to check the roll.
  const weekendGilt = { name: '2% Weekend 2028', coupon: 2, redemption: '2028-01-30' }; // a Sunday
  const flows = cashflows(weekendGilt, '2027-12-01');
  const final = flows[flows.length - 1];
  assert.equal(final.couponDate, '2028-01-30');
  assert.equal(final.paidOn, '2028-01-31', 'Sunday coupon pays the next business day');
  assert.equal(final.amount, 101, 'the amount is not adjusted by the date roll');
});
