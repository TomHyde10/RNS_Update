// Builds and sends one collated email for a single notification subscription
// (see lib/subscriptionStore.js) - everything published, for the companies
// and report types that subscription cares about, since it was last sent.
// Invoked on a timer from server.js, never directly from a request, so
// there's no requestor identity to check at send time - the address itself
// was already validated by digestSendAllowed() when the subscription was
// created (see server.js's POST /api/subscriptions).
const { Resend } = require('resend');
const { fetchReports, normaliseKeyword, daysSinceAsWindow, isPublishedAfter } = require('./fetchReports');
const { isAuthConfigured } = require('./basicAuth');
const {
  FONT, INK, MUTED, BORDER, ACCENT, escapeHtml, formatDateTime, formatShortDateTime, wrapEmail,
} = require('./emailLayout');

// Same policy as lib/sendNotification.js's readConfig(): without
// APP_PASSWORD, this deployment is reachable by anyone, so letting a
// request register an arbitrary address for a *recurring* automated email
// would make this an open spam relay. With APP_PASSWORD set, creating a
// subscription already required logging in, so any address is fine.
function digestSendAllowed(email) {
  if (isAuthConfigured()) return true;
  const fixed = (process.env.NOTIFY_EMAIL_TO || '').trim().toLowerCase();
  return Boolean(fixed) && email.trim().toLowerCase() === fixed;
}

// A brand-new subscription (never sent) covers exactly one cycle back
// rather than its entire history, so turning one on doesn't suddenly dump a
// backlog on someone: a "daily" digest's first email is the last 24h, a
// "monthly" one's is the last 30 days, and "immediate" ("as they occur")
// looks back 24h too, since it's meant to surface only what's genuinely new.
const NEVER_SENT_LOOKBACK_MS = {
  daily: 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  immediate: 24 * 60 * 60 * 1000,
};

function digestWindowStart(subscription, now) {
  if (subscription.lastSentAt) return new Date(subscription.lastSentAt);
  const lookbackMs = NEVER_SENT_LOOKBACK_MS[subscription.scheduleType] || NEVER_SENT_LOOKBACK_MS.daily;
  return new Date(now.getTime() - lookbackMs);
}

// "As they occur" digests only ever cover Half-year/Annual reports - the
// two categories that actually have a filing deadline worth hearing about
// the moment they land (see lib/dueDates.js) - regardless of what other
// categories happen to still be selected in this subscription's prefs from
// before it was switched to "immediate". Enforced here (not just in the
// notifications UI) so it holds even if prefs were saved some other way.
const IMMEDIATE_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report'];

function restrictToImmediateCategories(prefs) {
  const restricted = {};
  for (const [lei, entry] of Object.entries(prefs || {})) {
    const categories = (entry.categories || []).filter((c) => IMMEDIATE_CATEGORIES.includes(c));
    if (categories.length > 0) restricted[lei] = { ...entry, categories };
  }
  return restricted;
}

// A subscriber who never hears anything can't tell "nothing's happened"
// from "this broke weeks ago" (see sendDigestForSubscription below), but
// firing an empty digest on every single due cycle would be far too much
// for anyone checking hourly or every 6 hours - so an empty digest is
// capped to at most one per this many hours, regardless of how often the
// subscription itself is set to check. A digest with actual new reports
// is never throttled - this only ever holds back an empty one.
const EMPTY_DIGEST_MIN_GAP_HOURS = 24;

// Pulled out for unit testing, same reasoning as filterDigestReports()
// below - pure date math, no network dependency. A subscription that's
// never sent at all (lastSentAt null) is never throttled - there's no
// prior send to measure a gap against, and a brand-new subscription's
// first check should confirm delivery works right away, not wait a day.
function isEmptyDigestThrottled(lastSentAt, now, gapHours = EMPTY_DIGEST_MIN_GAP_HOURS) {
  if (!lastSentAt) return false;
  const hoursSinceLastSent = (now.getTime() - new Date(lastSentAt).getTime()) / (60 * 60 * 1000);
  return hoursSinceLastSent < gapHours;
}

// Pulled out of collectDigestReports() below so the actual decision logic
// - which of a company's already-fetched reports belong in this digest -
// is unit-testable against a crafted `reports` array, with no network call
// and no dependency on live NSM data being in any particular state.
// `keyword`, when set, is OR'd with the per-company category match (same
// relationship as lib/fetchReports.js's own matchesCategory/matchesKeyword)
// - a report mentioning it surfaces even for a category this subscription
// hasn't otherwise selected for that company, as long as the company itself
// is in `prefs` at all. Matched against the title, the same field NSM's own
// `headline` normalises into (see lib/fetchReports.js's normalise()) -
// normaliseKeyword() is the same trim/lowercase fetchReports.js itself
// applies before matching, reused here so "keyword" means the same thing
// throughout the app rather than two independently-drifting definitions.
function filterDigestReports(reports, prefs, since, keyword) {
  const keywordNorm = normaliseKeyword(keyword);
  return reports.filter((r) => {
    const entry = prefs[r.lei];
    if (!entry) return false;
    const categoryMatch = entry.categories.some((c) => c.toLowerCase() === (r.category || '').toLowerCase());
    const keywordMatch = Boolean(keywordNorm) && typeof r.title === 'string' && r.title.toLowerCase().includes(keywordNorm);
    if (!categoryMatch && !keywordMatch) return false;
    return isPublishedAfter(r, since);
  });
}

// prefs: { [lei]: { name, categories: [...] } }. One fetchReports() call
// covering every LEI and the union of every selected category (reusing its
// NSM cache), then filtered down per-LEI to that company's own selected
// categories (or a keyword match - see filterDigestReports) and to strictly
// after `since` - fetchReports()'s own `days` window is day-granular and
// only used to get a wide-enough net. `keyword` is passed through to
// fetchReports() itself too, so a matching filing is fetched (and returned
// in body.reports) even for a category outside the union above - see
// lib/fetchReports.js's own matchesKeyword.
async function collectDigestReports(prefs, since, now, keyword) {
  const leis = Object.keys(prefs);
  if (leis.length === 0) return [];

  const categorySet = new Set();
  for (const entry of Object.values(prefs)) {
    for (const category of entry.categories || []) categorySet.add(category);
  }
  if (categorySet.size === 0 && !keyword) return [];

  const days = daysSinceAsWindow(since, now);

  const { status, body } = await fetchReports({
    leis: leis.join(','),
    days,
    categories: [...categorySet].join(','),
    keyword,
  });
  if (status !== 200) throw new Error(body.error || `fetchReports failed (${status})`);

  return filterDigestReports(body.reports, prefs, since, keyword);
}

// All markup below is table-based with inline styles - see
// lib/emailLayout.js for why.

// Compact one-line breakdown by report type ("6 Net Asset Value(s) · 1
// Miscellaneous"). Per-company counts are already in each section heading
// below, so this deliberately doesn't repeat them.
function typeSummary(categoryCounts) {
  const parts = categoryCounts
    .map(([label, count]) => `<span style="white-space:nowrap;"><strong style="color:${INK};">${count}</strong>&nbsp;${escapeHtml(label)}</span>`)
    .join(`<span style="color:${BORDER};">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`);
  return `<p style="margin:0 0 20px;padding:0 0 16px;border-bottom:1px solid ${BORDER};font-size:13px;line-height:1.7;color:${MUTED};">${parts}</p>`;
}

function reportRow(r, isLast) {
  const title = r.url
    ? `<a href="${escapeHtml(r.url)}" style="color:${ACCENT};text-decoration:none;font-weight:600;font-size:14px;line-height:1.4;">${escapeHtml(r.title)}</a>`
    : `<span style="font-weight:600;font-size:14px;line-height:1.4;color:${INK};">${escapeHtml(r.title)}</span>`;
  // NSM often reuses the category as the headline ("Net Asset Value(s)" /
  // "Net Asset Value(s)") - don't say it twice.
  const category = r.category || 'Other';
  const meta = category === r.title
    ? escapeHtml(formatShortDateTime(r.publishedAt))
    : `${escapeHtml(category)} &middot; ${escapeHtml(formatShortDateTime(r.publishedAt))}`;
  const border = isLast ? '' : `border-bottom:1px solid ${BORDER};`;
  return `<tr>
    <td style="padding:10px 0;${border}font-family:${FONT};">
      ${title}
      <div style="margin-top:3px;font-size:12px;line-height:1.4;color:${MUTED};">${meta}</div>
    </td>
  </tr>`;
}

function companySection(name, items) {
  const rows = items
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .map((r, i) => reportRow(r, i === items.length - 1))
    .join('');
  return `<h3 style="margin:0;padding:0 0 6px;border-bottom:2px solid ${INK};font-size:15px;line-height:1.3;color:${INK};">${escapeHtml(name)} <span style="font-weight:400;color:${MUTED};font-size:12px;white-space:nowrap;">(${items.length} report${items.length === 1 ? '' : 's'})</span></h3>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 20px;">${rows}</table>`;
}

function buildDigestHtml(reports, prefs, windowLabel) {
  const byLei = new Map();
  const byCategory = new Map();
  for (const r of reports) {
    if (!byLei.has(r.lei)) byLei.set(r.lei, []);
    byLei.get(r.lei).push(r);
    const category = r.category || 'Other';
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
  }

  // Busiest company/category first - the point of a summary is to show
  // what to look at first, not to preserve report order.
  const companies = [...byLei.entries()]
    .map(([lei, items]) => ({ lei, name: (prefs[lei] && prefs[lei].name) || lei, items }))
    .sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  const categoryCounts = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);

  // Only worth showing once there's more than one report type to break
  // down - company counts are already in each section heading.
  const summary = reports.length > 0 && categoryCounts.length > 1
    ? typeSummary(categoryCounts)
    : '';

  const sections = companies.map(({ name, items }) => companySection(name, items));

  const count = `${reports.length} new report${reports.length === 1 ? '' : 's'}`;
  const headline = `${count} ${escapeHtml(windowLabel)}.`;
  const body = summary + (sections.join('') || `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${MUTED};">Nothing new was published for the companies and report types you follow.</p>`);
  const preheader = companies.length > 0
    ? `${count}: ${companies.map((c) => c.name).join(', ')}`
    : 'Nothing new since the last update.';
  return wrapEmail({ headline, bodyHtml: body, preheader });
}

// How far back a test send looks for sample reports - wide enough to
// usually find something to show, but capped well short of MAX_WINDOW_DAYS
// so a test send doesn't turn into a full-history dump.
const TEST_WINDOW_DAYS = 30;

// Sends every due cycle with actual new reports, plus at most one empty
// "nothing new" heartbeat per EMPTY_DIGEST_MIN_GAP_HOURS - a subscriber
// who never hears anything can't tell "nothing's happened" from "this
// broke weeks ago", but an empty email on every single due cycle would be
// far too much for anyone checking more often than daily. Returns { sent:
// boolean, count } - `sent: false` (with count 0) means either a paused
// subscription (shouldn't reach this function via the scheduler at all,
// isDue() already filters those out, but handled here too for any other
// caller) or a throttled empty digest. The caller must only advance its
// own "last sent" cursor when sent is true - see digestScheduler.js.
async function sendDigestForSubscription(subscription) {
  if (!subscription.scheduleType || subscription.scheduleType === 'paused') return { sent: false, count: 0 };

  const { RESEND_API_KEY, NOTIFY_EMAIL_FROM } = process.env;
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_FROM) {
    throw new Error('Email notifications aren\'t configured (missing RESEND_API_KEY / NOTIFY_EMAIL_FROM).');
  }
  if (!digestSendAllowed(subscription.email)) {
    throw new Error('Without APP_PASSWORD, this deployment only sends to its NOTIFY_EMAIL_TO address.');
  }

  const isImmediate = subscription.scheduleType === 'immediate';
  const prefs = isImmediate ? restrictToImmediateCategories(subscription.prefs) : (subscription.prefs || {});

  const now = new Date();
  const since = digestWindowStart(subscription, now);
  const reports = await collectDigestReports(prefs, since, now, subscription.keyword);

  if (reports.length === 0) {
    // "As they occur" never sends an empty heartbeat - there's no fixed
    // cycle for a subscriber to wonder whether they missed, just silence
    // until something half-year/annual actually publishes.
    if (isImmediate) return { sent: false, count: 0 };
    if (isEmptyDigestThrottled(subscription.lastSentAt, now)) return { sent: false, count: 0 };
  }

  const windowLabel = `since ${formatDateTime(since.toISOString())}`;
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: NOTIFY_EMAIL_FROM,
    to: subscription.email,
    subject: reports.length > 0
      ? `RNS Update: ${reports.length} new report${reports.length === 1 ? '' : 's'}`
      : 'RNS Update: No new reports',
    html: buildDigestHtml(reports, prefs, windowLabel),
  });
  if (error) throw new Error(error.message || JSON.stringify(error));

  return { sent: true, count: reports.length };
}

// Unlike sendDigestForSubscription(), this always sends a real email -
// ignoring the "since last send" window and even a paused subscription -
// and the caller must not call markSent() afterwards,
// so a test send never disturbs the real recurring digest's cursor. Exists
// purely so someone setting up a digest can confirm delivery/formatting
// works right now, without needing new reports to actually be pending.
async function sendTestDigest(subscription) {
  const { RESEND_API_KEY, NOTIFY_EMAIL_FROM } = process.env;
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_FROM) {
    throw new Error('Email notifications aren\'t configured (missing RESEND_API_KEY / NOTIFY_EMAIL_FROM).');
  }
  if (!digestSendAllowed(subscription.email)) {
    throw new Error('Without APP_PASSWORD, this deployment only sends to its NOTIFY_EMAIL_TO address.');
  }

  const now = new Date();
  const since = new Date(now.getTime() - TEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const reports = await collectDigestReports(subscription.prefs || {}, since, now, subscription.keyword);

  const html = reports.length > 0
    ? buildDigestHtml(reports, subscription.prefs, `in the last ${TEST_WINDOW_DAYS} days (test send)`)
    : wrapEmail({
        headline: `Test send - 0 reports in the last ${TEST_WINDOW_DAYS} days.`,
        bodyHtml: `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${MUTED};">No reports matched your selected companies/categories in the last ${TEST_WINDOW_DAYS} days, but delivery is working.</p>`,
        preheader: 'Delivery is working.',
      });

  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: NOTIFY_EMAIL_FROM,
    to: subscription.email,
    subject: `RNS Update test: ${reports.length} report${reports.length === 1 ? '' : 's'} found`,
    html,
  });
  if (error) throw new Error(error.message || JSON.stringify(error));

  return { sent: true, count: reports.length };
}

module.exports = { digestSendAllowed, sendDigestForSubscription, sendTestDigest, collectDigestReports, filterDigestReports, digestWindowStart, isEmptyDigestThrottled, buildDigestHtml, restrictToImmediateCategories, IMMEDIATE_CATEGORIES };
