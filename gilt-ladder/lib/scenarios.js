// What a move in rates does to the cost of funding a plan.
//
// One curve gives one number, and the curve moves every day. A cash-flow
// matched ladder is supposed to be largely immune to that - which is a claim
// worth checking rather than asserting, and the duration gap in the result
// only checks it to first order.
//
// Every scenario is a transformed curve put through exactly the same
// buildLadder as the real one. Nothing here approximates the answer from a
// duration: an approximation would hide the two things most worth seeing, that
// the ladder can re-select different gilts under a different curve, and that
// rounding up to whole lots is not linear in anything.
const PIVOT_YEARS = 10;

const mapRates = (curve, fn) => ({
  ...curve,
  points: curve.points.map((point) => ({ ...point, rate: fn(point.rate, point.years) })),
});

// Every rate up or down by the same amount. Rates may go negative and are left
// to - gilt yields have been negative, and clamping at zero would quietly
// turn a symmetric scenario into an asymmetric one.
const parallel = (curve, bp) => mapRates(curve, (rate) => rate + bp / 10000);

// A rotation about the 10-year point: the long end moves by +bp/2 and the short
// end by -bp/2, linearly in maturity between, so the two ends move by the
// stated amount in total and the pivot does not move at all. Negative `bp`
// flattens.
function twist(curve, bp) {
  const first = curve.points[0].years;
  const last = curve.points[curve.points.length - 1].years;
  const half = bp / 2 / 10000;

  return mapRates(curve, (rate, years) => {
    if (years >= PIVOT_YEARS) {
      const span = last - PIVOT_YEARS;
      return rate + (span > 0 ? half * ((years - PIVOT_YEARS) / span) : 0);
    }
    const span = PIVOT_YEARS - first;
    return rate - (span > 0 ? half * ((PIVOT_YEARS - years) / span) : 0);
  });
}

// The set offered by default. Symmetric, because the interesting asymmetries
// are the ladder's, not the scenario list's.
//
// `id` is what anything reading the response matches on, and it is plain
// ASCII. `name` is for display and uses a real minus sign, which is not a
// hyphen - making a caller match on the display text would make a typographic
// choice into a breaking change.
const SCENARIOS = [
  { id: 'parallel-100', name: 'Rates −100bp', apply: (curve) => parallel(curve, -100) },
  { id: 'parallel-50', name: 'Rates −50bp', apply: (curve) => parallel(curve, -50) },
  { id: 'parallel-25', name: 'Rates −25bp', apply: (curve) => parallel(curve, -25) },
  { id: 'base', name: 'As at the curve date', apply: (curve) => curve },
  { id: 'parallel+25', name: 'Rates +25bp', apply: (curve) => parallel(curve, 25) },
  { id: 'parallel+50', name: 'Rates +50bp', apply: (curve) => parallel(curve, 50) },
  { id: 'parallel+100', name: 'Rates +100bp', apply: (curve) => parallel(curve, 100) },
  { id: 'steepen50', name: 'Steepen 50bp', apply: (curve) => twist(curve, 50) },
  { id: 'flatten50', name: 'Flatten 50bp', apply: (curve) => twist(curve, -50) },
];

// `build` is given a curve and returns a costed ladder. Kept injected so this
// module needs no universe, no settlement rules and no curve store.
function runScenarios(curve, build, scenarios = SCENARIOS) {
  const rows = [];
  const baseline = build(curve);

  for (const scenario of scenarios) {
    let result;
    try {
      result = build(scenario.apply(curve));
    } catch (err) {
      // A shifted curve can make a plan unbuildable where the real one did
      // not. That is a finding, not a reason to abandon the other scenarios.
      rows.push({ id: scenario.id, name: scenario.name, error: err.message });
      continue;
    }

    rows.push({
      id: scenario.id,
      name: scenario.name,
      cost: result.totals.cost,
      change: result.totals.cost - baseline.totals.cost,
      changePercent:
        baseline.totals.cost > 0
          ? ((result.totals.cost - baseline.totals.cost) / baseline.totals.cost) * 100
          : null,
      fullyFunded: result.fullyFunded,
      holdingCount: result.totals.holdingCount,
      // Whether the ladder chose different gilts. A scenario that reshuffles
      // the rungs is telling you something a single cost number does not.
      reselected: result.holdings.map((h) => h.isin).join(',') !== baseline.holdings.map((h) => h.isin).join(','),
    });
  }

  return { baselineCost: baseline.totals.cost, rows };
}

module.exports = { parallel, twist, runScenarios, SCENARIOS, PIVOT_YEARS };
