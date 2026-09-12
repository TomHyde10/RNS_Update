// Integration tests for lib/subscriptionStore.js against a real Postgres
// database - skipped entirely unless TEST_DATABASE_URL is set, since
// there's no way to test this module honestly without a real database
// (unlike lib/digestScheduler.js and lib/sendDigest.js, which take fakes).
//
// TEST_DATABASE_URL must point at a disposable database, never a
// production one - this writes real rows to notification_subscriptions
// (cleaned up again in `after`, best-effort). It's deliberately a
// *separate* env var from DATABASE_URL (which the running app itself may
// have configured) so this suite can never accidentally run against
// whatever database this project's own deployment happens to be using.
//
// subscriptionStore.js reads DATABASE_URL once at module-load time, so it
// has to be set *before* requiring it below - hence the whole suite is
// built conditionally rather than using `{ skip }` on individual tests,
// so the real module is never loaded at all when TEST_DATABASE_URL isn't
// set, whatever this environment's own DATABASE_URL happens to be.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  describe('lib/subscriptionStore.js (Postgres integration)', () => {
    it('is skipped - set TEST_DATABASE_URL to a disposable Postgres database to run this suite', { skip: true }, () => {});
  });
} else {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  const store = require('../lib/subscriptionStore');

  describe('lib/subscriptionStore.js (Postgres integration)', () => {
    const createdIds = [];
    const testEmail = () => `test-${crypto.randomUUID()}@example.com`;

    after(async () => {
      for (const id of createdIds) {
        try { await store.deleteSubscription(id); } catch { /* best-effort cleanup */ }
      }
    });

    it('reports itself enabled once DATABASE_URL is set', () => {
      assert.equal(store.enabled, true);
    });

    it('creates a subscription and reads it back via listSubscriptions', async () => {
      const created = await store.createSubscription({ email: testEmail(), scheduleType: 'daily', sendTimeUtc: '08:00', prefs: {} });
      createdIds.push(created.id);

      assert.ok(created.id);
      assert.equal(created.scheduleType, 'daily');
      assert.equal(created.sendTimeUtc, '08:00');
      assert.equal(created.lastSentAt, null);
      assert.ok(created.createdAt);

      const all = await store.listSubscriptions();
      assert.ok(all.some((s) => s.id === created.id));
    });

    it('updates schedule and prefs', async () => {
      const created = await store.createSubscription({ email: testEmail(), scheduleType: 'daily', sendTimeUtc: '08:00', prefs: {} });
      createdIds.push(created.id);

      const prefs = { LEI1: { name: 'Co', categories: ['Half-year Financial Report'] } };
      const updated = await store.updateSubscription(created.id, { scheduleType: 'monthly', sendTimeUtc: '14:30', prefs });
      assert.equal(updated.scheduleType, 'monthly');
      assert.equal(updated.sendTimeUtc, '14:30');
      assert.deepEqual(updated.prefs, prefs);
    });

    it('updateSubscription on an unknown id returns null rather than throwing', async () => {
      const result = await store.updateSubscription('00000000-0000-0000-0000-000000000000', { scheduleType: 'daily', sendTimeUtc: '08:00', prefs: {} });
      assert.equal(result, null);
    });

    it('markSent sets lastSentAt', async () => {
      const created = await store.createSubscription({ email: testEmail(), scheduleType: 'daily', sendTimeUtc: '08:00', prefs: {} });
      createdIds.push(created.id);

      const sentAt = new Date();
      await store.markSent(created.id, sentAt);
      const row = (await store.listSubscriptions()).find((s) => s.id === created.id);
      assert.equal(row.lastSentAt, sentAt.toISOString());
    });

    it('deleteSubscription removes it', async () => {
      const created = await store.createSubscription({ email: testEmail(), scheduleType: 'daily', sendTimeUtc: '08:00', prefs: {} });
      await store.deleteSubscription(created.id);
      const all = await store.listSubscriptions();
      assert.ok(!all.some((s) => s.id === created.id));
    });
  });
}
