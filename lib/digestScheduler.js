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

module.exports = { isDue, runDueDigests };
