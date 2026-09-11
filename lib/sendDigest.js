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
// rather than its entire history - a "daily" digest's first email is the
// last 24h, a "weekly" one's is the last 7 days - so turning one on doesn't
// suddenly dump a year of backlog on someone.
function digestWindowStart(subscription, now) {
  return subscription.lastSentAt
    ? new Date(subscription.lastSentAt)
    : new Date(now.getTime() - subscription.frequencyMinutes * 60 * 1000);
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

function buildDigestHtml(reports, prefs, windowLabel) {
  const byLei = new Map();
  for (const r of reports) {
    if (!byLei.has(r.lei)) byLei.set(r.lei, []);
    byLei.get(r.lei).push(r);
  }

  const sections = [...byLei.entries()].map(([lei, items]) => {
    const name = (prefs[lei] && prefs[lei].name) || lei;
    const rows = items
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .map((r) => {
        const title = r.url
          ? `<a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a>`
          : escapeHtml(r.title);
        return `<li>${title} - ${escapeHtml(r.category || '')} - ${escapeHtml(formatDate(r.publishedAt))}</li>`;
      })
      .join('');
    return `<h3>${escapeHtml(name)}</h3><ul>${rows}</ul>`;
  });

  return `<p>${reports.length} new report${reports.length === 1 ? '' : 's'} ${escapeHtml(windowLabel)}.</p>${sections.join('')}`;
}

// How far back a test send looks for sample reports - wide enough to
// usually find something to show, but capped well short of MAX_WINDOW_DAYS
// so a test send doesn't turn into a full-history dump.
const TEST_WINDOW_DAYS = 30;

// Returns { sent: boolean, count } - `sent: false` (with count 0) is the
// normal, frequent outcome (nothing new since last time), not an error.
async function sendDigestForSubscription(subscription) {
  if (!subscription.frequencyMinutes) return { sent: false, count: 0 };

  const { RESEND_API_KEY, NOTIFY_EMAIL_FROM } = process.env;
  if (!RESEND_API_KEY || !NOTIFY_EMAIL_FROM) {
    throw new Error('Email notifications aren\'t configured (missing RESEND_API_KEY / NOTIFY_EMAIL_FROM).');
  }
  if (!digestSendAllowed(subscription.email)) {
    throw new Error('Without APP_PASSWORD, this deployment only sends to its NOTIFY_EMAIL_TO address.');
  }

  const now = new Date();
  const since = digestWindowStart(subscription, now);
  const reports = await collectDigestReports(subscription.prefs || {}, since, now);
  if (reports.length === 0) return { sent: false, count: 0 };

  const windowLabel = `since ${formatDate(since.toISOString())}`;
  const resend = new Resend(RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: NOTIFY_EMAIL_FROM,
    to: subscription.email,
    subject: `RNS Update: ${reports.length} new report${reports.length === 1 ? '' : 's'}`,
    html: buildDigestHtml(reports, subscription.prefs, windowLabel),
  });
  if (error) throw new Error(error.message || JSON.stringify(error));

  return { sent: true, count: reports.length };
}

// Unlike sendDigestForSubscription(), this always sends a real email -
// ignoring the "since last send" window and even a paused (frequencyMinutes
// unset) subscription - and the caller must not call markSent() afterwards,
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
    : `<p>This is a test send for your RNS Update digest. No reports matched your selected companies/categories in the last ${TEST_WINDOW_DAYS} days, but delivery is working.</p>`;

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

module.exports = { digestSendAllowed, sendDigestForSubscription, sendTestDigest, collectDigestReports, filterDigestReports, digestWindowStart, buildDigestHtml };
