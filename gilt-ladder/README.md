# Gilt Ladder

Builds a gilt ladder that funds a set of dated liabilities: you give it what
you have and what you owe when, it tells you which gilts to buy.

No API keys, no account, no paid data feed, and **zero runtime dependencies**
of its own.

It runs inside the RNS Update server, mounted at `/gilt-ladder/`: same
process, same deployment, same login. From the repository root:

```
npm start      # RNS at http://localhost:3000, Gilt Ladder at http://localhost:3000/gilt-ladder/
npm test       # runs both apps' suites; the gilt tests need no network
```

`router.js` is the mount. `server.js` hands it every path under
`/gilt-ladder` after the Basic Auth check. Everything else in this directory
is self-contained: nothing here requires RNS code, and RNS only requires
`router.js`.

## What it does

Given liabilities (`£25,000 on 30 September 2028`, and so on) it constructs a
portfolio of conventional gilts whose coupons and redemptions cover each one by
the date it falls due, and reports what that costs against the portfolio value
you have.

It also answers the question that actually drives gilt selection for a UK
taxpayer: **gilt coupons are taxed as income, but capital gains on gilts are
CGT-exempt**. A low-coupon gilt trading at a discount therefore beats a
high-coupon gilt at a premium with the same gross yield, and the size of that
effect depends on your marginal rate. Set the rate to 0% for an ISA or SIPP and
the selection changes accordingly — visibly so, which is the point.

The Accrued Income Scheme is modelled too, which narrows that penalty without
reversing it: relief is proportional to the accrued interest you pay, accrued is
proportional to the coupon, so a high-coupon gilt gets more of its first
coupon's tax back. Ignoring it — as any model that simply taxes every coupon in
full does — overstates the case against high coupons on every rung.

## The honest caveats

**Prices are derived, not observed.** They come from discounting each gilt's
cash flows off the Bank of England's nominal gilt spot curve. They are the right
shape — a low-coupon gilt still prices below par, so the tax logic holds — but
they carry no individual gilt's richness or cheapness, they exclude dealing
costs and commission, and **you cannot deal at them**. Every result is labelled
indicative.

**Unless you supply prices yourself.** The one real price this application can
see is a quote you paste in: the Observed prices panel takes a clean price per
£100 nominal for any ISIN in the universe, and that price then drives both the
cost and the selection for that gilt. Each holding is labelled `quoted` or
`derived`, so a mixed ladder never reads as though it were all one or the
other. See [Observed prices](#observed-prices).

**Why not real prices.** The DMO stopped publishing end-of-day gilt reference
prices in 2017; that passed to FTSE-Tradeweb, which is a licensed feed. The
DMO's own remaining daily data sits behind a bot wall that blocks servers
outright — see [Data sources](#data-sources).

**Index-linked gilts are excluded.** RPI-linked cash flows cannot cash-flow
match a nominal liability without an inflation assumption, so they are left out
rather than silently priced as though conventional.

**This is not advice.** It is a planning tool.

## Data sources

| What | Where | How |
|---|---|---|
| Gilt spot curve | Bank of England, `latest-yield-curve-data.zip` | Fetched automatically, daily, cached with the month's dailies |
| Gilt universe | DMO "Gilts in Issue" (D1A) | **Manual** download, then `npm run gilt:build-universe -- <file>` |

### Why the universe is a committed file

`dmo.gov.uk` sits behind ShieldSquare/PerfDrive bot detection that blocks
identified server clients across the whole site, homepage included. Measured
with `npm run gilt:probe`: 0/5 on every endpoint, with roughly a 1-in-20 intermittent
leak — which is *worse* than a clean block, because a nightly job would appear
to work and then serve stale data without saying so.

No attempt is made to get around it. The universe is instead a checked-in
config file, which is tolerable because the data barely moves — a handful of
gilts are issued or redeemed a year:

1. Open <https://www.dmo.gov.uk/data/pdfdatareport?reportCode=D1A> **in a
   browser** and export the report as Excel.
2. `npm run gilt:build-universe -- ~/Downloads/GiltsInIssue.xlsx`

That rewrites `config/gilts.js` and validates it. Until you do, the app runs on
clearly-labelled **sample data** with an unmissable banner — the ISINs use the
reserved `ZZ` prefix so they cannot collide with a real instrument.

### The curve's compounding convention

BoE spot rates are **continuously compounded**, so `DF(T) = exp(-s(T)·T)`. This
is not stated in the workbook. It was established empirically: numerically
integrating the instantaneous forward curve from the same file reproduces the
spot curve to within trapezoid error under continuous compounding, and is off by
a systematic ~20bp under annual compounding — which would be a >1% price error
on a 30-year gilt, in one direction, with nothing to make it visible. It is
asserted in `test/curve.test.js` rather than left to a comment.

## Observed prices

Everything else here is modelled. A price you copy from your broker is not, so
it is worth more than anything the curve can produce — and it is the only route
to a dealable answer that does not need a licensed feed.

Give any gilt a **clean** price per £100 nominal and:

- accrued interest is added for you, on the same ACT/ACT (ICMA) basis and with
  the same ex-dividend sign convention as everywhere else, so the dirty price
  you are charged follows from the price you were shown;
- that price replaces the derived one in the selection criterion, so a gilt
  that is genuinely cheap in the market — not merely cheap on a fitted curve —
  can take the rung;
- the holding is labelled `quoted`, and the response's `pricing` block says how
  many rungs rest on quotes rather than on the model.

The intermediate coupons are still valued off the curve. A quote is a price for
the whole bond today; it says nothing about what that bond's individual future
coupons are worth. Mixing the two is deliberate — the leg that can be observed
is observed, the leg that cannot is still modelled — and `priceSource` records
which is which rather than letting them blend.

Results stay labelled indicative even when every rung is quoted, because the
coupon valuation is still modelled and nothing here accounts for dealing costs
or commission.

A price for an ISIN that is not in the universe is **reported, not ignored** —
almost always a mistyped ISIN, and silently dropping it would leave you
believing a rung was priced from the market when it was not.

## The bond mathematics

- **Coupons** are semi-annual, `c/2` per £100 nominal, redeeming at par. Coupon
  dates are generated by stepping back from the redemption date, each computed
  as an offset from that anchor rather than iteratively — stepping iteratively
  lets end-of-month clamping compound and drift a day permanently after the
  first short month.
- **Accrued interest** is ACT/ACT (ICMA).
- **The Accrued Income Scheme** adjusts the tax on the first coupon after
  purchase, because a ladder buys mid-period on every rung. Buying
  cum-dividend you pay the seller for interest that accrued before you owned
  the gilt and then receive the whole coupon, so that payment is relieved and
  you are taxed only on what accrued while it was yours. Buying ex-dividend the
  seller keeps the coupon and rebates you the unexpired part, and the scheme
  runs the other way: the rebate is a charge. Both are `taxable = coupon −
  accrued`, with no case analysis, because accrued is already negative inside
  the ex-dividend window. Relief is capped at the coupon it attaches to rather
  than spilling onto other income this application cannot see. It applies over
  £5,000 nominal; `'auto'` builds once and rebuilds if the ladder came out
  below that, since the choice of gilts and the tax treatment each depend on
  the other.
- **Ex-dividend** is 7 business days before a coupon date. A buyer settling
  inside that window does not receive the coupon and accrued interest goes
  **negative**. This is the easiest thing in the model to get wrong — it
  overstates cash flows *and* misprices the purchase, and only bites for about
  two weeks a year per gilt.
- **Settlement** is T+1. Accrued is computed to the settlement date, not the
  trade or curve date.
- **Payment dates** roll to the next business day when a coupon date is not one;
  the amount is not adjusted, so accrual keeps using the unadjusted schedule.
- **Discounting** is ACT/365 off the curve — a separate convention from the
  ACT/ACT used for accrual, deliberately.
- **Business days** use the real gov.uk England & Wales bank holiday table
  where it reaches (currently to 2028) and a rule-based calendar beyond it. The
  published table is preferred because it is the only source for one-off
  holidays — jubilees, state funerals — that no rule predicts. The rule-based
  generator is checked against the published table for every year where both
  exist.

## What the result reports

Beyond the holdings and the coverage table:

- **Gross redemption yield** per holding, solved by bisection against the price
  actually paid — so a quoted price gives the yield that quote implies, not the
  curve's. Semi-annually compounded, the convention gilts are quoted on, which
  is a different convention from the continuously-compounded curve it was
  discounted off; `test/ladder.test.js` pins the relationship down.
- **Macaulay and modified duration** per holding, off the curve.
- **The duration gap** between the ladder's cash flows and the liabilities',
  both valued off the curve. Cash-flow matching should make this close to zero
  *by construction*, so it is a check on the result rather than an input to it:
  a wide gap means nothing in the universe matched the liability dates and the
  ladder is more exposed to a move in rates than a matched one should be.
- **The runner-up for every rung**, with the gap in basis points of cost per £1
  delivered. Backward induction is not provably cost-minimal (see below), and
  this is what makes the size of that concession visible instead of theoretical.

### Warnings that are not raised

`priceFromCurve` reports whether any cash flow was priced off a flat
extrapolation, and almost every gilt comes back true: the curve starts at 0.5
years, so all but the shortest have a coupon inside that. Discounting a coupon
two months out at the six-month rate is a rounding error, so warning on it would
put a warning on every ladder ever built. The warning keys off `beyondCurve`
instead — the *redemption* falling past the curve's long end, where it is the
rung's whole principal resting on a rate nobody published.

The gilt universe also warns once its DMO export is more than 180 days old. A
stale committed file is indistinguishable from a fresh one from the outside, and
a gilt issued since the last export simply cannot be selected.

## Saving and sharing a plan

A plan is what you entered — liabilities, tax rate, quotes, what you already
hold — not what came back. Reopening one **rebuilds it against today's curve**,
so a saved plan is never a stale answer that merely looks current.

There are two mechanisms because they answer different questions:

**A share link** needs no storage. The whole plan is deflated, encrypted with
AES-256-GCM and put in the URL as one opaque token. A plan says what you owe and
roughly what you are worth, and that does not belong in browser history, hosting
request logs, a screenshot or a link preview. An edited or truncated token fails
to open rather than quietly decrypting to some other plan. This hides the link's
contents from anyone who only sees the URL — not from whoever opens it, since
the server decrypts it for them; `APP_PASSWORD` remains the access control.

The secret is the host's `VIEW_TOKEN_SECRET`, so a deployment has one secret
rather than two, but the HKDF `info` label differs from the RNS view token's.
Same secret, different key: an RNS watchlist link cannot be opened as a plan or
the reverse, which the tests assert against the real `lib/viewToken.js`. Without
the secret, sharing reports itself unavailable rather than failing.

**A saved plan** needs `DATABASE_URL`. It stays put so it can be reopened by
name and — the real reason it exists — re-costed on a schedule without you being
there. There is deliberately **no in-memory fallback**: a saved plan that
vanishes on the next restart is worse than no saving at all, because it looks
like it worked. Without a database the save controls stay hidden and sharing
still works, so the feature degrades by half rather than disappearing.

`pg` is required lazily, inside the connection pool, so the Gilt Ladder's "no
runtime dependencies of its own" stays true on every deployment that leaves
saving off.

A token is authenticated, which proves this server sealed it — not that what it
sealed is still acceptable. Plans are therefore re-validated on the way out as
well as in, against exactly the validation a build request gets, and only
known fields are carried: without that the request body would be an open
channel into `buildLadder`'s options.

## If rates move

One curve gives one number, and the curve moves every day. A cash-flow matched
ladder is supposed to be largely insensitive to that — a claim worth checking
rather than asserting, and the duration gap only checks it to first order.

Parallel shifts of ±25/50/100bp, plus a steepen and a flatten (a rotation about
the 10-year point: each end moves by half the stated amount, the pivot not at
all). Each one is the **whole ladder rebuilt** against the transformed curve,
never an estimate from duration — because an estimate hides the two things most
worth seeing: that the ladder can re-select different gilts under a different
curve (reported as `reselected`), and that rounding up to whole lots is not
linear in anything. Convexity falls out of it for free: −100bp costs more than
+100bp saves.

Rates are allowed to go negative. Gilt yields have been, and clamping at zero
would quietly turn a symmetric pair of scenarios into an asymmetric one.

Scenarios are matched on a plain-ASCII `id`; `name` is for display and uses a
real minus sign rather than a hyphen, so matching on it would make a typographic
choice into a breaking change.

### This month, for free

The Bank's workbook holds one curve for **every business day of the current
month**, and `parseLatestCurve` parsed them all and threw all but the last away.
They are now kept, so the plan can be costed against each one and the month's
drift reported without another request.

## Savings allowances and the tax year

A single marginal rate is a poor model of UK savings income. Two allowances sit
underneath it and make the effective rate a **step function** of how much coupon
income lands in a tax year:

- the **starting rate for savings** — a £5,000 band at 0%, reduced £1 for £1 by
  non-savings income above the personal allowance, so a salary well over it
  leaves none;
- the **Personal Savings Allowance** — £1,000, £500 or nothing, by taxpayer band.

This is not only a reporting improvement. Gilt selection is driven entirely by
the rate on coupons, so a ladder small enough to sit inside the allowances faces
no coupon tax at all — and the low-coupon preference this application exists to
demonstrate correctly **disappears**. The tests assert exactly that: with no tax,
two gilts redeeming on the same date cost the same per £1 delivered, whatever
their coupons.

Coupons are pooled **by tax year** (6 April to 5 April) before any allowance is
applied, across everything held — bought and already owned alike, since HMRC
does not care which. Two £600 coupons in one year exceed a £1,000 allowance
together even though neither does alone.

### Why it is solved by iteration

The rate a coupon bears depends on the year's total coupon income, which depends
on how much was bought, which depends on the rate. There is no closed form, so
it is a fixed point: the first pass prices on the flat marginal rate, each later
pass re-prices against the blended rates the previous ladder's own coupon income
implied, and it stops when the rates stop moving (two or three passes in
practice, capped at five). `tax.passes` reports how many it took.

The flows are net of the **blended rate for their own tax year**, so the reported
tax and the cash flow calendar agree year by year rather than only in total.

### Other income

`otherIncome` is non-savings income — salary, pension, rent. Left unset it is
treated as enough to exhaust the starting rate band, which is the cautious
direction: it can only overstate the tax. Stating a modest pension can remove
the coupon tax entirely.

### The allowances are a config file

`config/taxYears.js`, for the same reason `config/gilts.js` is: nothing
publishes them in a form a server can fetch and they change once a year at most.
**Check them against gov.uk before relying on them.** A tax year the table does
not list falls back to the most recent one it does, held flat — a ladder runs
well past what has been announced — and every such year is flagged `estimated`
in the result rather than passing as though it were known.

## Exports

Three artefacts you take away rather than look at:

- **Dealing list (CSV)** — what goes to a broker. Clean price and accrued are
  separate columns, because that is how a contract note reads and how a quote is
  checked back against the screen it came from.
- **Cash flows (CSV)** — inflows lined up against the liabilities they fund.
- **Calendar (.ics)** — coupons, redemptions and liability dates as all-day
  events, for any calendar app. Also served over `GET` with a share token, since
  a subscribing calendar can only fetch a URL.

Every export is **rebuilt from the plan against the current curve**, so a file
can never disagree with the ladder it claims to be an export of. The indicative
caveat and the curve date travel inside the CSV: a file outlives the page that
produced it, and a column of prices with no provenance is exactly what gets
mistaken for dealable.

Two details that are easy to get wrong and are asserted rather than assumed.
Spreadsheets treat a leading `=`, `+`, `-` or `@` as a formula, so such a field
is prefixed to keep it text. And calendar UIDs are derived from the event, not
random — a subscribed calendar is re-fetched forever, and random UIDs would
duplicate every entry on every refresh instead of updating it.

## Watching a plan

The cost of funding a plan moves every day the curve moves, and nobody reopens
a page to find that out. Tick **Watch** on a saved plan and it is re-costed
against each new curve; you are emailed when something is worth saying. It needs
no new data — the curve is already fetched daily for the app itself.

Two things count as worth saying:

- **The cost moved** by more than the threshold (1% by default). Smaller moves
  are noise; an alert every morning is one nobody reads.
- **The plan stopped being fully funded**, at any size of move. That is a change
  in kind rather than degree, and it is the whole reason to watch a plan rather
  than build it once. It fires on the transition only, so a plan that is already
  short does not re-alert daily.

A plan is re-costed whether or not an alert follows, because the stored cost is
the baseline the next comparison is made against — skipping that write would
make every later move look as though it happened in a single day. A plan that
fails to cost is reported and skipped, so one unpriceable plan cannot silence
every other alert, and it keeps its old baseline rather than losing it.

`lib/recost.js` holds the policy and nothing else: the store, the ladder
builder, the clock and the sender are all injected, so it is tested against
fakes with no Postgres, no Resend and no waiting on real timers — the same shape
as the host's `lib/digestScheduler.js`. The Gilt Ladder requires no RNS code, so
`server.js` supplies the transport: the Gilt Ladder states the policy, the
composition root wires in the means to act on it.

Deployment settings: `GILT_ALERT_EMAIL` (falls back to `NOTIFY_EMAIL_TO`),
`GILT_ALERT_THRESHOLD_PERCENT`, plus the host's `RESEND_API_KEY` and
`NOTIFY_EMAIL_FROM`. Which plans are watched is per-plan and lives on the plan.

## Liabilities in today's money

School fees and care costs rise; a nominal ladder built against today's figure
silently under-funds them. A liability may carry an `escalation` rate, which
means the amount is stated in **today's money** and uprated to the date it falls
due — compounded annually on an ACT/365 year, matching the discounting
convention.

This is **not** index-linked gilt support and does not pretend to be. It is an
assumption you state, applied to the liability side only; the assets are still
nominal gilts whose cash flows do not rise with anything. The result reports the
stated amount beside the uprated one for exactly that reason — a liability that
has grown 60% between being typed in and being funded should not have to be
reverse-engineered out of the answer.

An escalation is a rate, not a percentage, and anything beyond ±0.5 is refused:
`3` entered where `0.03` was meant would compound a liability into the millions
without complaint.

In a series, each occurrence is uprated to its **own** date, so a five-year run
of school fees costs more each year.

## Liability series

The shapes people actually fund repeat — school fees every September for five
years, drawdown every year for twenty-five — and typing those a row at a time is
the main reason a real plan never gets entered at all. A liability may carry a
`repeat: { every, count }` block, with `every` one of `month`, `quarter`,
`half-year` or `year`.

Expansion happens before anything else runs, so the ladder, the coverage walk
and the chart never see a repeating liability: a series and the list it stands
for build an identical ladder, which the tests assert directly.

Each date is computed as an offset from the **first** one, never by stepping off
the previous one — the same trap `giltCashflows.js` avoids for coupon dates. A
series starting 31 January must go 28 February and then back to 31 March; step
iteratively and the clamp compounds, leaving every later date a day early.

## Gilts you already own

Nobody starts from cash. Give the app a list of `{ isin, nominal }` and those
holdings' coupons and redemptions are credited against the liabilities *before*
the backward pass runs, so the ladder is constructed against the **shortfall**
rather than against the whole liability.

They are kept apart from the holdings to buy, because `holdings` is a dealing
list and nothing you already own belongs in it. They are valued but never
costed: `totals.cost` stays the cash that still has to be spent, and
`totals.existingValue` is what is already committed.

They get no Accrued Income Scheme relief. Relief attaches to accrued interest
paid at a purchase, and these were bought on some earlier date this application
knows nothing about.

A holding whose ISIN matches nothing in the universe is **reported, not
ignored** — it may have redeemed, or be index-linked, both of which are outside
what this models, and silently dropping it would overstate what still needs
buying.

## The ladder algorithm

Backward cash-flow matching, the classic dedicated-portfolio construction.
Starting from the **last** liability: pick a gilt redeeming in time to fund it,
buy enough nominal, then credit the coupons that holding throws off against the
earlier liabilities and repeat. Rungs are chosen by **after-tax cost per £1
delivered**, net of the intermediate coupons valued off the curve.

That criterion is provably coupon-neutral before tax — on a fitted curve every
gilt maturing on a given date costs the same per £1 delivered, which is exactly
right and is asserted in the tests. So any preference it shows between coupons
is caused by tax and nothing else.

**This is not the linear program the design originally called for.** An LP
minimises cost across the whole universe, but its optimum is typically 30+
holdings chosen to shave basis points, and constraining it back to something a
person would actually place needs a MILP and a WASM solver. Backward induction
produces one rung per liability *by construction* — which is what a ladder is —
with no dependencies, and every holding traces to the liability it funds. The
cost is that the result is not provably cost-minimal; `diagnostics.selection`
records the runner-up for each rung so the gap is visible.

### Operational constraints modelled

- **Cash buffer** — money must arrive N business days before the liability
  (default 5), covering clearing and the following-business-day payment rule.
- **Dealing lots** — nominal is rounded **up** to whole lots, so rounding can
  only ever over-fund a rung.
- **Idle cash** — when a rung's gilt redeems well before the liability it funds,
  the proceeds sit in cash earning nothing (no reinvestment is assumed, which is
  the conservative choice). Anything over a year is flagged as a warning, since
  the usual cause is that nothing in the universe matches the liability's date.

## API

| Route | Purpose |
|---|---|
| `POST /gilt-ladder/api/ladder` | Build a ladder. Body: `liabilities[]`, `portfolioValue`, `marginalRate`, `lotSize`, `bufferBusinessDays`, `observedPrices[]`, `existingHoldings[]`, `otherIncome`, `accruedIncomeScheme` |
| `GET /gilt-ladder/api/universe` | The gilt universe and whether it is real or sample |
| `GET /gilt-ladder/api/curve` | The cached curve, its date, and whether it is stale |
| `GET /gilt-ladder/api/health` | Liveness; 503 if the universe failed validation |
| `POST /gilt-ladder/api/plan/share` | Seal a plan into a shareable token; 501 without `VIEW_TOKEN_SECRET` |
| `GET /gilt-ladder/api/plan?t=` | Open a shared plan token |
| `GET/POST /gilt-ladder/api/plans` | List or save plans; 501 without `DATABASE_URL` |
| `GET/PATCH/DELETE /gilt-ladder/api/plans/:id` | Read, watch/unwatch, or delete one saved plan |
| `POST /gilt-ladder/api/scenarios` | Cost a plan under shifted curves, plus this month's drift |
| `POST /gilt-ladder/api/export/dealing-list.csv` | The dealing list for a plan |
| `POST /gilt-ladder/api/export/cashflows.csv` | The cash flow calendar for a plan |
| `POST\|GET /gilt-ladder/api/export/calendar.ics` | Coupons and liabilities as a calendar; `GET` takes a share token in `t` |

Every ladder response carries a `provenance` block — price basis, curve date,
staleness, universe source — so a number that looks like a price can never
travel without the context that it is indicative.

The frontend uses relative URLs (`api/ladder`, `style.css`) so it never
collides with RNS's own `/style.css` and `/app.js`. That only works from the
trailing-slash URL, so `/gilt-ladder` redirects to `/gilt-ladder/`.

## Deploying

Nothing extra: it ships with every RNS deployment that runs `server.js`
(Render, Northflank, Docker, local).

- **Authentication** is RNS's `APP_USERNAME`/`APP_PASSWORD` (see the root
  README's "Authentication"). The username defaults to `admin`; the standalone
  app's old `gilt` default no longer applies.
- **Storage**: none needed for the ladder itself. `DATABASE_URL` (the host's,
  already used by RNS) additionally enables saved plans; `VIEW_TOKEN_SECRET`
  (also the host's) enables share links. Both are optional and each degrades to
  the feature simply being unavailable. `GILT_LADDER_DATA_DIR` (default
  `gilt-ladder/data/`) caches the curve so a restart does not refetch. An
  ephemeral filesystem is fine: the app just refetches, and falls back to the
  last good curve if the Bank is unreachable.
- **Failure isolation**: if `config/gilts.js` fails validation, the Gilt
  Ladder answers 503 and logs why. RNS keeps running.
- **Vercel is not supported.** Like RNS's database-backed routes, the Gilt
  Ladder only exists on `server.js`, and there is no `api/*.js` function for
  it.

## Layout

```
router.js                  Mount inside RNS's server.js: static files and JSON API
public/                    Frontend (no build step, no framework)
config/gilts.js            The gilt universe - GENERATED, see above
config/bankHolidays.js     gov.uk bank holidays - GENERATED
lib/calendar.js            Business days, bank holidays, Easter
lib/giltCashflows.js       Coupon schedules, ex-dividend
lib/accrued.js             ACT/ACT (ICMA) accrued interest
lib/curve.js               BoE curve: fetch, parse, interpolate, discount
lib/curveStore.js          Daily cache with graceful degradation
lib/bondMath.js            Pricing, yield, duration
lib/ladder.js              The ladder construction
lib/universe.js            Universe loading and strict validation
lib/liabilities.js         Liability series expansion
lib/planToken.js           Encrypted shareable plan links
lib/planStore.js           Optional Postgres storage for saved plans
lib/recost.js              Daily re-costing policy and alert wording
lib/exports.js             CSV dealing list / cash flows, and the .ics feed
lib/tax.js                 Savings allowances, tax years, the banded rate
lib/scenarios.js           Curve shifts and twists for sensitivity
config/taxYears.js         Allowances by tax year - CHECK AGAINST GOV.UK
lib/zip.js                 Minimal zip reader (so no unzip binary is needed)
lib/xlsx.js                Minimal xlsx reader for the DMO export
scripts/build-universe.js  DMO export -> config/gilts.js
scripts/phase0-data-probe.js  Re-runnable check of what data is reachable
```
