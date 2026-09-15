// Phase 0 data spike for the proposed Gilt Ladder service: establishes
// whether the two datasets the ladder optimiser needs - a daily gilt price
// source and the gilt universe (coupon/maturity/ISIN per gilt) - can be
// fetched and parsed from a server, unattended, on a schedule.
//
// Run: node phase0-data-probe.js
// Needs real network access to www.dmo.gov.uk and www.bankofengland.co.uk.
// Shells out to `unzip` (present on macOS/Linux; alpine needs `apk add unzip`).
//
// Not wired into anything - this exists to make the build/no-build call on
// the data layer before any bond maths gets written.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Honest, identifying UA - the polite-scraper norm. Deliberately NOT a
// browser string: the point of this probe is to find out what a server is
// actually allowed to fetch, not to disguise one as a browser.
const UA = 'GiltLadder-DataSpike/0.1 (+twhyde@btinternet.com)';

const DMO_ENDPOINTS = [
  ['D1A  Gilts in Issue   ', 'https://www.dmo.gov.uk/data/pdfdatareport?reportCode=D1A'],
  ['D10B P&S prices       ', 'https://www.dmo.gov.uk/data/pdfdatareport?reportCode=D10B'],
  ['     site root        ', 'https://www.dmo.gov.uk/'],
];

const BOE_ZIP = 'https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/latest-yield-curve-data.zip';
const BOE_WORKBOOK = 'GLC Nominal daily data current month.xlsx';
const SPOT_CURVE_SHEET = 'xl/worksheets/sheet5.xml'; // "4. spot curve", per xl/workbook.xml sheet order

async function probe(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const location = res.headers.get('location') || '';
    // ShieldSquare/PerfDrive bot wall - a 302 to validate.perfdrive.com rather
    // than a real redirect. Treated as a hard block, not a retryable error.
    const blocked = /validate\.perfdrive\.com/.test(location);
    return { status: res.status, blocked, location };
  } catch (err) {
    return { status: 0, blocked: false, error: err.message };
  }
}

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Minimal reader for the numeric region of an xlsx sheet. The BoE curve
// sheets hold only numbers and date serials in their data rows (no shared
// strings), which is what makes this viable without an xlsx dependency -
// it would NOT generalise to an arbitrary workbook.
function parseSheet(xml) {
  const rows = new Map();
  for (const rowMatch of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const c of rowMatch[2].matchAll(/<c r="([A-Z]+\d+)"(?![^>]*t="s")[^>]*>\s*<v>([^<]+)<\/v>/g)) {
      cells[colIndex(c[1])] = Number(c[2]);
    }
    rows.set(Number(rowMatch[1]), cells);
  }
  return rows;
}

const excelSerialToDate = (serial) =>
  new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);

// The wall leaks: roughly 1 request in 20 gets a real 200 while the rest are
// walled. A single attempt per endpoint is therefore a coin flip and will
// occasionally report "accessible" for a source that is not usable on a
// schedule - so each endpoint is attempted ATTEMPTS times and reported as a
// pass rate.
const ATTEMPTS = 5;

async function main() {
  console.log('=== 1. DMO (the originally-planned source) ===\n');
  let allBlocked = true;
  for (const [label, url] of DMO_ENDPOINTS) {
    let passed = 0;
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await probe(url);
      if (!r.blocked && r.status === 200) passed++;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (passed) allBlocked = false;
    console.log(`  ${label} ${passed}/${ATTEMPTS} got through`);
  }
  console.log(
    `\n  -> DMO is ${allBlocked ? 'blocked' : 'intermittently blocked'} to an identified server client.\n`
  );

  console.log('=== 2. Bank of England gilt curve (the alternative) ===\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giltladder-'));
  const zipPath = path.join(dir, 'boe.zip');

  const res = await fetch(BOE_ZIP, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    console.log(`  FAILED: status ${res.status}`);
    process.exit(1);
  }
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  console.log(`  downloaded ${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB`);

  execFileSync('unzip', ['-o', '-q', zipPath, BOE_WORKBOOK, '-d', dir]);
  const xlsxPath = path.join(dir, BOE_WORKBOOK);
  const sheetXml = execFileSync('unzip', ['-p', xlsxPath, SPOT_CURVE_SHEET], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const rows = parseSheet(sheetXml);
  const maturities = rows.get(4) || [];      // row 4: maturity in years
  const dateRows = [...rows.entries()]
    .filter(([n, cells]) => n >= 6 && Number.isFinite(cells[0]))
    .sort((a, b) => a[0] - b[0]);

  if (!dateRows.length) {
    console.log('  FAILED: no dated curve rows found - sheet layout has changed.');
    process.exit(1);
  }

  const [, latest] = dateRows[dateRows.length - 1];
  const points = [];
  for (let i = 1; i < latest.length; i++) {
    if (Number.isFinite(latest[i]) && Number.isFinite(maturities[i])) {
      points.push([maturities[i], latest[i]]);
    }
  }

  const curveDate = excelSerialToDate(latest[0]);
  const lagDays = Math.round((Date.now() - Date.parse(curveDate)) / 86400000);
  console.log(`  parsed ${dateRows.length} daily curves this month`);
  console.log(`  latest curve date: ${curveDate}  (${lagDays} day(s) behind today)`);
  console.log(`  ${points.length} spot points, ${points[0][0]}y .. ${points[points.length - 1][0]}y\n`);
  for (const [m, r] of [points[0], points[1], points[Math.floor(points.length / 2)], points[points.length - 1]]) {
    console.log(`    ${String(m).padStart(5)}y  ${r.toFixed(4)}%`);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n=== verdict ===');
  console.log(`  DMO scraping:        ${allBlocked ? 'NOT VIABLE - bot wall' : 'NOT VIABLE - too unreliable'}`);
  console.log('  BoE nominal curve:   VIABLE - fetched and parsed unattended');
  console.log('  Gilt universe:       UNRESOLVED - D1A was the source and it is blocked');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
