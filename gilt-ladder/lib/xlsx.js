// A small read-only .xlsx reader: enough to pull a sheet out as rows of
// strings and numbers. Used by scripts/build-universe.js, which has to read a
// human-facing DMO export rather than the numbers-only curve sheets that
// lib/curve.js handles with its own faster path.
const { extract, list } = require('./zip');

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

const decodeXmlEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last, so an escaped &amp;lt; does not double-decode

function sharedStrings(zipBuffer) {
  if (!list(zipBuffer).includes('xl/sharedStrings.xml')) return [];
  const xml = extract(zipBuffer, 'xl/sharedStrings.xml').toString('utf8');
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map((si) =>
    // A string can be split across formatting runs; concatenate every <t>.
    [...si[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => decodeXmlEntities(t[1])).join('')
  );
}

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetPaths(zipBuffer) {
  const workbook = extract(zipBuffer, 'xl/workbook.xml').toString('utf8');
  const names = [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*\/>/g)].map((m) =>
    decodeXmlEntities(m[1])
  );
  const files = list(zipBuffer)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
  return names.map((name, i) => ({ name, path: files[i] })).filter((s) => s.path);
}

// Returns rows as arrays of strings/numbers/nulls. `sheet` may be a name, an
// index, or omitted for the first sheet.
function readSheet(zipBuffer, sheet = 0) {
  const sheets = sheetPaths(zipBuffer);
  const target =
    typeof sheet === 'number' ? sheets[sheet] : sheets.find((s) => s.name === sheet) || sheets[0];
  if (!target) throw new Error(`sheet not found: ${sheet}`);

  const strings = sharedStrings(zipBuffer);
  const xml = extract(zipBuffer, target.path).toString('utf8');
  const rows = [];

  for (const rowMatch of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs)) {
      const [, ref, attrs, inner] = cellMatch;
      const type = /t="([^"]+)"/.exec(attrs);
      const value = /<v>(.*?)<\/v>/s.exec(inner);
      const index = columnIndex(ref);

      if (type && type[1] === 's') {
        cells[index] = value ? strings[Number(value[1])] : null;
      } else if (type && type[1] === 'inlineStr') {
        const t = /<t[^>]*>(.*?)<\/t>/s.exec(inner);
        cells[index] = t ? decodeXmlEntities(t[1]) : null;
      } else if (value) {
        cells[index] = Number(value[1]);
      } else {
        cells[index] = null;
      }
    }
    rows[Number(rowMatch[1]) - 1] = cells;
  }

  // Rows are placed by their spreadsheet row number, so gaps become holes.
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

// Excel stores dates as day serials. A value that is already a string is
// returned parsed if it looks like a date, so the reader copes with an export
// that formats its dates as text.
function toISODate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (value < 1 || value > 200000) return null;
    return new Date(EXCEL_EPOCH_UTC + value * 86400000).toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = /^(\d{1,2})[/\-\s]([A-Za-z]{3,})[/\-\s](\d{4})$/.exec(text); // 22 July 2049
  if (m) {
    const month = new Date(`${m[2]} 1, 2000`).getMonth();
    if (Number.isNaN(month)) return null;
    return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text); // dd/mm/yyyy - UK order
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  return null;
}

module.exports = { readSheet, sheetPaths, toISODate, decodeXmlEntities };
