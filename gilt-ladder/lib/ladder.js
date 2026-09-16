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
const {
  priceFromCurve,
  yearsBetween,
  yieldFromPrice,
  macaulayDuration,
  modifiedDuration,
  streamDuration,
} = require('./bondMath');
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
  // Accrued Income Scheme: 'auto', true or false. 'auto' applies it whenever
  // there is tax to relieve and the ladder is large enough to be within the
  // scheme - see AIS_NOMINAL_THRESHOLD.
  accruedIncomeScheme: 'auto',
};

// Proceeds sitting in cash longer than this before the liability they fund
// get a warning - see `warnings` in summarise().
const IDLE_WARNING_DAYS = 365;

const afterTaxAmount = (flow, marginalRate) => flow.principal + flow.coupon * (1 - marginalRate);

// Accrued Income Scheme. Taxing every coupon in full is wrong for the first
// one a buyer receives, and a ladder buys mid-period on every rung by
// construction, so it was wrong on every rung.
//
// Buying CUM-DIVIDEND you pay the seller for the interest that accrued before
// you owned the gilt, then receive the whole coupon; AIS gives you relief for
// what you paid, so you are taxed only on interest that accrued while it was
// yours. Buying EX-DIVIDEND the seller keeps the coupon and rebates you the
// unexpired part, and the scheme runs the other way: that rebate is a charge.
//
// Both are the same arithmetic - taxable = coupon - accrued - because accrued
// is already negative inside the ex-dividend window, so no case analysis is
// needed here. `lib/accrued.js` earns that.
//
// Relief is capped at the coupon it attaches to. In law it is relief against
// interest income generally, so a very large accrued payment could reduce tax
// on other income; modelling that would mean knowing about holdings this
// application cannot see, and stopping at zero is the conservative direction.
const AIS_NOMINAL_THRESHOLD = 5000;

function taxableCoupon(flow, index, aisRelief) {
  if (index !== 0 || !aisRelief) return flow.coupon;
  return Math.max(0, flow.coupon - aisRelief);
}

// After-tax value of a flow, given its position in the holding's own schedule -
// only the first flow carries AIS relief. `aisRelief` is per £100 nominal, the
// same unit as the flow.
const afterTaxAmountAt = (flow, index, marginalRate, aisRelief) =>
  flow.principal + flow.coupon - taxableCoupon(flow, index, aisRelief) * marginalRate;

// The flows a given nominal holding delivers, after tax, keyed by payment date.
function holdingFlows(gilt, nominal, settlement, marginalRate, aisRelief = 0) {
  return cashflows(gilt, settlement).map((flow, index) => ({
    date: flow.paidOn,
    couponDate: flow.couponDate,
    amount: (nominal / 100) * afterTaxAmountAt(flow, index, marginalRate, aisRelief),
    gross: (nominal / 100) * flow.amount,
    isRedemption: flow.principal > 0,
  }));
}

// Cost of £1 delivered at this gilt's redemption, net of the coupons it pays
// along the way (valued off the curve). This is the selection criterion: it is
// tax-aware through afterTaxAmount, and crediting the intermediate coupons
// stops it preferring a zero-coupon-like gilt purely because its redemption
// row looks cheap in isolation.
//
// `observedClean` is a real quoted clean price for this gilt, supplied by the
// user from their broker. When present it replaces the curve-derived price for
// THIS gilt's purchase cost only: the intermediate coupons are still valued off
// the curve, because a quoted price is a price for the whole bond today and
// says nothing about what its individual future coupons are worth. Mixing the
// two is the honest construction - the leg you can observe is observed, the leg
// you cannot is still modelled - and `source` records which.
function netCostPerUnit(gilt, settlement, curve, marginalRate, { observedClean = null, accruedIncomeScheme = false } = {}) {
  const priced = priceFromCurve(gilt, settlement, curve);
  const flows = priced.flows;
  if (!flows.length) return null;

  // Relief is set by the accrued the buyer pays, which is a property of the
  // gilt and the settlement date - not of the price, quoted or derived.
  const aisRelief = accruedIncomeScheme ? priced.accrued : 0;

  const last = flows.length - 1;
  const redemption = flows[last];
  const delivered = afterTaxAmountAt(redemption, last, marginalRate, aisRelief);
  if (delivered <= 0) return null;

  // Accrued is the buyer's either way, so an observed CLEAN price becomes the
  // dirty price the same way the derived one does. In the ex-dividend window
  // accrued is negative and dirty falls below clean, which is correct.
  const dirty = observedClean == null ? priced.dirty : observedClean + priced.accrued;

  let pvIntermediate = 0;
  for (let i = 0; i < last; i++) {
    pvIntermediate +=
      afterTaxAmountAt(flows[i], i, marginalRate, aisRelief) *
      discountTo(curve, yearsBetween(settlement, flows[i].paidOn));
  }

  return {
    perUnit: (dirty - pvIntermediate) / delivered,
    aisRelief,
    dirty,
    delivered,
    clean: dirty - priced.accrued,
    accrued: priced.accrued,
    source: observedClean == null ? 'derived' : 'observed',
    // True when any of this gilt's cash flows was priced off a rate held flat
    // beyond the curve's published range.
    extrapolated: priced.extrapolated,
    // ...which on its own is too blunt to act on. The BoE curve starts at 0.5
    // years, so all but the very shortest gilts have a coupon inside that and
    // come back extrapolated - and discounting a coupon two months out at the
    // six-month rate is a rounding error. The extrapolation that matters is at
    // the other end: a redemption past 40 years is the whole principal priced
    // off a rate nobody published. Only that is worth a warning.
    beyondCurve: yearsBetween(settlement, redemption.paidOn) > curve.points[curve.points.length - 1].years,
  };
}

// Yield and duration for a holding. All three of these were written, exported
// and never called; a ladder that cannot tell you what it yields or how long
// its money is tied up is answering less than it knows.
//
// The yield is solved against the price actually PAID, so a quoted price gives
// the yield that quote implies rather than the curve's. Duration stays on the
// curve's own basis, matching the portfolio-level figures in summarise() so
// the asset and liability sides are measured the same way.
function riskMeasures(gilt, settlement, curve, dirty) {
  const gry = yieldFromPrice(gilt, settlement, dirty);
  const macaulay = macaulayDuration(gilt, settlement, curve);
  return {
    grossRedemptionYield: gry,
    macaulayDuration: macaulay,
    modifiedDuration: gry == null ? null : modifiedDuration(macaulay, gry),
  };
}

function buildLadder(request) {
  const options = { ...DEFAULTS, ...request };
  const { universe, curve, portfolioValue, marginalRate, lotSize, bufferBusinessDays } = options;

  // With no tax there is nothing for the scheme to relieve, so an ISA or SIPP
  // is unaffected either way and the arithmetic is skipped rather than
  // multiplied by zero.
  const aisMode = options.accruedIncomeScheme;
  const accruedIncomeScheme = marginalRate > 0 && (aisMode === 'auto' || aisMode === true);

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

  // Observed clean prices, keyed by ISIN. These are quotes the user has copied
  // from their broker: the one input that turns an indicative ladder into a
  // dealable one, since nothing in this application can fetch a real price.
  const observedPrices = new Map(
    (request.observedPrices || [])
      .filter((p) => p && p.isin != null && Number.isFinite(Number(p.clean)))
      .map((p) => [String(p.isin).trim().toUpperCase(), Number(p.clean)])
  );
  // A price for a gilt that is not in the universe is almost always a typo in
  // an ISIN, and silently ignoring it would leave the user believing they had
  // priced a rung they had not. Reported, not dropped.
  const universeIsins = new Set(universe.map((g) => g.isin));
  const ignoredPrices = [...observedPrices.keys()].filter((isin) => !universeIsins.has(isin));

  // Latest date cash may arrive and still fund each liability.
  const fundBy = liabilities.map((l) => toISO(addBusinessDays(l.date, -bufferBusinessDays)));
  const residual = liabilities.map((l) => l.amount);

  // Credit the flow to the earliest liability the money can still reach.
  // Shared by gilts already owned and by the rungs bought below, so both sides
  // of the portfolio are applied under exactly the same rule.
  const creditAgainstLiabilities = (flows) => {
    for (const flow of flows) {
      const target = liabilities.findIndex((l, j) => flow.date <= fundBy[j]);
      if (target === -1) continue; // arrives too late to fund anything - surplus
      residual[target] -= flow.amount;
    }
  };

  // Gilts already owned. Their coupons and redemptions fund liabilities exactly
  // as a bought rung's would, so crediting them first means the ladder is
  // constructed against the SHORTFALL rather than against the whole liability -
  // which is the question anyone who already holds gilts is actually asking.
  //
  // No Accrued Income Scheme relief: relief attaches to accrued interest paid
  // at a purchase, and these were bought at some earlier date this application
  // knows nothing about.
  const byIsin = new Map(universe.map((g) => [g.isin, g]));
  const existing = [];
  const unknownHoldings = [];
  for (const entry of request.existingHoldings || []) {
    if (!entry || entry.isin == null) continue;
    const isin = String(entry.isin).trim().toUpperCase();
    const nominal = Number(entry.nominal);
    if (!(nominal > 0)) continue;

    const gilt = byIsin.get(isin);
    if (!gilt) {
      unknownHoldings.push(isin);
      continue;
    }

    const priced = netCostPerUnit(gilt, settlement, curve, marginalRate, {
      observedClean: observedPrices.get(isin) ?? null,
    });
    const flows = holdingFlows(gilt, nominal, settlement, marginalRate, 0);
    creditAgainstLiabilities(flows);

    existing.push({
      isin,
      name: gilt.name,
      coupon: gilt.coupon,
      redemption: gilt.redemption,
      nominal,
      cleanPrice: priced ? priced.clean : null,
      accrued: priced ? priced.accrued : null,
      priceSource: priced ? priced.source : null,
      // What it is worth now, not what it cost: this is not money to be spent,
      // it is money already committed, and it must not land in totals.cost.
      value: priced ? (nominal / 100) * priced.dirty : null,
      aisRelief: 0,
    });
  }

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
      .map((gilt) => ({
        gilt,
        cost: netCostPerUnit(gilt, settlement, curve, marginalRate, {
          observedClean: observedPrices.get(gilt.isin) ?? null,
          accruedIncomeScheme,
        }),
      }))
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

    const flows = holdingFlows(chosen.gilt, nominal, settlement, marginalRate, chosen.cost.aisRelief);
    const cost = (nominal / 100) * chosen.cost.dirty;

    holdings.push({
      isin: chosen.gilt.isin,
      name: chosen.gilt.name,
      coupon: chosen.gilt.coupon,
      redemption: chosen.gilt.redemption,
      nominal,
      dirtyPrice: chosen.cost.dirty,
      // The clean price is what a gilt is quoted and dealt on; accrued is the
      // separate line on the contract note. A dealing instruction needs both,
      // and showing them is what makes an observed price checkable against the
      // screen it was copied from.
      cleanPrice: chosen.cost.clean,
      accrued: chosen.cost.accrued,
      priceSource: chosen.cost.source,
      extrapolated: chosen.cost.extrapolated,
      beyondCurve: chosen.cost.beyondCurve,
      // Per £100 nominal, positive cum-dividend and negative ex-dividend. Kept
      // on the holding so summarise() rebuilds exactly the flows that were
      // chosen against, and so the relief is auditable rather than implicit.
      aisRelief: chosen.cost.aisRelief,
      cost,
      ...riskMeasures(chosen.gilt, settlement, curve, chosen.cost.dirty),
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
    creditAgainstLiabilities(flows);
  }

  // The scheme only catches an individual holding over £5,000 nominal of
  // these securities. Which gilts get bought depends on the tax treatment, and
  // the tax treatment depends on how much gets bought, so 'auto' resolves it
  // by building once and rebuilding if the answer came out too small to
  // qualify. It terminates: the second pass is pinned to an explicit false.
  if (aisMode === 'auto' && accruedIncomeScheme) {
    const totalNominal = holdings.reduce((sum, h) => sum + h.nominal, 0);
    if (totalNominal <= AIS_NOMINAL_THRESHOLD) {
      return buildLadder({ ...request, settlement, accruedIncomeScheme: false });
    }
  }

  return summarise({
    liabilities,
    holdings,
    selection,
    unfunded,
    residual,
    settlement,
    options,
    accruedIncomeScheme,
    existing,
    pricing: { observed: observedPrices.size, ignored: ignoredPrices, unknownHoldings },
  });
}

function summarise({
  liabilities,
  holdings,
  existing,
  selection,
  unfunded,
  residual,
  settlement,
  options,
  accruedIncomeScheme,
  pricing,
}) {
  const { curve, portfolioValue, marginalRate } = options;
  const totalCost = holdings.reduce((sum, h) => sum + h.cost, 0);

  // Rebuild the full cash flow calendar from the holdings actually bought, so
  // the coverage report is derived from the portfolio rather than from the
  // running residuals the construction used.
  // Gilts already owned throw off exactly the same kind of cash as ones bought
  // today, so the coverage report has to see both. They differ only in that
  // they cost nothing now.
  const calendar = new Map();
  for (const holding of [...existing, ...holdings]) {
    const gilt = { name: holding.name, coupon: holding.coupon, redemption: holding.redemption };
    for (const flow of holdingFlows(gilt, holding.nominal, settlement, marginalRate, holding.aisRelief)) {
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

  const assetSide = streamDuration(flows, settlement, curve);
  const liabilitySide = streamDuration(liabilities, settlement, curve);

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

  // A redemption past the end of the curve is not wrong so much as
  // unsupported: nothing was published out there to fit to, and it is the
  // rung's principal - not a stray coupon - resting on the extrapolation.
  for (const holding of holdings.filter((h) => h.beyondCurve)) {
    warnings.push({
      type: 'extrapolated-price',
      isin: holding.isin,
      message:
        `${holding.name} redeems beyond the published end of the curve, so its price rests on ` +
        'the longest rate held flat rather than on a fitted one.',
    });
  }

  for (const isin of pricing.ignored) {
    warnings.push({
      type: 'price-ignored',
      isin,
      message: `No gilt in the universe has ISIN ${isin}, so the price given for it was not used.`,
    });
  }

  // A holding that matched nothing has been left out of the funding entirely,
  // which quietly overstates what still needs buying. Never silent.
  for (const isin of pricing.unknownHoldings) {
    warnings.push({
      type: 'holding-ignored',
      isin,
      message:
        `You said you hold ${isin}, but no gilt in the universe has that ISIN - it may have ` +
        'redeemed, or be index-linked, which this application excludes. It was not counted.',
    });
  }

  return {
    settlement,
    curveDate: curve.date,
    marginalRate,
    // What tax treatment this answer was actually built under. The scheme
    // changes which gilts get chosen, so it cannot be left implicit.
    tax: {
      marginalRate,
      accruedIncomeScheme,
      nominalThreshold: AIS_NOMINAL_THRESHOLD,
      totalNominal: holdings.reduce((sum, h) => sum + h.nominal, 0),
    },
    holdings: holdings.sort((a, b) => a.redemption.localeCompare(b.redemption)),
    // Kept apart from `holdings` on purpose: `holdings` is a dealing list, and
    // nothing in it should be something the user already owns.
    existing: existing.sort((a, b) => a.redemption.localeCompare(b.redemption)),
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
      // What gilts already held are worth today. Not part of `cost`, which is
      // cash that still has to be spent.
      existingValue: existing.reduce((sum, h) => sum + (h.value || 0), 0),
      existingCount: existing.length,
    },
    fullyFunded: shortfalls.length === 0 && unfunded.length === 0,
    warnings,
    unfunded: [...unfunded, ...shortfalls.filter((s) => s.shortfall > 0.005)],
    // The check the ladder's own construction is supposed to pass: cash-flow
    // matching should land the assets' duration close to the liabilities', so
    // a wide gap means the universe could not match the dates and the result
    // is more exposed to a move in rates than a matched ladder should be. Both
    // sides are measured off the curve so they are comparable.
    analytics: {
      assets: { pv: assetSide.pv, duration: assetSide.duration },
      liabilities: { pv: liabilitySide.pv, duration: liabilitySide.duration },
      durationGap: assetSide.duration - liabilitySide.duration,
    },
    // How much of this answer rests on prices that were observed rather than
    // derived. `pricedRungs` counts the holdings actually bought at a quoted
    // price, which is the number that decides whether the total cost means
    // anything in the market.
    pricing: {
      observedPrices: pricing.observed,
      pricedRungs: holdings.filter((h) => h.priceSource === 'observed').length,
      derivedRungs: holdings.filter((h) => h.priceSource !== 'observed').length,
      ignored: pricing.ignored,
    },
    diagnostics: { selection, finalResiduals: residual },
  };
}

module.exports = {
  buildLadder,
  DEFAULTS,
  netCostPerUnit,
  holdingFlows,
  afterTaxAmount,
  afterTaxAmountAt,
  AIS_NOMINAL_THRESHOLD,
};
