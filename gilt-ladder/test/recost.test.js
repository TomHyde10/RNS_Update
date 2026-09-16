// Re-costing policy, against fakes: no Postgres, no Resend, no real timers.
// The store, the ladder builder, the clock and the sender are all injected for
// exactly this reason.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isRecostDue, drift, buildAlert, runRecosting } = require('../lib/recost');

const at = (iso) => Date.parse(iso);

// --- when a plan is due ----------------------------------------------------

test('a plan is not due before the scheduled hour', () => {
  assert.equal(isRecostDue(null, at('2026-09-16T08:59:00Z'), 9), false);
});

test('a plan never costed is due once the hour has passed', () => {
  assert.equal(isRecostDue(null, at('2026-09-16T09:00:00Z'), 9), true);
});

test('a plan costed today is not due again', () => {
  assert.equal(isRecostDue('2026-09-16T09:00:05Z', at('2026-09-16T14:00:00Z'), 9), false);
});

test('a plan costed yesterday is due again today', () => {
  assert.equal(isRecostDue('2026-09-15T09:00:05Z', at('2026-09-16T09:00:00Z'), 9), true);
});

// --- drift -----------------------------------------------------------------

test('drift is signed, so dearer and cheaper are distinguishable', () => {
  assert.equal(drift(100000, 101000).absolute, 1000);
  assert.equal(drift(100000, 101000).percent, 1);
  assert.ok(drift(100000, 99000).absolute < 0);
});

test('there is no drift from a plan that has never been costed', () => {
  assert.equal(drift(null, 100000), null);
  assert.equal(drift(0, 100000), null, 'nor from a zero baseline, which would divide by zero');
});

// --- what is worth saying --------------------------------------------------

const record = { id: 'p1', label: 'School fees', lastCost: 100000, lastFullyFunded: true };
const result = (cost, fullyFunded = true) => ({ cost, fullyFunded, curveDate: '2026-09-16' });

test('a move below the threshold says nothing', () => {
  assert.equal(buildAlert(record, result(100400), { thresholdPercent: 1 }), null);
});

test('a move above the threshold is reported with its direction', () => {
  const alert = buildAlert(record, result(103000), { thresholdPercent: 1 });
  assert.ok(alert);
  assert.match(alert.subject, /costs more to fund/);
  assert.match(alert.text, /3\.0%/);
  assert.ok(alert.drift.absolute > 0);
});

test('a fall is reported as a fall, not as a rise', () => {
  const alert = buildAlert(record, result(95000), { thresholdPercent: 1 });
  assert.match(alert.subject, /costs less to fund/);
  assert.match(alert.text, /less than/);
});

// A change in kind, not degree: this is the whole reason to watch a plan
// rather than build it once, so it alerts at any size of move.
test('losing full funding alerts even when the cost barely moved', () => {
  const alert = buildAlert(record, result(100050, false), { thresholdPercent: 1 });
  assert.ok(alert, 'expected an alert');
  assert.equal(alert.brokeFunding, true);
  assert.match(alert.subject, /no longer fully funded/);
});

test('a plan that was already short does not re-alert every day', () => {
  const short = { ...record, lastFullyFunded: false };
  assert.equal(buildAlert(short, result(100050, false), { thresholdPercent: 1 }), null);
});

test('a first costing says nothing, having nothing to compare against', () => {
  const fresh = { id: 'p2', label: 'New', lastCost: null, lastFullyFunded: null };
  assert.equal(buildAlert(fresh, result(100000), { thresholdPercent: 1 }), null);
});

test('every alert carries the curve date and the indicative caveat', () => {
  const alert = buildAlert(record, result(110000), { thresholdPercent: 1 });
  assert.match(alert.text, /2026-09-16/);
  assert.match(alert.text, /Indicative only/);
});

// --- the run ---------------------------------------------------------------

function fakeStore(records) {
  const costings = [];
  return {
    costings,
    all: async () => records,
    recordCosting: async (id, costing) => costings.push({ id, ...costing }),
  };
}

const now = at('2026-09-16T09:00:00Z');
const watched = (over = {}) => ({
  id: 'p1',
  label: 'School fees',
  plan: {},
  alertsEnabled: true,
  lastCost: 100000,
  lastFullyFunded: true,
  lastCostedAt: '2026-09-15T09:00:00Z',
  ...over,
});

test('an unwatched plan is left alone', async () => {
  const store = fakeStore([watched({ alertsEnabled: false })]);
  const summary = await runRecosting({ store, costPlan: async () => result(200000), now });
  assert.equal(summary.costed, 0);
  assert.equal(summary.skipped, 1);
  assert.deepEqual(store.costings, []);
});

// The stored cost is the baseline the next comparison uses. Not writing it
// would make every later move look as though it happened in one day.
test('a plan is costed even when nothing is worth sending', async () => {
  const store = fakeStore([watched()]);
  const sent = [];
  const summary = await runRecosting({
    store,
    costPlan: async () => result(100100),
    send: async (a) => sent.push(a),
    now,
  });

  assert.equal(summary.costed, 1);
  assert.equal(summary.alerted, 0);
  assert.equal(store.costings.length, 1, 'the baseline must still move');
  assert.equal(store.costings[0].cost, 100100);
  assert.deepEqual(sent, []);
});

test('a real move is costed and sent', async () => {
  const store = fakeStore([watched()]);
  const sent = [];
  const summary = await runRecosting({
    store,
    costPlan: async () => result(104000),
    send: async (a) => sent.push(a),
    now,
  });

  assert.equal(summary.alerted, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].planId, 'p1');
});

// One unpriceable plan must not silence every other alert.
test('a plan that fails to cost does not stop the others', async () => {
  const store = fakeStore([watched({ id: 'bad' }), watched({ id: 'good' })]);
  const sent = [];
  let call = 0;

  const summary = await runRecosting({
    store,
    costPlan: async () => {
      call++;
      if (call === 1) throw new Error('no curve available');
      return result(104000);
    },
    send: async (a) => sent.push(a),
    now,
  });

  assert.equal(call, 2, 'both plans must be attempted');
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].id, 'bad');
  assert.equal(summary.costed, 1, 'the second plan still ran');
  assert.equal(sent.length, 1);
  assert.deepEqual(store.costings.map((c) => c.id), ['good'], 'the failed plan keeps its old baseline');
});

test('a failed send is reported, and the costing still stands', async () => {
  const store = fakeStore([watched()]);
  const summary = await runRecosting({
    store,
    costPlan: async () => result(104000),
    send: async () => {
      throw new Error('Resend is down');
    },
    now,
  });

  assert.equal(summary.costed, 1);
  assert.equal(summary.alerted, 0);
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].error, /alert not sent/);
  assert.equal(store.costings.length, 1, 'the baseline moves regardless, so tomorrow is not a duplicate');
});
