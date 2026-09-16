// Liability series: one row standing in for many.
//
// The shapes people actually fund are repeating - school fees every September
// for five years, drawdown every year for twenty-five - and entering those a
// row at a time is the single biggest reason a real plan never gets typed in
// at all. A series is expanded here into the plain dated list everything
// downstream already understands, so the ladder, the coverage walk and the
// chart need to know nothing about repetition.
const { addMonths } = require('./giltCashflows');
const { toISO } = require('./calendar');

// Months between payments. Anything not in here is rejected rather than
// guessed at: a silently-misread frequency moves every date after the first.
const FREQUENCY_MONTHS = {
  month: 1,
  quarter: 3,
  'half-year': 6,
  year: 12,
};

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
      // `repeat` is dropped: what comes out is a plain dated amount.
      out.push({ date, amount: liability.amount });
    }
  }
  return out;
}

module.exports = { expand, expandedLength, validateRepeat, occurrenceDates, FREQUENCIES, MAX_OCCURRENCES };
