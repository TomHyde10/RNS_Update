// Exports: the artefacts you take away from a ladder rather than look at.
//
// A dealing list is what goes to a broker, a cash flow calendar is what goes
// into a spreadsheet, and an .ics feed is what puts "£1,250 coupon lands on
// 7 September" in front of you without opening anything.

// --- CSV -------------------------------------------------------------------

// A gilt's name contains commas and fractions, so quoting is not optional.
// RFC 4180: double the quotes, wrap anything containing a comma, quote or
// line break.
//
// The leading apostrophe is separate and is about the reader, not the format:
// spreadsheets treat a leading =, +, - or @ as the start of a formula, so a
// field beginning with one is prefixed to keep it text. Nothing in a ladder
// should start that way, which is exactly why it is worth handling - an export
// is opened in Excel, and a surprise here would be someone else's.
function csvField(value) {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvRow = (fields) => fields.map(csvField).join(',');

// CRLF per RFC 4180, and a trailing newline so the file ends on a record
// boundary rather than mid-line.
const csv = (rows) => `${rows.map(csvRow).join('\r\n')}\r\n`;

const money = (n) => (n == null ? '' : n.toFixed(2));

// What you place. Clean price and accrued are separate columns because that is
// how a contract note reads and how a quote is checked back against its source.
function dealingListCsv(result) {
  const rows = [
    ['Gilt', 'ISIN', 'Coupon %', 'Redeems', 'Nominal', 'Clean price', 'Accrued', 'Consideration', 'Price source', 'Funds liability'],
  ];
  for (const h of result.holdings) {
    rows.push([
      h.name,
      h.isin,
      h.coupon,
      h.redemption,
      h.nominal,
      money(h.cleanPrice),
      money(h.accrued),
      money(h.cost),
      h.priceSource,
      h.fundsLiability,
    ]);
  }
  rows.push([]);
  rows.push(['Total consideration', '', '', '', '', '', '', money(result.totals.cost)]);
  rows.push(['Priced off curve dated', result.curveDate]);
  rows.push(['Settlement', result.settlement]);
  // The caveat travels with the file. A CSV outlives the page it came from,
  // and a column of prices with no provenance is exactly the thing that gets
  // mistaken for dealable.
  rows.push(['Indicative only - not dealable prices, excludes dealing costs and commission']);
  return csv(rows);
}

function cashflowsCsv(result) {
  const liabilitiesByDate = new Map(result.coverage.map((c) => [c.date, c.amount]));
  const dates = [...new Set([...result.cashflows.map((f) => f.date), ...liabilitiesByDate.keys()])].sort();
  const inflowByDate = new Map(result.cashflows.map((f) => [f.date, f]));

  const rows = [['Date', 'Cash in (after tax)', 'Cash in (gross)', 'Liability due']];
  for (const date of dates) {
    const flow = inflowByDate.get(date);
    rows.push([
      date,
      flow ? money(flow.amount) : '',
      flow ? money(flow.gross) : '',
      liabilitiesByDate.has(date) ? money(liabilitiesByDate.get(date)) : '',
    ]);
  }
  return csv(rows);
}

// --- iCalendar -------------------------------------------------------------

// RFC 5545 §3.1: content lines SHOULD be folded at 75 octets, continued by
// CRLF and a single leading space, which itself counts against the next
// line's budget.
const FOLD_LIMIT = 75;

function foldLine(line) {
  if (line.length <= FOLD_LIMIT) return line;
  let out = line.slice(0, FOLD_LIMIT);
  let rest = line.slice(FOLD_LIMIT);
  while (rest.length > 0) {
    out += `\r\n ${rest.slice(0, FOLD_LIMIT - 1)}`;
    rest = rest.slice(FOLD_LIMIT - 1);
  }
  return out;
}

// RFC 5545 §3.3.11. Backslash first, or it would escape the escapes.
const icsText = (value) =>
  String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

const icsDate = (iso) => iso.replace(/-/g, '');
const icsStamp = (date) => `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;

// The day after, since an all-day DTEND is exclusive.
function dayAfter(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const gbp = (n) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A subscribed calendar is re-fetched forever, so UIDs have to be stable and
// derived from the event - not random, or every refresh would duplicate every
// entry instead of updating it.
function calendarIcs(result, { uidSuffix = 'gilt-ladder', now = new Date() } = {}) {
  const stamp = icsStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RNS Update//Gilt Ladder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText('Gilt Ladder')}`,
  ];

  const event = (uid, date, summary, description) => {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}@${uidSuffix}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(date)}`,
      `DTEND;VALUE=DATE:${icsDate(dayAfter(date))}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(description)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  };

  for (const flow of result.cashflows) {
    event(
      `in-${flow.date}`,
      flow.date,
      `Gilt income ${gbp(flow.amount)}`,
      `${gbp(flow.amount)} after tax (${gbp(flow.gross)} gross) from the ladder. Indicative.`
    );
  }

  for (const liability of result.coverage) {
    event(
      `due-${liability.date}`,
      liability.date,
      `Liability due ${gbp(liability.amount)}`,
      liability.covered
        ? `${gbp(liability.amount)} due, covered by the ladder.`
        : `${gbp(liability.amount)} due - NOT fully covered by the ladder.`
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

module.exports = { dealingListCsv, cashflowsCsv, calendarIcs, csvField, foldLine, icsText };
