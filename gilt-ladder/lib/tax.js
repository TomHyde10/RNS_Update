// UK tax on gilt coupons, by tax year.
//
// A flat marginal rate is a poor model of savings income. Two allowances sit
// underneath it and make the effective rate a STEP FUNCTION of how much coupon
// income arrives in a year:
//
//   - the starting rate for savings - a £5,000 band at 0%, reduced £1 for £1
//     by non-savings income above the personal allowance, so a salary well
//     over the personal allowance leaves none of it;
//   - the Personal Savings Allowance - £1,000, £500 or nothing, depending on
//     the band the taxpayer is in.
//
// This matters to more than the reported figure. Gilt selection is driven
// entirely by the rate on coupons, so a ladder small enough to sit inside the
// allowances faces no coupon tax at all - and the low-coupon preference this
// application exists to show simply vanishes, correctly.
//
// Capital gains on gilts are CGT-exempt for individuals, so redemption is
// never taxed. Only the coupon leg reaches any of this.
const taxConfig = require('../config/taxYears');

// The UK tax year runs 6 April to 5 April. A coupon paid on 5 April falls in
// the year ending that day; one paid on 6 April starts the next.
function taxYearOf(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  const startYear = month > 4 || (month === 4 && day >= 6) ? year : year - 1;
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// An unlisted year falls back to the most recent listed one rather than to
// nothing, and `estimated` says which happened so a twenty-year ladder cannot
// quietly imply its later bands were known.
function bandsFor(taxYear, config = taxConfig) {
  const bands = config.years[taxYear];
  return bands ? { ...bands, estimated: false } : { ...config.default, estimated: true };
}

// How much of each 0% band is available, given the taxpayer's marginal rate and
// whatever else they earn.
//
// `otherIncome` is non-savings income - salary, pension, rent. Left unset it is
// treated as enough to exhaust the starting rate band, which is the
// conservative assumption: it can only overstate the tax, never understate it,
// and anyone with a salary above the personal allowance is in that position
// anyway.
function allowancesFor(taxYear, { marginalRate, otherIncome = null }, config = taxConfig) {
  const bands = bandsFor(taxYear, config);
  const psa = bands.personalSavingsAllowance[marginalRate] ?? 0;

  const startingRate =
    otherIncome == null
      ? 0
      : Math.max(0, bands.startingRateBand - Math.max(0, otherIncome - bands.personalAllowance));

  return { startingRate, psa, zeroRated: startingRate + psa, estimated: bands.estimated };
}

// Tax on one year's coupon income: the 0% bands first, the marginal rate on
// what is left.
function taxOnCoupons(coupons, { marginalRate, otherIncome = null }, taxYear, config = taxConfig) {
  const allowances = allowancesFor(taxYear, { marginalRate, otherIncome }, config);
  const taxable = Math.max(0, coupons - allowances.zeroRated);
  return {
    taxYear,
    coupons,
    zeroRated: Math.min(coupons, allowances.zeroRated),
    taxable,
    tax: taxable * marginalRate,
    // The blended rate this year's coupons actually bear. This is the number
    // gilt selection needs: a single rate per year that reproduces the banded
    // tax exactly for that year's total.
    effectiveRate: coupons > 0 ? (taxable * marginalRate) / coupons : 0,
    startingRate: allowances.startingRate,
    psa: allowances.psa,
    estimated: allowances.estimated,
  };
}

// Groups gross coupon amounts by tax year and taxes each year on its own.
// `flows` are { date, coupon } in pounds - actual money, not per £100 nominal.
function taxByYear(flows, options, config = taxConfig) {
  const byYear = new Map();
  for (const flow of flows) {
    const year = taxYearOf(flow.date);
    byYear.set(year, (byYear.get(year) || 0) + flow.coupon);
  }

  return [...byYear.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, coupons]) => taxOnCoupons(coupons, options, year, config));
}

// year -> blended rate, for pricing the next pass of the ladder.
const ratesByYear = (rows) => new Map(rows.map((row) => [row.taxYear, row.effectiveRate]));

module.exports = {
  taxYearOf,
  bandsFor,
  allowancesFor,
  taxOnCoupons,
  taxByYear,
  ratesByYear,
  checkedAgainst: taxConfig.checkedAgainst,
};
