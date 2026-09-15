// Loads and validates the gilt universe.
//
// The universe is a committed config file rather than a live feed because its
// only authoritative source - the DMO's "Gilts in Issue" report - sits behind
// a bot wall that blocks servers (see scripts/phase0-data-probe.js). That is
// tolerable precisely because this data barely moves: a handful of gilts are
// issued or redeemed each year. Regenerate with scripts/build-universe.js.
//
// Validation is strict and refuses the whole file on any bad row. A gilt with
// a mistyped coupon or redemption date does not fail visibly - it produces a
// confidently wrong ladder, which is worse than no ladder.
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateGilt(gilt, index) {
  const where = `gilt[${index}]${gilt && gilt.name ? ` (${gilt.name})` : ''}`;
  const problems = [];

  if (!gilt || typeof gilt !== 'object') return [`${where}: not an object`];
  if (typeof gilt.name !== 'string' || !gilt.name.trim()) problems.push(`${where}: missing name`);
  if (typeof gilt.isin !== 'string' || !ISIN_RE.test(gilt.isin)) {
    problems.push(`${where}: invalid ISIN ${JSON.stringify(gilt.isin)}`);
  }
  if (typeof gilt.coupon !== 'number' || !(gilt.coupon >= 0) || gilt.coupon > 20) {
    problems.push(`${where}: implausible coupon ${JSON.stringify(gilt.coupon)}`);
  }
  if (typeof gilt.redemption !== 'string' || !DATE_RE.test(gilt.redemption)) {
    problems.push(`${where}: invalid redemption date ${JSON.stringify(gilt.redemption)}`);
  } else if (Number.isNaN(Date.parse(`${gilt.redemption}T00:00:00Z`))) {
    problems.push(`${where}: redemption is not a real date (${gilt.redemption})`);
  }
  return problems;
}

function validate(universe) {
  if (!universe || !Array.isArray(universe.gilts)) {
    throw new Error('gilt universe: expected { gilts: [...] }');
  }

  const problems = universe.gilts.flatMap(validateGilt);

  const seen = new Set();
  for (const gilt of universe.gilts) {
    if (gilt && seen.has(gilt.isin)) problems.push(`duplicate ISIN ${gilt.isin}`);
    if (gilt) seen.add(gilt.isin);
  }

  if (problems.length) {
    throw new Error(`gilt universe is invalid:\n  ${problems.join('\n  ')}`);
  }
  return universe;
}

// Only gilts that can still fund something: anything redeeming on or before
// the settlement date is already gone.
const activeAt = (universe, settlement) =>
  universe.gilts.filter((g) => g.redemption > settlement).sort((a, b) => a.redemption.localeCompare(b.redemption));

function load(file = '../config/gilts') {
  const universe = require(file);
  validate(universe);
  return universe;
}

module.exports = { load, validate, validateGilt, activeAt, ISIN_RE };
