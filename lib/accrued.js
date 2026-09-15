// Accrued interest on conventional gilts, ACT/ACT (ICMA).
//
// Per £100 nominal. The buyer compensates the seller for the part of the
// current coupon period already elapsed - except inside the ex-dividend
// window, where the seller has already been assigned the whole coupon and it
// is the BUYER who is owed the unexpired part. Accrued interest is negative
// there, which is a real cash effect, not a sign convention: it is the one
// case where the dirty price is below the clean price.
const { toDate, daysBetween } = require('./calendar');
const { couponPeriod, exDivDate } = require('./giltCashflows');

function accruedInterest(gilt, settlement) {
  const s = toDate(settlement);
  const { start, end, days } = couponPeriod(gilt, s);
  const perCoupon = gilt.coupon / 2;

  if (s >= exDivDate(end)) {
    // Ex-dividend: rebate the unexpired portion to the buyer.
    return -perCoupon * (daysBetween(s, end) / days);
  }
  return perCoupon * (daysBetween(start, s) / days);
}

const dirtyPrice = (gilt, cleanPrice, settlement) => cleanPrice + accruedInterest(gilt, settlement);

const cleanPrice = (gilt, dirty, settlement) => dirty - accruedInterest(gilt, settlement);

const isExDiv = (gilt, settlement) => {
  const { end } = couponPeriod(gilt, toDate(settlement));
  return toDate(settlement) >= exDivDate(end);
};

module.exports = { accruedInterest, dirtyPrice, cleanPrice, isExDiv };
