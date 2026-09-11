// Flags a company as potentially overdue on its Half-year/Annual Financial
// Report - deliberately scoped to just these two, not every report type
// (recurring ones like NAV have no fixed "due" cadence, so guessing at one
// would just be noise). The estimate is necessarily approximate: this app
// has no visibility into any company's actual financial year-end, only
// when it last filed - so "next due" is inferred from the FCA's Disclosure
// Guidance and Transparency Rules deadlines (DTR 4.1.3: annual report
// within 4 months of year-end; DTR 4.2.2: half-yearly report within 3
// months of period-end) applied to a typical ~6/12-month recurring cycle
// from the last filing seen. Always surfaced as an estimate to the user,
// never as a claim of an actual known deadline.
const HALF_YEAR = { category: 'Half-year Financial Report', periodDays: 182, graceDays: 90 };
const ANNUAL = { category: 'Annual Financial Report', periodDays: 365, graceDays: 120 };

// Flagged "due soon" this many days before the estimated deadline, so it's
// visible before it tips over into "overdue" rather than appearing there
// with no warning.
const DUE_SOON_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

// 'unknown' (no prior filing of this type seen at all, within however far
// back the caller looked - nothing to estimate a cycle from), 'ok',
// 'due-soon', or 'overdue'.
function classify(lastFiledAt, now, periodDays, graceDays) {
  if (!lastFiledAt) return 'unknown';
  const deadlineMs = lastFiledAt.getTime() + (periodDays + graceDays) * DAY_MS;
  if (now.getTime() > deadlineMs) return 'overdue';
  if (now.getTime() > deadlineMs - DUE_SOON_WINDOW_DAYS * DAY_MS) return 'due-soon';
  return 'ok';
}

// `reports` is the normalised report list from fetchReports() (lei,
// category, publishedAt) - the caller is expected to have already asked
// for a wide enough window and just the two categories above (see
// server.js's /api/due-dates route). Returns { [lei]: { halfYear: {
// lastFiledAt, status }, annual: { lastFiledAt, status } } } - a LEI with
// no matching filings at all in what was fetched is omitted entirely
// (nothing to say about it, not even "unknown", since the caller may not
// have asked about every watched company).
function computeDueInfo(reports, now = new Date()) {
  const byLei = new Map();
  for (const r of reports) {
    const published = r.publishedAt ? new Date(r.publishedAt) : null;
    if (!published || Number.isNaN(published.getTime())) continue;
    if (r.category !== HALF_YEAR.category && r.category !== ANNUAL.category) continue;

    if (!byLei.has(r.lei)) byLei.set(r.lei, { halfYear: null, annual: null });
    const entry = byLei.get(r.lei);
    if (r.category === HALF_YEAR.category && (!entry.halfYear || published > entry.halfYear)) entry.halfYear = published;
    if (r.category === ANNUAL.category && (!entry.annual || published > entry.annual)) entry.annual = published;
  }

  const result = {};
  for (const [lei, entry] of byLei) {
    result[lei] = {
      halfYear: { lastFiledAt: entry.halfYear ? entry.halfYear.toISOString() : null, status: classify(entry.halfYear, now, HALF_YEAR.periodDays, HALF_YEAR.graceDays) },
      annual: { lastFiledAt: entry.annual ? entry.annual.toISOString() : null, status: classify(entry.annual, now, ANNUAL.periodDays, ANNUAL.graceDays) },
    };
  }
  return result;
}

module.exports = { computeDueInfo, classify, HALF_YEAR, ANNUAL, DUE_SOON_WINDOW_DAYS };
