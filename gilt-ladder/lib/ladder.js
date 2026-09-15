// Builds a gilt ladder that funds a set of dated liabilities.
//
// Algorithm: backward cash-flow matching (the classic dedicated-portfolio
// construction). Starting from the LAST liability, pick a gilt redeeming on or
// before it, buy enough nominal for its redemption to cover that liability,
// then credit the coupons that holding throws off against the earlier
// liabilities and repeat.
//
// Why not the linear program the design originally called for: an LP minimises
// cost across the whole universe, but its optimum is typically 30+ holdings
// chosen to shave basis points, and it needs a MILP and a WASM solver to be
// constrained back down to something a person would actually place. Backward
// induction produces one rung per liability by construction - which is what a
// ladder IS - in a few hundred lines with no dependencies, and every holding
// traces to the liability it funds. The cost is that the result is not
// provably cost-minimal; `diagnostics.selection` records the runner-up for
// each rung so the gap is visible.
const { toDate, toISO, addBusinessDays, daysBetween } = require('./calendar');
const { cashflows } = require('./giltCashflows');
const { priceFromCurve, yearsBetween } = require('./bondMath');
const { discountTo } = require('./curve');

const DEFAULTS = {
  // Cash must land this many business days before the liability it funds.
  // Covers clearing plus the following-business-day payment rule; without it
  // a ladder can fund a liability with money that arrives the same morning.
  bufferBusinessDays: 5,
  // Gilts deal in fine increments, but a dealing instruction of "£38,412.67
  // nominal" is not one anybody wants to place. Rounded UP, so rounding can
  // only ever over-fund a rung.
  lotSize: 100,
  // Marginal income tax rate on coupons. 0 for an ISA or SIPP. Capital gains
  // on gilts are exempt for individuals, so redemption is never taxed - which
  // is exactly why a low-coupon gilt at a discount beats a high-coupon one at
  // a premium for a taxpayer, and why this materially changes gilt selection.
  marginalRate: 0,
  // T+1 is the gilt settlement convention.
  settlementBusinessDays: 1,
};

// Proceeds sitting in cash longer than this before the liability they fund
// get a warning - see `warnings` in summarise().
const IDLE_WARNING_DAYS = 365;

const afterTaxAmount = (flow, marginalRate) => flow.principal + flow.coupon * (1 - marginalRate);

// The flows a given nominal holding delivers, after tax, keyed by payment date.
function holdingFlows(gilt, nominal, settlement, marginalRate) {
  return cashflows(gilt, settlement).map((flow) => ({
    date: flow.paidOn,
    couponDate: flow.couponDate,
    amount: (nominal / 100) * afterTaxAmount(flow, marginalRate),
    gross: (nominal / 100) * flow.amount,
    isRedemption: flow.principal > 0,
  }));
}

// Cost of £1 delivered at this gilt's redemption, net of the coupons it pays
// along the way (valued off the curve). This is the selection criterion: it is
// tax-aware through afterTaxAmount, and crediting the intermediate coupons
// stops it preferring a zero-coupon-like gilt purely because its redemption
// row looks cheap in isolation.
function netCostPerUnit(gilt, settlement, curve, marginalRate) {
  const { dirty, flows } = priceFromCurve(gilt, settlement, curve);
  if (!flows.length) return null;

  const redemption = flows[flows.length - 1];
  const delivered = afterTaxAmount(redemption, marginalRate);
  if (delivered <= 0) return null;

  let pvIntermediate = 0;
  for (const flow of flows.slice(0, -1)) {
    pvIntermediate += afterTaxAmount(flow, marginalRate) * discountTo(curve, yearsBetween(settlement, flow.paidOn));
  }

  return { perUnit: (dirty - pvIntermediate) / delivered, dirty, delivered };
}

function buildLadder(request) {
  const options = { ...DEFAULTS, ...request };
  const { universe, curve, portfolioValue, marginalRate, lotSize, bufferBusinessDays } = options;

  const settlement = toISO(
    options.settlement || addBusinessDays(curve.date, options.settlementBusinessDays)
  );

  const liabilities = [...request.liabilities]
    .map((l) => ({ date: toISO(l.date), amount: Number(l.amount) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!liabilities.length) throw new Error('at least one liability is required');
  if (liabilities.some((l) => !(l.amount > 0))) throw new Error('liability amounts must be positive');
  if (liabilities[0].date <= settlement) {
    throw new Error(`first liability (${liabilities[0].date}) is not after settlement (${settlement})`);
  }

  // Latest date cash may arrive and still fund each liability.
  const fundBy = liabilities.map((l) => toISO(addBusinessDays(l.date, -bufferBusinessDays)));
  const residual = liabilities.map((l) => l.amount);

  const holdings = [];
  const selection = [];
  const unfunded = [];

  // Backwards: later rungs are chosen first, because the coupons they throw
  // off reduce what the earlier rungs need to buy.
  for (let i = liabilities.length - 1; i >= 0; i--) {
    if (residual[i] <= 0.005) continue; // already covered by coupons from later rungs

    // A gilt qualifies if it redeems in time to fund this rung. Preferring
    // those redeeming after the previous liability keeps each rung's principal
    // from sitting idle across an earlier liability it could have funded.
    const latest = fundBy[i];
    const earliest = i > 0 ? liabilities[i - 1].date : settlement;

    const priced = universe
      .map((gilt) => ({ gilt, cost: netCostPerUnit(gilt, settlement, curve, marginalRate) }))
      .filter((c) => c.cost && c.gilt.redemption <= latest);

    let candidates = priced.filter((c) => c.gilt.redemption > earliest);
    let widened = false;
    if (!candidates.length) {
      candidates = priced; // accept idle cash rather than fail the rung
      widened = true;
    }

    if (!candidates.length) {
      unfunded.push({ ...liabilities[i], shortfall: residual[i], reason: 'no gilt redeems before this date' });
      continue;
    }

    candidates.sort((a, b) => a.cost.perUnit - b.cost.perUnit);
    const chosen = candidates[0];
    const runnerUp = candidates[1];

    const exactNominal = (residual[i] / chosen.cost.delivered) * 100;
    const nominal = Math.ceil(exactNominal / lotSize) * lotSize;

    const flows = holdingFlows(chosen.gilt, nominal, settlement, marginalRate);
    const cost = (nominal / 100) * chosen.cost.dirty;

    holdings.push({
      isin: chosen.gilt.isin,
      name: chosen.gilt.name,
      coupon: chosen.gilt.coupon,
      redemption: chosen.gilt.redemption,
      nominal,
      dirtyPrice: chosen.cost.dirty,
      cost,
      fundsLiability: liabilities[i].date,
      // Days the redemption proceeds sit in cash before the liability falls due.
      idleDays: daysBetween(chosen.gilt.redemption, liabilities[i].date),
      widenedSearch: widened,
    });

    selection.push({
      liability: liabilities[i].date,
      chosen: chosen.gilt.name,
      perUnit: chosen.cost.perUnit,
      runnerUp: runnerUp ? { name: runnerUp.gilt.name, perUnit: runnerUp.cost.perUnit } : null,
      candidates: candidates.length,
    });

    // Credit every flow this holding produces against the earliest liability
    // the money can still reach. Processing backwards means the redemption
    // lands on this rung and the coupons fall to earlier ones.
    for (const flow of flows) {
      const target = liabilities.findIndex((l, j) => flow.date <= fundBy[j]);
      if (target === -1) continue; // arrives too late to fund anything - surplus
      residual[target] -= flow.amount;
    }
  }

  return summarise({ liabilities, holdings, selection, unfunded, residual, settlement, options });
}

function summarise({ liabilities, holdings, selection, unfunded, residual, settlement, options }) {
  const { curve, portfolioValue, marginalRate } = options;
  const totalCost = holdings.reduce((sum, h) => sum + h.cost, 0);

  // Rebuild the full cash flow calendar from the holdings actually bought, so
  // the coverage report is derived from the portfolio rather than from the
  // running residuals the construction used.
  const calendar = new Map();
  for (const holding of holdings) {
    const gilt = { name: holding.name, coupon: holding.coupon, redemption: holding.redemption };
    for (const flow of holdingFlows(gilt, holding.nominal, settlement, marginalRate)) {
      const entry = calendar.get(flow.date) || { date: flow.date, amount: 0, gross: 0 };
      entry.amount += flow.amount;
      entry.gross += flow.gross;
      calendar.set(flow.date, entry);
    }
  }
  const flows = [...calendar.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Walk forwards through time carrying cash, to confirm each liability is met
  // from money that had actually arrived by then.
  let cash = 0;
  let flowIndex = 0;
  const coverage = liabilities.map((liability, i) => {
    const deadline = toISO(addBusinessDays(liability.date, -options.bufferBusinessDays));
    while (flowIndex < flows.length && flows[flowIndex].date <= deadline) {
      cash += flows[flowIndex].amount;
      flowIndex++;
    }
    const covered = cash >= liability.amount - 0.005;
    cash -= liability.amount;
    return {
      date: liability.date,
      amount: liability.amount,
      covered,
      shortfall: covered ? 0 : liability.amount - (cash + liability.amount),
      surplusCarried: Math.max(0, cash),
    };
  });

  const leftover = cash + flows.slice(flowIndex).reduce((sum, f) => sum + f.amount, 0);
  const shortfalls = coverage.filter((c) => !c.covered);

  // A rung whose gilt redeems long before the liability still funds it - the
  // money just sits in cash until then. With no reinvestment assumed that is
  // modelled correctly but is real drag, and it means no gilt matched the
  // liability's date well. Worth saying out loud rather than burying in
  // `idleDays`, since the usual cause is a liability beyond the longest gilt.
  const warnings = holdings
    .filter((h) => h.idleDays > IDLE_WARNING_DAYS)
    .map((h) => ({
      type: 'idle-cash',
      liability: h.fundsLiability,
      isin: h.isin,
      idleDays: h.idleDays,
      message:
        `${h.name} redeems ${h.idleDays} days before the ${h.fundsLiability} liability; ` +
        'the proceeds sit in cash until then, earning nothing in this model.',
    }));

  return {
    settlement,
    curveDate: curve.date,
    marginalRate,
    holdings: holdings.sort((a, b) => a.redemption.localeCompare(b.redemption)),
    coverage,
    cashflows: flows,
    totals: {
      liabilities: liabilities.reduce((sum, l) => sum + l.amount, 0),
      cost: totalCost,
      portfolioValue,
      // Positive: the portfolio covers the liabilities with this much to spare.
      // Negative: it does not, by this much.
      surplus: portfolioValue == null ? null : portfolioValue - totalCost,
      residualCash: leftover,
      holdingCount: holdings.length,
    },
    fullyFunded: shortfalls.length === 0 && unfunded.length === 0,
    warnings,
    unfunded: [...unfunded, ...shortfalls.filter((s) => s.shortfall > 0.005)],
    diagnostics: { selection, finalResiduals: residual },
  };
}

module.exports = { buildLadder, DEFAULTS, netCostPerUnit, holdingFlows, afterTaxAmount };
