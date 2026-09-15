// Turns a DMO "Gilts in Issue" (report D1A) export into config/gilts.js.
//
//   node scripts/build-universe.js ~/Downloads/GiltsInIssue.xlsx
//
// The download is manual because dmo.gov.uk blocks automated clients (see
// scripts/phase0-data-probe.js). Open
// https://www.dmo.gov.uk/data/pdfdatareport?reportCode=D1A in a browser and
// export the report as Excel. The data barely moves - a few gilts a year - so
// this is a two-minute job once or twice a year, not a daily one.
//
// The parser is driven by column HEADERS rather than fixed positions, because
// nothing here has been validated against a real export - the DMO report was
// unreachable from the environment this was written in. If it cannot find what
// it needs it prints the headers it did find and stops, rather than guessing.
const fs = require('fs');
const path = require('path');
const { readSheet, toISODate } = require('../lib/xlsx');
const { validate } = require('../lib/universe');

const OUT = path.join(__dirname, '..', 'config', 'gilts.js');

// Gilt names carry the coupon as a vulgar fraction: "4¼% Treasury Gilt 2049".
const FRACTIONS = {
  '¼': 0.25,
  '½': 0.5,
  '¾': 0.75,
  '⅛': 0.125,
  '⅜': 0.375,
  '⅝': 0.625,
  '⅞': 0.875,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
};

// Returns the coupon as a percentage, or null if the name does not carry one.
// Index-linked gilts are excluded by the caller, not here.
function couponFromName(name) {
  // The decimal part must be part of the same alternation as the whole
  // number: matching \d+ alone against "3.75%" finds "75" and silently
  // returns a coupon of 75.
  const match = /(\d+(?:\.\d+)?)?\s*([¼½¾⅛⅜⅝⅞⅓⅔])?\s*%/.exec(String(name));
  if (!match || (!match[1] && !match[2])) return null;

  const whole = match[1] ? Number(match[1]) : 0;
  const fraction = match[2] ? FRACTIONS[match[2]] : 0;
  return whole + fraction;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map(norm);
    const hasName = cells.some((c) => c.includes('gilt') || c.includes('name') || c.includes('stock'));
    const hasIsin = cells.some((c) => c.includes('isin'));
    if (hasName && hasIsin) return i;
  }
  return -1;
}

function columnFor(headers, ...needles) {
  for (const needle of needles) {
    const i = headers.findIndex((h) => norm(h).includes(needle));
    if (i !== -1) return i;
  }
  return -1;
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/build-universe.js <GiltsInIssue.xlsx>');
    process.exit(2);
  }

  const rows = readSheet(fs.readFileSync(file));
  const headerRow = findHeaderRow(rows);
  if (headerRow === -1) {
    console.error('Could not find a header row with both a name and an ISIN column.');
    console.error('First rows seen:');
    rows.slice(0, 12).forEach((r, i) => console.error(`  ${i}: ${JSON.stringify(r.slice(0, 8))}`));
    process.exit(1);
  }

  const headers = rows[headerRow];
  const nameCol = columnFor(headers, 'giltname', 'name', 'stock', 'gilt');
  const isinCol = columnFor(headers, 'isin');
  const redemptionCol = columnFor(headers, 'redemption', 'maturity');

  if (nameCol === -1 || isinCol === -1 || redemptionCol === -1) {
    console.error('Missing a required column. Headers found:');
    headers.forEach((h, i) => console.error(`  [${i}] ${JSON.stringify(h)}`));
    console.error(`\nname=${nameCol} isin=${isinCol} redemption=${redemptionCol} (-1 means not found)`);
    process.exit(1);
  }

  const gilts = [];
  const skipped = [];

  for (const row of rows.slice(headerRow + 1)) {
    const name = row[nameCol];
    const isin = row[isinCol];
    if (!name || !isin) continue;

    // Index-linked gilts have RPI-linked cash flows that cannot cash-flow
    // match a nominal liability without an inflation assumption, so they are
    // deliberately excluded rather than silently priced as if conventional.
    if (/index[- ]?linked/i.test(String(name))) {
      skipped.push(`${name} (index-linked)`);
      continue;
    }

    const coupon = couponFromName(name);
    const redemption = toISODate(row[redemptionCol]);

    if (coupon == null) {
      skipped.push(`${name} (no coupon in name)`);
      continue;
    }
    if (!redemption) {
      skipped.push(`${name} (unreadable redemption date ${JSON.stringify(row[redemptionCol])})`);
      continue;
    }

    gilts.push({ name: String(name).trim(), isin: String(isin).trim().toUpperCase(), coupon, redemption });
  }

  gilts.sort((a, b) => a.redemption.localeCompare(b.redemption));

  const universe = { source: 'dmo', asOf: new Date().toISOString().slice(0, 10), gilts };
  validate(universe); // refuse to write a file the application would reject

  const body = gilts
    .map(
      (g) =>
        `    { name: ${JSON.stringify(g.name)}, isin: ${JSON.stringify(g.isin)}, ` +
        `coupon: ${g.coupon}, redemption: ${JSON.stringify(g.redemption)} },`
    )
    .join('\n');

  fs.writeFileSync(
    OUT,
    `// Conventional gilts in issue, generated from the DMO's "Gilts in Issue"
// report (D1A) by scripts/build-universe.js. Do not hand-edit - regenerate.
//
// Index-linked gilts are excluded: their RPI-linked cash flows cannot
// cash-flow match a nominal liability without an inflation assumption.
//
// Source file: ${path.basename(file)}
module.exports = {
  source: 'dmo',
  asOf: ${JSON.stringify(universe.asOf)},
  gilts: [
${body}
  ],
};
`
  );

  console.log(`Wrote ${gilts.length} gilts to ${path.relative(process.cwd(), OUT)}`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  - ${s}`);
  }
}

if (require.main === module) main();

module.exports = { couponFromName, findHeaderRow, columnFor };
