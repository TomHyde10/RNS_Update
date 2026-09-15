const test = require('node:test');
const assert = require('node:assert');
const { validate, activeAt } = require('../lib/universe');
const { couponFromName } = require('../scripts/build-universe');
const { toISODate } = require('../lib/xlsx');

// The coupon lives inside the gilt's NAME in the DMO report, as a vulgar
// fraction. This parser is the whole join between the reference data and the
// maths, and a silent mis-parse here corrupts every number downstream.
test('coupon is parsed out of the gilt name', () => {
  const cases = {
    '4¼% Treasury Gilt 2049': 4.25,
    '0⅛% Treasury Gilt 2026': 0.125,
    '3¾% Treasury Gilt 2052': 3.75,
    '1½% Treasury Gilt 2047': 1.5,
    '0¾% Treasury Gilt 2033': 0.75,
    '8% Treasury Stock 2028': 8,
    '2⅜% Treasury Gilt 2035': 2.375,
    '4⅝% Treasury Gilt 2034': 4.625,
    '0⅞% Treasury Gilt 2033': 0.875,
    '3.75% Treasury Gilt 2038': 3.75,
  };
  for (const [name, expected] of Object.entries(cases)) {
    assert.equal(couponFromName(name), expected, name);
  }
});

test('a name with no coupon yields null rather than a wrong number', () => {
  assert.equal(couponFromName('Treasury Gilt 2049'), null);
  assert.equal(couponFromName(''), null);
});

test('dates are read from serials and from text', () => {
  assert.equal(toISODate(46279), '2026-09-14');
  assert.equal(toISODate('2049-01-22'), '2049-01-22');
  assert.equal(toISODate('22 July 2049'), '2049-07-22');
  assert.equal(toISODate('07/12/2038'), '2038-12-07'); // dd/mm/yyyy
  assert.equal(toISODate(''), null);
  assert.equal(toISODate('not a date'), null);
});

test('the sample universe is valid', () => {
  const universe = require('../config/gilts');
  assert.doesNotThrow(() => validate(universe));
  assert.equal(universe.source, 'sample', 'sample data must declare itself as such');
});

test('validation rejects data that would produce a wrong ladder', () => {
  const good = { name: 'X', isin: 'GB00B16NNR78', coupon: 4.25, redemption: '2049-12-07' };

  assert.doesNotThrow(() => validate({ gilts: [good] }));
  assert.throws(() => validate({ gilts: [{ ...good, isin: 'NOPE' }] }), /invalid ISIN/);
  assert.throws(() => validate({ gilts: [{ ...good, coupon: 'four' }] }), /implausible coupon/);
  assert.throws(() => validate({ gilts: [{ ...good, coupon: 45 }] }), /implausible coupon/);
  assert.throws(() => validate({ gilts: [{ ...good, redemption: '07-12-2049' }] }), /invalid redemption/);
  assert.throws(() => validate({ gilts: [{ ...good, redemption: '2049-13-45' }] }), /not a real date/);
  assert.throws(() => validate({ gilts: [good, good] }), /duplicate ISIN/);
  assert.throws(() => validate({}), /expected/);
});

test('gilts already redeemed are excluded from the active universe', () => {
  const universe = {
    gilts: [
      { name: 'past', isin: 'GB00B16NNR78', coupon: 4, redemption: '2020-01-01' },
      { name: 'future', isin: 'GB00BBJNQY21', coupon: 4, redemption: '2040-01-01' },
    ],
  };
  const active = activeAt(universe, '2026-09-15');
  assert.equal(active.length, 1);
  assert.equal(active[0].name, 'future');
});
