// Postgres-backed storage for the company watchlist, mirroring
// lib/subscriptionStore.js's pattern - shared across every visitor to this
// deployment instead of trapped in one browser's localStorage, so renaming
// or removing a company is permanent regardless of device or browser.
// Same "no in-memory fallback" reasoning as subscriptions: a change here
// only means something as "permanent" if it survives process restarts, so
// this is simply unavailable without DATABASE_URL rather than silently
// degrading - app.js falls back to localStorage itself in that case (see
// initWatchlist() there), not this module.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

let pool = null;
let schemaReady = null;

// Same TLS handling as lib/cacheStore.js and lib/subscriptionStore.js -
// kept in sync deliberately rather than shared, since these are small
// independent modules.
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
      CREATE TABLE IF NOT EXISTS watchlist_companies (
        lei TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    // Added after the table above (kept a separate ALTER rather than
    // rewriting CREATE TABLE, same reasoning as subscriptionStore.js's
    // schedule_type/send_time_utc columns) - a free-text sector/portfolio
    // tag per company, used to filter the main report list and to build
    // watchlist "views" (see app.js). Named group_name rather than `group`
    // since GROUP is a reserved SQL keyword.
    schemaReady = schemaReady.then(() => getPool().query(`
      ALTER TABLE watchlist_companies
        ADD COLUMN IF NOT EXISTS group_name TEXT NOT NULL DEFAULT ''
    `));
  }
  return schemaReady;
}

function toCompany(row) {
  return { lei: row.lei, name: row.name || '', enabled: row.enabled, group: row.group_name || '' };
}

async function listCompanies() {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT * FROM watchlist_companies ORDER BY created_at ASC');
  return rows.map(toCompany);
}

// Full-list replace rather than individual add/rename/remove operations -
// matches the client's own saveWatchlist(list) exactly (mutate the whole
// list locally, persist the whole thing), so this one function is all the
// server needs regardless of which UI action produced the new list.
// Upserts everything in `companies` and deletes anything no longer
// present, in one transaction so a partial failure can't leave the two
// sides inconsistent.
async function replaceCompanies(companies) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const leis = companies.map((c) => c.lei);
    if (leis.length) {
      await client.query('DELETE FROM watchlist_companies WHERE lei <> ALL($1)', [leis]);
    } else {
      await client.query('DELETE FROM watchlist_companies');
    }
    for (const c of companies) {
      await client.query(
        `INSERT INTO watchlist_companies (lei, name, enabled, group_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lei) DO UPDATE SET name = $2, enabled = $3, group_name = $4`,
        [c.lei, c.name || '', c.enabled !== false, c.group || '']
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return listCompanies();
}

module.exports = { enabled, listCompanies, replaceCompanies };
