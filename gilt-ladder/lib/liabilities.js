// Liability series: one row standing in for many.
//
// The shapes people actually fund are repeating - school fees every September
// for five years, drawdown every year for twenty-five - and entering those a
// row at a time is the single biggest reason a real plan never gets typed in
// at all. A series is expanded here into the plain dated list everything
// downstream already understands, so the ladder, the coverage walk and the
// chart need to know nothing about repetition.
const { addMonths } = require('./giltCashflows');
const { toISO, daysBetween } = require('./calendar');

// Months between payments. Anything not in here is rejected rather than
// guessed at: a silently-misread frequency moves every date after the first.
const FREQUENCY_MONTHS = {
  month: 1,
  quarter: 3,
  'half-year': 6,
  year: 12,
};

// School fees and care costs rise; a nominal ladder against them silently
// under-funds. `escalation` lets a liability be stated in TODAY'S money and
// uprated to the date it falls due, which is how anybody actually thinks about
// a cost twelve years out.
//
// This is not index-linked gilt support and is not a substitute for it. It is
// an assumption the user states and can see, applied to the liability side
// only; the assets are still nominal gilts whose cash flows do not rise with
// anything. That is the honest version of the feature, and the reason the
// result reports both the stated amount and the uprated one.
//
// Compounded annually on an ACT/365 year, matching the discounting convention
// rather than the accrual one.
const ESCALATION_YEAR_DAYS = 365;

function escalate(amount, rate, from, to) {
  if (!rate) return amount;
  const years = daysBetween(from, to) / ESCALATION_YEAR_DAYS;
  return amount * (1 + rate) ** years;
}

// Fifty years of monthly payments. High enough never to be met by accident,
// low enough that a typo in `count` cannot ask for a million rows.
const MAX_OCCURRENCES = 600;

const FREQUENCIES = Object.keys(FREQUENCY_MONTHS);

// Each date is computed as an offset from the FIRST one, never by stepping off
// the previous one. Stepping iteratively lets end-of-month clamping compound:
// a series starting 31 January would go 28 February, then 28 March, and stay a
// day early for ever after the first short month. This is the same trap
// giltCashflows.js avoids when it generates coupon dates, and for the same
// reason.
function occurrenceDates(start, frequency, count) {
  const months = FREQUENCY_MONTHS[frequency];
  return Array.from({ length: count }, (_, k) => toISO(addMonths(start, months * k)));
}

// Returns the problems with a repeat block, empty when there are none.
function validateRepeat(repeat, where) {
  if (repeat == null) return [];
  if (typeof repeat !== 'object') return [`${where}: repeat must be an object`];

  const problems = [];
  if (!FREQUENCIES.includes(repeat.every)) {
    problems.push(`${where}: repeat.every must be one of ${FREQUENCIES.join(', ')}`);
  }
  const count = Number(repeat.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_OCCURRENCES) {
    problems.push(`${where}: repeat.count must be a whole number between 1 and ${MAX_OCCURRENCES}`);
  }
  return problems;
}

// How many dated liabilities a list expands to, without doing the expansion -
// so a request can be refused for being too large before any work is done.
const expandedLength = (liabilities) =>
  (liabilities || []).reduce((total, l) => total + (l && l.repeat ? Number(l.repeat.count) || 1 : 1), 0);

// A liability with no `repeat` passes through untouched, so an expanded list
// and a hand-written one are indistinguishable downstream.
function expand(liabilities) {
  const out = [];
  for (const liability of liabilities) {
    if (!liability || !liability.repeat) {
      out.push(liability);
      continue;
    }
    const { every, count } = liability.repeat;
    for (const date of occurrenceDates(liability.date, every, Number(count))) {
      // `repeat` is dropped: what comes out is a plain dated amount. Any
      // escalation is carried through, because it is uprated later, against a
      // settlement date this module does not know.
      out.push({
        date,
        amount: liability.amount,
        ...(liability.escalation ? { escalation: liability.escalation } : {}),
      });
    }
  }
  return out;
}

// Generous, but it catches the mistake that matters: 3 entered where 0.03 was
// meant, which would compound a liability into the millions without complaint.
const MAX_ESCALATION = 0.5;

const validateEscalation = (escalation, where) =>
  escalation == null || (Number.isFinite(Number(escalation)) && Math.abs(Number(escalation)) <= MAX_ESCALATION)
    ? []
    : [`${where}: escalation must be a rate between -${MAX_ESCALATION} and ${MAX_ESCALATION} (0.03 for 3% a year)`];

module.exports = {
  expand,
  escalate,
  expandedLength,
  validateRepeat,
  validateEscalation,
  occurrenceDates,
  FREQUENCIES,
  MAX_OCCURRENCES,
  MAX_ESCALATION,
};
