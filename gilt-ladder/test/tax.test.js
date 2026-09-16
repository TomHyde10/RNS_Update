// UK tax on gilt coupons. The allowances make the effective rate a step
// function of how much coupon income a tax year carries, which is why a single
// marginal rate cannot describe it - and why gilt selection, which is driven
// entirely by that rate, can change when the allowances are modelled.
const test = require('node:test');
const assert = require('node:assert/strict');
const { taxYearOf, bandsFor, allowancesFor, taxOnCoupons, taxByYear, ratesByYear } = require('../lib/tax');

const config = {
  years: {
    '2026/27': {
      personalAllowance: 12570,
      startingRateBand: 5000,
      personalSavingsAllowance: { 0.2: 1000, 0.4: 500, 0.45: 0 },
    },
  },
  default: {
    personalAllowance: 12570,
    startingRateBand: 5000,
    personalSavingsAllowance: { 0.2: 1000, 0.4: 500, 0.45: 0 },
  },
  checkedAgainst: '2026/27',
};

// --- tax years -------------------------------------------------------------

test('the tax year runs 6 April to 5 April', () => {
  assert.equal(taxYearOf('2026-04-05'), '2025/26', 'the 5th ends the old year');
  assert.equal(taxYearOf('2026-04-06'), '2026/27', 'the 6th starts the new one');
  assert.equal(taxYearOf('2026-04-04'), '2025/26');
  assert.equal(taxYearOf('2027-01-01'), '2026/27', 'January belongs to the year that began the previous April');
});

test('the tax year label rolls over the century correctly', () => {
  assert.equal(taxYearOf('2099-06-30'), '2099/00');
  assert.equal(taxYearOf('2100-06-30'), '2100/01');
});

// --- allowances ------------------------------------------------------------

// No stated other income is treated as enough to exhaust the starting rate
// band. That can only overstate the tax, never understate it.
test('the starting rate band is unavailable unless other income is stated', () => {
  assert.equal(allowancesFor('2026/27', { marginalRate: 0.2 }, config).startingRate, 0);
});

test('a small other income leaves the starting rate band intact', () => {
  const a = allowancesFor('2026/27', { marginalRate: 0.2, otherIncome: 10000 }, config);
  assert.equal(a.startingRate, 5000);
  assert.equal(a.zeroRated, 6000, 'plus the £1,000 PSA');
});

// Reduced £1 for £1 by non-savings income above the personal allowance.
test('the starting rate band tapers away against other income', () => {
  const at = (otherIncome) => allowancesFor('2026/27', { marginalRate: 0.2, otherIncome }, config).startingRate;
  assert.equal(at(12570), 5000, 'exactly at the personal allowance, none is used up');
  assert.equal(at(14570), 3000);
  assert.equal(at(17570), 0);
  assert.equal(at(40000), 0, 'and cannot go negative');
});

test('the Personal Savings Allowance follows the taxpayer band', () => {
  const psa = (marginalRate) => allowancesFor('2026/27', { marginalRate }, config).psa;
  assert.equal(psa(0.2), 1000);
  assert.equal(psa(0.4), 500);
  assert.equal(psa(0.45), 0, 'an additional-rate taxpayer gets none');
});

// --- the step function -----------------------------------------------------

test('coupon income inside the allowances is untaxed', () => {
  const row = taxOnCoupons(800, { marginalRate: 0.2 }, '2026/27', config);
  assert.equal(row.tax, 0);
  assert.equal(row.effectiveRate, 0);
  assert.equal(row.taxable, 0);
});

test('only the excess over the allowances is taxed', () => {
  const row = taxOnCoupons(3000, { marginalRate: 0.2 }, '2026/27', config);
  assert.equal(row.taxable, 2000);
  assert.equal(row.tax, 400);
});

// The reason this matters: the rate a coupon bears rises with the year's total
// rather than being a constant, and it is that rate selection is priced on.
test('the effective rate climbs towards the marginal rate, never past it', () => {
  const rate = (coupons) => taxOnCoupons(coupons, { marginalRate: 0.2 }, '2026/27', config).effectiveRate;
  assert.equal(rate(1000), 0);
  assert.ok(rate(2000) > 0 && rate(2000) < 0.2);
  assert.ok(rate(10000) > rate(2000));
  assert.ok(rate(1000000) < 0.2);
  assert.ok(rate(1000000) > 0.199, 'and approaches it');
});

test('no coupons means no rate rather than a division by zero', () => {
  const row = taxOnCoupons(0, { marginalRate: 0.45 }, '2026/27', config);
  assert.equal(row.effectiveRate, 0);
  assert.equal(row.tax, 0);
});

// --- grouping --------------------------------------------------------------

test('coupons are pooled by tax year before the allowances are applied', () => {
  // Two £600 coupons in one tax year exceed a £1,000 allowance together even
  // though neither does alone. Taxing them separately would find no tax at all.
  const rows = taxByYear(
    [
      { date: '2026-06-30', coupon: 600 },
      { date: '2026-12-31', coupon: 600 },
    ],
    { marginalRate: 0.2 },
    config
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coupons, 1200);
  assert.equal(rows[0].taxable, 200);
});

test('coupons either side of 5 April fall in different years', () => {
  const rows = taxByYear(
    [
      { date: '2027-04-05', coupon: 900 },
      { date: '2027-04-06', coupon: 900 },
    ],
    { marginalRate: 0.2 },
    config
  );
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.tax, 0, 'each year has its own allowance');
});

test('years without published bands are marked estimated', () => {
  const rows = taxByYear([{ date: '2045-06-30', coupon: 5000 }], { marginalRate: 0.2 }, config);
  assert.equal(rows[0].estimated, true);
  assert.equal(bandsFor('2026/27', config).estimated, false);
});

test('the rate map is keyed by tax year for the next pricing pass', () => {
  const rows = taxByYear([{ date: '2026-06-30', coupon: 3000 }], { marginalRate: 0.2 }, config);
  const rates = ratesByYear(rows);
  assert.equal(rates.get('2026/27'), rows[0].effectiveRate);
});
