// Shareable plan links. A plan says what someone owes and roughly what they
// are worth, so the URL must carry ciphertext rather than a readable query
// string - and a tampered link must fail to open rather than quietly
// decrypting to some other plan.
const test = require('node:test');
const assert = require('node:assert/strict');

const SECRET = 'a'.repeat(48);
process.env.VIEW_TOKEN_SECRET = SECRET;

const { sealPlan, openPlan, normalizePlan, MAX_TOKEN_LENGTH } = require('../lib/planToken');

const plan = {
  liabilities: [
    { date: '2030-06-30', amount: 25000 },
    { date: '2032-09-30', amount: 12000, repeat: { every: 'year', count: 5 } },
  ],
  observedPrices: [{ isin: 'GB00B16NNR78', clean: 96.42 }],
  existingHoldings: [{ isin: 'GB00BMBL1D50', nominal: 10000 }],
  portfolioValue: 250000,
  marginalRate: 0.4,
  lotSize: 100,
  bufferBusinessDays: 5,
  accruedIncomeScheme: 'auto',
};

test('a plan survives a round trip intact', () => {
  const { token } = sealPlan(plan);
  assert.ok(token, 'expected a token');
  assert.deepEqual(openPlan(token).plan, normalizePlan(plan));
});

test('the token is opaque and URL-safe', () => {
  const { token } = sealPlan(plan);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(!token.includes('25000'), 'amounts must not be readable');
  assert.ok(!token.includes('GB00B16NNR78'), 'ISINs must not be readable');
  assert.ok(token.length < MAX_TOKEN_LENGTH);
});

test('two seals of the same plan differ, and both open', () => {
  const a = sealPlan(plan).token;
  const b = sealPlan(plan).token;
  assert.notEqual(a, b, 'a random IV means no two tokens match');
  assert.deepEqual(openPlan(a).plan, openPlan(b).plan);
});

test('a tampered or truncated token is refused', () => {
  const { token } = sealPlan(plan);
  for (const bad of [token.slice(0, -4), `${token.slice(0, -2)}AA`, `A${token}`, 'not-a-token', '']) {
    assert.ok(openPlan(bad).error, `expected ${JSON.stringify(bad.slice(0, 12))} to be refused`);
  }
});

test('a token sealed under a different secret does not open', () => {
  const { token } = sealPlan(plan);
  process.env.VIEW_TOKEN_SECRET = 'b'.repeat(48);
  try {
    assert.ok(openPlan(token).error, 'changing the secret must invalidate every link');
  } finally {
    process.env.VIEW_TOKEN_SECRET = SECRET;
  }
});

// The RNS view token and this one share VIEW_TOKEN_SECRET but derive different
// keys from it. An RNS watchlist link and a gilt plan link are both base64url
// blobs of the same shape, so nothing but the key stops one opening as the
// other.
test('an RNS view token cannot be opened as a plan', () => {
  const { sealView } = require('../../lib/viewToken');
  const { token } = sealView({ leis: [], days: 30, categories: [] });
  assert.ok(token, 'expected the host to seal a view token');
  assert.ok(openPlan(token).error, 'domain separation must hold');
});

test('sharing is unavailable, not broken, without a secret', () => {
  delete process.env.VIEW_TOKEN_SECRET;
  try {
    assert.equal(sealPlan(plan).status, 501);
    assert.equal(openPlan('anything').status, 501);
  } finally {
    process.env.VIEW_TOKEN_SECRET = SECRET;
  }
});

test('a short secret is refused rather than weakly used', () => {
  process.env.VIEW_TOKEN_SECRET = 'tooshort';
  try {
    assert.equal(sealPlan(plan).status, 500);
  } finally {
    process.env.VIEW_TOKEN_SECRET = SECRET;
  }
});

// A token seals what the server chose to seal. Without this the request body
// would be an open channel into buildLadder's options.
test('unknown fields are stripped rather than carried', () => {
  const { token } = sealPlan({ ...plan, universe: [{ isin: 'EVIL' }], settlement: '1999-01-01' });
  const opened = openPlan(token).plan;
  assert.equal(opened.universe, undefined);
  assert.equal(opened.settlement, undefined);
});

test('ISINs are normalised on the way in', () => {
  const { token } = sealPlan({ ...plan, observedPrices: [{ isin: ' gb00b16nnr78 ', clean: 96 }] });
  assert.equal(openPlan(token).plan.observedPrices[0].isin, 'GB00B16NNR78');
});

// A drawdown series is a lot of very similar JSON, which is exactly what
// deflating before encrypting is for.
test('a large plan still fits in a link', () => {
  const many = {
    ...plan,
    liabilities: Array.from({ length: 150 }, (_, i) => ({ date: `20${30 + (i % 40)}-06-30`, amount: 10000 + i })),
  };
  const { token, error } = sealPlan(many);
  assert.ok(!error, `expected it to seal: ${error}`);
  assert.equal(openPlan(token).plan.liabilities.length, 150);
});
