// Builds and sends one collated email for a single notification subscription
// (see lib/subscriptionStore.js) - everything published, for the companies
// and report types that subscription cares about, since it was last sent.
// Invoked on a timer from server.js, never directly from a request, so
// there's no requestor identity to check at send time - the address itself
// was already validated by digestSendAllowed() when the subscription was
// created (see server.js's POST /api/subscriptions).
const { Resend } = require('resend');
const { fetchReports, MAX_WINDOW_DAYS } = require('./fetchReports');
const { isAuthConfigured } = require('./basicAuth');

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function formatDate(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString('en-GB');
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
function filterDigestReports(reports, prefs, since) {
  return reports.filter((r) => {
    const entry = prefs[r.lei];
    if (!entry) return false;
    if (!entry.categories.some((c) => c.toLowerCase() === (r.category || '').toLowerCase())) return false;
    const published = r.publishedAt ? new Date(r.publishedAt) : null;
    return published && !Number.isNaN(published.getTime()) && published > since;
  });
}

// prefs: { [lei]: { name, categories: [...] } }. One fetchReports() call
// covering every LEI and the union of every selected category (reusing its
// NSM cache), then filtered down per-LEI to that company's own selected
// categories and to strictly after `since` - fetchReports()'s own `days`
// window is day-granular and only used to get a wide-enough net.
async function collectDigestReports(prefs, since, now) {
  const leis = Object.keys(prefs);
  if (leis.length === 0) return [];

  const categorySet = new Set();
  for (const entry of Object.values(prefs)) {
    for (const category of entry.categories || []) categorySet.add(category);
  }
  if (categorySet.size === 0) return [];

  const days = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.ceil((now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000)) + 1));

  const { status, body } = await fetchReports({
    leis: leis.join(','),
    days,
    categories: [...categorySet].join(','),
  });
  if (status !== 200) throw new Error(body.error || `fetchReports failed (${status})`);

  return filterDigestReports(body.reports, prefs, since);
}

// Inline styles only, deliberately - a <style> block gets stripped by
// several webmail clients (Gmail included), so anything that needs to
// render consistently has to live on the element itself. Colors are
// spelled out explicitly rather than left to defaults, since email
// clients' own dark-mode remapping of unstyled text is unpredictable.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#0f172a';
const MUTED = '#64748b';
const BORDER = '#e2e8f0';
const ACCENT = '#2563eb';
const ACCENT_BG = '#eff6ff';

function summaryTable(headingLabel, rows) {
  const body = rows
    .map(([label, count], i) => {
      const bg = i % 2 ? 'background:#f8fafc;' : '';
      return `<tr>
        <td style="padding:6px 10px;font-size:13px;color:${INK};border-bottom:1px solid ${BORDER};${bg}">${escapeHtml(label)}</td>
        <td style="padding:6px 10px;font-size:13px;color:${INK};text-align:right;border-bottom:1px solid ${BORDER};${bg}">${count}</td>
      </tr>`;
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;border:1px solid ${BORDER};border-radius:6px;overflow:hidden;">
    <tr>
      <th style="text-align:left;padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};background:#f1f5f9;border-bottom:1px solid ${BORDER};">${escapeHtml(headingLabel)}</th>
      <th style="text-align:right;padding:6px 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${MUTED};background:#f1f5f9;border-bottom:1px solid ${BORDER};">Reports</th>
    </tr>
    ${body}
  </table>`;
}

function reportRow(r) {
  const title = r.url
    ? `<a href="${escapeHtml(r.url)}" style="color:${ACCENT};text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(r.title)}</a>`
    : `<span style="font-weight:600;font-size:14px;color:${INK};">${escapeHtml(r.title)}</span>`;
  return `<div style="padding:10px 0;border-bottom:1px solid ${BORDER};">
    <div>${title}</div>
    <div style="margin-top:4px;">
      <span style="display:inline-block;background:${ACCENT_BG};color:${ACCENT};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${escapeHtml(r.category || 'Other')}</span>
      <span style="margin-left:6px;font-size:12px;color:${MUTED};">${escapeHtml(formatDate(r.publishedAt))}</span>
    </div>
  </div>`;
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

  // A summary is only worth showing once there's more than one company or
  // category to break down - for a single-company, single-type digest the
  // detail section below already says everything the summary would.
  const summary = reports.length > 0 && (companies.length > 1 || categoryCounts.length > 1)
    ? summaryTable('Company', companies.map((c) => [c.name, c.items.length]))
      + summaryTable('Report type', categoryCounts)
    : '';

  const sections = companies.map(({ name, items }) => {
    const rows = items
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .map(reportRow)
      .join('');
    return `<div style="margin:0 0 20px;">
      <h3 style="margin:0 0 4px;font-size:15px;color:${INK};">${escapeHtml(name)} <span style="font-weight:400;color:${MUTED};font-size:13px;">(${items.length} report${items.length === 1 ? '' : 's'})</span></h3>
      ${rows}
    </div>`;
  });

  const headline = `${reports.length} new report${reports.length === 1 ? '' : 's'} ${escapeHtml(windowLabel)}.`;
  const body = summary + (sections.join('') || `<p style="margin:0;font-size:13px;color:${MUTED};">Nothing to show.</p>`);
  return wrapEmail(headline, body);
}

// Optional - without it the footer below is simply omitted, same as any
// other feature gated on an env var this app treats as optional. Trailing
// slashes stripped so `${APP_URL}/#notifications` never ends up with `//`.
const APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');

// Shared header/card shell for every digest email - a test send with
// nothing to report uses this too (see sendTestDigest() below), so
// "delivery works but nothing matched" looks like the same product as a
// real digest, not a bare, unstyled fallback. The footer link (when
// APP_URL is configured) opens the app straight to the Notifications
// overlay - see app.js's `#notifications` hash handling - so changing or
// pausing a subscription doesn't require remembering where the button is.
function wrapEmail(headline, bodyHtml) {
  const footer = APP_URL
    ? `<p style="margin:16px 0 0;text-align:center;font-size:12px;color:${MUTED};">
        <a href="${escapeHtml(APP_URL)}/#notifications" style="color:${MUTED};">Manage notification preferences</a>
      </p>`
    : '';
  return `<div style="font-family:${FONT};max-width:600px;margin:0 auto;">
    <div style="background:${INK};border-radius:8px 8px 0 0;padding:16px 20px;">
      <p style="margin:0;color:#ffffff;font-size:16px;font-weight:600;">RNS Update</p>
      <p style="margin:4px 0 0;color:#cbd5e1;font-size:13px;">${headline}</p>
    </div>
    <div style="border:1px solid ${BORDER};border-top:none;border-radius:0 0 8px 8px;padding:20px;">
      ${bodyHtml}
    </div>
    ${footer}
  </div>`;
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
  const reports = await collectDigestReports(prefs, since, now);

  if (reports.length === 0) {
    // "As they occur" never sends an empty heartbeat - there's no fixed
    // cycle for a subscriber to wonder whether they missed, just silence
    // until something half-year/annual actually publishes.
    if (isImmediate) return { sent: false, count: 0 };
    if (isEmptyDigestThrottled(subscription.lastSentAt, now)) return { sent: false, count: 0 };
  }

  const windowLabel = `since ${formatDate(since.toISOString())}`;
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
  const reports = await collectDigestReports(subscription.prefs || {}, since, now);

  const html = reports.length > 0
    ? buildDigestHtml(reports, subscription.prefs, `in the last ${TEST_WINDOW_DAYS} days (test send)`)
    : wrapEmail(
        `Test send - 0 reports in the last ${TEST_WINDOW_DAYS} days.`,
        `<p style="margin:0;font-size:13px;color:${MUTED};">No reports matched your selected companies/categories in the last ${TEST_WINDOW_DAYS} days, but delivery is working.</p>`,
      );

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
