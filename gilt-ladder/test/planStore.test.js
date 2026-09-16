// Integration tests for lib/planStore.js against a real Postgres database -
// skipped unless TEST_DATABASE_URL is set, following the same reasoning as the
// host's test/subscriptionStore.test.js: there is no honest way to test a
// store without a store, and a fake would only assert that the fake works.
//
// TEST_DATABASE_URL must point at a disposable database. This writes real rows
// to gilt_plans and cleans them up best-effort. It is deliberately a separate
// variable from DATABASE_URL so the suite can never run against whatever
// database this deployment itself uses.
//
// planStore.js reads DATABASE_URL once at load, so the suite is built
// conditionally rather than skipped test by test - the real module is never
// loaded at all when TEST_DATABASE_URL is unset.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  describe('lib/planStore.js (Postgres integration)', () => {
    it('is skipped - set TEST_DATABASE_URL to a disposable Postgres database to run this suite', { skip: true }, () => {});
  });
} else {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const store = require('../lib/planStore');

  describe('lib/planStore.js (Postgres integration)', () => {
    const created = [];
    const plan = { liabilities: [{ date: '2030-06-30', amount: 1000 }], marginalRate: 0.4 };

    after(async () => {
      for (const id of created) {
        try { await store.remove(id); } catch { /* best-effort cleanup */ }
      }
    });

    it('reports itself enabled once DATABASE_URL is set', () => {
      assert.equal(store.enabled, true);
    });

    it('saves and reads a plan back', async () => {
      const saved = await store.save({ label: 'School fees', plan });
      created.push(saved.id);
      assert.ok(saved.id);
      assert.equal(saved.label, 'School fees');

      const read = await store.get(saved.id);
      assert.deepEqual(read.plan, plan);
    });

    it('lists without the plan contents', async () => {
      const saved = await store.save({ label: 'Drawdown', plan });
      created.push(saved.id);
      const rows = await store.list();
      const row = rows.find((r) => r.id === saved.id);
      assert.ok(row, 'expected the saved plan in the list');
      assert.equal(row.plan, undefined, 'a menu does not need every liability');
    });

    it('returns full records to a re-costing run', async () => {
      const saved = await store.save({ label: 'For re-costing', plan });
      created.push(saved.id);
      const row = (await store.all()).find((r) => r.id === saved.id);
      assert.deepEqual(row.plan, plan);
    });

    it('updates in place when given an id', async () => {
      const saved = await store.save({ label: 'Before', plan });
      created.push(saved.id);
      const updated = await store.save({ id: saved.id, label: 'After', plan });
      assert.equal(updated.id, saved.id, 'updating must not create a second plan');
      assert.equal(updated.label, 'After');
    });

    it('reports a missing plan rather than inventing one', async () => {
      assert.equal(await store.get('does-not-exist'), null);
      assert.equal(await store.remove('does-not-exist'), false);
    });

    it('deletes', async () => {
      const saved = await store.save({ label: 'Temporary', plan });
      assert.equal(await store.remove(saved.id), true);
      assert.equal(await store.get(saved.id), null);
    });
  });
}
