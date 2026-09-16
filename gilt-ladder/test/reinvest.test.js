// Reinvestment of money that arrives before it is needed. The default is that
// it earns nothing, which is conservative and assumption-free; this is the
// opt-in alternative, and the tests are as much about the default staying
// untouched as about the alternative being right.
const test = require('node:test');
const assert = require('node:assert/strict');
const { growthFactor, reinvested, valueAt } = require('../lib/reinvest');

const flat = (rate) => ({
  date: '2026-09-14',
  points: Array.from({ length: 80 }, (_, i) => ({ years: (i + 1) * 0.5, rate })),
});

test('the growth factor is the curve\'s own implied forward', () => {
  // On a flat continuously-compounded curve the forward between any two dates
  // is the same rate, so three years of growth is exactly e^(r*3).
  const factor = growthFactor(flat(0.045), '2026-09-15', '2028-09-15', '2031-09-15');
  assert.ok(Math.abs(factor - Math.exp(0.045 * 3)) < 1e-6, `got ${factor}`);
});

test('money not held forward does not grow', () => {
  assert.equal(growthFactor(flat(0.045), '2026-09-15', '2030-01-01', '2030-01-01'), 1);
  assert.equal(growthFactor(flat(0.045), '2026-09-15', '2031-01-01', '2030-01-01'), 1, 'nor backwards');
});

// A modelled negative deposit rate would be a worse assumption than the
// zero-growth default it replaced.
test('growth is never less than 1, even on an inverted curve', () => {
  const inverted = {
    date: '2026-09-14',
    points: [
      { years: 1, rate: 0.05 },
      { years: 40, rate: -0.02 },
    ],
  };
  assert.ok(growthFactor(inverted, '2026-09-15', '2030-01-01', '2036-01-01') >= 1);
});

test('untaxed, the money simply grows by the factor', () => {
  assert.ok(Math.abs(reinvested(10000, 1.2, 0) - 12000) < 1e-9);
});

test('tax reduces the growth, never the money that arrived', () => {
  const taxed = reinvested(10000, 1.2, 0.4);
  assert.ok(taxed > 10000, 'the principal is untouched - it was taxed on the way in');
  assert.ok(taxed < 12000, 'but the interest is not');
});

// The property the whole form was chosen for. The ladder's construction values
// a parcel of cash over ONE span while the coverage walk grows the pooled cash
// deadline by deadline; unless taxed growth telescopes, the two compute
// different amounts for the same money and disagree about whether a liability
// is funded. `1 + (g - 1)(1 - r)` does not telescope - it is out by several
// percent over a long wait - and `g^(1 - r)` does, exactly.
test('taxed growth telescopes across a split span', () => {
  const rate = 0.45;
  const whole = reinvested(1000, 1.5 * 1.4, rate);
  const split = reinvested(reinvested(1000, 1.5, rate), 1.4, rate);
  assert.ok(Math.abs(whole - split) < 1e-9, `${whole} vs ${split}`);

  // And the form it replaced genuinely did not, so this is not vacuous.
  const naive = (amount, g) => amount + amount * (g - 1) * (1 - rate);
  assert.ok(Math.abs(naive(1000, 1.5 * 1.4) - naive(naive(1000, 1.5), 1.4)) > 10);
});

// g = e^(fT), so g^(1-r) = e^(f(1-r)T): the forward rate net of tax,
// compounded continuously - interest taxed as it accrues, the rest reinvested.
test('the taxed factor is the forward rate net of tax', () => {
  const forward = 0.05;
  const years = 12;
  const rate = 0.4;
  const grown = reinvested(1, Math.exp(forward * years), rate);
  assert.ok(Math.abs(grown - Math.exp(forward * (1 - rate) * years)) < 1e-12);
});

test('a 100% rate leaves nothing to compound', () => {
  assert.equal(reinvested(1000, 2, 1), 1000);
});

test('with reinvestment off, value is the identity', () => {
  const args = { curve: flat(0.045), settlement: '2026-09-15', from: '2028-01-01', to: '2035-01-01', rate: 0 };
  assert.equal(valueAt(5000, { ...args, enabled: false }), 5000);
  assert.ok(valueAt(5000, { ...args, enabled: true }) > 5000);
});
