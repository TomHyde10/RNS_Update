// Postgres-backed storage for which reports have already been shown to
// someone, mirroring lib/subscriptionStore.js and lib/watchlistStore.js -
// shared across every visitor to this deployment instead of trapped in one
// browser's localStorage, so "New" badges reflect what the team has seen,
// not just what one browser has. Same "no in-memory fallback" reasoning as
// the other two: app.js falls back to localStorage itself (see
// initSeenBackend() there) when DATABASE_URL isn't set, not this module.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

let pool = null;
let schemaReady = null;

// Report keys are only ever useful for "have we shown this before" within
// roughly the app's own search windows (up to 365 days, for filing
// history) - pruning anything older keeps this table from growing forever
// without needing a separate scheduled cleanup job.
const RETENTION_DAYS = 400;
// A full-table DELETE on every write is wasteful for what's meant to be
// occasional housekeeping - this runs it on roughly 1 in 50 calls instead.
const PRUNE_PROBABILITY = 0.02;
// Defensive cap on a single read, in case this table ends up far larger
// than any realistic "have I seen this" check actually needs.
const MAX_KEYS_RETURNED = 20000;

// Same TLS handling as the other two stores - kept in sync deliberately
// rather than shared, since these are small independent modules.
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
    schemaReady = getPool()
      .query(`
        CREATE TABLE IF NOT EXISTS seen_reports (
          key TEXT PRIMARY KEY,
          seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `)
      .then(() => getPool().query('CREATE INDEX IF NOT EXISTS seen_reports_seen_at_idx ON seen_reports (seen_at)'));
  }
  return schemaReady;
}

async function listSeenKeys() {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT key FROM seen_reports ORDER BY seen_at DESC LIMIT $1', [MAX_KEYS_RETURNED]);
  return rows.map((r) => r.key);
}

// Additive only (ON CONFLICT DO NOTHING) - the caller always passes the
// keys of whatever's currently on screen, not an accumulated history, so
// re-marking an already-seen key here is a normal, harmless no-op rather
// than something that needs merging client-side first.
async function markSeen(keys) {
  if (!keys || keys.length === 0) return;
  await ensureSchema();
  const pool = getPool();
  const values = keys.map((_, i) => `($${i + 1})`).join(', ');
  await pool.query(`INSERT INTO seen_reports (key) VALUES ${values} ON CONFLICT (key) DO NOTHING`, keys);

  if (Math.random() < PRUNE_PROBABILITY) {
    await pool
      .query('DELETE FROM seen_reports WHERE seen_at < now() - make_interval(days => $1)', [RETENTION_DAYS])
      .catch((err) => console.error('seen_reports prune failed:', err.message || err));
  }
}

module.exports = { enabled, listSeenKeys, markSeen };
