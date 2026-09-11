// Integration test for the /api/subscriptions* routes in server.js -
// exercised as real HTTP requests against a real (in-process) server, with
// only lib/subscriptionStore.js swapped for an in-memory fake so this
// never touches Postgres. Everything else (routing, validation, the
// digestSendAllowed security gate, error status codes) is the real thing.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const TEST_PORT = 48173;
const BASE_URL = `http://localhost:${TEST_PORT}`;
// The one address digestSendAllowed() will accept while APP_PASSWORD is
// unset (see the dedicated security-gate test at the bottom) - used for
// every other test's subscription-creation calls too, so this suite never
// needs to set APP_PASSWORD itself. That matters because APP_PASSWORD
// doesn't just affect digestSendAllowed() - it also makes checkBasicAuth()
// reject every unauthenticated request in this file with 401, which would
// break every test here, not just the ones about the security gate.
const ALLOWED_EMAIL = 'analyst@example.com';

describe('/api/subscriptions', () => {
  let rows;
  let httpServer;

  after(() => new Promise((resolve) => httpServer.close(resolve)));

  before(async () => {
    // Swap in the fake before server.js (or anything it requires) loads
    // the real store, so every route below exercises server.js's actual
    // handlers without ever opening a database connection.
    rows = [];
    const storePath = require.resolve('../lib/subscriptionStore');
    const fakeStore = {
      enabled: true,
      listSubscriptions: async () => rows.map((r) => ({ ...r })),
      createSubscription: async ({ email, frequencyMinutes, prefs }) => {
        const row = { id: crypto.randomUUID(), email, frequencyMinutes: frequencyMinutes || 0, prefs: prefs || {}, lastSentAt: null, createdAt: new Date().toISOString() };
        rows.push(row);
        return { ...row };
      },
      updateSubscription: async (id, { frequencyMinutes, prefs }) => {
        const row = rows.find((r) => r.id === id);
        if (!row) return null;
        row.frequencyMinutes = frequencyMinutes || 0;
        row.prefs = prefs || {};
        return { ...row };
      },
      markSent: async (id, sentAt) => {
        const row = rows.find((r) => r.id === id);
        if (row) row.lastSentAt = sentAt.toISOString();
      },
      deleteSubscription: async (id) => { rows = rows.filter((r) => r.id !== id); },
    };
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

    process.env.PORT = String(TEST_PORT);
    delete process.env.APP_PASSWORD; // must stay unset - see the ALLOWED_EMAIL comment above
    process.env.NOTIFY_EMAIL_TO = ALLOWED_EMAIL;
    delete process.env.DATABASE_URL; // belt-and-braces: this test must never reach a real database
    delete process.env.RESEND_API_KEY; // so send-now fails fast on missing config, never hits the network

    httpServer = require('../server.js').server;
    await new Promise((resolve) => {
      if (httpServer.listening) resolve();
      else httpServer.once('listening', resolve);
    });
  });

  it('GET starts empty', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data, { enabled: true, subscriptions: [] });
  });

  it('POST creates a subscription', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALLOWED_EMAIL, frequencyMinutes: 1440, prefs: {} }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.subscription.email, ALLOWED_EMAIL);
    assert.equal(data.subscription.frequencyMinutes, 1440);
    assert.ok(data.subscription.id);
    assert.equal(data.subscription.lastSentAt, null);
  });

  it('rejects an invalid email address', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', frequencyMinutes: 60, prefs: {} }),
    });
    assert.equal(res.status, 400);
  });

  it('PUT updates frequency and prefs for an existing subscription', async () => {
    const created = await (await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALLOWED_EMAIL, frequencyMinutes: 60, prefs: {} }),
    })).json();

    const prefs = { LEI1: { name: 'Co', categories: ['Half-year Financial Report'] } };
    const res = await fetch(`${BASE_URL}/api/subscriptions/${created.subscription.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequencyMinutes: 10080, prefs }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.subscription.frequencyMinutes, 10080);
    assert.deepEqual(data.subscription.prefs, prefs);
  });

  it('PUT on an unknown id returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions/does-not-exist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequencyMinutes: 60, prefs: {} }),
    });
    assert.equal(res.status, 404);
  });

  it('DELETE removes a subscription', async () => {
    const created = await (await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALLOWED_EMAIL, frequencyMinutes: 60, prefs: {} }),
    })).json();

    const del = await fetch(`${BASE_URL}/api/subscriptions/${created.subscription.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);

    const list = await (await fetch(`${BASE_URL}/api/subscriptions`)).json();
    assert.ok(!list.subscriptions.some((s) => s.id === created.subscription.id));
  });

  it('send-now reaches sendDigestForSubscription and surfaces its error rather than failing silently', async () => {
    const created = await (await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALLOWED_EMAIL, frequencyMinutes: 60, prefs: {} }),
    })).json();

    // RESEND_API_KEY is deliberately unset above, so this fails fast on
    // the config check inside sendDigestForSubscription() before it would
    // ever attempt a real network call - proving the route wiring
    // (id lookup -> send -> markSent) without touching NSM or Resend.
    const res = await fetch(`${BASE_URL}/api/subscriptions/${created.subscription.id}/send-now`, { method: 'POST' });
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.match(data.error, /Failed to send/);
  });

  it('send-now on an unknown id returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions/does-not-exist/send-now`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  it('send-test reaches sendTestDigest and surfaces its error rather than failing silently', async () => {
    const created = await (await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALLOWED_EMAIL, frequencyMinutes: 60, prefs: {} }),
    })).json();

    // Same "fails fast on missing RESEND_API_KEY, never touches the
    // network" proof as the send-now test above, for the parallel
    // send-test route.
    const res = await fetch(`${BASE_URL}/api/subscriptions/${created.subscription.id}/send-test`, { method: 'POST' });
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.match(data.error, /Failed to send test/);
  });

  it('send-test on an unknown id returns 404', async () => {
    const res = await fetch(`${BASE_URL}/api/subscriptions/does-not-exist/send-test`, { method: 'POST' });
    assert.equal(res.status, 404);
  });

  it('without APP_PASSWORD, only the fixed NOTIFY_EMAIL_TO address can be subscribed', async () => {
    const denied = await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'not-allowed@example.com', frequencyMinutes: 60, prefs: {} }),
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(`${BASE_URL}/api/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALLOWED_EMAIL, frequencyMinutes: 60, prefs: {} }),
    });
    assert.equal(allowed.status, 200);
  });
});
