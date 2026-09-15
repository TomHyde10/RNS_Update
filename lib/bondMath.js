// Pricing and risk measures for conventional gilts, per £100 nominal.
const { daysBetween } = require('./calendar');
const { cashflows } = require('./giltCashflows');
const { accruedInterest } = require('./accrued');
const { discountTo, isExtrapolated } = require('./curve');

// ACT/365 for discounting. This is the curve's own time axis, and is a
// separate question from the ACT/ACT convention used for accrued interest -
// the two coexist deliberately and are not interchangeable.
const YEAR_DAYS = 365;
const yearsBetween = (from, to) => daysBetween(from, to) / YEAR_DAYS;

// Present value of a gilt's remaining cash flows, discounted off the spot
// curve. Returns the dirty price (what you pay) and the clean price (what is
// quoted), which differ by accrued interest.
function priceFromCurve(gilt, settlement, curve) {
  const flows = cashflows(gilt, settlement);
  let dirty = 0;
  let extrapolated = false;

  for (const flow of flows) {
    const t = yearsBetween(settlement, flow.paidOn);
    if (isExtrapolated(curve, t)) extrapolated = true;
    dirty += flow.amount * discountTo(curve, t);
  }

  const accrued = accruedInterest(gilt, settlement);
  return {
    dirty,
    clean: dirty - accrued,
    accrued,
    flows,
    // True when any cash flow falls outside the curve's published range and
    // was priced off a flat-extrapolated rate. Surfaced so the UI can say so
    // rather than presenting an extrapolated price as if it were fitted.
    extrapolated,
  };
}

// Gross redemption yield, semi-annually compounded - the convention gilts are
// quoted on. Solved by bisection rather than Newton: it cannot diverge, and
// the extra iterations are irrelevant at this scale.
function yieldFromPrice(gilt, settlement, dirtyPrice, { tolerance = 1e-10, maxIterations = 200 } = {}) {
  const flows = cashflows(gilt, settlement);
  if (!flows.length) return null;

  const pv = (y) =>
    flows.reduce((sum, f) => sum + f.amount / (1 + y / 2) ** (2 * yearsBetween(settlement, f.paidOn)), 0);

  let lo = -0.9;
  let hi = 2.0;
  if (pv(lo) < dirtyPrice || pv(hi) > dirtyPrice) return null; // price outside solvable range

  for (let i = 0; i < maxIterations; i++) {
    const mid = (lo + hi) / 2;
    const diff = pv(mid) - dirtyPrice;
    if (Math.abs(diff) < tolerance) return mid;
    if (diff > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Macaulay duration in years, discounting off the curve. For a cash-flow
// matched ladder this should sit close to the liabilities' own duration by
// construction; it is reported as a check on that, not as an input.
function macaulayDuration(gilt, settlement, curve) {
  const flows = cashflows(gilt, settlement);
  let pv = 0;
  let weighted = 0;
  for (const flow of flows) {
    const t = yearsBetween(settlement, flow.paidOn);
    const value = flow.amount * discountTo(curve, t);
    pv += value;
    weighted += value * t;
  }
  return pv === 0 ? 0 : weighted / pv;
}

// Duration of an arbitrary dated cash flow stream, same basis - used for the
// liability side, which has no coupon structure.
function streamDuration(stream, from, curve) {
  let pv = 0;
  let weighted = 0;
  for (const { date, amount } of stream) {
    const t = yearsBetween(from, date);
    const value = amount * discountTo(curve, t);
    pv += value;
    weighted += value * t;
  }
  return { pv, duration: pv === 0 ? 0 : weighted / pv };
}

const modifiedDuration = (macaulay, yieldRate) => macaulay / (1 + yieldRate / 2);

module.exports = {
  YEAR_DAYS,
  yearsBetween,
  priceFromCurve,
  yieldFromPrice,
  macaulayDuration,
  streamDuration,
  modifiedDuration,
};
