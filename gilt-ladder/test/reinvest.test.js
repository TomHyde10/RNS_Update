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

test('only the interest is taxed, not the money that arrived', () => {
  const gross = reinvested(10000, 1.2, 0);
  const taxed = reinvested(10000, 1.2, 0.4);
  assert.equal(gross, 12000);
  assert.equal(taxed, 10000 + 2000 * 0.6);
});

test('with reinvestment off, value is the identity', () => {
  const args = { curve: flat(0.045), settlement: '2026-09-15', from: '2028-01-01', to: '2035-01-01', rate: 0 };
  assert.equal(valueAt(5000, { ...args, enabled: false }), 5000);
  assert.ok(valueAt(5000, { ...args, enabled: true }) > 5000);
});
