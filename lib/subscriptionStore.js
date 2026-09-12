// Postgres-backed storage for automatic email digest subscriptions (see
// lib/sendDigest.js and the scheduler in server.js). Unlike lib/cacheStore.js
// there is no in-memory fallback: a subscription has to survive process
// restarts and Render free-tier spin-downs to mean anything as "automatic",
// so this feature is simply unavailable without DATABASE_URL rather than
// silently degrading to something that resets itself. `enabled` (checked by
// server.js before ever routing to /api/subscriptions or running the
// scheduler) reflects that.
const { Pool } = require('pg');
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

let pool = null;
let schemaReady = null;

// Same TLS handling as lib/cacheStore.js - kept in sync deliberately rather
// than shared, since these are two small independent modules.
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
      CREATE TABLE IF NOT EXISTS notification_subscriptions (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        frequency_minutes INTEGER NOT NULL DEFAULT 0,
        prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Added after frequency_minutes (kept around, unused, rather than
    // migrated - this is a personal-use deployment, not a multi-tenant one
    // needing a careful backfill). schedule_type replaces the old
    // paused/hourly/6h/daily/weekly picker with paused/daily/monthly/
    // immediate; send_time_utc ("HH:MM") is the GMT time of day daily/
    // monthly sends fire at - see lib/digestScheduler.js's isDue().
    schemaReady = schemaReady.then(() => getPool().query(`
      ALTER TABLE notification_subscriptions
        ADD COLUMN IF NOT EXISTS schedule_type TEXT NOT NULL DEFAULT 'daily',
        ADD COLUMN IF NOT EXISTS send_time_utc TEXT NOT NULL DEFAULT '08:00'
    `));
  }
  return schemaReady;
}

function toSubscription(row) {
  return {
    id: row.id,
    email: row.email,
    scheduleType: row.schedule_type,
    sendTimeUtc: row.send_time_utc,
    prefs: row.prefs || {},
    lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function listSubscriptions() {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT * FROM notification_subscriptions ORDER BY created_at ASC');
  return rows.map(toSubscription);
}

async function createSubscription({ email, scheduleType, sendTimeUtc, prefs }) {
  await ensureSchema();
  const id = crypto.randomUUID();
  const { rows } = await getPool().query(
    `INSERT INTO notification_subscriptions (id, email, schedule_type, send_time_utc, prefs)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, email, scheduleType || 'daily', sendTimeUtc || '08:00', JSON.stringify(prefs || {})]
  );
  return toSubscription(rows[0]);
}

// Email is deliberately not editable here - it's the row's identity from
// the UI's point of view (one dropdown entry per address); changing it is a
// remove-and-re-add.
async function updateSubscription(id, { scheduleType, sendTimeUtc, prefs }) {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE notification_subscriptions
     SET schedule_type = $2, send_time_utc = $3, prefs = $4
     WHERE id = $1
     RETURNING *`,
    [id, scheduleType || 'daily', sendTimeUtc || '08:00', JSON.stringify(prefs || {})]
  );
  return rows.length ? toSubscription(rows[0]) : null;
}

async function markSent(id, sentAt) {
  await ensureSchema();
  await getPool().query('UPDATE notification_subscriptions SET last_sent_at = $2 WHERE id = $1', [id, sentAt]);
}

async function deleteSubscription(id) {
  await ensureSchema();
  await getPool().query('DELETE FROM notification_subscriptions WHERE id = $1', [id]);
}

module.exports = { enabled, listSubscriptions, createSubscription, updateSubscription, markSent, deleteSubscription };
