// Postgres-backed storage for saved plans.
//
// A shareable link (lib/planToken.js) carries a plan in the URL and needs no
// storage at all, which is the right mechanism for sending someone a plan.
// This is the other half: a plan that stays put, so it can be reopened by
// name and - the real reason it exists - re-costed against tomorrow's curve
// without the user having to be there.
//
// There is no in-memory fallback. A saved plan that vanishes on the next
// restart is worse than no saving at all, because it looks like it worked. So
// the feature is simply unavailable without DATABASE_URL, which `enabled`
// reports and the routes check before doing anything.
//
// `pg` is required lazily, inside getPool(). It belongs to the host RNS app,
// and loading it only when a plan is actually stored keeps the Gilt Ladder's
// "no runtime dependencies of its own" true for every deployment that leaves
// this feature off.
const crypto = require('crypto');

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

const MAX_LABEL_LENGTH = 120;
const MAX_PLANS = 200;

let pool = null;
let schemaReady = null;

// Same TLS handling as the host's lib/cacheStore.js and lib/subscriptionStore.js
// - kept in sync deliberately rather than shared, since the Gilt Ladder does
// not require RNS code.
function sslOptions() {
  if (process.env.DATABASE_SSL_VERIFY === 'false') return { rejectUnauthorized: false };
  const ca = process.env.DATABASE_SSL_CA;
  return ca ? { ca: ca.replace(/\\n/g, '\n') } : { rejectUnauthorized: true };
}

function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: sslOptions() });
  }
  return pool;
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS gilt_plans (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        plan JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }
  return schemaReady;
}

const newId = () => crypto.randomBytes(9).toString('base64url');

// Trimmed and truncated rather than rejected: a label is a human note, and
// failing someone's save over a long name loses the plan to save a column.
const cleanLabel = (label) => {
  const text = String(label == null ? '' : label).trim().replace(/\s+/g, ' ');
  return (text || 'Untitled plan').slice(0, MAX_LABEL_LENGTH);
};

const toRecord = (row) => ({
  id: row.id,
  label: row.label,
  plan: row.plan,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

async function save({ id, label, plan }) {
  await ensureSchema();

  if (id) {
    const { rows } = await getPool().query(
      `UPDATE gilt_plans SET label = $2, plan = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, cleanLabel(label), JSON.stringify(plan)]
    );
    return rows.length ? toRecord(rows[0]) : null;
  }

  // A cap, not a queue: silently evicting someone's oldest plan to make room
  // for a new one is the kind of helpfulness that loses data.
  const { rows: counted } = await getPool().query('SELECT count(*)::int AS n FROM gilt_plans');
  if (counted[0].n >= MAX_PLANS) {
    throw new Error(`at most ${MAX_PLANS} saved plans - delete one first`);
  }

  const { rows } = await getPool().query(
    `INSERT INTO gilt_plans (id, label, plan) VALUES ($1, $2, $3) RETURNING *`,
    [newId(), cleanLabel(label), JSON.stringify(plan)]
  );
  return toRecord(rows[0]);
}

// Labels and dates only. The list is for choosing between plans, and sending
// every plan's full contents to render a menu is a lot of liabilities nobody
// asked for.
async function list() {
  await ensureSchema();
  const { rows } = await getPool().query(
    'SELECT id, label, created_at, updated_at FROM gilt_plans ORDER BY updated_at DESC'
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }));
}

// Full records including plan contents - what a scheduled re-costing needs.
async function all() {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT * FROM gilt_plans ORDER BY updated_at DESC');
  return rows.map(toRecord);
}

async function get(id) {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT * FROM gilt_plans WHERE id = $1', [id]);
  return rows.length ? toRecord(rows[0]) : null;
}

async function remove(id) {
  await ensureSchema();
  const { rowCount } = await getPool().query('DELETE FROM gilt_plans WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { enabled, save, list, all, get, remove, cleanLabel, MAX_PLANS, MAX_LABEL_LENGTH };
