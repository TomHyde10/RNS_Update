// THIS IS SAMPLE DATA. IT IS NOT REAL GILT DATA AND MUST NOT BE USED TO MAKE
// AN INVESTMENT DECISION.
//
// Every entry below is invented: the ISINs use the reserved "ZZ" country
// prefix so they cannot collide with a real instrument, and the coupons and
// redemption dates are made up. It exists so the application runs, and so the
// shape of a real universe is documented, nothing more. `source: 'sample'` is
// surfaced by /gilt-ladder/api/universe and the UI renders an unmissable banner while it
// is set.
//
// To replace it with the real universe:
//   1. Open https://www.dmo.gov.uk/data/pdfdatareport?reportCode=D1A in a
//      BROWSER and export the "Gilts in Issue" report as Excel. This step is
//      manual because dmo.gov.uk blocks automated clients - see
//      scripts/phase0-data-probe.js.
//   2. node gilt-ladder/scripts/build-universe.js <the-downloaded-file.xlsx>
//
// That regenerates this file with `source: 'dmo'` and the report's own as-at
// date. Do it when a new gilt is issued or one redeems - a few times a year.
module.exports = {
  source: 'sample',
  asOf: null,
  gilts: [
    { name: 'SAMPLE 2027 (low coupon)', isin: 'ZZ0000SAMP01', coupon: 0.25, redemption: '2027-01-31' },
    { name: 'SAMPLE 2027 (high coupon)', isin: 'ZZ0000SAMP02', coupon: 4.75, redemption: '2027-07-31' },
    { name: 'SAMPLE 2028 (low coupon)', isin: 'ZZ0000SAMP03', coupon: 0.5, redemption: '2028-01-31' },
    { name: 'SAMPLE 2028 (high coupon)', isin: 'ZZ0000SAMP04', coupon: 6.0, redemption: '2028-09-30' },
    { name: 'SAMPLE 2029', isin: 'ZZ0000SAMP05', coupon: 0.875, redemption: '2029-03-31' },
    { name: 'SAMPLE 2030 (low coupon)', isin: 'ZZ0000SAMP06', coupon: 0.375, redemption: '2030-04-30' },
    { name: 'SAMPLE 2030 (high coupon)', isin: 'ZZ0000SAMP07', coupon: 5.25, redemption: '2030-10-31' },
    { name: 'SAMPLE 2031', isin: 'ZZ0000SAMP08', coupon: 1.0, redemption: '2031-05-31' },
    { name: 'SAMPLE 2032', isin: 'ZZ0000SAMP09', coupon: 4.25, redemption: '2032-03-31' },
    { name: 'SAMPLE 2033', isin: 'ZZ0000SAMP10', coupon: 0.625, redemption: '2033-07-31' },
    { name: 'SAMPLE 2034', isin: 'ZZ0000SAMP11', coupon: 4.5, redemption: '2034-09-30' },
    { name: 'SAMPLE 2036', isin: 'ZZ0000SAMP12', coupon: 1.25, redemption: '2036-10-31' },
    { name: 'SAMPLE 2038', isin: 'ZZ0000SAMP13', coupon: 4.75, redemption: '2038-12-07' },
    { name: 'SAMPLE 2040', isin: 'ZZ0000SAMP14', coupon: 3.25, redemption: '2040-01-31' },
    { name: 'SAMPLE 2043', isin: 'ZZ0000SAMP15', coupon: 4.5, redemption: '2043-12-07' },
    { name: 'SAMPLE 2046', isin: 'ZZ0000SAMP16', coupon: 3.5, redemption: '2046-07-22' },
    { name: 'SAMPLE 2049', isin: 'ZZ0000SAMP17', coupon: 1.75, redemption: '2049-01-22' },
    { name: 'SAMPLE 2052', isin: 'ZZ0000SAMP18', coupon: 3.75, redemption: '2052-10-22' },
    { name: 'SAMPLE 2055', isin: 'ZZ0000SAMP19', coupon: 4.25, redemption: '2055-07-31' },
  ],
};
