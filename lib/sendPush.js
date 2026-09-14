// Checks one push subscription's watched companies/categories/keyword for
// anything new since it was last checked, and sends a Web Push notification
// if so - the push equivalent of lib/sendDigest.js's
// sendDigestForSubscription(), but simpler: no HTML, no company-by-company
// breakdown, just enough for a browser/OS notification, and no "as they
// occur only for Half-year/Annual" restriction, since a push subscription
// mirrors whatever companies/categories/keyword were active in the browser
// when it was turned on (see app.js's syncPushSubscription()) rather than
// being configured through its own separate matrix.
const { fetchReports, MAX_WINDOW_DAYS } = require('./fetchReports');
const { sendPush } = require('./webPush');

// Same reasoning as lib/sendDigest.js's NEVER_SENT_LOOKBACK_MS: a brand-new
// subscription (never checked) looks back one day rather than dumping
// everything currently matching as a burst of "new" notifications the
// moment push is turned on.
const NEVER_CHECKED_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const APP_URL = (process.env.APP_URL || '').trim().replace(/\/+$/, '');

// How many individual report titles to name before falling back to just a
// count - matches app.js's own notifyNewReports() (the tab-open Notification
// fallback this feature replaces) for a consistent feel between the two.
const MAX_NAMED_REPORTS = 3;

function buildPayload(matched) {
  if (matched.length === 1) {
    return { title: `RNS Update: ${matched[0].company}`, body: matched[0].title, url: APP_URL || '/' };
  }
  const names = matched.slice(0, MAX_NAMED_REPORTS).map((r) => r.company);
  const extra = matched.length > MAX_NAMED_REPORTS ? ` +${matched.length - MAX_NAMED_REPORTS} more` : '';
  return { title: `RNS Update: ${matched.length} new reports`, body: `${names.join(', ')}${extra}`, url: APP_URL || '/' };
}

// Returns { sent, gone } - `sent` is the number of matching reports found
// (0 means nothing new, not an error), `gone` (from lib/webPush.js's
// sendPush()) means the push service has permanently invalidated this
// subscription and the caller (lib/digestScheduler.js's runDuePush()) should
// delete it rather than keep retrying.
async function sendPushForSubscription(subscription) {
  const now = new Date();
  const since = subscription.lastCheckedAt ? new Date(subscription.lastCheckedAt) : new Date(now.getTime() - NEVER_CHECKED_LOOKBACK_MS);

  const leis = subscription.leis || [];
  if (leis.length === 0) return { sent: 0 };

  const days = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.ceil((now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000)) + 1));
  const categories = subscription.categories && subscription.categories.length ? subscription.categories.join(',') : undefined;

  const { status, body } = await fetchReports({ leis: leis.join(','), days, categories, keyword: subscription.keyword });
  if (status !== 200) throw new Error(body.error || `fetchReports failed (${status})`);

  const matched = body.reports.filter((r) => {
    const published = r.publishedAt ? new Date(r.publishedAt) : null;
    return published && !Number.isNaN(published.getTime()) && published > since;
  });

  if (matched.length === 0) return { sent: 0 };

  const result = await sendPush(subscription, buildPayload(matched));
  return { sent: matched.length, gone: result.gone };
}

module.exports = { sendPushForSubscription };
