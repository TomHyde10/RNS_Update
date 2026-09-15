// Caches the BoE curve so the application fetches it once a day at most, and
// keeps serving the last good one if the Bank is unreachable.
//
// The curve is a few kilobytes and always refetchable, so the snapshot is a
// plain JSON file rather than a database. Its real job is degradation: a
// failed refresh must not take the service down, it must serve yesterday's
// curve and say how old it is.
const fs = require('fs');
const path = require('path');
const { fetchCurve } = require('./curve');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SNAPSHOT = path.join(DATA_DIR, 'curve.json');

// The BoE publishes once each business morning, so anything younger than this
// cannot be improved by refetching.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

let cached = null;
let inFlight = null;

function readSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    if (raw && raw.curve && Array.isArray(raw.curve.points)) return raw;
  } catch {
    // No snapshot yet, or an unreadable one - treated the same as a cold start.
  }
  return null;
}

function writeSnapshot(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(entry));
  } catch (err) {
    // A read-only or ephemeral filesystem is survivable: the in-memory cache
    // still works for this process's lifetime.
    console.warn(`curve snapshot not written: ${err.message}`);
  }
}

async function refresh() {
  const curve = await fetchCurve();
  const entry = { curve, fetchedAt: new Date().toISOString() };
  cached = entry;
  writeSnapshot(entry);
  return entry;
}

// Returns { curve, fetchedAt, ageMs, stale, error }. `stale` means the data
// is older than a refresh cycle - either a refresh failed or none has been
// attempted - and callers are expected to surface it rather than hide it.
async function getCurve({ force = false } = {}) {
  if (!cached) cached = readSnapshot();

  const age = cached ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
  if (!force && cached && age < MAX_AGE_MS) {
    return { ...cached, ageMs: age, stale: false };
  }

  // Collapse concurrent refreshes: several requests arriving on a cold start
  // must not each pull a 300KB zip from the Bank.
  if (!inFlight) {
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
  }

  try {
    const entry = await inFlight;
    return { ...entry, ageMs: 0, stale: false };
  } catch (err) {
    if (cached) {
      return { ...cached, ageMs: Date.now() - Date.parse(cached.fetchedAt), stale: true, error: err.message };
    }
    throw new Error(`no curve available and refresh failed: ${err.message}`);
  }
}

module.exports = { getCurve, refresh, MAX_AGE_MS, SNAPSHOT };
