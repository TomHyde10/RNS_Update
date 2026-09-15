// UK business-day calendar. Everything here works in UTC midnight so that a
// BST/GMT transition can never shift a date by a day - a real hazard when the
// whole application is about which side of a deadline a cash flow lands on.
//
// Dates cross module boundaries as 'YYYY-MM-DD' strings and are only Date
// objects internally; a gilt ladder spans decades, so a stray local-timezone
// Date is a bug that surfaces years later in the schedule.
const table = require('../config/bankHolidays');

const DAY_MS = 86400000;

function toDate(d) {
  if (d instanceof Date) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
  if (!m) throw new Error(`invalid date: ${d} (expected YYYY-MM-DD)`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

const toISO = (d) => toDate(d).toISOString().slice(0, 10);

const addDays = (d, n) => new Date(toDate(d).getTime() + n * DAY_MS);

const daysBetween = (a, b) => Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS);

// Easter Sunday, Anonymous Gregorian algorithm (Meeus/Jones/Butcher). Needed
// because Good Friday and Easter Monday are the only two UK bank holidays that
// can't be expressed as an nth-weekday-of-month rule.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

function lastWeekdayOfMonth(year, month, weekday) {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

const isWeekend = (d) => {
  const day = toDate(d).getUTCDay();
  return day === 0 || day === 6;
};

// England & Wales bank holidays derived from the standing rules, for years
// beyond what gov.uk publishes. One-off holidays (jubilees, state funerals)
// are by definition not derivable and will be missing from these years - the
// error is at most one day on a coupon that lands on such a date, decades out.
function ruleBasedHolidays(year) {
  const easter = easterSunday(year);
  const fixed = [
    new Date(Date.UTC(year, 0, 1)),
    addDays(easter, -2), // Good Friday
    addDays(easter, 1), // Easter Monday
    nthWeekdayOfMonth(year, 4, 1, 1), // first Monday in May
    lastWeekdayOfMonth(year, 4, 1), // last Monday in May
    lastWeekdayOfMonth(year, 7, 1), // last Monday in August
  ];

  const out = new Set();
  // Good Friday / Easter Monday never fall at a weekend, and the May/August
  // ones are Mondays by construction, so only New Year's Day can need a
  // substitute here - but run them all through the same rule for uniformity.
  for (const d of fixed) {
    let s = d;
    while (isWeekend(s) || out.has(toISO(s))) s = addDays(s, 1);
    out.add(toISO(s));
  }
  // Christmas and Boxing Day are handled in order so that a Christmas landing
  // on a Saturday pushes Boxing Day to the Tuesday rather than colliding.
  for (const d of [new Date(Date.UTC(year, 11, 25)), new Date(Date.UTC(year, 11, 26))]) {
    let s = d;
    while (isWeekend(s) || out.has(toISO(s))) s = addDays(s, 1);
    out.add(toISO(s));
  }
  return out;
}

const ruleCache = new Map();
function holidaysForYear(year) {
  if (year >= table.coveredFrom && year <= table.coveredTo) return null; // use the published table
  if (!ruleCache.has(year)) ruleCache.set(year, ruleBasedHolidays(year));
  return ruleCache.get(year);
}

function isBankHoliday(d) {
  const date = toDate(d);
  const iso = toISO(date);
  const computed = holidaysForYear(date.getUTCFullYear());
  return computed ? computed.has(iso) : table.dates.has(iso);
}

const isBusinessDay = (d) => !isWeekend(d) && !isBankHoliday(d);

function nextBusinessDay(d) {
  let x = addDays(d, 1);
  while (!isBusinessDay(x)) x = addDays(x, 1);
  return x;
}

// n may be negative. n === 0 returns the date itself even if it is not a
// business day - callers wanting "roll to a business day" should say so.
function addBusinessDays(d, n) {
  let x = toDate(d);
  const step = n < 0 ? -1 : 1;
  for (let i = 0; i < Math.abs(n); i++) {
    do {
      x = addDays(x, step);
    } while (!isBusinessDay(x));
  }
  return x;
}

// Gilt coupons are paid on the coupon date, or the next business day if that
// is not one. The amount is NOT adjusted - this is a payment-date shift only,
// which is why accrued interest keeps using the unadjusted schedule.
const paymentDate = (d) => (isBusinessDay(d) ? toDate(d) : nextBusinessDay(d));

module.exports = {
  DAY_MS,
  toDate,
  toISO,
  addDays,
  daysBetween,
  easterSunday,
  isWeekend,
  isBankHoliday,
  isBusinessDay,
  nextBusinessDay,
  addBusinessDays,
  paymentDate,
  ruleBasedHolidays,
};
