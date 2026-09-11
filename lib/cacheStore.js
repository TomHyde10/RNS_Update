// Optional Postgres-backed persistence for the NSM result cache, so it
// survives a Render free-tier web service spinning down and cold-starting
// again - the in-memory Map this replaces (still used as the fallback below)
// is wiped every time the process restarts, meaning a cold start would
// otherwise treat every company as never-before-fetched and hit NSM for all
// of them at once. Entirely optional: with no DATABASE_URL set, the app
// behaves exactly as before (in-memory only, zero setup) - see `enabled`
// below, checked by lib/fetchReports.js before ever touching this module's
// query functions.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

let pool = null;
let schemaReady = null;

// The server's certificate is verified by default. DATABASE_SSL_CA (the
// provider's CA certificate as PEM text - env var or secret file, see
// server.js) trusts a CA that isn't in Node's default store.
// DATABASE_SSL_VERIFY=false is the last-resort opt-out: still encrypted, but
// anyone able to intercept the connection could impersonate the database
// and read or poison the cache. An `sslmode` in DATABASE_URL itself
// overrides all of this, since pg applies connection string params last.
function sslOptions() {
  if (process.env.DATABASE_SSL_VERIFY === 'false') return { rejectUnauthorized: false };
  const ca = process.env.DATABASE_SSL_CA;
  // A PEM pasted into a single-line env var usually carries literal "\n"s.
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
      CREATE TABLE IF NOT EXISTS nsm_cache (
        lei TEXT PRIMARY KEY,
        items JSONB NOT NULL,
        size INTEGER NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL
      )
    `);
  }
  return schemaReady;
}

async function getCached(lei) {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT items, size, fetched_at FROM nsm_cache WHERE lei = $1', [lei]);
  if (rows.length === 0) return null;
  return { items: rows[0].items, size: rows[0].size, fetchedAt: new Date(rows[0].fetched_at).getTime() };
}

async function setCached(lei, items, size) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO nsm_cache (lei, items, size, fetched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (lei) DO UPDATE SET items = $2, size = $3, fetched_at = NOW()`,
    [lei, JSON.stringify(items), size]
  );
}

module.exports = { enabled, getCached, setCached };
