// Postgres-backed storage for Web Push subscriptions (see lib/webPush.js
// and lib/sendPush.js), mirroring lib/subscriptionStore.js's pattern for
// email digests. No in-memory fallback, same reasoning as that module: a
// push subscription has to survive process restarts to mean anything (the
// whole point is notifying with no tab open, which by definition includes
// "the server itself restarted since"), so this is simply unavailable
// without DATABASE_URL rather than silently degrading to something that
// forgets every subscription on the next deploy. `enabled` reflects that -
// checked by server.js before routing to /api/push/* or running the push
// scheduler.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

let pool = null;
let schemaReady = null;

// Same TLS handling as the other lib/*Store.js modules - kept in sync
// deliberately rather than shared, since these are small independent
// modules.
function sslOptions() {
  if (process.env.DATABASE_SSL_VERIFY === 'false') return { rejectUnauthorized: false };
  const ca = process.env.DATABASE_SSL_CA;
  return ca ? { ca: ca.replace(/\\n/g, '\n') } : { rejectUnauthorized: true };
}

function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DATABASE_URL, ssl: sslOptions() });
  }
  return pool;
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        leis JSONB NOT NULL DEFAULT '[]'::jsonb,
        categories JSONB NOT NULL DEFAULT '[]'::jsonb,
        keyword TEXT NOT NULL DEFAULT '',
        last_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }
  return schemaReady;
}

function toSubscription(row) {
  return {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    leis: row.leis || [],
    categories: row.categories || [],
    keyword: row.keyword || '',
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function listPushSubscriptions() {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT * FROM push_subscriptions ORDER BY created_at ASC');
  return rows.map(toSubscription);
}

// One row per browser (keyed by the push endpoint URL itself, which is
// unique per subscription) - upserted rather than insert-only, so
// re-subscribing the same browser (e.g. after changing which companies/
// categories/keyword it should be notified for - see app.js's
// syncPushSubscription()) just replaces its prefs in place instead of
// accumulating duplicate rows. last_checked_at is deliberately left alone
// on an upsert of prefs-only changes (COALESCE keeps the existing value) -
// only the scheduler itself (markPushChecked() below) advances it, so
// changing your watched companies never resets "since" back to a fresh
// subscription's default lookback and re-sends a backlog.
async function upsertPushSubscription({ endpoint, keys, leis, categories, keyword }) {
  await ensureSchema();
  const { rows } = await getPool().query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, leis, categories, keyword)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = $2, auth = $3, leis = $4, categories = $5, keyword = $6
     RETURNING *`,
    [endpoint, keys.p256dh, keys.auth, JSON.stringify(leis || []), JSON.stringify(categories || []), keyword || '']
  );
  return toSubscription(rows[0]);
}

async function deletePushSubscription(endpoint) {
  await ensureSchema();
  await getPool().query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

async function markPushChecked(endpoint, checkedAt) {
  await ensureSchema();
  await getPool().query('UPDATE push_subscriptions SET last_checked_at = $2 WHERE endpoint = $1', [endpoint, checkedAt]);
}

module.exports = { enabled, listPushSubscriptions, upsertPushSubscription, deletePushSubscription, markPushChecked };
