// The due-check logic behind server.js's setInterval loop, pulled out into
// its own module so it's unit-testable against a fake store and a fake
// sender - no real Postgres, no real Resend, no waiting on real timers.
// Both `subscriptionStore` and `sendDigestForSubscription` are passed in
// (rather than required directly) for exactly that reason: a test can hand
// in stand-ins instead of the real lib/subscriptionStore.js and
// lib/sendDigest.js modules.

// Parses a subscription's "HH:MM" send_time_utc, falling back to 08:00 for
// anything malformed rather than letting a bad value wedge the scheduler.
function parseSendTimeUtc(sendTimeUtc) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(sendTimeUtc || '');
  if (!match) return { hour: 8, minute: 0 };
  const hour = Math.min(23, parseInt(match[1], 10));
  const minute = Math.min(59, parseInt(match[2], 10));
  return { hour, minute };
}

// The current period's scheduled instant in UTC: today's send_time_utc for
// "daily", the 1st of the current month's send_time_utc for "monthly". Not
// meaningful for "paused"/"immediate", which isDue() handles separately.
function currentScheduledInstant(subscription, nowMs) {
  const { hour, minute } = parseSendTimeUtc(subscription.sendTimeUtc);
  const now = new Date(nowMs);
  const day = subscription.scheduleType === 'monthly' ? 1 : now.getUTCDate();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, minute, 0, 0);
}

// A "daily"/"monthly" subscription is due once the current period's
// scheduled instant has passed and hasn't been sent yet - so a subscriber
// added after today's (or this month's) time has already gone by gets its
// first send right away, rather than waiting a full extra period, and a
// missed tick (the process was down) just sends slightly late instead of
// being skipped entirely. "immediate" ("as they occur") is always due to
// check - lib/sendDigest.js only actually emails it when there's fresh
// half-year/annual content, never an empty heartbeat. "paused" is never due.
function isDue(subscription, now) {
  const type = subscription.scheduleType;
  if (!type || type === 'paused') return false;
  if (type === 'immediate') return true;

  const target = currentScheduledInstant(subscription, now);
  const lastSentMs = subscription.lastSentAt ? new Date(subscription.lastSentAt).getTime() : 0;
  return now >= target && lastSentMs < target;
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
      // Only advance the cursor when something was actually emailed -
      // sendDigestForSubscription() can now decline to send a due but
      // empty digest (see lib/sendDigest.js's isEmptyDigestThrottled(),
      // capping empty ones to at most one per day). Leaving lastSentAt
      // untouched in that case is what makes the throttle's own "time
      // since last sent" check keep working on the next tick, and is
      // harmless either way since nothing new was found in this window to
      // begin with - there's nothing for a later, wider re-check to lose.
      if (result.sent) {
        await subscriptionStore.markSent(subscription.id, new Date(nowMs));
        sent++;
        log(`Digest sent to ${subscription.email}: ${result.count} report(s).`);
      }
    } catch (err) {
      logError(`Digest failed for ${subscription.email}:`, err.message || err);
    }
  }
  return { checked: subscriptions.length, sent };
}

// A floor for how often the scheduler ever checks (used when at least one
// subscription is "immediate", which needs to notice new content promptly),
// and the cadence used otherwise (no subscriptions, all paused, or only
// day/month-scheduled ones - a fixed handful of minutes is close enough to
// any chosen send_time_utc without checking constantly). Matches this
// project's original fixed 5-minute interval.
const MIN_POLL_INTERVAL_MINUTES = 1;
const DEFAULT_POLL_INTERVAL_MINUTES = 5;

// The scheduler's own check cadence. Unlike the old elapsed-frequency model
// (where a subscription's own interval directly set the poll rate), a
// "daily"/"monthly" send now fires at an absolute time of day rather than N
// minutes after the last send, so there's no single "fastest" cadence to
// derive from any more - DEFAULT_POLL_INTERVAL_MINUTES is close enough to
// any send_time_utc for those. Only "immediate" subscriptions still need
// tight polling, since they're meant to notice new half-year/annual reports
// as they're published. Callers are expected to recompute this - and
// reschedule their timer accordingly - every time subscriptions are
// created, updated, or deleted, not just once at startup.
function computePollIntervalMinutes(subscriptions) {
  const active = subscriptions.filter((s) => s.scheduleType && s.scheduleType !== 'paused');
  if (active.length === 0) return DEFAULT_POLL_INTERVAL_MINUTES;
  if (active.some((s) => s.scheduleType === 'immediate')) return MIN_POLL_INTERVAL_MINUTES;
  return DEFAULT_POLL_INTERVAL_MINUTES;
}

module.exports = {
  isDue,
  runDueDigests,
  computePollIntervalMinutes,
  MIN_POLL_INTERVAL_MINUTES,
  DEFAULT_POLL_INTERVAL_MINUTES,
};
