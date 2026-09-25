# RNS Update

A lightweight site that watches a list of companies you manage and shows
their report disclosures for a time period and set of report types you
choose — sourced directly from the FCA's **National Storage Mechanism**
(data.fca.org.uk), the UK regulator's public repository for company
disclosures. No API key, no account, no cost.

Static HTML/CSS/JS frontend, backed by either a Vercel serverless function
or a small persistent Node server, depending on how you deploy it (see
["Two ways to run this"](#two-ways-to-run-this) below) — the difference
matters, because several features (a shared watchlist, automatic digests,
push notifications) only exist on one of the two.

This repository also hosts **Gilt Ladder** (`gilt-ladder/`), a separate,
self-contained tool that builds a bond portfolio to fund dated liabilities.
It's mounted at `/gilt-ladder/` by the same server, behind the same login.
See ["Gilt Ladder"](#gilt-ladder) below and
[gilt-ladder/README.md](gilt-ladder/README.md) for the whole thing.

## Contents

- [Quick start](#quick-start)
- [Two ways to run this](#two-ways-to-run-this)
- [Using the app](#using-the-app)
  - [The watchlist and search settings](#the-watchlist-and-search-settings)
  - [The report list](#the-report-list)
  - [The filing calendar and estimated due dates](#the-filing-calendar-and-estimated-due-dates)
  - [Sector/portfolio grouping and saved views](#sectorportfolio-grouping-and-saved-views)
  - [Shareable links, the RSS feed, and the .ics feed](#shareable-links-the-rss-feed-and-the-ics-feed)
- [Notifications](#notifications)
  - [Manual: the Send Notification button](#manual-the-send-notification-button)
  - [Automatic email digests](#automatic-email-digests)
  - [Push notifications](#push-notifications)
- [Authentication](#authentication)
- [Encrypted view links](#encrypted-view-links)
- [Sharing data across browsers and devices (Postgres)](#sharing-data-across-browsers-and-devices-postgres)
  - [The persistent NSM cache](#the-persistent-nsm-cache)
  - [The shared watchlist](#the-shared-watchlist)
  - [Shared "seen" tracking](#shared-seen-tracking)
- [Configuration reference](#configuration-reference)
- [API integration notes: the NSM search](#api-integration-notes-the-nsm-search)
- [Deploying](#deploying)
  - [Vercel](#deploying-vercel)
  - [Render](#deploying-render)
  - [Northflank](#deploying-northflank)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)
- [Gilt Ladder](#gilt-ladder)

## Quick start

```
npm install
npm start
```

Then open <http://localhost:3000>. No `.env` file is needed to run the core
app — see `.env.example` for every optional variable, all of which unlock
one specific feature and are otherwise safely left unset.

`config/watchlist.js`'s companies are merged into the browser's watchlist on
**every** page load (via `/api/watchlist`, see `initWatchlist()` in
`app.js`), not just the first, so they're always present at startup.
Removing one of the defaults via the page only lasts until the next reload
— they're added back in — but companies you add beyond the defaults are
untouched and persist normally. The watchlist otherwise lives in that
browser's `localStorage`, unless you've enabled the [shared
watchlist](#the-shared-watchlist).

## Two ways to run this

This app can run two different ways, and they don't have the same features:

1. **`server.js`** — a plain, persistent Node process. This is what runs
   locally (`npm start`), on **Render**, on **Northflank**, and in the
   **Docker** image. Because the process stays alive between requests, it
   can run a background loop and hold a database connection pool — so this
   is the only way to get a **shared watchlist**, **shared "seen"
   tracking**, **automatic email digests**, **push notifications**, and
   **Gilt Ladder**.
2. **Vercel serverless functions** (`api/*.js`) — each request gets its own
   short-lived function invocation with nothing persisted between calls.
   This gets you the core report list, the RSS feed, manual "Send
   Notification" emails, and encrypted view links — but not any of the
   features above, since none of them fit a stateless, per-request
   execution model. There's also no Gilt Ladder route on Vercel.

If you want the full feature set, deploy `server.js` somewhere that keeps a
process running (Render, Northflank, your own Docker host) rather than to
Vercel.

## Using the app

### The watchlist and search settings

Add a company by its **LEI** (Legal Entity Identifier, a 20-character
code) — the NSM has no ISIN or ticker field at all, only LEI and company
name, confirmed from a real search export. If you only know a company's
ISIN or name, look up its LEI at
[search.gleif.org](https://search.gleif.org/).

Under "Search settings", choose a **time period** (24 hours to 90 days) and
the **report types** to match: checkboxes for the four confirmed category
names, plus an "Other report types" field for anything not listed
(comma-separated, matched exactly against the filing's category — not a
substring match, so `Half-year` alone won't match `"Half-year Financial
Report"`). Clearing every checkbox and hitting Apply falls back to
`"Half-year Financial Report, Annual Financial Report"` rather than
matching nothing. These settings are saved to `localStorage` and sent to
`/api/reports` as `days` and `categories` query params.

### The report list

- **New-report highlighting** — a report that's appeared since your last
  visit gets a "NEW" badge and a left-border highlight. Tracked as a set of
  seen report keys: per-browser in `localStorage` by default (`SEEN_KEY` in
  `app.js`, capped at the most recent 1000 entries), or shared across every
  visitor when [shared "seen" tracking](#shared-seen-tracking) is enabled.
  Either way, the very first load establishes a baseline silently — nothing
  is flagged "new" the first time you ever see it.
- **Cache visibility** — the status line shows a "refreshed at HH:MM:SS"
  time and, when applicable, how many of your watched companies were served
  from the [NSM result cache](#the-persistent-nsm-cache) rather than
  freshly fetched.
- **Download CSV** — exports the currently-displayed report list (company,
  title, category, date, link) as a CSV file.
- **Filter and sort** — a text box above the report list filters by company
  or title client-side (no re-fetch); a dropdown reorders by date or company
  name (persisted in `localStorage`). Both act purely on the in-memory list
  the CSV export also reads from.
- **Auto-refresh and in-tab notifications** — polls `/api/reports` on an
  interval (5/15/30 minutes) via `setInterval` while the tab is open.
  Turning it on requests browser notification permission; if granted, a
  newly-seen report triggers an OS notification **only while the tab is in
  the background** (a foreground tab already shows the "NEW" badge). This is
  plain browser `Notification`, not push — it stops the moment the tab or
  browser closes. See [Push notifications](#push-notifications) for the
  alternative that doesn't.
- **Per-company filing history** — the clock icon next to each watched
  company opens a modal showing its full filing history for the last 365
  days (every item NSM returns for it, not just ones matching your current
  category filter).
- **Manual theme toggle** — Auto/Light/Dark, persisted in `localStorage`,
  overriding the `prefers-color-scheme` media query the app otherwise
  follows.
- **Export/import your watchlist** — "Export list" downloads your companies
  as JSON; "Import list" reads one back in, merging new entries and skipping
  ones you already have (by LEI) or that aren't validly formed.

### The filing calendar and estimated due dates

The floating calendar button (bottom-right) opens a month grid
superimposing recent filings and **estimated** Half-year/Annual due dates,
for a user-editable subset of your watchlist and report types independent
of the main list's own settings (`app.js`'s `openCalendarOverlay()`).

The estimate comes from `lib/dueDates.js`: this app has no visibility into
any company's actual financial year-end, only when it last filed a
Half-year or Annual report, so a due date is inferred from the FCA's
Disclosure Guidance and Transparency Rules deadlines (annual within 4
months of year-end, half-yearly within 3 months of period-end) applied to
that company's own recurring cycle. A company with no prior filing of that
type is flagged `unknown` rather than guessed at; otherwise it's `ok`,
`due-soon` (within 30 days of the estimated deadline), or `overdue`. This is
always surfaced as an estimate, never a claimed known deadline.

The calendar's "Add to Calendar" link is a subscribable **`.ics` feed**
(`lib/buildIcs.js`, served at `/api/calendar.ics`) carrying the same
filings and due-date estimates as all-day events, so they show up
alongside everything else in Google/Outlook/Apple Calendar too, on that
app's own polling schedule rather than needing this site open. It uses the
same `v`-token/readable-params handling as the RSS feed below.

### Sector/portfolio grouping and saved views

Each company can be tagged with a free-text **group** (e.g. "Income
trusts", "Client A", "Growth") from the Edit companies overlay, with
autocomplete against groups already in use. A company with no group set
shows up under "Ungrouped" wherever groups are listed. This is a label on
the one watchlist, not a separate list — renaming a company or moving it
between groups is a single edit, reflected everywhere that group is used.
When the [shared watchlist](#the-shared-watchlist) is enabled, a company's
group is part of its shared row, visible to every visitor; otherwise it
lives alongside the rest of that browser's `localStorage` watchlist.

The main report list's **Group** dropdown filters to one group (or
"Ungrouped", or "All groups") — purely client-side over whatever's already
loaded, the same way the text filter works.

**Views** (the "Views" panel in the sidebar) are named, saved combinations
of **group filter + time period + report types + keyword** — not a
separate company list. Save the current combination, switch between saved
views, update one to match the currently-applied settings, or delete it.
Views live in `localStorage` only, **even when the watchlist itself is
shared** — they're per-browser, and reference groups by name, so renaming
or deleting the only group a view filters to leaves that view matching
nothing until it's repointed.

### Shareable links, the RSS feed, and the .ics feed

The address bar always reflects your current companies/time-period/
categories after a load (via `history.replaceState`, so it doesn't spam
browser history) — copy it to bookmark or share a specific view. Opening
either kind of link **only ever adds** those companies to your watchlist
(or adopts the days/categories as your active settings) — it never removes
or replaces anything already saved.

The "RSS feed" link points at `/api/feed` with your current watchlist/
time-period/category settings baked in — paste it into any feed reader to
get "new report" notifications without this app needing to run its own
pipeline (`lib/buildFeed.js`).

By default both kinds of link carry your companies and settings as
readable query params (`?leis=…&days=7&categories=…`). See [Encrypted view
links](#encrypted-view-links) to replace that with a single opaque token.

## Notifications

There are three separate ways this app can tell you about a report, each
with its own requirements:

| | Fires | Needs | Works with the tab/browser closed? |
|---|---|---|---|
| [Send Notification](#manual-the-send-notification-button) | On click, for one report | `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM` | n/a (manual) |
| [Automatic email digests](#automatic-email-digests) | On a schedule you set | The above, plus `DATABASE_URL` | Yes — `server.js` only |
| [Push notifications](#push-notifications) | The moment something new matches | `DATABASE_URL`, VAPID keys | Yes — `server.js` only |
| Auto-refresh (see [above](#the-report-list)) | While polling | Nothing | No — stops when the tab closes |

### Manual: the Send Notification button

Each report in the list has a **Send Notification** button that emails a
summary of it (company, title, type, publish date, link) on click, with the
linked document attached as a PDF when the report has one.

The attachment uses Resend's `path` attachment option — Resend fetches the
document itself server-side from the report's `url`, rather than this app
downloading and re-uploading it. Filename is taken from the URL when it
looks like a real filename, otherwise falls back to `report.pdf`. Resend
caps attachments at 40MB per email; what happens for an oversized or
unreachable document isn't confirmed from a sandboxed environment with no
network access — treat the first real oversized/broken link as the test.

Sending goes through the [Resend](https://resend.com) API via their
official Node SDK (`lib/sendNotification.js`, `/api/notify`), not SMTP:

- **Server-side config (required)**: `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM`.
  If either is missing, clicking the button shows an error naming which
  one, rather than failing silently.
- **Recipient**: the first click opens an overlay asking for the email that
  should receive notifications, saved to that browser's `localStorage` and
  sent as `to` on every request. **That per-browser recipient is only
  honoured when `APP_PASSWORD` is set** — otherwise anyone with the URL
  could use `/api/notify` to send mail from your verified domain to any
  address. Without `APP_PASSWORD`, mail only ever goes to the server-side
  `NOTIFY_EMAIL_TO` (required in that case), and a request naming any other
  recipient is refused. With `APP_PASSWORD`, `NOTIFY_EMAIL_TO` becomes an
  optional fallback for a request that doesn't supply its own `to`.

**Setup**: sign up at [resend.com](https://resend.com) (free tier: 100
emails/day, 3,000/month). For a `from` address, either use
`onboarding@resend.dev` (Resend's shared sandbox — only delivers to the
email you signed up with, fine for testing) or verify your own domain and
use any address on it. Create an API key (Sending access is enough), then
set `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` as environment variables (or
[secret files](#deploying)). In the app's Send Notification overlay, set
the recipient — this needs `APP_PASSWORD`; without it, set `NOTIFY_EMAIL_TO`
instead and use that same address.

This hasn't been exercised against the real Resend API from a
network-isolated environment — the first real click after configuring
credentials is effectively the integration test.

### Automatic email digests

The **Notifications** button (top-left) opens a subscription manager,
independent of the manual flow above: each email address gets its own
schedule, its own matrix of which companies and report types to watch, and
an optional **keyword filter** (e.g. "delisting", "merger") — a filing
mentioning that word is included even for a company/type combination the
matrix hasn't otherwise selected (OR'd with the category match, matching
the main report list's own Keyword field — see `matchesKeyword` in
`lib/fetchReports.js`).

- **Daily** / **Monthly** send one collated email of everything matched
  since the last send, at a GMT time of day you choose (monthly always
  fires on the 1st).
- **As they occur** sends the moment a new Half-year or Annual Financial
  Report is found for a watched company — the only two categories with an
  actual filing deadline worth hearing about immediately — with no fixed
  heartbeat, and never an empty email.

Every digest email's footer links back to the Notifications overlay when
`APP_URL` is set. A brand-new subscription's first send covers exactly one
cycle back (not its entire history), so turning one on doesn't dump a
backlog.

This needs `DATABASE_URL` — subscriptions live in Postgres
(`lib/subscriptionStore.js`), not `localStorage`, because a subscription
has to survive process restarts and free-tier spin-downs to mean anything
as "automatic". `server.js` runs a self-rescheduling loop
(`lib/digestScheduler.js`'s `runDueDigests()`, driven from `server.js`)
that checks every 5 minutes normally, or every minute while any
subscription is set to "as they occur" — the same loop also drives [push
notifications](#push-notifications) and the Gilt Ladder's daily plan
re-costing, so all three tighten their cadence together. Without
`DATABASE_URL`, the Notifications overlay explains that a database is
needed and `/api/subscriptions` is a no-op.

Same recipient policy as manual sends: without `APP_PASSWORD`, only the
fixed `NOTIFY_EMAIL_TO` address can be subscribed. This only runs on
`server.js` (Render/Northflank/local/Docker) — Vercel's serverless
functions have nothing to run a background loop from.

### Push notifications

The **Push** button (header, next to Diagnostics) turns on real
browser/OS push notifications — the actual fix for auto-refresh's
tab-must-stay-open limitation. It goes through a service worker (`sw.js`)
and the browser vendor's own push service, so it keeps working with this
site closed entirely.

- **What it notifies for**: whichever companies are currently enabled in
  your watchlist, and the current Search settings' report types/keyword.
  Turning Push on snapshots those; changing your watchlist or settings
  re-syncs an already-active subscription automatically
  (`maybeSyncPushSubscription()` in `app.js`). It does **not** follow the
  Group filter or a saved view.
- **Setup**: needs `DATABASE_URL` (subscriptions stored in Postgres, same
  database as digests — see `lib/pushStore.js`) plus a VAPID key pair:
  ```
  npx web-push generate-vapid-keys
  ```
  Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Without both, the Push
  button never appears. `VAPID_SUBJECT` (a `mailto:`/`https:` contact URI,
  required by the VAPID spec, never shown to a subscriber) defaults to a
  placeholder if unset.
- **How it's checked**: the same digest-scheduler loop checks every push
  subscription on every tick, since a push subscription has no schedule of
  its own to be "due" against — any push subscription existing at all
  forces the loop's fastest cadence.
- A subscription that goes stale (permission revoked, site data cleared,
  the push endpoint expired) is detected the next time a push actually
  fails to deliver with a 404/410 (`lib/webPush.js`) and removed
  automatically, rather than retried forever.

Only relevant on `server.js` deployments, same as automatic digests.

## Authentication

By default the whole app — every page and API route, including
`/api/notify` — is open to anyone with the URL. Set `APP_PASSWORD` to
require an HTTP Basic Auth login (the browser's native prompt) before
anything loads. Username defaults to `admin`; set `APP_USERNAME` to
change it.

Enforced on every deployment method:

- **`server.js`** checks it on every request, before any routing
  (`lib/basicAuth.js`).
- **Vercel** uses `middleware.js` at the repo root (Edge Middleware), which
  runs before both the static files and every `api/*.js` function. Edge
  Runtime is a separate, more restricted runtime (no `Buffer`, no Node
  `crypto`, no filesystem), so it re-implements the same check with only
  Web-standard APIs — keep the two in sync if this logic ever changes.

Both compare credentials as SHA-256 digests in constant time, so response
timing doesn't reveal how close a guess was. `/api/notify` also rejects any
POST whose `Content-Type` isn't `application/json`: browsers resend cached
Basic Auth credentials automatically, so without that check a hidden
cross-site form could make a logged-in visitor's browser send email on
their behalf. A JSON content type forces a CORS preflight, which this app
never approves.

Was added specifically to stop an anonymous visitor from triggering "Send
Notification" (which sends real email from this deployment's verified
domain) — protecting the whole app was simpler and more robust than gating
that one endpoint alone.

## Encrypted view links

By default, shareable links, the RSS feed URL, and the `.ics` calendar feed
URL carry your companies and settings as readable query params. Anyone who
sees the URL can read them — including through browser history, hosting
request logs, and link previews. Set `VIEW_TOKEN_SECRET` (at least 32
characters, e.g. `openssl rand -base64 32`) to replace them with a single
encrypted `?v=<token>` param instead.

- **How it works** (`lib/viewToken.js`, `/api/view`): the browser POSTs its
  current view, and the server returns it compressed and encrypted with
  AES-256-GCM under a key derived (via HKDF) from `VIEW_TOKEN_SECRET`. The
  key never leaves the server. An edited or truncated token is rejected
  rather than opening a different view. The keyword field is never part of
  the encrypted payload — it's a transient search term, not data worth
  hiding, so it always stays a plain, readable param.
- **What it doesn't do**: anyone who opens a link still sees that view —
  `APP_PASSWORD` is what controls actual access, not this. A token's length
  also hints at roughly how many companies it holds.
- **Changing the secret breaks every existing encrypted link and RSS/`.ics`
  subscription** — they'll show "Invalid view link" and need re-copying.
- **Without it**, nothing changes: links stay readable, and readable links
  keep working even after you enable it later (the address bar just
  switches to the encrypted form on the next load).

## Sharing data across browsers and devices (Postgres)

Three independent features share the same `DATABASE_URL` — a single
Postgres database, three separate tables — each answering a different
question, and each degrading gracefully with a clear explanation when
`DATABASE_URL` isn't set:

| Feature | Table | Falls back to |
|---|---|---|
| [NSM cache](#the-persistent-nsm-cache) | `nsm_cache` | An in-memory `Map`, wiped on restart |
| [Shared watchlist](#the-shared-watchlist) | `watchlist_companies` | That browser's own `localStorage` |
| [Shared "seen" tracking](#shared-seen-tracking) | `seen_reports` | That browser's own `localStorage` |

Automatic email digests and push notifications also require `DATABASE_URL`,
but for their own dedicated tables — see [Notifications](#notifications)
above.

### The persistent NSM cache

Each watched company's raw NSM results are cached for
`NSM_CACHE_TTL_MINUTES` (default 10) so a burst of refreshes within that
window doesn't re-hit NSM for every company again (`fetchForLeiCached()` in
`lib/fetchReports.js`) — see [the NSM section](#api-integration-notes-the-nsm-search)
for exactly how. By default this cache is an in-memory `Map`, which is
wiped every time the process restarts — on Render's **free** web service
plan, that happens after every idle spin-down, so the next request would
otherwise hit NSM once per watched company all at once.

Setting `DATABASE_URL` makes `lib/cacheStore.js` store the same cache in
Postgres instead (`nsm_cache`: `lei` primary key, `items` JSONB, `size`,
`fetched_at`, created automatically). A Postgres outage or bad connection
string doesn't break report loading — a failed cache read/write is logged
and treated as a cache miss, falling through to a fresh NSM fetch.

This is a plain `pg.Pool` connection over TLS with the server's certificate
verified by default. If your provider's certificate isn't in Node's
default trust store, set `DATABASE_SSL_CA` to its CA certificate (PEM
text). As a last resort, `DATABASE_SSL_VERIFY=false` skips verification
(still encrypted, but open to interception). An `sslmode` in `DATABASE_URL`
itself overrides both.

**Render's free Postgres plan expires and is deleted after 30 days** —
fine for testing, not a long-term store without a paid plan. This isn't
wired into `render.yaml` as a Blueprint resource deliberately, so deploying
the Blueprint never silently provisions a database (and its 30-day clock)
you didn't ask for.

### The shared watchlist

Without `DATABASE_URL`, the watchlist (companies, names, enabled state,
group tags) lives entirely in that one browser's `localStorage` — nobody
else sees your edits, and a cleared browser loses them. Setting
`DATABASE_URL` makes it a single shared list instead
(`lib/watchlistStore.js`, table `watchlist_companies`), visible and
editable from any browser or device pointed at the same deployment:

- `GET /api/companies` returns the shared list; `PUT /api/companies`
  replaces it wholesale with whatever the client currently has, matching
  the frontend's own "mutate the whole list locally, then persist all of
  it" pattern for every kind of edit (add, rename, toggle, remove, bulk
  import).
- `app.js` reads `enabled: false` from `GET /api/companies` on a deployment
  with no database and falls back to `localStorage` itself — the shared
  watchlist is either fully on or fully off, never partially degraded.
- There's deliberately no in-memory fallback: a "shared" watchlist that
  resets on every restart would be worse than no sharing at all.
- `config/watchlist.js`'s defaults are unaffected either way — they're
  merged into whichever watchlist (shared or local) is active on every
  load, same as always.

### Shared "seen" tracking

The "NEW" badge (see [The report list](#the-report-list)) is normally
per-browser: what counts as "seen" lives in that browser's `localStorage`
only. Setting `DATABASE_URL` makes it shared instead
(`lib/seenStore.js`, table `seen_reports`) — a report one visitor has
already looked at stops showing "NEW" for everyone on the same
deployment, which matters once the watchlist itself is shared and more
than one person is actually looking at the same list.

- `GET /api/seen` returns the shared set of seen report keys; `POST
  /api/seen` marks more of them seen — additively, since the client only
  ever reports what's currently on screen, never an accumulated history.
- Rows older than 400 days are pruned automatically on a small fraction of
  writes, rather than needing a separate scheduled cleanup job.
- Same all-or-nothing behaviour as the shared watchlist: `app.js` falls
  back to `localStorage` itself when this is disabled, and there's no
  in-memory fallback when `DATABASE_URL` is unset — a "shared" seen-state
  that resets on every restart would just relabel things "NEW" again for
  everyone at once.

## Configuration reference

Every variable below is optional; the app runs with none of them set. Each
one only unlocks the specific feature listed — see that feature's own
section for full setup steps. Any of these can also be provided as a
**secret file** instead of an environment variable — see
["Secret files instead of secret variables"](#secret-files-instead-of-secret-variables).

| Variable | Unlocks | Notes |
|---|---|---|
| `PORT` | — | Local dev server port. Default `3000`. |
| `APP_USERNAME`, `APP_PASSWORD` | [Authentication](#authentication) | Username defaults to `admin`. |
| `VIEW_TOKEN_SECRET` | [Encrypted view links](#encrypted-view-links) | ≥ 32 characters. |
| `DATABASE_URL` | [Persistent cache, shared watchlist/seen tracking](#sharing-data-across-browsers-and-devices-postgres), [automatic digests](#automatic-email-digests), [push](#push-notifications) | Postgres connection string. |
| `DATABASE_SSL_CA`, `DATABASE_SSL_VERIFY` | — | Only if your Postgres provider's TLS cert isn't in Node's default trust store. |
| `NSM_CACHE_TTL_MINUTES` | — | Default `10`; `0` disables caching. |
| `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM` | [Send Notification](#manual-the-send-notification-button), digests, gilt alerts | Resend account + verified sender. |
| `NOTIFY_EMAIL_TO` | Email recipient fallback | Required if `APP_PASSWORD` is unset. |
| `APP_URL` | — | Adds a "manage preferences" link to digest email footers. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | [Push notifications](#push-notifications) | Generate with `npx web-push generate-vapid-keys`. |
| `SECRET_FILE_DIR` | — | Default `/etc/secrets`; see [secret files](#secret-files-instead-of-secret-variables). |
| `GILT_LADDER_DATA_DIR`, `GILT_ALERT_EMAIL`, `GILT_ALERT_THRESHOLD_PERCENT` | Gilt Ladder | See [gilt-ladder/README.md](gilt-ladder/README.md). |

## API integration notes: the NSM search

This is **not a documented public API** — there is no official developer
API for the NSM. The request shape below was captured by watching the
actual browser network traffic on data.fca.org.uk (DevTools → Network tab)
while performing a real search, not from any published reference. That
means it could change, add rate limiting, or start blocking non-browser
traffic without notice, with no changelog to warn us. Treat this
integration as inherently more fragile than a documented API, and revisit
it if reports stop showing up.

**How a report reaches the app, step by step** (`fetchReports()` in
`lib/fetchReports.js`, run once per watched company):

1. **Build the request** — assemble the one confirmed-working JSON body
   below for that company's LEI, the requested day window, and a page size.
2. **Size the request** — turn the day window into a `size` (items to ask
   for) and attach browser-like headers.
3. **Check the cache** — fresh → skip straight to step 6; stale-but-present
   → step 4 asks for only what's new; cold → step 4 asks for everything.
4. **Call NSM** — POST the request; one call per company, never a
   multi-company batch (batching is untested — see below).
5. **Merge into the cache** — a delta fetch's results are merged with
   what was already cached, with the fresh copy winning on collision (e.g.
   an amended filing).
6. **Normalise** — map NSM's raw field names (`headline`, `type`,
   `publication_date`, ...) onto the app's report shape, via `normalise()`.
7. **Filter** — keep items inside the requested day window, then keep ones
   matching a report category **or** a keyword (OR'd, not AND'd, so a
   keyword like "delisting" surfaces a filing even under an untracked
   report type).
8. **Handle failure** — one company's request failing doesn't fail the
   batch; only returning a hard error when *every* company's request has
   failed, since an all-failed result shouldn't be silently reported as "0
   reports found".

```
POST https://api.data.fca.org.uk/search?index=nsm-search
Content-Type: application/json

{
  "from": 0, "size": 100, "sort": "submitted_date", "sortorder": "desc",
  "criteriaObj": {
    "criteria": [
      { "name": "company_lei", "value": ["", "<LEI>", "disclose_org", "related_org"] },
      { "name": "latest_flag", "value": "Y" }
    ],
    "dateCriteria": [
      { "name": "publication_date", "value": { "from": "<iso>", "to": "<iso>" } },
      { "name": "submitted_date", "value": { "from": "<iso>", "to": "<iso>" } }
    ]
  }
}
```

- **`company_lei` genuinely filters server-side** — confirmed by a real
  response where every hit matched the requested LEI. That's why the app
  makes **one request per watched company** (`fetchForLei()` in
  `lib/fetchReports.js`) instead of paginating the whole market feed.
- The response is a raw Elasticsearch result (`hits.hits[]._source`), also
  confirmed from a real capture. Report type is the `type` field — exact
  values `"Half-year Financial Report"` and `"Annual Financial Report"`
  (see `REPORT_TYPES` in `lib/fetchReports.js`) rather than a keyword guess
  against free text.
- `download_link` in the response is a path relative to
  `https://data.fca.org.uk/artefacts/` (confirmed by comparing a CSV
  export's full download URL against the API's relative one for the same
  document).
- The four-element `company_lei` value array (`["", "<LEI>", "disclose_org",
  "related_org"]`) is used exactly as captured from a real browser request
  — the leading empty string and the two flag strings are unexplained
  (there's no documentation to explain them) and kept as-is rather than
  guessed at.
- No API key, and no documented rate limit — meaning also no documented
  *allowance*. Keep usage light and don't assume it can take sustained/bulk
  traffic.
- **Batching multiple LEIs into a single request is untested.** The
  `company_lei` value array has only ever been sent/confirmed with one LEI;
  whether NSM's search accepts several at once (which would cut a
  21-company refresh down to 1–3 requests) is unconfirmed and not relied
  on.
- A handful of filings come through a different shape (seen once: a "Direct
  Upload" PDF factsheet with `ContentVersionId`/`html_link` fields instead
  of the usual RNS/PRN shape). `normalise()` handles this by only relying on
  fields both shapes share.
- **No pagination**: `size` per company scales with the chosen time period
  (`resultsPerCompany()` in `lib/fetchReports.js`, ~15 items/day of
  headroom, capped at 1000). Fine for normal filing volume, but an unusually
  active company in a long window could still exceed it and silently miss
  older items.
- **Report-type matching is exact and case-insensitive**, not a substring
  match.
- CORS headers in the real captured request (`Origin`/`Referer`) are
  browser-only concerns and don't apply to this server-to-server call, but
  the server sends browser-like headers anyway (`BROWSER_LIKE_HEADERS` in
  `lib/fetchReports.js`) in case the endpoint also enforces them
  server-side as informal bot filtering — unconfirmed either way.

## Deploying

### Deploying (Vercel)

This repo needs no build step — Vercel's zero-config Node setup serves the
root static files and auto-detects every file under `api/` as a serverless
function. Just import the repo — no environment variables required for the
base app. Set `RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` too if you want "Send
Notification" to work. Remember: this deployment mode gets none of the
`server.js`-only features — see [Two ways to run this](#two-ways-to-run-this).

### Deploying (Render)

`server.js` maps directly onto a Render **Web Service**. `render.yaml` in
the repo root is a Blueprint for this: **New → Blueprint**, point it at
this repo. It builds with `npm install` and starts with `npm start`;
Render sets `PORT` itself, which `server.js` already reads. The Blueprint
prompts for `RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` and
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` only if you want those optional
features — leave them unset otherwise. `DATABASE_URL` is wired
automatically from the Blueprint's own database, so the persistent cache,
shared watchlist, shared seen tracking, automatic digests, and push
notifications all use the same one.

Without the Blueprint: **New → Web Service** → connect the repo → Build
Command `npm install`, Start Command `npm start`.

### Deploying (Northflank)

`server.js` works the same way here — no serverless function support
needed, `api/*.js` is ignored.

1. **New → Service → Combined service**, connect this GitHub repo.
2. **Build**: Northflank's Buildpack should auto-detect this as a standard
   Node app (build `npm install`, start `npm start`). If detection has
   trouble, choose **Dockerfile** as the build type instead — this repo has
   a working one.
3. **Ports**: Northflank does **not** auto-inject `PORT` the way Render
   does. Either leave `PORT` unset and add a port for **3000** (HTTP,
   public) in Ports & DNS, or set `PORT` yourself and match it there.
   Skipping this is the most likely way a first deploy here ends up "build
   succeeded, site unreachable."
4. Add `RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` and/or
   `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (service → Environment) for those
   optional features — there's no Blueprint here to prompt for them.

#### Secret files instead of secret variables

Some Northflank plans/projects only offer **Secret Files** (mounted into
the container), not individual **Secret Variables**. `server.js` handles
this itself: for every variable in [Configuration
reference](#configuration-reference) except `PORT` and `SECRET_FILE_DIR`,
if the real environment variable isn't set, it falls back to reading a
file named exactly after that variable under `SECRET_FILE_DIR` (default
`/etc/secrets`) and uses its trimmed contents as the value.

To use this: create a secret file per credential, with the mount path set
to `/etc/secrets/<VARIABLE_NAME>` (exact name, no extension) and the
file's content set to just the raw value. A real environment variable, if
you're later able to set one, always takes priority over the file for the
same name.

#### Optional: Postgres addon for the persistent features

If you want any of the `DATABASE_URL`-backed features on Northflank rather
than provisioning Postgres separately, its own addon is more directly
integrated than copying Render's connection string by hand: **Addons →
PostgreSQL**, then link its generated `DATABASE_URL` secret to the service
as an environment variable. Northflank's addon already names it
`DATABASE_URL` in exactly the `postgresql://user:pass@host:5432/dbname`
shape this app expects.

This wasn't build-tested from this environment — the sandbox this was
written in blocks Docker Hub registry pulls even through its own network
proxy, so the `Dockerfile` couldn't actually be built and run here. It
follows the standard, widely-used Node Docker pattern; the same "first
real deploy is the real test" caveat applies here as everywhere else
unverifiable from this sandbox.

## Testing

```
npm test
```

Runs `node --test` over both `test/` and `gilt-ladder/test/` (Node's
built-in test runner, no extra dependency). The root suite covers the
automatic email digest system end to end, including the push-notification
scheduler that shares its check loop:

- `test/digestScheduler.test.js` — the due-check/send loop for both email
  (`runDueDigests`) and push (`runDuePush`), plus the poll-interval logic,
  against a fake in-memory store and a fake sender. No network, no
  database.
- `test/sendDigest.test.js` — digest-window calculation, per-company/
  per-category matching (including the keyword-filter OR-relationship),
  HTML building, and the recipient security gate, all pure functions in
  `lib/sendDigest.js`.
- `test/subscriptionsApi.test.js` — the real `/api/subscriptions*` routes
  in `server.js`, hit as real HTTP requests against a real in-process
  server; only `lib/subscriptionStore.js` is swapped for an in-memory fake,
  so this never touches Postgres.
- `test/subscriptionStore.test.js` — real CRUD against Postgres.
  **Skipped by default.** Set `TEST_DATABASE_URL` to a disposable database
  to run it — deliberately a separate env var from `DATABASE_URL`, so this
  suite can never accidentally run against a real database just because
  one happens to be configured for the app itself.
- `test/fetchReports.test.js`, `test/dueDates.test.js`, `test/buildIcs.test.js`
  — the NSM caching/delta-fetch logic, the due-date estimator, and the
  `.ics` feed builder, all as pure functions with no network dependency.

`gilt-ladder/test/` covers the Gilt Ladder's bond maths, calendar, curve
parsing, ladder construction, and its mount under `/gilt-ladder/` — see
[gilt-ladder/README.md](gilt-ladder/README.md).

Nothing else in the app (the NSM integration beyond what's unit-tested
above, the frontend, CSV/RSS/`.ics` export, manual "Send Notification") has
automated coverage yet — this suite is scoped specifically to the
recurring-notification systems and the pure logic modules that are cheap
to test in isolation. `lib/watchlistStore.js`, `lib/seenStore.js`,
`lib/pushStore.js`'s real Postgres CRUD, `lib/webPush.js`'s actual delivery
through a push service, and `lib/sendNotification.js`'s send through Resend
have no automated test of their own — the same "first real deploy/click is
the real test" caveat as elsewhere in this document applies.

## Project layout

```
index.html, style.css, app.js   Frontend: LEI watchlist manager + reports list (localStorage-backed unless the shared features below are enabled)
api/reports.js                  Vercel serverless function: GET /api/reports
api/watchlist.js                Vercel serverless function: GET /api/watchlist (seeds a fresh browser)
api/feed.js                     Vercel serverless function: GET /api/feed (RSS feed)
api/notify.js                   Vercel serverless function: POST /api/notify (see "Manual: the Send Notification button")
api/view.js                     Vercel serverless function: POST/GET /api/view (see "Encrypted view links")
lib/fetchReports.js             NSM search call + filtering + caching logic (shared by api/ and server.js)
lib/viewToken.js                AES-256-GCM view tokens for shareable links, the RSS feed, and the .ics feed
lib/buildFeed.js                Builds the RSS 2.0 XML for /api/feed
lib/buildIcs.js                 Builds the .ics calendar feed for /api/calendar.ics
lib/dueDates.js                 Estimated Half-year/Annual due-date logic behind /api/due-dates and the filing calendar
lib/sendNotification.js         Manual email sending via the Resend API
lib/cacheStore.js               Optional Postgres-backed NSM cache (see "The persistent NSM cache")
lib/watchlistStore.js           Optional Postgres-backed shared watchlist (see "The shared watchlist")
lib/seenStore.js                Optional Postgres-backed shared "seen" tracking (see "Shared 'seen' tracking")
lib/subscriptionStore.js        Postgres-backed automatic email digest subscriptions
lib/sendDigest.js               Builds/sends one email digest - server.js only
lib/digestScheduler.js          Due-check/send loop for both email digests and push - server.js only
lib/pushStore.js                Postgres-backed Web Push subscriptions - server.js only, no in-memory fallback
lib/webPush.js                  Thin VAPID/web-push wrapper - sends one push notification
lib/sendPush.js                 Checks one push subscription for anything new and sends a push if so
lib/basicAuth.js                HTTP Basic Auth check used by server.js - middleware.js re-implements the same check for Vercel
sw.js                            Service worker behind Web Push - handles 'push'/'notificationclick', nothing else
middleware.js                   Vercel Edge Middleware - gates every route before it reaches api/ or the static files
server.js                       Plain persistent Node server: static files + every /api/* route + the digest/push/gilt-recost scheduler + mounts gilt-ladder/
config/watchlist.js             Default company list - seeds a fresh browser/shared watchlist, and the fallback for /api/reports called with no leis param
Dockerfile, .dockerignore       Fallback build path for Northflank (or anywhere else that wants a container)
gilt-ladder/                    Gilt Ladder, mounted by server.js at /gilt-ladder/ - self-contained, see gilt-ladder/README.md
```

`/api/due-dates`, `/api/calendar.ics`, `/api/companies`, `/api/seen`,
`/api/subscriptions*`, and `/api/push/*` only exist on `server.js` — there
is no matching Vercel serverless function for any of them, since each
needs either a persistent database connection or a long-running process to
schedule checks from, neither of which fits Vercel's per-request execution
model. See [Two ways to run this](#two-ways-to-run-this).

## Known limitations

- **Auto-refresh's own in-tab notifications only run while the tab is
  open** — see [Notifications](#notifications) for the three alternatives
  that don't (RSS, the `.ics` feed, and Push).
- **Push notifications need both a database and a VAPID key pair** —
  without either, the Push button never appears rather than failing when
  clicked. Like automatic digests, the scheduler that checks and sends
  pushes only runs on `server.js` deployments.
- **A push subscription mirrors your enabled watchlist and Search
  settings, not the Group filter or a saved view.**
- **Sector/portfolio groups and watchlist views are handled differently.**
  A company's `group` tag is part of the shared watchlist row once
  `DATABASE_URL` is set, and so is visible to every visitor — but **views
  themselves always live in `localStorage`**, even then, so one browser's
  saved views are invisible to another browser/device pointed at the same
  shared watchlist.
- **The keyword digest filter matches only the filing's title** (NSM's
  `headline` field), the same as the main report list's own Keyword field
  — not the linked document's full text, which this app never downloads or
  parses.
- A stale browser `localStorage` entry from before the ISIN→LEI switch (an
  `isin` field instead of `lei`) is silently dropped on load rather than
  migrated, since there's no way to derive an LEI from an old ISIN entry
  automatically.
- The per-company history modal always requests 365 days for that one
  LEI (`MAX_WINDOW_DAYS` in `lib/fetchReports.js`) — everything NSM will
  return for that window, not literally all-time history.
- The debug panel ("All items returned in this period") shows every item
  for every watched company, un-truncated — scoped to your own watchlist,
  but a long time period with many watched companies could still make it
  sizeable.
- See also [the NSM section](#api-integration-notes-the-nsm-search)'s own
  list of caveats specific to that integration (untested batching,
  no pagination beyond a generous cap, the occasional differently-shaped
  filing).

## Gilt Ladder

`gilt-ladder/` is a separate, self-contained tool: given a set of dated
liabilities and what you already hold, it constructs a portfolio of
conventional gilts whose coupons and redemptions cover each one, taking UK
gilt taxation (coupons taxed as income, gains CGT-exempt) into account. It
shares nothing with the rest of this app except the HTTP server it's
mounted on (`router.js`, wired in from `server.js`) and, optionally,
`DATABASE_URL`/`VIEW_TOKEN_SECRET` for saved/shared plans.

It runs wherever `server.js` runs (local, Render, Northflank, Docker) at
`/gilt-ladder/`, behind the same Basic Auth login — **not on Vercel**, for
the same reason the rest of this app's database-backed features aren't.

See [gilt-ladder/README.md](gilt-ladder/README.md) for everything else:
the bond mathematics, the tax modelling, data sources and their caveats,
the ladder-construction algorithm, scenario analysis, and its own API.
