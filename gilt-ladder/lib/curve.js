// The Bank of England nominal gilt spot curve: fetch, parse, interpolate.
//
// This replaces the originally-planned DMO price feed, which is unusable from
// a server (see scripts/phase0-data-probe.js - dmo.gov.uk sits behind a bot
// wall that blocks identified clients and leaks through roughly 1 request in
// 20, which is worse than a clean block for anything on a schedule).
//
// Consequence: gilt prices here are DERIVED from the curve, not observed in
// the market. They are the right shape - a low-coupon gilt still prices below
// par, so the tax logic in lib/ladder.js works as intended - but they carry no
// individual gilt's richness or cheapness and are not dealable. Every price
// this module produces is indicative.
const { extract } = require('./zip');

const BOE_ZIP_URL =
  'https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/latest-yield-curve-data.zip';
const WORKBOOK = 'GLC Nominal daily data current month.xlsx';
const SPOT_SHEET = 'xl/worksheets/sheet5.xml'; // "4. spot curve", per xl/workbook.xml

// BoE spot rates are CONTINUOUSLY COMPOUNDED. This is not documented in the
// workbook, so it was established empirically: numerically integrating the
// instantaneous forward curve from the same file reproduces the spot curve to
// within trapezoid error (a few bp, concentrated at the short end where
// curvature is highest) under continuous compounding, and is off by a
// systematic ~20bp under annual compounding.
//
// Getting this wrong biases every long-dated price by well over 1%, silently
// and in one direction, so it is asserted by test/curve.test.js rather than
// left as a comment.
const discountFactor = (rate, years) => Math.exp(-rate * years);

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
const excelSerialToISO = (serial) =>
  new Date(EXCEL_EPOCH_UTC + serial * 86400000).toISOString().slice(0, 10);

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Reads only the numeric cells of a sheet. The BoE curve sheets hold nothing
// but numbers and Excel date serials in their data rows, which is what makes
// this viable without a spreadsheet library - it would not generalise.
function parseNumericSheet(xml) {
  const rows = new Map();
  for (const row of xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const c of row[2].matchAll(/<c r="([A-Z]+\d+)"(?![^>]*t="s")[^>]*>\s*<v>([^<]+)<\/v>/g)) {
      cells[columnIndex(c[1])] = Number(c[2]);
    }
    rows.set(Number(row[1]), cells);
  }
  return rows;
}

// Row 4 holds maturities in years; rows from 6 hold one dated curve each.
function parseCurves(sheetXml) {
  const rows = parseNumericSheet(sheetXml);
  const maturities = rows.get(4);
  if (!maturities) throw new Error('BoE sheet layout changed: no maturity header row');

  const curves = [...rows.entries()]
    .filter(([n, cells]) => n >= 6 && Number.isFinite(cells[0]))
    .sort((a, b) => a[0] - b[0])
    .map(([, cells]) => {
      const points = [];
      for (let i = 1; i < cells.length; i++) {
        if (Number.isFinite(cells[i]) && Number.isFinite(maturities[i])) {
          points.push({ years: maturities[i], rate: cells[i] / 100 });
        }
      }
      return { date: excelSerialToISO(cells[0]), points };
    })
    .filter((c) => c.points.length > 0);

  if (!curves.length) throw new Error('BoE sheet layout changed: no dated curve rows');
  return curves;
}

// Every dated curve in the workbook, oldest first. The BoE file holds one per
// business day of the current month, and until now all but the last were
// parsed and thrown away - which is a month of free history for asking how the
// cost of a plan has moved.
function parseAllCurves(zipBuffer) {
  const workbook = extract(zipBuffer, (name) => name === WORKBOOK);
  const sheet = extract(workbook, SPOT_SHEET).toString('utf8');
  return parseCurves(sheet);
}

function parseLatestCurve(zipBuffer) {
  const curves = parseAllCurves(zipBuffer);
  return curves[curves.length - 1];
}

async function fetchAllCurves({ url = BOE_ZIP_URL, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'GiltLadder/1.0 (+https://github.com/TomHyde10)' },
  });
  if (!res.ok) throw new Error(`BoE curve download failed: HTTP ${res.status}`);
  return parseAllCurves(Buffer.from(await res.arrayBuffer()));
}

async function fetchCurve(options) {
  const curves = await fetchAllCurves(options);
  return curves[curves.length - 1];
}

// Linear interpolation on spot rates between published points. Outside the
// published range the nearest rate is held flat: the curve stops at 40 years
// and a handful of gilts run beyond it, so the alternative is refusing to
// price them. Flat extrapolation is the conservative choice - it neither
// extends the curve's slope nor invents a turning point.
function spotRate(curve, years) {
  const pts = curve.points;
  if (years <= pts[0].years) return pts[0].rate;
  if (years >= pts[pts.length - 1].years) return pts[pts.length - 1].rate;

  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].years <= years) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  const w = (years - a.years) / (b.years - a.years);
  return a.rate + w * (b.rate - a.rate);
}

const discountTo = (curve, years) => discountFactor(spotRate(curve, years), years);

const isExtrapolated = (curve, years) =>
  years < curve.points[0].years || years > curve.points[curve.points.length - 1].years;

module.exports = {
  BOE_ZIP_URL,
  WORKBOOK,
  SPOT_SHEET,
  fetchCurve,
  fetchAllCurves,
  parseLatestCurve,
  parseAllCurves,
  parseCurves,
  spotRate,
  discountFactor,
  discountTo,
  isExtrapolated,
};
