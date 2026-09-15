const test = require('node:test');
const assert = require('node:assert');
const { parseCurves, spotRate, discountFactor, discountTo, isExtrapolated } = require('../lib/curve');

const flat = (rate) => ({
  date: '2026-09-14',
  points: Array.from({ length: 80 }, (_, i) => ({ years: (i + 1) * 0.5, rate })),
});

test('discount factors are continuously compounded', () => {
  // Established empirically against the BoE's own instantaneous forward curve
  // (see the note in lib/curve.js). Asserted here because the alternative -
  // annual compounding - is off by ~20bp at the long end, which is a >1% price
  // error on a 30-year gilt, in one direction, with nothing to make it visible.
  assert.equal(discountFactor(0.05, 10), Math.exp(-0.5));
  assert.ok(Math.abs(discountFactor(0.05, 10) - 1 / 1.05 ** 10) > 0.005, 'must not be annual compounding');
});

test('spot rates interpolate linearly between published points', () => {
  const curve = {
    date: '2026-09-14',
    points: [
      { years: 1, rate: 0.04 },
      { years: 2, rate: 0.05 },
      { years: 3, rate: 0.054 },
    ],
  };
  assert.equal(spotRate(curve, 1), 0.04);
  assert.equal(spotRate(curve, 2), 0.05);
  assert.ok(Math.abs(spotRate(curve, 1.5) - 0.045) < 1e-12);
  assert.ok(Math.abs(spotRate(curve, 2.25) - 0.051) < 1e-12);
});

test('rates outside the published range are held flat, not extended', () => {
  const curve = {
    date: '2026-09-14',
    points: [
      { years: 0.5, rate: 0.042 },
      { years: 40, rate: 0.057 },
    ],
  };
  assert.equal(spotRate(curve, 0.1), 0.042);
  assert.equal(spotRate(curve, 60), 0.057);
  assert.ok(isExtrapolated(curve, 45));
  assert.ok(isExtrapolated(curve, 0.2));
  assert.ok(!isExtrapolated(curve, 10));
});

test('discounting a flat curve is exact', () => {
  const curve = flat(0.05);
  assert.ok(Math.abs(discountTo(curve, 10) - Math.exp(-0.5)) < 1e-12);
});

test('parses the BoE sheet layout', () => {
  // Row 4 carries maturities in years, rows from 6 carry one dated curve each.
  // Serial 46266 is 2026-09-14.
  const xml = `
    <sheetData>
      <row r="3"><c r="A3" t="s"><v>0</v></c></row>
      <row r="4"><c r="A4" t="s"><v>1</v></c><c r="B4"><v>0.5</v></c><c r="C4"><v>1</v></c></row>
      <row r="5"><c r="A5"><v>0</v></c></row>
      <row r="6"><c r="A6"><v>46272</v></c><c r="B6"><v>4.1</v></c><c r="C6"><v>4.3</v></c></row>
      <row r="7"><c r="A7"><v>46279</v></c><c r="B7"><v>4.2515</v></c><c r="C7"><v>4.4943</v></c></row>
    </sheetData>`;

  const curves = parseCurves(xml);
  assert.equal(curves.length, 2);
  const latest = curves[1];
  assert.equal(latest.date, '2026-09-14');
  assert.deepEqual(latest.points, [
    { years: 0.5, rate: 0.042515 },
    { years: 1, rate: 0.044943 },
  ]);
});

test('a changed sheet layout fails loudly', () => {
  assert.throws(() => parseCurves('<sheetData></sheetData>'), /layout changed/);
  // Maturity header present but no dated rows.
  assert.throws(
    () => parseCurves('<sheetData><row r="4"><c r="B4"><v>0.5</v></c></row></sheetData>'),
    /no dated curve rows/
  );
});
