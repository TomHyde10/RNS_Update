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
    // Added for re-costing (lib/recost.js). Written as ALTERs rather than
    // folded into the CREATE above so a database created by an earlier version
    // gains them too, without a migration step anyone has to remember.
    schemaReady = schemaReady.then(() =>
      getPool().query(`
        ALTER TABLE gilt_plans
          ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS last_cost NUMERIC,
          ADD COLUMN IF NOT EXISTS last_curve_date TEXT,
          ADD COLUMN IF NOT EXISTS last_fully_funded BOOLEAN,
          ADD COLUMN IF NOT EXISTS last_costed_at TIMESTAMPTZ
      `)
    );
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

const iso = (value) => (value instanceof Date ? value.toISOString() : value || null);

const toRecord = (row) => ({
  id: row.id,
  label: row.label,
  plan: row.plan,
  alertsEnabled: Boolean(row.alerts_enabled),
  // NUMERIC comes back from pg as a string, since not every value fits a
  // double exactly. A cost is pounds and pence, so converting is safe here -
  // but it has to be done, or the drift comparison would subtract strings.
  lastCost: row.last_cost == null ? null : Number(row.last_cost),
  lastCurveDate: row.last_curve_date || null,
  lastFullyFunded: row.last_fully_funded == null ? null : Boolean(row.last_fully_funded),
  lastCostedAt: iso(row.last_costed_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
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
    `SELECT id, label, alerts_enabled, last_cost, last_curve_date, last_fully_funded,
            last_costed_at, created_at, updated_at
       FROM gilt_plans ORDER BY updated_at DESC`
  );
  return rows.map((row) => {
    const { plan, ...rest } = toRecord({ ...row, plan: null });
    return rest;
  });
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

// Whether a plan is watched. Kept apart from save() so toggling it from a list
// cannot overwrite the plan itself with whatever the page last had in its form.
async function setAlerts(id, enabled) {
  await ensureSchema();
  const { rows } = await getPool().query(
    'UPDATE gilt_plans SET alerts_enabled = $2 WHERE id = $1 RETURNING *',
    [id, Boolean(enabled)]
  );
  return rows.length ? toRecord(rows[0]) : null;
}

// The baseline the next comparison is made against. Written whether or not an
// alert followed: skipping it would make every later move look as though it
// had happened in a single day.
async function recordCosting(id, { cost, curveDate, fullyFunded, at }) {
  await ensureSchema();
  const { rows } = await getPool().query(
    `UPDATE gilt_plans
        SET last_cost = $2, last_curve_date = $3, last_fully_funded = $4, last_costed_at = $5
      WHERE id = $1 RETURNING *`,
    [id, cost, curveDate, fullyFunded, at || new Date().toISOString()]
  );
  return rows.length ? toRecord(rows[0]) : null;
}

async function remove(id) {
  await ensureSchema();
  const { rowCount } = await getPool().query('DELETE FROM gilt_plans WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = {
  enabled,
  save,
  list,
  all,
  get,
  remove,
  setAlerts,
  recordCosting,
  cleanLabel,
  MAX_PLANS,
  MAX_LABEL_LENGTH,
};
