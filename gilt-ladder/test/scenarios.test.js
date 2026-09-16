// Sensitivity: what a move in rates does to the cost of funding a plan.
//
// Each scenario is the real buildLadder against a transformed curve, not a
// duration approximation, so these assert the things an approximation would
// miss as well as the direction of the obvious ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parallel, twist, runScenarios, PIVOT_YEARS } = require('../lib/scenarios');
const { buildLadder } = require('../lib/ladder');

const curve = {
  date: '2026-09-14',
  points: [
    { years: 0.5, rate: 0.04 },
    { years: 10, rate: 0.045 },
    { years: 40, rate: 0.05 },
  ],
};

// --- the transforms --------------------------------------------------------

test('a parallel shift moves every rate by the same amount', () => {
  const shifted = parallel(curve, 50);
  for (const [i, point] of shifted.points.entries()) {
    assert.ok(Math.abs(point.rate - (curve.points[i].rate + 0.005)) < 1e-12);
  }
});

test('a shift leaves the original curve alone', () => {
  const before = curve.points.map((p) => p.rate);
  parallel(curve, 100);
  twist(curve, 100);
  assert.deepEqual(curve.points.map((p) => p.rate), before);
});

// Gilt yields have been negative. Clamping at zero would turn a symmetric
// pair of scenarios into an asymmetric one without saying so.
test('rates are allowed to go negative', () => {
  const shifted = parallel({ ...curve, points: [{ years: 1, rate: 0.001 }] }, -100);
  assert.ok(shifted.points[0].rate < 0);
});

test('a twist pivots at ten years and moves each end by half the amount', () => {
  const steeper = twist(curve, 50);
  const pivot = steeper.points.find((p) => p.years === PIVOT_YEARS);
  assert.ok(Math.abs(pivot.rate - 0.045) < 1e-12, 'the pivot must not move');
  assert.ok(Math.abs(steeper.points[0].rate - (0.04 - 0.0025)) < 1e-12, 'short end down 25bp');
  assert.ok(Math.abs(steeper.points[2].rate - (0.05 + 0.0025)) < 1e-12, 'long end up 25bp');
});

test('flattening is steepening with the sign reversed', () => {
  const steeper = twist(curve, 50).points.map((p) => p.rate);
  const flatter = twist(curve, -50).points.map((p) => p.rate);
  for (const [i, rate] of steeper.entries()) {
    assert.ok(Math.abs((rate + flatter[i]) / 2 - curve.points[i].rate) < 1e-12);
  }
});

// --- running them ----------------------------------------------------------

const universe = [
  { isin: 'TEST00000001', name: '0.5% Test 2030', coupon: 0.5, redemption: '2030-03-31' },
  { isin: 'TEST00000002', name: '4% Test 2030', coupon: 4, redemption: '2030-03-31' },
  { isin: 'TEST00000003', name: '2% Test 2035', coupon: 2, redemption: '2035-03-31' },
];

const build = (c) =>
  buildLadder({
    curve: c,
    universe,
    settlement: '2026-09-15',
    liabilities: [
      { date: '2030-06-30', amount: 50000 },
      { date: '2035-06-30', amount: 50000 },
    ],
  });

// Rows are looked up by `id`, never by `name`: the display names use a real
// minus sign rather than a hyphen, and matching on display text would make a
// typographic choice into a breaking change.
test('scenarios are identified by a plain ASCII id', () => {
  const { rows } = runScenarios(curve, build);
  for (const row of rows) {
    assert.match(row.id, /^[a-z0-9+-]+$/, `${row.id} must be safe to match on`);
  }
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'and unique');
});

test('higher rates cost less to fund, and lower rates more', () => {
  const { rows, baselineCost } = runScenarios(curve, build);
  const cost = (id) => rows.find((r) => r.id === id).cost;

  assert.ok(cost('parallel+100') < baselineCost, 'discounting harder costs less today');
  assert.ok(cost('parallel-100') > baselineCost);
  assert.ok(cost('parallel+100') < cost('parallel+25'), 'and a bigger rise costs less still');
});

test('the scenario list is monotonic in the size of the shift', () => {
  const { rows } = runScenarios(curve, build);
  const ordered = ['parallel-100', 'parallel-50', 'parallel-25', 'base', 'parallel+25', 'parallel+50', 'parallel+100'];
  const costs = ordered.map((id) => rows.find((r) => r.id === id).cost);
  for (let i = 1; i < costs.length; i++) {
    assert.ok(costs[i] < costs[i - 1], `${ordered[i]} should cost less than ${ordered[i - 1]}`);
  }
});

test('the unshifted scenario reproduces the baseline exactly', () => {
  const { rows, baselineCost } = runScenarios(curve, build);
  const base = rows.find((r) => r.id === 'base');
  assert.equal(base.cost, baselineCost);
  assert.equal(base.change, 0);
  assert.equal(base.reselected, false);
});

test('each row carries its change against the baseline', () => {
  const { rows, baselineCost } = runScenarios(curve, build);
  for (const row of rows) {
    if (row.error) continue;
    assert.ok(Math.abs(row.cost - baselineCost - row.change) < 1e-9);
    assert.ok(Math.abs(row.changePercent - (row.change / baselineCost) * 100) < 1e-9);
  }
});

// A scenario that reshuffles the rungs is saying something a single cost
// number does not, and it is the thing a duration approximation cannot show.
test('re-selection under a scenario is reported', () => {
  const { rows } = runScenarios(curve, build);
  for (const row of rows) {
    if (!row.error) assert.equal(typeof row.reselected, 'boolean');
  }
});

// A shifted curve can make a plan unbuildable where the real one did not.
test('a scenario that cannot be built is reported, not thrown', () => {
  const { rows } = runScenarios(curve, build, [
    { id: 'broken', name: 'broken', apply: () => ({ date: '2026-09-14', points: [] }) },
    { id: 'fine', name: 'fine', apply: (c) => c },
  ]);
  assert.ok(rows[0].error, 'the broken scenario reports its failure');
  assert.equal(rows[1].cost > 0, true, 'and the rest still run');
});
