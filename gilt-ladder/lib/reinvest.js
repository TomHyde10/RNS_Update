// What happens to money that arrives before it is needed.
//
// The model's default is that it sits in cash earning nothing. That is
// deliberately conservative and it is also, for anyone who actually holds the
// cash, wrong - a redemption three years early is three years of deposit
// interest not being counted. But assuming a reinvestment rate is an
// assumption, and the wrong one flatters the ladder into looking cheaper than
// it is, so it stays opt-in and the default does not move.
//
// The rate assumed is the curve's OWN implied forward rate between the two
// dates. Nothing is invented: it is the rate already embedded in the spot
// curve being used to price everything else, so a ladder priced off a curve is
// reinvested at the same curve's view of the future. It is not a deposit rate
// anyone is offering, and a gilt's forward rate is not obtainable in a bank
// account - which is why it is labelled an assumption rather than a forecast.
const { discountTo } = require('./curve');
const { yearsBetween } = require('./bondMath');

// The factor money at `from` grows by if left until `to`, under the curve's
// implied forwards: DF(from) / DF(to), both measured from settlement. Always
// at least 1 for an upward curve, and never less than 1 here even if the curve
// inverts far enough to imply negative forwards - a modelled negative deposit
// rate would be a worse assumption than the zero-growth default it replaced.
function growthFactor(curve, settlement, from, to) {
  if (!curve || to <= from) return 1;
  const dfFrom = discountTo(curve, yearsBetween(settlement, from));
  const dfTo = discountTo(curve, yearsBetween(settlement, to));
  if (!(dfTo > 0)) return 1;
  return Math.max(1, dfFrom / dfTo);
}

// Interest is savings income like any coupon, so it is taxed at the same rate
// the destination tax year bears. Only the interest is taxed; the money that
// arrived was already taxed on its way in.
function reinvested(amount, factor, rate = 0) {
  if (factor <= 1) return amount;
  return amount + amount * (factor - 1) * (1 - rate);
}

// The whole operation in one call: what `amount`, arriving on `from`, is worth
// by `to`. With reinvestment off this is the identity, which is what keeps the
// default path exactly as it was.
function valueAt(amount, { curve, settlement, from, to, rate = 0, enabled = false }) {
  if (!enabled) return amount;
  return reinvested(amount, growthFactor(curve, settlement, from, to), rate);
}

module.exports = { growthFactor, reinvested, valueAt };
