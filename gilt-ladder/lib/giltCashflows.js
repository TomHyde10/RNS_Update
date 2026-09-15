// Coupon schedules and the cash flows a buyer actually receives.
//
// All amounts are per £100 nominal, the unit gilts are quoted and dealt in.
// Conventional gilts pay semi-annually and redeem at par, so a gilt is fully
// described by its coupon rate and redemption date - everything below is
// derived from those two.
const { toDate, toISO, addBusinessDays, paymentDate, daysBetween } = require('./calendar');

// Gilts go ex-dividend 7 business days before a coupon date. A buyer whose
// trade settles on or after the xd date does not receive that coupon - it
// goes to the seller. This is the single easiest thing to get wrong in the
// whole model: it silently overstates the cash flows AND misprices the
// purchase, and only bites for the ~2 weeks a year each gilt is in xd.
const EX_DIV_BUSINESS_DAYS = 7;

const REDEMPTION_PER_100 = 100;

function addMonths(date, months) {
  const d = toDate(date);
  const targetMonth = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), daysInMonth)));
}

// Every coupon date is computed as an offset from the redemption date rather
// than by stepping iteratively off the previous one. Stepping iteratively lets
// end-of-month clamping compound: a 31 March redemption would go 30 September,
// then 30 March, then 30 September... and drift a day permanently after the
// first short month.
const couponDateAt = (redemption, periodsBack) => addMonths(redemption, -6 * periodsBack);

const exDivDate = (couponDate) => addBusinessDays(couponDate, -EX_DIV_BUSINESS_DAYS);

// Coupon dates strictly after `after`, up to and including redemption.
// `after` is normally the settlement date.
function couponSchedule(gilt, after) {
  const redemption = toDate(gilt.redemption);
  const cutoff = toDate(after);
  if (cutoff >= redemption) return [];

  const dates = [];
  for (let k = 0; ; k++) {
    const d = couponDateAt(redemption, k);
    if (d <= cutoff) break;
    dates.push(d);
    if (k > 200) throw new Error(`coupon schedule for ${gilt.name} did not terminate`); // 100y guard
  }
  return dates.reverse();
}

// The coupon period containing `settlement`: the pair of unadjusted coupon
// dates that bracket it. Used for accrued interest, which is why it uses the
// unadjusted dates - the business-day payment shift does not change accrual.
function couponPeriod(gilt, settlement) {
  const redemption = toDate(gilt.redemption);
  const s = toDate(settlement);
  for (let k = 0; k < 400; k++) {
    const end = couponDateAt(redemption, k);
    if (end <= s) continue;
    const start = couponDateAt(redemption, k + 1);
    if (start <= s) return { start, end, days: daysBetween(start, end) };
  }
  throw new Error(`no coupon period of ${gilt.name} contains ${toISO(s)}`);
}

// The cash flows a buyer settling on `settlement` receives, per £100 nominal.
// Each entry carries both the unadjusted coupon date and the date the money
// actually arrives; the ladder matches liabilities against `paidOn`, because
// that is when the cash is available to spend.
function cashflows(gilt, settlement) {
  const perCoupon = gilt.coupon / 2;
  const flows = [];

  for (const couponDate of couponSchedule(gilt, settlement)) {
    const isRedemption = couponDate.getTime() === toDate(gilt.redemption).getTime();
    // A coupon whose xd date has already passed at settlement belongs to the
    // seller. Redemption is never affected - only the coupon is.
    const inExDiv = toDate(settlement) >= exDivDate(couponDate);
    const coupon = inExDiv ? 0 : perCoupon;
    const amount = coupon + (isRedemption ? REDEMPTION_PER_100 : 0);
    if (amount === 0) continue;

    flows.push({
      couponDate: toISO(couponDate),
      paidOn: toISO(paymentDate(couponDate)),
      coupon,
      principal: isRedemption ? REDEMPTION_PER_100 : 0,
      amount,
      exDiv: inExDiv,
    });
  }

  return flows;
}

module.exports = {
  EX_DIV_BUSINESS_DAYS,
  REDEMPTION_PER_100,
  addMonths,
  couponDateAt,
  exDivDate,
  couponSchedule,
  couponPeriod,
  cashflows,
};
