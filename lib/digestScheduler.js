// The due-check logic behind server.js's setInterval loop, pulled out into
// its own module so it's unit-testable against a fake store and a fake
// sender - no real Postgres, no real Resend, no waiting on real timers.
// Both `subscriptionStore` and `sendDigestForSubscription` are passed in
// (rather than required directly) for exactly that reason: a test can hand
// in stand-ins instead of the real lib/subscriptionStore.js and
// lib/sendDigest.js modules.

// A subscription is due once its frequency has elapsed since its last
// send - or immediately, for one that's never been sent at all. frequency
// 0 ("Paused") is never due.
function isDue(subscription, now) {
  if (!subscription.frequencyMinutes) return false;
  const lastSentMs = subscription.lastSentAt ? new Date(subscription.lastSentAt).getTime() : 0;
  return now >= lastSentMs + subscription.frequencyMinutes * 60 * 1000;
}

async function runDueDigests({ subscriptionStore, sendDigestForSubscription, now = () => new Date(), log = console.log, logError = console.error }) {
  if (!subscriptionStore.enabled) return { checked: 0, sent: 0 };

  let subscriptions;
  try {
    subscriptions = await subscriptionStore.listSubscriptions();
  } catch (err) {
    logError('Failed to load subscriptions for digest run:', err.message || err);
    return { checked: 0, sent: 0 };
  }

  const nowMs = now().getTime();
  let sent = 0;
  for (const subscription of subscriptions) {
    if (!isDue(subscription, nowMs)) continue;

    try {
      const result = await sendDigestForSubscription(subscription);
      await subscriptionStore.markSent(subscription.id, new Date(nowMs));
      if (result.sent) {
        sent++;
        log(`Digest sent to ${subscription.email}: ${result.count} report(s).`);
      }
    } catch (err) {
      logError(`Digest failed for ${subscription.email}:`, err.message || err);
    }
  }
  return { checked: subscriptions.length, sent };
}

// How far ahead of the fastest active subscription's own due moment the
// scheduler aims to check, so that check reliably lands at-or-before that
// subscription's exact due instant instead of needing a whole extra cycle
// to notice it (and, per its name, leaves this much of a lead-in window
// before the send to have already warmed lib/fetchReports.js's NSM cache
// for those companies, rather than that fetch happening cold at send time).
const PREP_BUFFER_MINUTES = 3;

// A floor against ever spinning implausibly fast, and a ceiling used when
// there's nothing active to derive an interval from at all (no
// subscriptions, or all of them paused) - a newly-created subscription
// still gets noticed reasonably promptly rather than waiting on a check
// that would otherwise have no reason to run again soon. Matches this
// project's original fixed 5-minute interval.
const MIN_POLL_INTERVAL_MINUTES = 1;
const DEFAULT_POLL_INTERVAL_MINUTES = 5;

// The scheduler's own check cadence: derived from the fastest active
// subscription rather than fixed, so a deployment with only daily/weekly
// subscribers isn't checked every few minutes for no reason, while one
// with an hourly subscriber still gets checked often enough to catch it
// close to on time. Callers are expected to recompute this - and
// reschedule their timer accordingly - every time subscriptions are
// created, updated, or deleted, not just once at startup, since the
// interval a now-paused or long-frequency-only deployment needs can
// change at any time.
function computePollIntervalMinutes(subscriptions) {
  const activeFrequencies = subscriptions
    .map((s) => s.frequencyMinutes)
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0);

  if (activeFrequencies.length === 0) return DEFAULT_POLL_INTERVAL_MINUTES;

  const fastest = Math.min(...activeFrequencies);
  return Math.max(MIN_POLL_INTERVAL_MINUTES, fastest - PREP_BUFFER_MINUTES);
}

module.exports = {
  isDue,
  runDueDigests,
  computePollIntervalMinutes,
  PREP_BUFFER_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
  DEFAULT_POLL_INTERVAL_MINUTES,
};
