// Unit tests for lib/digestScheduler.js - the due-check/send loop behind
// server.js's setInterval, tested here against a fake in-memory store and a
// fake sender instead of real Postgres/Resend/timers.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isDue, runDueDigests, computePollIntervalMinutes, MIN_POLL_INTERVAL_MINUTES, DEFAULT_POLL_INTERVAL_MINUTES } = require('../lib/digestScheduler');

describe('isDue', () => {
  it('is never due when paused, even if never sent', () => {
    assert.equal(isDue({ scheduleType: 'paused', lastSentAt: null }, Date.now()), false);
  });

  it('treats a missing scheduleType the same as paused', () => {
    assert.equal(isDue({ lastSentAt: null }, Date.now()), false);
  });

  it('"immediate" is always due, regardless of lastSentAt', () => {
    assert.equal(isDue({ scheduleType: 'immediate', lastSentAt: null }, Date.now()), true);
    assert.equal(isDue({ scheduleType: 'immediate', lastSentAt: new Date().toISOString() }, Date.now()), true);
  });

  describe('daily', () => {
    it('is due once today\'s send_time_utc has passed and nothing has been sent yet', () => {
      const now = new Date('2026-01-02T09:00:00Z').getTime();
      assert.equal(isDue({ scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: null }, now), true);
    });

    it('is not due before today\'s send_time_utc', () => {
      const now = new Date('2026-01-02T07:00:00Z').getTime();
      assert.equal(isDue({ scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: null }, now), false);
    });

    it('is not due again the same day once already sent at/after today\'s target', () => {
      const now = new Date('2026-01-02T09:00:00Z').getTime();
      const lastSentAt = new Date('2026-01-02T08:00:00Z').toISOString();
      assert.equal(isDue({ scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt }, now), false);
    });

    it('is due again the next day once the previous send is more than a day old', () => {
      const now = new Date('2026-01-03T08:00:00Z').getTime();
      const lastSentAt = new Date('2026-01-02T08:00:00Z').toISOString();
      assert.equal(isDue({ scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt }, now), true);
    });

    it('falls back to 08:00 for a malformed send_time_utc', () => {
      const now = new Date('2026-01-02T09:00:00Z').getTime();
      assert.equal(isDue({ scheduleType: 'daily', sendTimeUtc: 'garbage', lastSentAt: null }, now), true);
    });
  });

  describe('monthly', () => {
    it('is due once this month\'s 1st at send_time_utc has passed and nothing has been sent this month', () => {
      const now = new Date('2026-02-05T09:00:00Z').getTime();
      const lastSentAt = new Date('2026-01-01T08:00:00Z').toISOString();
      assert.equal(isDue({ scheduleType: 'monthly', sendTimeUtc: '08:00', lastSentAt }, now), true);
    });

    it('is not due again the same month once already sent this month', () => {
      const now = new Date('2026-02-05T09:00:00Z').getTime();
      const lastSentAt = new Date('2026-02-01T08:00:00Z').toISOString();
      assert.equal(isDue({ scheduleType: 'monthly', sendTimeUtc: '08:00', lastSentAt }, now), false);
    });

    it('is not due before this month\'s 1st has reached send_time_utc', () => {
      const now = new Date('2026-02-01T07:00:00Z').getTime();
      assert.equal(isDue({ scheduleType: 'monthly', sendTimeUtc: '08:00', lastSentAt: null }, now), false);
    });
  });
});

describe('computePollIntervalMinutes', () => {
  it('falls back to the default interval when there are no subscriptions at all', () => {
    assert.equal(computePollIntervalMinutes([]), DEFAULT_POLL_INTERVAL_MINUTES);
  });

  it('falls back to the default interval when every subscription is paused', () => {
    const subs = [{ scheduleType: 'paused' }, { scheduleType: 'paused' }];
    assert.equal(computePollIntervalMinutes(subs), DEFAULT_POLL_INTERVAL_MINUTES);
  });

  it('uses the default interval for daily/monthly-only subscribers', () => {
    const subs = [{ scheduleType: 'daily' }, { scheduleType: 'monthly' }];
    assert.equal(computePollIntervalMinutes(subs), DEFAULT_POLL_INTERVAL_MINUTES);
  });

  it('polls at the minimum floor when at least one subscription is "immediate"', () => {
    const subs = [{ scheduleType: 'daily' }, { scheduleType: 'immediate' }, { scheduleType: 'paused' }];
    assert.equal(computePollIntervalMinutes(subs), MIN_POLL_INTERVAL_MINUTES);
  });

  it('ignores paused subscriptions when deciding whether anything is active', () => {
    const subs = [{ scheduleType: 'paused' }, { scheduleType: 'daily' }];
    assert.equal(computePollIntervalMinutes(subs), DEFAULT_POLL_INTERVAL_MINUTES);
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
    const store = makeStore([{ id: '1', email: 'a@b.com', scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: null }]);
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
      { id: 'due', email: 'due@example.com', scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: new Date('2026-01-01T08:00:00Z').toISOString() },
      { id: 'not-due', email: 'not-due@example.com', scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: new Date('2026-01-02T08:00:00Z').toISOString() },
      { id: 'paused', email: 'paused@example.com', scheduleType: 'paused', lastSentAt: null },
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

  it('does not mark a due subscription sent when sendDigestForSubscription declined to send (e.g. a throttled empty digest)', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const store = makeStore([{ id: '1', email: 'a@b.com', scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: null }]);
    return runDueDigests({
      subscriptionStore: store,
      sendDigestForSubscription: async () => ({ sent: false, count: 0 }),
      now: () => now,
      log: noopLog,
      logError: noopLog,
    }).then((result) => {
      // "sent" counts actual emails, not due-checks performed. Unlike a
      // real send, this deliberately does NOT advance lastSentAt - see
      // lib/sendDigest.js's isEmptyDigestThrottled(), which caps empty
      // digests to at most one per day using exactly this cursor: if it
      // moved on every check regardless of whether anything was actually
      // emailed, the throttle's own "time since last sent" would never
      // reach the gap it's waiting for.
      assert.equal(result.sent, 0);
      assert.equal(store.rows[0].lastSentAt, null);
    });
  });

  it('keeps going after one subscription fails to send, and does not mark it sent', async () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const store = makeStore([
      { id: 'fails', email: 'fails@example.com', scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: null },
      { id: 'ok', email: 'ok@example.com', scheduleType: 'daily', sendTimeUtc: '08:00', lastSentAt: null },
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
