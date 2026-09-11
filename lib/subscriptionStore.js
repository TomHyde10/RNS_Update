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
  }
  return schemaReady;
}

function toSubscription(row) {
  return {
    id: row.id,
    email: row.email,
    frequencyMinutes: row.frequency_minutes,
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

async function createSubscription({ email, frequencyMinutes, prefs }) {
  await ensureSchema();
  const id = crypto.randomUUID();
  const { rows } = await getPool().query(
    `INSERT INTO notification_subscriptions (id, email, frequency_minutes, prefs)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [id, email, frequencyMinutes || 0, JSON.stringify(prefs || {})]
  );
  return toSubscription(rows[0]);
}

// Email is deliberately not editable here - it's the row's identity from
// the UI's point of view (one dropdown entry per address); changing it is a
// remove-and-re-add.
async function updateSubscription(id, { frequencyMinutes, prefs }) {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE notification_subscriptions
     SET frequency_minutes = $2, prefs = $3
     WHERE id = $1
     RETURNING *`,
    [id, frequencyMinutes || 0, JSON.stringify(prefs || {})]
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
