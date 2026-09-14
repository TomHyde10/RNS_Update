// Phase 0 check for the proposed NAV/dividend time-series feature: pulls
// real NAV and Dividend Declaration filings for the current watchlist and
// prints their raw `headline` text, so you can eyeball whether a numeric
// value is actually embedded in it (e.g. "Net Asset Value(s) - 245.67p")
// or whether it's just a generic label with the real number only inside
// the linked document.
//
// Run from the repo root: node scripts/phase0-check-headlines.js
// Needs real network access to data.fca.org.uk - won't work in a sandbox
// that blocks that host (this one does).
//
// Not wired into the app anywhere - delete this file once you've made the
// call on whether headline-regex extraction is viable.
const { fetchReports } = require('../lib/fetchReports');
const watchlist = require('../config/watchlist');

const CATEGORIES = ['Net Asset Value(s)', 'Dividend Declaration'];
const DAYS = 365; // a year back, to get enough real samples per company
const SAMPLE_LEIS = watchlist.slice(0, 8).map((c) => c.lei); // a handful is enough to judge format consistency

async function main() {
  const { status, body } = await fetchReports({
    leis: SAMPLE_LEIS.join(','),
    days: DAYS,
    categories: CATEGORIES.join(','),
  });

  if (status !== 200) {
    console.error('fetchReports failed:', body.error, body.details || '');
    process.exit(1);
  }

  console.log(`${body.reports.length} matching filings across ${SAMPLE_LEIS.length} companies, last ${DAYS} days:\n`);

  for (const category of CATEGORIES) {
    const items = body.reports.filter((r) => r.category === category);
    console.log(`=== ${category} (${items.length}) ===`);
    for (const r of items) {
      console.log(`  ${r.publishedAt || '?'}  [${r.company}]  "${r.title}"`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
