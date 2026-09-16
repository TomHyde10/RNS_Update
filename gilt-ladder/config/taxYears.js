// UK savings-income allowances, by tax year.
//
// CHECK THESE BEFORE RELYING ON THEM. They are a configuration file, not a
// live feed, for the same reason config/gilts.js is: nothing publishes them in
// a form a server can fetch, and they change once a year at most. HMRC's
// "Income Tax rates and allowances" page is the source:
// https://www.gov.uk/government/collections/rates-and-allowances-hmrc
//
// A year that is not listed falls back to `default`, which is the most recent
// listed year. That is the safe direction - an unlisted future year is costed
// on today's allowances rather than on nothing - but it does mean a ladder
// running twenty years out is using today's figures for most of its life, and
// the result says so rather than implying the bands were known.
//
// All amounts are pounds of income per tax year.
const YEARS = {
  '2024/25': {
    personalAllowance: 12570,
    // The starting rate for savings: a £5,000 band taxed at 0%, reduced £1 for
    // £1 by non-savings income above the personal allowance. Someone with a
    // salary much over the personal allowance has none of it left.
    startingRateBand: 5000,
    // Personal Savings Allowance, by the band the taxpayer is in. An
    // additional-rate taxpayer gets none.
    personalSavingsAllowance: { 0.2: 1000, 0.4: 500, 0.45: 0 },
  },
  '2025/26': {
    personalAllowance: 12570,
    startingRateBand: 5000,
    personalSavingsAllowance: { 0.2: 1000, 0.4: 500, 0.45: 0 },
  },
};

module.exports = {
  years: YEARS,
  default: YEARS['2025/26'],
  // The year these figures were last checked against gov.uk, surfaced with the
  // result so a stale table is visible rather than assumed current.
  checkedAgainst: '2025/26',
};
