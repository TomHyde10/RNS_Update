// Re-costing saved plans against each new curve.
//
// This is what turns the application from a calculator into something worth
// coming back to: the cost of funding a plan moves every day the curve moves,
// and nobody is going to reopen the page to find that out. It needs no new
// data - the curve is already fetched daily for the app itself.
//
// Everything here is pure policy: what is due, what has moved, and what the
// message says. The store, the ladder builder, the clock and the sender are
// all passed in, the same way lib/digestScheduler.js in the host app takes its
// store and sender - so this is testable against fakes, with no Postgres, no
// Resend and no waiting on real timers.

// A move smaller than this is noise. Gilt prices move a few basis points most
// days, and an alert that fires every morning is one nobody reads.
const DEFAULT_THRESHOLD_PERCENT = 1;

// Re-cost once a day, after the Bank publishes.
const DEFAULT_HOUR_UTC = 9;

// A plan is due when the day's scheduled instant has passed and it has not
// been costed since. Lifted from the host scheduler's isDue(): the same shape
// of question, so the same shape of answer.
function isRecostDue(lastCostedAt, nowMs, hourUtc = DEFAULT_HOUR_UTC) {
  const now = new Date(nowMs);
  const scheduled = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0);
  if (nowMs < scheduled) return false;
  if (!lastCostedAt) return true;
  return Date.parse(lastCostedAt) < scheduled;
}

// Signed: positive means funding the plan got more expensive.
function drift(previousCost, currentCost) {
  if (previousCost == null || !(previousCost > 0)) return null;
  const absolute = currentCost - previousCost;
  return { absolute, percent: (absolute / previousCost) * 100 };
}

const money = (n) =>
  n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });

// Returns the alert to send, or null for nothing worth saying.
//
// Two things are worth saying. One is that the cost has moved more than the
// threshold. The other is that a plan which used to be fully funded no longer
// is - that is worth an alert at any size of move, because it is a change in
// kind rather than in degree, and it is the whole reason someone would watch a
// plan rather than build it once.
function buildAlert(record, result, { thresholdPercent = DEFAULT_THRESHOLD_PERCENT } = {}) {
  const moved = drift(record.lastCost, result.cost);
  const brokeFunding = record.lastFullyFunded === true && result.fullyFunded === false;
  const bigMove = moved != null && Math.abs(moved.percent) >= thresholdPercent;

  if (!brokeFunding && !bigMove) return null;

  const direction = moved && moved.absolute > 0 ? 'more' : 'less';
  const lines = [];

  if (brokeFunding) {
    lines.push(`"${record.label}" no longer funds every liability in full.`);
  }
  if (bigMove) {
    lines.push(
      `Funding "${record.label}" now costs ${money(result.cost)}, ` +
        `${money(Math.abs(moved.absolute))} ${direction} than when it was last costed ` +
        `(${money(record.lastCost)}), a move of ${moved.percent.toFixed(1)}%.`
    );
  }

  lines.push(`Priced off the ${result.curveDate} curve.`);
  if (result.indicative !== false) {
    lines.push('Indicative only: these are not dealable prices and exclude dealing costs.');
  }

  return {
    planId: record.id,
    subject: brokeFunding
      ? `Gilt Ladder: "${record.label}" is no longer fully funded`
      : `Gilt Ladder: "${record.label}" costs ${moved.percent > 0 ? 'more' : 'less'} to fund`,
    text: lines.join('\n\n'),
    drift: moved,
    brokeFunding,
  };
}

// Re-costs every plan that is due and sends what is worth sending.
//
// A plan is costed even when no alert follows, because the stored cost is the
// baseline the next comparison is made against: skipping the write would make
// every later move look like it happened in one day.
//
// A failure on one plan must not stop the rest - one unpriceable plan should
// not silence every other alert - so failures are collected and reported.
async function runRecosting({
  store,
  costPlan,
  send,
  now = Date.now(),
  hourUtc = DEFAULT_HOUR_UTC,
  thresholdPercent = DEFAULT_THRESHOLD_PERCENT,
} = {}) {
  const summary = { costed: 0, alerted: 0, skipped: 0, failed: [] };

  for (const record of await store.all()) {
    if (!record.alertsEnabled) {
      summary.skipped++;
      continue;
    }
    if (!isRecostDue(record.lastCostedAt, now, hourUtc)) {
      summary.skipped++;
      continue;
    }

    let result;
    try {
      result = await costPlan(record.plan);
    } catch (err) {
      summary.failed.push({ id: record.id, error: err.message });
      continue;
    }

    const alert = buildAlert(record, result, { thresholdPercent });

    await store.recordCosting(record.id, {
      cost: result.cost,
      curveDate: result.curveDate,
      fullyFunded: result.fullyFunded,
      at: new Date(now).toISOString(),
    });
    summary.costed++;

    if (!alert || !send) continue;
    try {
      await send(alert);
      summary.alerted++;
    } catch (err) {
      // The costing is already recorded, so a failed send is not retried into
      // a duplicate tomorrow - it is reported and the baseline moves on.
      summary.failed.push({ id: record.id, error: `alert not sent: ${err.message}` });
    }
  }

  return summary;
}

module.exports = {
  isRecostDue,
  drift,
  buildAlert,
  runRecosting,
  DEFAULT_THRESHOLD_PERCENT,
  DEFAULT_HOUR_UTC,
};
