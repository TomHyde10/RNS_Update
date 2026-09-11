// Unit tests for lib/digestScheduler.js - the due-check/send loop behind
// server.js's setInterval, tested here against a fake in-memory store and a
// fake sender instead of real Postgres/Resend/timers.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isDue, runDueDigests } = require('../lib/digestScheduler');

describe('isDue', () => {
  it('is never due when paused (frequencyMinutes 0), even if never sent', () => {
    assert.equal(isDue({ frequencyMinutes: 0, lastSentAt: null }, Date.now()), false);
  });

  it('is due immediately for a subscription that has never sent', () => {
    assert.equal(isDue({ frequencyMinutes: 60, lastSentAt: null }, Date.now()), true);
  });

  it('is not due before its frequency has elapsed since the last send', () => {
    const now = Date.now();
    const lastSentAt = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago
    assert.equal(isDue({ frequencyMinutes: 60, lastSentAt }, now), false);
  });

  it('is due once its frequency has elapsed', () => {
    const now = Date.now();
    const lastSentAt = new Date(now - 61 * 60 * 1000).toISOString(); // 61 min ago
    assert.equal(isDue({ frequencyMinutes: 60, lastSentAt }, now), true);
  });

  it('is due exactly at the boundary', () => {
    const now = Date.now();
    const lastSentAt = new Date(now - 60 * 60 * 1000).toISOString(); // exactly 60 min ago
    assert.equal(isDue({ frequencyMinutes: 60, lastSentAt }, now), true);
  });
});

describe('runDueDigests', () => {
  function makeStore(subscriptions) {
    let rows = subscriptions.map((s) => ({ ...s }));
    return {
      enabled: true,
      listSubscriptions: async () => rows.map((r) => ({ ...r })),
      markSent: async (id, sentAt) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.lastSentAt = sentAt.toISOString();
      },
      get rows() { return rows; },
    };
  }
  const noopLog = () => {};

  it('does nothing when the store is disabled', async () => {
    const store = makeStore([{ id: '1', email: 'a@b.com', frequencyMinutes: 60, lastSentAt: null }]);
    store.enabled = false;
    let sendCalls = 0;
    const result = await runDueDigests({
      subscriptionStore: store,
      sendDigestForSubscription: async () => { sendCalls++; return { sent: true, count: 1 }; },
      log: noopLog,
      logError: noopLog,
    });
    assert.equal(sendCalls, 0);
    assert.deepEqual(result, { checked: 0, sent: 0 });
  });

  it('sends only the subscriptions that are due, and marks them sent', async () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const store = makeStore([
      { id: 'due', email: 'due@example.com', frequencyMinutes: 60, lastSentAt: new Date(now.getTime() - 61 * 60 * 1000).toISOString() },
      { id: 'not-due', email: 'not-due@example.com', frequencyMinutes: 60, lastSentAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString() },
      { id: 'paused', email: 'paused@example.com', frequencyMinutes: 0, lastSentAt: null },
    ]);
    const sentTo = [];
    const result = await runDueDigests({
      subscriptionStore: store,
      sendDigestForSubscription: async (sub) => { sentTo.push(sub.email); return { sent: true, count: 2 }; },
      now: () => now,
      log: noopLog,
      logError: noopLog,
    });

    assert.deepEqual(sentTo, ['due@example.com']);
    assert.equal(result.checked, 3);
    assert.equal(result.sent, 1);
    assert.equal(store.rows.find((r) => r.id === 'due').lastSentAt, now.toISOString());
    assert.notEqual(store.rows.find((r) => r.id === 'not-due').lastSentAt, now.toISOString());
  });

  it('still marks a due subscription sent when there was nothing new to send', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const store = makeStore([{ id: '1', email: 'a@b.com', frequencyMinutes: 60, lastSentAt: null }]);
    return runDueDigests({
      subscriptionStore: store,
      sendDigestForSubscription: async () => ({ sent: false, count: 0 }),
      now: () => now,
      log: noopLog,
      logError: noopLog,
    }).then((result) => {
      // "sent" counts actual emails, not due-checks performed - nothing was
      // actually emailed here, but the window still moves forward so the
      // next check doesn't re-scan the same already-covered period.
      assert.equal(result.sent, 0);
      assert.equal(store.rows[0].lastSentAt, now.toISOString());
    });
  });

  it('keeps going after one subscription fails to send, and does not mark it sent', async () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const store = makeStore([
      { id: 'fails', email: 'fails@example.com', frequencyMinutes: 60, lastSentAt: null },
      { id: 'ok', email: 'ok@example.com', frequencyMinutes: 60, lastSentAt: null },
    ]);
    const sentTo = [];
    const errors = [];
    const result = await runDueDigests({
      subscriptionStore: store,
      sendDigestForSubscription: async (sub) => {
        if (sub.id === 'fails') throw new Error('boom');
        sentTo.push(sub.email);
        return { sent: true, count: 1 };
      },
      now: () => now,
      log: noopLog,
      logError: (...args) => errors.push(args),
    });

    assert.deepEqual(sentTo, ['ok@example.com']);
    assert.equal(result.sent, 1);
    assert.equal(errors.length, 1);
    assert.equal(store.rows.find((r) => r.id === 'fails').lastSentAt, null);
  });
});
