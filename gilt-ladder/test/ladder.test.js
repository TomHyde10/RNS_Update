const test = require('node:test');
const assert = require('node:assert');
const {
  buildLadder,
  netCostPerUnit,
  holdingFlows,
  afterTaxAmountAt,
  AIS_NOMINAL_THRESHOLD,
  DEFAULTS,
} = require('../lib/ladder');
const { discountTo } = require('../lib/curve');
const { yearsBetween } = require('../lib/bondMath');

const curve = {
  date: '2026-09-14',
  points: Array.from({ length: 80 }, (_, i) => ({ years: (i + 1) * 0.5, rate: 0.045 })),
};

// Synthetic universe: nothing here asserts anything about a real gilt.
const universe = [
  { isin: 'TEST00000001', name: '0.5% Test 2028', coupon: 0.5, redemption: '2028-03-31' },
  { isin: 'TEST00000002', name: '6% Test 2028', coupon: 6, redemption: '2028-03-31' },
  { isin: 'TEST00000003', name: '1% Test 2030', coupon: 1, redemption: '2030-03-31' },
  { isin: 'TEST00000004', name: '4% Test 2032', coupon: 4, redemption: '2032-03-31' },
  { isin: 'TEST00000005', name: '2% Test 2035', coupon: 2, redemption: '2035-03-31' },
];

const base = { curve, universe, settlement: '2026-09-15' };

test('a single liability produces a single rung that covers it', () => {
  const result = buildLadder({ ...base, liabilities: [{ date: '2030-06-30', amount: 50000 }] });

  assert.equal(result.holdings.length, 1);
  assert.ok(result.fullyFunded);
  assert.equal(result.coverage[0].covered, true);
  assert.deepEqual(result.unfunded, []);
  // The rung must redeem before the liability, not after it.
  assert.ok(result.holdings[0].redemption <= '2030-06-30');
});

test('every liability is covered by cash that has already arrived', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-09-30', amount: 20000 },
      { date: '2030-09-30', amount: 25000 },
      { date: '2032-09-30', amount: 30000 },
      { date: '2035-09-30', amount: 40000 },
    ],
  });

  assert.ok(result.fullyFunded, `unfunded: ${JSON.stringify(result.unfunded)}`);
  for (const c of result.coverage) assert.ok(c.covered, `${c.date} not covered`);
  assert.ok(result.totals.cost > 0);
});

// The selection criterion is coupon-neutral on a flat curve when untaxed: a
// fairly-priced gilt costs the same per £1 delivered whatever its coupon. This
// pins that down, so the tax effect below is demonstrably caused by tax and
// not by an accidental bias in the criterion.
test('gilt selection is coupon-neutral with no tax', () => {
  const lowCoupon = netCostPerUnit(universe[0], '2026-09-15', curve, 0);
  const highCoupon = netCostPerUnit(universe[1], '2026-09-15', curve, 0);

  assert.ok(
    Math.abs(lowCoupon.perUnit - highCoupon.perUnit) < 1e-9,
    `expected equal cost per unit, got ${lowCoupon.perUnit} vs ${highCoupon.perUnit}`
  );
  // And it equals the plain discount factor to redemption.
  const df = discountTo(curve, yearsBetween('2026-09-15', '2028-03-31'));
  assert.ok(Math.abs(lowCoupon.perUnit - df) < 1e-4);
});

// The point of the whole tool for a taxpayer holding outside a wrapper: gilt
// coupons are taxed as income but redemption is CGT-exempt, so a low-coupon
// gilt at a discount beats a high-coupon one at a premium.
test('a taxpayer is steered to the low-coupon gilt', () => {
  const untaxed = buildLadder({ ...base, marginalRate: 0, liabilities: [{ date: '2028-06-30', amount: 30000 }] });
  const taxed = buildLadder({ ...base, marginalRate: 0.45, liabilities: [{ date: '2028-06-30', amount: 30000 }] });

  assert.equal(taxed.holdings[0].name, '0.5% Test 2028', 'higher-rate taxpayer should prefer the low coupon');
  assert.ok(taxed.holdings[0].coupon < universe[1].coupon);

  const lowUnderTax = netCostPerUnit(universe[0], '2026-09-15', curve, 0.45).perUnit;
  const highUnderTax = netCostPerUnit(universe[1], '2026-09-15', curve, 0.45).perUnit;
  assert.ok(lowUnderTax < highUnderTax, 'tax must make the high-coupon gilt worse per £1 delivered');

  // Untaxed the two are interchangeable, so cost should be near-identical.
  assert.ok(untaxed.totals.cost > 0);
});

test('nominal is rounded up to whole lots, never down', () => {
  const result = buildLadder({
    ...base,
    lotSize: 1000,
    liabilities: [{ date: '2030-06-30', amount: 33333 }],
  });
  const holding = result.holdings[0];
  assert.equal(holding.nominal % 1000, 0);
  assert.ok(result.coverage[0].covered, 'rounding up must not under-fund');
});

test('the settlement buffer is respected', () => {
  const result = buildLadder({
    ...base,
    bufferBusinessDays: 10,
    liabilities: [{ date: '2030-06-30', amount: 10000 }],
  });
  // Redemption must clear the liability date by at least the buffer.
  const holding = result.holdings[0];
  assert.ok(holding.redemption < '2030-06-30');
  assert.ok(result.coverage[0].covered);
});

test('coupons from later rungs reduce what earlier rungs must buy', () => {
  // A long liability funded by a high-coupon gilt throws off enough income to
  // shrink, and can entirely remove, the rungs in front of it.
  const withSmallEarly = buildLadder({
    ...base,
    liabilities: [
      { date: '2031-06-30', amount: 100 },
      { date: '2035-06-30', amount: 200000 },
    ],
  });
  assert.ok(withSmallEarly.fullyFunded);
  // The tiny early liability should be met from the long gilt's coupons rather
  // than needing a rung of its own.
  assert.equal(withSmallEarly.holdings.length, 1);
});

// A liability beyond the longest gilt is still fundable - the proceeds just
// sit in cash until it falls due. With no reinvestment assumed that is
// modelled correctly, but it is real drag and the usual sign that nothing in
// the universe matches the liability's date, so it has to be visible.
test('a liability beyond the longest gilt is funded but flagged as idle cash', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2050-06-30', amount: 10000 }],
  });

  assert.ok(result.fullyFunded, 'cash held to maturity does still fund it');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].type, 'idle-cash');
  assert.ok(result.warnings[0].idleDays > 5000, 'roughly 15 years of idle cash');
  assert.equal(result.holdings[0].redemption, '2035-03-31', 'uses the longest gilt available');
});

test('a well-matched ladder produces no idle-cash warnings', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-06-30', amount: 10000 },
      { date: '2030-06-30', amount: 10000 },
    ],
  });
  assert.deepEqual(result.warnings, []);
});

test('surplus and shortfall are reported against the portfolio value', () => {
  const liabilities = [{ date: '2030-06-30', amount: 50000 }];

  const rich = buildLadder({ ...base, portfolioValue: 1000000, liabilities });
  assert.ok(rich.totals.surplus > 0);

  const poor = buildLadder({ ...base, portfolioValue: 100, liabilities });
  assert.ok(poor.totals.surplus < 0);
  // The ladder itself is still constructible - affordability is reported, not
  // enforced, so the user learns what it would actually cost.
  assert.ok(poor.fullyFunded);
});

test('invalid requests fail loudly', () => {
  assert.throws(() => buildLadder({ ...base, liabilities: [] }), /at least one liability/);
  assert.throws(
    () => buildLadder({ ...base, liabilities: [{ date: '2030-01-01', amount: -5 }] }),
    /must be positive/
  );
  assert.throws(
    () => buildLadder({ ...base, liabilities: [{ date: '2020-01-01', amount: 5 }] }),
    /not after settlement/
  );
});

// --- Observed clean prices -------------------------------------------------
//
// Prices here are derived from a curve and are not dealable; a quote the user
// copies from their broker is the only real price this application can ever
// see. These pin down that such a quote reaches the cost, reaches selection,
// and is reported as observed rather than blending invisibly into the derived
// numbers.

test('an observed clean price replaces the derived one and is labelled', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2028-09-30', amount: 20000 }],
    observedPrices: [{ isin: 'TEST00000001', clean: 80 }],
  });

  const rung = result.holdings[0];
  assert.equal(rung.isin, 'TEST00000001');
  assert.equal(rung.priceSource, 'observed');
  assert.ok(Math.abs(rung.cleanPrice - 80) < 1e-9, `clean was ${rung.cleanPrice}`);
  // Dirty is the quoted clean price plus the accrued the buyer also pays.
  assert.ok(Math.abs(rung.dirtyPrice - (rung.cleanPrice + rung.accrued)) < 1e-9);
  assert.equal(result.pricing.pricedRungs, 1);
  assert.equal(result.pricing.derivedRungs, 0);
});

// The point of the feature: a gilt that is cheap in the market, not merely on
// the curve, should win the rung. Both 2028 gilts price identically off a flat
// curve untaxed (asserted above), so any change here is caused by the quote.
test('a cheap observed price flips which gilt is chosen', () => {
  const liabilities = [{ date: '2028-09-30', amount: 20000 }];

  const derived = buildLadder({ ...base, liabilities });
  assert.equal(derived.holdings[0].isin, 'TEST00000001');

  const observed = buildLadder({
    ...base,
    liabilities,
    observedPrices: [{ isin: 'TEST00000002', clean: 90 }],
  });
  assert.equal(observed.holdings[0].isin, 'TEST00000002');
  assert.equal(observed.holdings[0].priceSource, 'observed');
});

test('ISINs are matched case-insensitively and with surrounding space trimmed', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2028-09-30', amount: 20000 }],
    observedPrices: [{ isin: ' test00000001 ', clean: 80 }],
  });
  assert.equal(result.holdings[0].priceSource, 'observed');
  assert.deepEqual(result.pricing.ignored, []);
});

// Silently dropping a price would leave the user believing a rung was priced
// from the market when it was not - the exact failure this whole feature is
// meant to remove.
test('a price for an unknown ISIN is reported, not swallowed', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2028-09-30', amount: 20000 }],
    observedPrices: [{ isin: 'TEST00000009', clean: 95 }],
  });

  assert.deepEqual(result.pricing.ignored, ['TEST00000009']);
  assert.equal(result.holdings[0].priceSource, 'derived');
  const warning = result.warnings.find((w) => w.type === 'price-ignored');
  assert.ok(warning, 'expected a price-ignored warning');
  assert.match(warning.message, /TEST00000009/);
});

test('rungs with no quote keep their derived price alongside quoted ones', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-09-30', amount: 20000 },
      { date: '2035-09-30', amount: 40000 },
    ],
    observedPrices: [{ isin: 'TEST00000001', clean: 80 }],
  });

  const sources = Object.fromEntries(result.holdings.map((h) => [h.isin, h.priceSource]));
  assert.equal(sources.TEST00000001, 'observed');
  assert.equal(result.pricing.pricedRungs + result.pricing.derivedRungs, result.holdings.length);
  assert.ok(result.pricing.derivedRungs >= 1);
});

// --- Risk measures and provenance ------------------------------------------

test('every holding reports a yield and a duration', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-09-30', amount: 20000 },
      { date: '2035-09-30', amount: 40000 },
    ],
  });

  for (const h of result.holdings) {
    assert.ok(h.grossRedemptionYield > 0, `${h.name} has no yield`);
    assert.ok(h.macaulayDuration > 0, `${h.name} has no duration`);
    assert.ok(h.modifiedDuration > 0 && h.modifiedDuration < h.macaulayDuration);
  }

  // Longer gilt, longer duration - the ordering is the point, not the level.
  const byRedemption = [...result.holdings].sort((a, b) => a.redemption.localeCompare(b.redemption));
  assert.ok(byRedemption[0].macaulayDuration < byRedemption[1].macaulayDuration);
});

// The curve is continuously compounded and the yield is quoted semi-annually,
// so a gilt priced off a flat 4.5% curve must solve to 2*(e^0.0225-1), not to
// 4.5%. This is the same convention question that test/curve.test.js pins down
// on the discounting side, checked here from the other direction.
test('the solved yield is on the semi-annual convention gilts are quoted in', () => {
  const result = buildLadder({ ...base, liabilities: [{ date: '2030-06-30', amount: 10000 }] });
  const expected = 2 * (Math.exp(0.045 / 2) - 1);
  assert.ok(
    Math.abs(result.holdings[0].grossRedemptionYield - expected) < 5e-5,
    `got ${result.holdings[0].grossRedemptionYield}, expected about ${expected}`
  );
});

test('a quoted price moves the yield with it', () => {
  const liabilities = [{ date: '2028-09-30', amount: 20000 }];
  const derived = buildLadder({ ...base, liabilities });
  const cheap = buildLadder({
    ...base,
    liabilities,
    observedPrices: [{ isin: derived.holdings[0].isin, clean: derived.holdings[0].cleanPrice - 5 }],
  });
  assert.ok(
    cheap.holdings[0].grossRedemptionYield > derived.holdings[0].grossRedemptionYield,
    'paying less for the same cash flows must yield more'
  );
});

// Cash-flow matching should put the assets' duration next to the liabilities'
// by construction; this is the check on that, not an input to it.
test('a matched ladder has a small duration gap', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-06-30', amount: 20000 },
      { date: '2030-06-30', amount: 20000 },
    ],
  });
  assert.ok(result.analytics.assets.pv > 0);
  assert.ok(result.analytics.liabilities.pv > 0);
  assert.ok(
    Math.abs(result.analytics.durationGap) < 1,
    `expected a close match, got ${result.analytics.durationGap}`
  );
});

// A liability past the longest gilt is funded by cash sitting idle, so the
// assets' money comes back far earlier than the liabilities need it.
test('an unmatchable liability shows up as a wide duration gap', () => {
  const result = buildLadder({ ...base, liabilities: [{ date: '2050-06-30', amount: 10000 }] });
  assert.ok(result.analytics.durationGap < -5, `expected a wide gap, got ${result.analytics.durationGap}`);
});

// The BoE curve starts at 0.5 years, so all but the shortest gilts have a
// coupon inside that and come back `extrapolated`. Warning on that would put a
// warning on every ladder ever built, which is why the warning keys off the
// redemption instead.
test('short-end extrapolation is recorded but does not raise a warning', () => {
  const result = buildLadder({ ...base, liabilities: [{ date: '2028-09-30', amount: 20000 }] });
  assert.equal(result.holdings[0].extrapolated, true, 'a near coupon does fall before the curve starts');
  assert.equal(result.holdings[0].beyondCurve, false);
  assert.deepEqual(result.warnings.filter((w) => w.type === 'extrapolated-price'), []);
});

test('a redemption past the end of the curve is warned about', () => {
  const result = buildLadder({
    ...base,
    universe: [...universe, { isin: 'TEST00000099', name: '1% Test 2075', coupon: 1, redemption: '2075-03-31' }],
    liabilities: [{ date: '2080-06-30', amount: 10000 }],
  });

  const holding = result.holdings[0];
  assert.equal(holding.isin, 'TEST00000099');
  assert.equal(holding.beyondCurve, true);
  const warning = result.warnings.find((w) => w.type === 'extrapolated-price');
  assert.ok(warning, 'expected an extrapolated-price warning');
  assert.match(warning.message, /beyond the published end of the curve/);
});

// --- Accrued Income Scheme -------------------------------------------------
//
// Taxing every coupon in full is wrong for the first one a buyer receives, and
// a ladder buys mid-period on every rung, so it was wrong on every rung. The
// direction matters as much as the size: relief is proportional to accrued,
// accrued is proportional to the coupon, so the scheme gives back more on a
// high-coupon gilt than on a low-coupon one - it narrows the tax penalty the
// whole application exists to show, without reversing it.

const exDivSettlement = '2027-03-26'; // inside the xd window for a 31 March coupon

test('the scheme relieves the accrued interest paid on a cum-dividend purchase', () => {
  const without = netCostPerUnit(universe[1], '2026-09-15', curve, 0.45, { accruedIncomeScheme: false });
  const with_ = netCostPerUnit(universe[1], '2026-09-15', curve, 0.45, { accruedIncomeScheme: true });

  assert.ok(with_.aisRelief > 0, 'a cum-dividend buyer pays accrued, so relief is positive');
  assert.ok(with_.perUnit < without.perUnit, 'relief must make the gilt cheaper per £1 delivered');
});

// Inside the ex-dividend window the seller keeps the coupon and rebates the
// unexpired part, so accrued is negative and the scheme runs the other way.
// This is the case that would need special-casing if the sign convention in
// lib/accrued.js were not already right.
test('the scheme charges the rebate received on an ex-dividend purchase', () => {
  const gilt = universe[3]; // 4% Test 2032
  const without = netCostPerUnit(gilt, exDivSettlement, curve, 0.45, { accruedIncomeScheme: false });
  const with_ = netCostPerUnit(gilt, exDivSettlement, curve, 0.45, { accruedIncomeScheme: true });

  assert.ok(with_.aisRelief < 0, 'an ex-dividend buyer receives a rebate, so it is a charge');
  assert.ok(with_.perUnit > without.perUnit, 'a charge must make the gilt dearer per £1 delivered');
});

test('the scheme narrows the tax penalty on a high-coupon gilt', () => {
  const gap = (ais) => {
    const low = netCostPerUnit(universe[0], '2026-09-15', curve, 0.45, { accruedIncomeScheme: ais });
    const high = netCostPerUnit(universe[1], '2026-09-15', curve, 0.45, { accruedIncomeScheme: ais });
    return high.perUnit - low.perUnit;
  };

  assert.ok(gap(true) < gap(false), 'relief is larger on the larger coupon, so the gap must narrow');
  assert.ok(gap(true) > 0, 'but it must not reverse: the low-coupon gilt still wins for a taxpayer');
});

test('an ISA or SIPP is untouched by the scheme', () => {
  const result = buildLadder({ ...base, marginalRate: 0, liabilities: [{ date: '2028-09-30', amount: 50000 }] });
  assert.equal(result.tax.accruedIncomeScheme, false, 'no tax means nothing to relieve');
  assert.equal(result.holdings[0].aisRelief, 0);
});

// The scheme catches holdings over £5,000 nominal. Which gilts get bought
// depends on the tax treatment and the treatment depends on how much gets
// bought, so 'auto' builds once and rebuilds if the answer came out too small.
test('auto applies the scheme only above the nominal threshold', () => {
  const big = buildLadder({ ...base, marginalRate: 0.45, liabilities: [{ date: '2028-09-30', amount: 50000 }] });
  assert.ok(big.tax.totalNominal > AIS_NOMINAL_THRESHOLD);
  assert.equal(big.tax.accruedIncomeScheme, true);

  const small = buildLadder({ ...base, marginalRate: 0.45, liabilities: [{ date: '2028-09-30', amount: 1000 }] });
  assert.ok(small.tax.totalNominal <= AIS_NOMINAL_THRESHOLD);
  assert.equal(small.tax.accruedIncomeScheme, false);
  assert.equal(small.holdings[0].aisRelief, 0, 'the rebuild must clear the relief, not just the flag');
});

test('the scheme can be forced off above the threshold', () => {
  const forced = buildLadder({
    ...base,
    marginalRate: 0.45,
    accruedIncomeScheme: false,
    liabilities: [{ date: '2028-09-30', amount: 50000 }],
  });
  assert.equal(forced.tax.accruedIncomeScheme, false);
});

// Relief attaches to the first coupon received and to no other, and it cannot
// take a coupon's taxable amount below zero.
test('relief applies once, to the first flow only', () => {
  const flow = { coupon: 3, principal: 0 };
  assert.equal(afterTaxAmountAt(flow, 0, 0.45, 1), 3 - (3 - 1) * 0.45);
  assert.equal(afterTaxAmountAt(flow, 1, 0.45, 1), 3 - 3 * 0.45, 'later coupons get no relief');
  assert.equal(afterTaxAmountAt(flow, 0, 0.45, 99), 3, 'relief is capped at the coupon, never negative tax');
});

// A ladder built under the scheme must have its reported cash flows built the
// same way, or the coverage table would be checked against flows that differ
// from the ones selection was made on.
test('the reported cash flows carry the same relief selection used', () => {
  const result = buildLadder({
    ...base,
    marginalRate: 0.45,
    liabilities: [{ date: '2028-09-30', amount: 50000 }],
  });

  const holding = result.holdings[0];
  const gilt = { name: holding.name, coupon: holding.coupon, redemption: holding.redemption };
  const expected = holdingFlows(gilt, holding.nominal, result.settlement, 0.45, holding.aisRelief);
  const reported = result.cashflows;

  assert.equal(reported.length, expected.length);
  assert.ok(Math.abs(reported[0].amount - expected[0].amount) < 1e-9, 'first flow must carry the relief');
});

// --- Gilts already owned ---------------------------------------------------
//
// Nobody starts from cash. Crediting what is already held before the backward
// pass means the ladder is built against the shortfall, which is the question
// someone holding gilts is actually asking.

test('an existing holding reduces what has to be bought', () => {
  const liabilities = [
    { date: '2028-09-30', amount: 20000 },
    { date: '2030-09-30', amount: 20000 },
  ];

  const fromCash = buildLadder({ ...base, liabilities });
  const withHolding = buildLadder({
    ...base,
    liabilities,
    existingHoldings: [{ isin: 'TEST00000001', nominal: 15000 }],
  });

  assert.ok(withHolding.totals.cost < fromCash.totals.cost, 'owning gilts must cost less to complete');
  assert.ok(withHolding.fullyFunded, 'and must still fund every liability');
  for (const c of withHolding.coverage) assert.ok(c.covered);
});

// The dealing list must never contain something the user already owns.
test('existing holdings are reported apart from the ones to buy', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2030-09-30', amount: 20000 }],
    existingHoldings: [{ isin: 'TEST00000001', nominal: 5000 }],
  });

  assert.equal(result.existing.length, 1);
  assert.equal(result.existing[0].isin, 'TEST00000001');
  assert.ok(result.existing[0].value > 0, 'what it is worth now');
  assert.equal(result.totals.existingCount, 1);
  assert.ok(!result.holdings.some((h) => h.isin === 'TEST00000001' && h.nominal === 5000));
});

// Money already committed is not money still to be spent.
test('the value of an existing holding does not land in the cost to fund', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2035-09-30', amount: 40000 }],
    existingHoldings: [{ isin: 'TEST00000001', nominal: 10000 }],
  });

  assert.ok(result.totals.existingValue > 0);
  const boughtCost = result.holdings.reduce((sum, h) => sum + h.cost, 0);
  assert.ok(Math.abs(result.totals.cost - boughtCost) < 1e-9, 'cost is the dealing list and nothing else');
});

// An existing holding's coupons are cash like any other, so they must appear in
// the calendar the coverage table is checked against.
test('an existing holding contributes to the cash flow calendar', () => {
  const without = buildLadder({ ...base, liabilities: [{ date: '2030-09-30', amount: 20000 }] });
  const with_ = buildLadder({
    ...base,
    liabilities: [{ date: '2030-09-30', amount: 20000 }],
    existingHoldings: [{ isin: 'TEST00000005', nominal: 20000 }], // 2% to 2035, coupons only
  });
  assert.ok(with_.cashflows.length > without.cashflows.length, 'its coupons must show up');
});

// Relief attaches to accrued paid at a purchase. These were bought at some
// earlier date this application knows nothing about.
test('an existing holding gets no Accrued Income Scheme relief', () => {
  const result = buildLadder({
    ...base,
    marginalRate: 0.45,
    liabilities: [{ date: '2035-09-30', amount: 40000 }],
    existingHoldings: [{ isin: 'TEST00000001', nominal: 10000 }],
  });
  assert.equal(result.existing[0].aisRelief, 0);
  assert.equal(result.tax.accruedIncomeScheme, true, 'the bought rungs still get it');
});

test('a holding in a gilt that is not in the universe is reported, not swallowed', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2030-09-30', amount: 20000 }],
    existingHoldings: [{ isin: 'TEST00009999', nominal: 50000 }],
  });

  const warning = result.warnings.find((w) => w.type === 'holding-ignored');
  assert.ok(warning, 'expected a holding-ignored warning');
  assert.match(warning.message, /TEST00009999/);
  assert.equal(result.existing.length, 0);
});

test('a quoted price values an existing holding too', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2030-09-30', amount: 20000 }],
    existingHoldings: [{ isin: 'TEST00000001', nominal: 10000 }],
    observedPrices: [{ isin: 'TEST00000001', clean: 80 }],
  });
  assert.equal(result.existing[0].priceSource, 'observed');
  assert.ok(Math.abs(result.existing[0].cleanPrice - 80) < 1e-9);
});

test('a repeating liability is expanded before the ladder is built', () => {
  const series = buildLadder({
    ...base,
    liabilities: [{ date: '2028-09-30', amount: 10000, repeat: { every: 'year', count: 4 } }],
  });
  const written = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-09-30', amount: 10000 },
      { date: '2029-09-30', amount: 10000 },
      { date: '2030-09-30', amount: 10000 },
      { date: '2031-09-30', amount: 10000 },
    ],
  });

  assert.equal(series.coverage.length, 4);
  assert.deepEqual(
    series.holdings.map((h) => [h.isin, h.nominal]),
    written.holdings.map((h) => [h.isin, h.nominal]),
    'a series and the list it stands for must build the same ladder'
  );
  assert.ok(Math.abs(series.totals.cost - written.totals.cost) < 1e-9);
});

// A plan that has been stored, sealed into a link or posted to an export
// arrives with absent options as explicit nulls. Object spread lets those
// nulls win over the defaults, and a null lotSize makes every nominal NaN -
// which reached the re-costing job and the CSV exports before it was caught.
test('an explicit null option falls back to its default', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2030-06-30', amount: 50000 }],
    lotSize: null,
    bufferBusinessDays: null,
    marginalRate: null,
    accruedIncomeScheme: null,
  });

  const holding = result.holdings[0];
  assert.ok(Number.isFinite(holding.nominal), `nominal was ${holding.nominal}`);
  assert.equal(holding.nominal % DEFAULTS.lotSize, 0);
  assert.ok(Number.isFinite(holding.cost));
  assert.ok(Number.isFinite(result.totals.cost));
  assert.equal(result.marginalRate, DEFAULTS.marginalRate);
});

test('a supplied option still beats the default', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2030-06-30', amount: 50000 }],
    lotSize: 1000,
  });
  assert.equal(result.holdings[0].nominal % 1000, 0);
});

// --- Savings allowances ----------------------------------------------------
//
// The rate a coupon bears depends on how much coupon income its tax year
// carries, which depends on how much was bought, which depends on the rate. It
// is solved by iteration, and the point of solving it is that the answer
// changes: a ladder small enough to sit inside the allowances faces no coupon
// tax at all, and the low-coupon preference correctly disappears.

const sameDate = [
  { isin: 'TEST0000000A', name: '0.5% Test 2032', coupon: 0.5, redemption: '2032-03-31' },
  { isin: 'TEST0000000B', name: '6% Test 2032', coupon: 6, redemption: '2032-03-31' },
];

test('a ladder inside the allowances bears no coupon tax', () => {
  const result = buildLadder({
    ...base,
    universe: sameDate,
    marginalRate: 0.4,
    liabilities: [{ date: '2032-06-30', amount: 5000 }],
  });

  assert.ok(result.tax.couponIncome > 0, 'it does produce coupons');
  assert.equal(result.tax.total, 0, 'but they fit inside the Personal Savings Allowance');
  for (const row of result.tax.byYear) assert.equal(row.effectiveRate, 0);
});

test('a large ladder is taxed, at less than the marginal rate', () => {
  const result = buildLadder({
    ...base,
    universe: sameDate,
    marginalRate: 0.4,
    liabilities: [{ date: '2032-06-30', amount: 400000 }],
  });

  assert.ok(result.tax.total > 0);
  const blended = result.tax.total / result.tax.couponIncome;
  assert.ok(blended > 0 && blended < 0.4, `expected a blended rate under 40%, got ${blended}`);
});

// The whole point of modelling the allowances rather than merely reporting
// them. Selection is coupon-neutral before tax (asserted above), so the entire
// gap between these two gilts is tax - and a ladder small enough to sit inside
// the Personal Savings Allowance has none, which closes the gap completely.
test('the allowances can remove the low-coupon preference entirely', () => {
  const at = (amount) =>
    buildLadder({
      ...base,
      universe: sameDate,
      marginalRate: 0.2, // a basic-rate taxpayer has a £1,000 PSA
      liabilities: [{ date: '2032-06-30', amount }],
    });

  const spread = (result) => {
    const rung = result.diagnostics.selection[0];
    return rung.runnerUp.perUnit - rung.perUnit;
  };

  const small = at(5000);
  const large = at(400000);

  assert.equal(small.tax.total, 0, 'the small ladder is inside the allowance');
  assert.ok(spread(small) < 1e-9, 'with no tax the two gilts must cost the same per £1 delivered');
  assert.ok(large.tax.total > 0);
  assert.ok(spread(large) > 0, 'once taxed, the low coupon wins again');
});

// An additional-rate taxpayer has no Personal Savings Allowance and, absent
// other income, no starting rate band either - so for them the allowances
// change nothing, at any size. Worth pinning down, since it is the case where
// the feature correctly does nothing.
test('an additional-rate taxpayer gets no allowance to absorb coupons', () => {
  const result = buildLadder({
    ...base,
    universe: sameDate,
    marginalRate: 0.45,
    liabilities: [{ date: '2032-06-30', amount: 4000 }],
  });
  assert.ok(result.tax.total > 0, 'taxed from the first pound of coupon');
  for (const row of result.tax.byYear) assert.ok(Math.abs(row.effectiveRate - 0.45) < 1e-9);
});

test('an ISA or SIPP skips the allowance machinery entirely', () => {
  const result = buildLadder({
    ...base,
    marginalRate: 0,
    liabilities: [{ date: '2030-06-30', amount: 50000 }],
  });
  assert.deepEqual(result.tax.byYear, [], 'no bands to apply at 0%');
  assert.equal(result.tax.total, 0);
  assert.equal(result.tax.passes, 1, 'and nothing to iterate');
});

test('the blended rate settles within the pass limit', () => {
  const result = buildLadder({
    ...base,
    marginalRate: 0.45,
    liabilities: [
      { date: '2028-09-30', amount: 40000 },
      { date: '2030-09-30', amount: 40000 },
      { date: '2035-09-30', amount: 60000 },
    ],
  });
  assert.ok(result.tax.passes >= 2, 'the first pass has nothing to blend from');
  assert.ok(result.tax.passes <= 5, `expected convergence, took ${result.tax.passes} passes`);
});

// Stating other income makes the starting rate band available, which can only
// reduce the tax.
test('stating a small other income lowers the tax', () => {
  const liabilities = [{ date: '2035-09-30', amount: 150000 }];
  const assumed = buildLadder({ ...base, marginalRate: 0.2, liabilities });
  const stated = buildLadder({ ...base, marginalRate: 0.2, otherIncome: 10000, liabilities });

  assert.ok(stated.tax.total < assumed.tax.total, 'the starting rate band has to bite');
  assert.equal(stated.tax.otherIncome, 10000);
});

// A ladder runs well past what has been announced, and that has to be visible.
test('tax years with no published bands are flagged', () => {
  const result = buildLadder({
    ...base,
    marginalRate: 0.45,
    liabilities: [{ date: '2035-09-30', amount: 100000 }],
  });
  assert.ok(result.tax.estimatedYears.length > 0, 'a 2035 ladder runs past the published table');
  assert.ok(result.tax.allowancesCheckedAgainst);
});

// Coupons from gilts already owned are the same income to HMRC.
test('existing holdings count towards the year\'s coupon income', () => {
  const liabilities = [{ date: '2035-09-30', amount: 40000 }];
  const without = buildLadder({ ...base, marginalRate: 0.45, liabilities });
  const with_ = buildLadder({
    ...base,
    marginalRate: 0.45,
    liabilities,
    existingHoldings: [{ isin: 'TEST00000004', nominal: 200000 }], // 4% to 2032
  });
  assert.ok(with_.tax.couponIncome > without.tax.couponIncome, 'their coupons are taxable too');
});

// --- Liabilities stated in today's money -----------------------------------

test('an escalating liability is uprated to the date it falls due', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2035-06-30', amount: 20000, escalation: 0.05 }],
  });

  const row = result.coverage[0];
  assert.equal(row.statedAmount, 20000);
  assert.ok(row.amount > 28000, `expected roughly nine years of 5%, got ${row.amount}`);
  assert.equal(row.escalation, 0.05);
  assert.ok(result.fullyFunded, 'and the ladder funds the uprated figure');
});

// The point of the feature: a nominal ladder against today's figure
// under-funds a cost that rises.
test('escalating costs more to fund than not escalating', () => {
  const flat = buildLadder({ ...base, liabilities: [{ date: '2035-06-30', amount: 20000 }] });
  const rising = buildLadder({
    ...base,
    liabilities: [{ date: '2035-06-30', amount: 20000, escalation: 0.05 }],
  });
  assert.ok(rising.totals.cost > flat.totals.cost * 1.3);
});

// A liability that has grown 50% between being entered and being funded should
// not have to be reverse-engineered from the result.
test('both the stated and the uprated totals are reported', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2035-06-30', amount: 20000, escalation: 0.05 }],
  });
  assert.equal(result.totals.liabilitiesAsStated, 20000);
  assert.ok(result.totals.liabilities > result.totals.liabilitiesAsStated);
});

test('a plain liability is untouched and its coverage row unchanged', () => {
  const result = buildLadder({ ...base, liabilities: [{ date: '2030-06-30', amount: 20000 }] });
  assert.equal(result.coverage[0].amount, 20000);
  assert.equal(result.coverage[0].escalation, undefined, 'no escalation fields where none was asked for');
  assert.equal(result.totals.liabilitiesAsStated, result.totals.liabilities);
});

test('an escalating series uprates each occurrence to its own date', () => {
  const result = buildLadder({
    ...base,
    liabilities: [{ date: '2028-09-30', amount: 10000, escalation: 0.05, repeat: { every: 'year', count: 4 } }],
  });

  const amounts = result.coverage.map((c) => c.amount);
  assert.equal(amounts.length, 4);
  for (let i = 1; i < amounts.length; i++) {
    assert.ok(amounts[i] > amounts[i - 1], 'each year costs more than the last');
  }
  for (const row of result.coverage) assert.equal(row.statedAmount, 10000);
});

// The coverage walk rebuilds the cash flow calendar from the holdings, and it
// must credit that cash at exactly the rate the construction spent against.
// Using the flat marginal rate there while construction used the blended
// per-year rates left every taxed ladder reporting a shortfall it did not
// have - small enough to look like rounding, and wrong on every rung.
test('a taxed ladder is actually fully funded', () => {
  for (const marginalRate of [0.2, 0.4, 0.45]) {
    const result = buildLadder({
      ...base,
      marginalRate,
      liabilities: [
        { date: '2028-09-30', amount: 12000 },
        { date: '2030-09-30', amount: 12000 },
        { date: '2032-09-30', amount: 12000 },
        { date: '2035-09-30', amount: 12000 },
      ],
    });

    assert.ok(
      result.fullyFunded,
      `at ${marginalRate}: ${JSON.stringify(result.unfunded)}`
    );
    for (const row of result.coverage) assert.ok(row.covered, `${row.date} short at ${marginalRate}`);
  }
});

// A universe with a gilt for each liability's window, so this exercises tax
// and escalation together rather than the widened-search weakness that a
// universe with gaps exposes (see ROADMAP.md item 13).
test('a taxed escalating series is fully funded too', () => {
  const matched = [
    { isin: 'TEST0000M028', name: '1% Test 2028', coupon: 1, redemption: '2028-09-15' },
    { isin: 'TEST0000M029', name: '1% Test 2029', coupon: 1, redemption: '2029-09-15' },
    { isin: 'TEST0000M030', name: '1% Test 2030', coupon: 1, redemption: '2030-09-15' },
    { isin: 'TEST0000M031', name: '1% Test 2031', coupon: 1, redemption: '2031-09-15' },
    { isin: 'TEST0000M032', name: '1% Test 2032', coupon: 1, redemption: '2032-09-15' },
  ];

  const result = buildLadder({
    ...base,
    universe: matched,
    marginalRate: 0.2,
    liabilities: [{ date: '2028-09-30', amount: 12000, escalation: 0.05, repeat: { every: 'year', count: 5 } }],
  });

  assert.ok(result.fullyFunded, JSON.stringify(result.unfunded));
  assert.equal(result.holdings.length, 5, 'one rung per liability');
  // Each rung funds a liability that has grown since it was stated.
  for (const row of result.coverage) assert.ok(row.amount > row.statedAmount);
});

// --- Rungs fund the liability they were bought for -------------------------
//
// A liability with no gilt redeeming inside its window makes the search widen
// to an earlier-maturing gilt. That rung's PRINCIPAL used to be credited, like
// every other flow, to the earliest liability the money could reach - so the
// rung was sized for one liability and its money funded another, leaving the
// first short with the backward pass already past it. The redemption is now
// pinned to the liability the rung was bought for.

const gappy = [
  { date: '2028-09-30', amount: 12000 },
  { date: '2029-09-30', amount: 12000 }, // nothing redeems in this window
  { date: '2031-09-30', amount: 12000 }, // nor this one
];

test('a liability with no matching gilt is still funded, by a widened rung', () => {
  const result = buildLadder({ ...base, liabilities: gappy });

  assert.ok(result.fullyFunded, `unfunded: ${JSON.stringify(result.unfunded)}`);
  for (const row of result.coverage) assert.ok(row.covered, `${row.date} not covered`);
  assert.equal(result.holdings.length, 3, 'one rung per liability');
  assert.ok(result.holdings.some((h) => h.widenedSearch), 'and the search did have to widen');
});

test('a widened rung funds its own liability, not an earlier one', () => {
  const result = buildLadder({ ...base, liabilities: gappy });

  const widened = result.holdings.filter((h) => h.widenedSearch);
  assert.ok(widened.length > 0);
  for (const holding of widened) {
    // The gilt redeems before the liability it funds - that is what made the
    // search widen - and the liability it funds is still its own.
    assert.ok(holding.redemption < holding.fundsLiability);
    assert.ok(gappy.some((l) => l.date === holding.fundsLiability));
  }
  // Each liability is funded by exactly one rung.
  assert.deepEqual(
    [...new Set(result.holdings.map((h) => h.fundsLiability))].sort(),
    gappy.map((l) => l.date)
  );
});

// Pinning must be a no-op when the chosen gilt already redeems after the
// previous liability, which is every ordinary rung. If this drifts, the fix
// has started changing ladders it has no business changing.
test('pinning leaves a well-matched ladder exactly as it was', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2028-06-30', amount: 10000 },
      { date: '2030-06-30', amount: 10000 },
    ],
  });

  assert.ok(result.fullyFunded);
  assert.ok(!result.holdings.some((h) => h.widenedSearch), 'nothing needed widening here');
  // The exact cost of this ladder on this curve, unchanged by the pinning.
  assert.ok(Math.abs(result.totals.cost - 18132.31) < 0.01, `got ${result.totals.cost}`);
});

// Pinning applies to the principal only. A later rung's coupons must still
// fall to earlier liabilities, or the mechanism that shrinks the rungs in
// front of a high-coupon holding would be gone.
test('coupons still fall to earlier liabilities after pinning', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2031-06-30', amount: 100 },
      { date: '2035-06-30', amount: 200000 },
    ],
  });
  assert.ok(result.fullyFunded);
  assert.equal(result.holdings.length, 1, 'the long rung\'s coupons still cover the tiny early one');
});

// Gilts already owned were not bought for any liability, so there is nothing
// to pin them to: their redemption goes to the earliest liability it can
// reach, exactly as before.
test('an existing holding\'s redemption is not pinned', () => {
  const result = buildLadder({
    ...base,
    liabilities: [
      { date: '2030-09-30', amount: 12000 },
      { date: '2035-09-30', amount: 12000 },
    ],
    // Redeems in 2028, well before either liability.
    existingHoldings: [{ isin: 'TEST00000001', nominal: 12000 }],
  });

  assert.ok(result.fullyFunded);
  // It reduced what had to be bought for the FIRST liability, which is where
  // its money can first be used.
  const bare = buildLadder({
    ...base,
    liabilities: [
      { date: '2030-09-30', amount: 12000 },
      { date: '2035-09-30', amount: 12000 },
    ],
  });
  assert.ok(result.totals.cost < bare.totals.cost);
});

test('the pinned ladder costs more than the under-funded one it replaces', () => {
  // Not a regression: the old ladder was cheaper because it bought two rungs
  // for three liabilities and left two of them short.
  const result = buildLadder({ ...base, liabilities: gappy });
  const owed = gappy.reduce((sum, l) => sum + l.amount, 0);
  assert.ok(result.totals.cost > 30000, `got ${result.totals.cost}`);
  assert.ok(result.totals.cost < owed, 'but still less than the undiscounted liabilities');
});

// --- Reinvestment of idle cash ---------------------------------------------

test('the default leaves idle cash earning nothing', () => {
  const result = buildLadder({ ...base, liabilities: [{ date: '2050-06-30', amount: 10000 }] });
  assert.equal(result.totals.reinvestmentIncome, 0);
  assert.equal(result.totals.reinvestment, 'none');
  assert.match(result.warnings[0].message, /earning nothing/);
});

test('reinvestment shrinks the rung that funds a distant liability', () => {
  const liabilities = [{ date: '2050-06-30', amount: 50000 }];
  const idle = buildLadder({ ...base, liabilities });
  const grown = buildLadder({ ...base, liabilities, reinvestment: 'forward' });

  assert.ok(grown.holdings[0].nominal < idle.holdings[0].nominal, 'less has to be bought');
  assert.ok(grown.totals.cost < idle.totals.cost);
  assert.ok(grown.totals.reinvestmentIncome > 0);
  assert.ok(grown.fullyFunded, 'and it still funds the liability');
});

// The size of the effect is the size of the assumption, so it has to scale
// with how long the money actually waits. A well-matched rung still has a few
// weeks of idle cash - gilts do not redeem on the day a liability falls due -
// so the claim is not that it changes nothing, but that it barely changes
// anything next to a rung that waits fifteen years.
test('the reinvestment effect scales with how long the cash waits', () => {
  const effect = (date) => {
    const liabilities = [{ date, amount: 20000 }];
    const idle = buildLadder({ ...base, liabilities });
    const grown = buildLadder({ ...base, liabilities, reinvestment: 'forward' });
    return {
      saved: (idle.totals.cost - grown.totals.cost) / idle.totals.cost,
      idleDays: idle.holdings[0].idleDays,
    };
  };

  const matched = effect('2030-06-30'); // a rung redeeming three months early
  const stranded = effect('2050-06-30'); // nothing redeems within fifteen years

  assert.ok(stranded.idleDays > matched.idleDays * 10);
  assert.ok(matched.saved < 0.02, `a well-matched rung barely moves, got ${matched.saved}`);
  assert.ok(stranded.saved > 0.3, `a stranded one moves a lot, got ${stranded.saved}`);
});

// Selection has to see the assumption too, or the ladder would go on choosing
// as though the money sat idle and then report interest it had not selected for.
test('reinvestment reaches the ranking, not just the arithmetic', () => {
  const liabilities = [{ date: '2050-06-30', amount: 50000 }];
  const idle = buildLadder({ ...base, liabilities });
  const grown = buildLadder({ ...base, liabilities, reinvestment: 'forward' });

  assert.ok(
    grown.diagnostics.selection[0].perUnit < idle.diagnostics.selection[0].perUnit,
    'cost per £1 the liability receives must fall'
  );
  assert.equal(
    grown.diagnostics.selection[0].perUnitAtRedemption,
    idle.diagnostics.selection[0].perUnitAtRedemption,
    'while the cost per £1 at redemption is unchanged'
  );
});

test('the idle-cash warning says when it rests on an assumption', () => {
  const result = buildLadder({
    ...base,
    reinvestment: 'forward',
    liabilities: [{ date: '2050-06-30', amount: 10000 }],
  });
  assert.match(result.warnings[0].message, /assumption, not a rate anyone is offering/);
});

test('reinvestment interest is taxed like any other savings income', () => {
  const liabilities = [{ date: '2050-06-30', amount: 50000 }];
  const untaxed = buildLadder({ ...base, liabilities, reinvestment: 'forward', marginalRate: 0 });
  const taxed = buildLadder({ ...base, liabilities, reinvestment: 'forward', marginalRate: 0.45 });
  assert.ok(taxed.totals.reinvestmentIncome < untaxed.totals.reinvestmentIncome);
});
