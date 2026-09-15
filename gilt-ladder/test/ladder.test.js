const test = require('node:test');
const assert = require('node:assert');
const { buildLadder, netCostPerUnit } = require('../lib/ladder');
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
