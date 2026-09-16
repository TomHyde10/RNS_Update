# Gilt Ladder roadmap

The build order below is worked **top to bottom**. This file is the source of
truth for what is done and what is next: a session picking the work up should
read it, take the first `[ ]` item, implement it, tick it, and commit.

Each item lands as its own commit with its own tests. `npm test` must be green
before a tick.

## Why this order

The binding constraint on this application is not the feature count, it is the
**price source**: prices are discounted off the BoE curve, carry no individual
gilt's richness or cheapness, and are not dealable. Every feature has to keep
living behind that caveat, so the order front-loads the work that attacks the
constraint (1), wires up code that already exists (4), and fixes a defect in
the tax logic the app's headline claim rests on (2), before adding scope.

## Order

- [x] **0. Roadmap and a working test command.**
      `node --test test/ gilt-ladder/test/` does not resolve directory
      arguments on Node 22, so `npm test` failed before any of this started.
- [ ] **1. Manual clean-price override.** Accept observed clean prices per
      ISIN and run selection against them, falling back to curve-derived
      prices for the rest. Provenance becomes per-holding. The only route to
      a dealable answer that needs no licensed feed.
- [ ] **4. Surface computed-but-stranded analytics.** `yieldFromPrice`,
      `macaulayDuration`, `streamDuration` and `modifiedDuration` are
      exported and never called. `priceFromCurve` returns `extrapolated` and
      `netCostPerUnit` drops it. Holdings carry `dirtyPrice` but not the
      clean price and accrued you actually deal on. `diagnostics.selection`
      records the runner-up per rung and the UI never renders it. The
      universe's `asOf` is shown as grey text with no staleness warning.
- [ ] **2. Accrued Income Scheme.** Every coupon is taxed in full, which is
      wrong for the first coupon of every rung: a cum-div buyer gets relief
      for accrued interest paid, an ex-div buyer takes a charge for the
      rebate. `taxable = coupon - accruedInterest(gilt, settlement)`, and the
      existing negative-in-xd sign convention already makes that work with no
      special case. Applies above the GBP 5,000 nominal threshold.
- [ ] **5. Existing holdings as an input.** Credit gilts already owned against
      the liabilities before the backward pass, so the ladder funds the
      shortfall rather than the whole liability.
- [ ] **10. Liability series generator.** Repeat/frequency/count expansion for
      the shapes that are actually common (school fees, drawdown).
- [ ] **6. Saved plans and shareable links.** Postgres via the `cacheStore`
      pattern, sharing via the existing AES-256-GCM `viewToken`. No new
      dependency, no new auth story, degrades to off without `DATABASE_URL`.
- [ ] **7. Re-cost alerts.** Re-price saved plans against each new daily curve
      and report the drift, reusing the existing digest scheduler, Resend and
      web-push. Needs no new data: the curve is already fetched daily.
- [ ] **8. Exports.** CSV dealing list (the artefact you take to a broker),
      CSV cash flow calendar, and an iCal feed of coupon and liability dates
      built on `lib/buildIcs.js`.
- [ ] **3. Tax years, PSA and the starting rate band.** A flat marginal rate
      misstates UK savings income: the Personal Savings Allowance and the
      starting rate band make the effective rate a step function, and
      selection is driven by that rate. Requires aggregating flows into tax
      years (6 April - 5 April), which nothing does today.
- [ ] **9. Sensitivity and scenarios.** Parallel shifts and steepen/flatten,
      plus month-to-date cost drift: `parseCurves` already returns every
      business day in the workbook and `parseLatestCurve` discards all but
      the last.
- [ ] **11. Escalating liabilities in today's money.** A liability stated in
      today's money with an escalation rate, expanded to a nominal schedule
      before matching. Does not require index-linked gilts.
- [ ] **12. Reinvestment assumption for idle cash.** Optional reinvestment of
      idle proceeds at the curve's own implied forward rate, labelled as an
      assumption. The zero-reinvestment default stays the default.

## Deliberately not on the list

- **Index-linked gilts.** RPI lag and 3-month vs 8-month indexation are a
  large job, and they break the no-inflation-assumption discipline the README
  defends. Item 11 gets most of the user value for a fraction of the cost.
- **The LP/MILP optimiser.** A WASM solver to shave basis points off prices
  you cannot deal at is effort on the wrong side of the constraint. Revisit
  only after item 1.
- **Anything implying dealability** - order routing, broker integration -
  until prices are observed rather than derived.
