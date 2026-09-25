# RNS Update

A lightweight site that shows company report disclosures for a time period
and set of report types you choose, for a list of companies you manage
yourself in the page — sourced directly from the FCA's **National Storage
Mechanism** (data.fca.org.uk), the UK regulator's public repository for
company disclosures. No API key, no account, no cost.

Static HTML/CSS/JS frontend + a small serverless function that proxies the
NSM search so the browser doesn't need to talk to it directly.

This repository also hosts **Gilt Ladder** (`gilt-ladder/`), a separate tool
that builds a gilt portfolio to fund dated liabilities. `server.js` serves it
at `/gilt-ladder/`, behind the same login, and the header's "Gilt Ladder" link
goes there. It is only available where `server.js` runs, not on Vercel. See
[gilt-ladder/README.md](gilt-ladder/README.md).

## Setup

1. Run locally:
   ```
   npm start
   ```
   then open http://localhost:3000. No `.env` setup needed — see `.env.example`.
2. `config/watchlist.js`'s default companies are merged into the browser's
   watchlist on **every** page load (via `/api/watchlist` — see
   `initWatchlist()` in `app.js`), not just the first, so they're always
   present at startup. Removing one of the defaults via the page only lasts
   until the next reload, since it's added back in; companies you add
   beyond the defaults are untouched by this and persist normally. The list
   otherwise lives in that browser's `localStorage`.
3. Under "Search settings", choose a **time period** (24 hours to 90 days)
   and the **report types** to match — checkboxes for the four confirmed
   category names, plus an "Other report types" field for anything not
   listed (comma-separated, matched exactly against the filing's category;
   defaults to "Half-year Financial Report, Annual Financial Report" if you
   clear everything and hit Apply). These are saved to `localStorage` and
   sent to `/api/reports` as `days` and `categories` query params.

`config/watchlist.js` serves two roles: it's what `/api/watchlist` seeds a
brand-new browser with (see above), and it's also the fallback `/api/reports`
itself falls back to when called with no `leis` query parameter (e.g.
hitting the API directly).

### Features beyond the basic list

- **New-report highlighting**: reports that appeared since your last visit
  get a "NEW" badge and a left-border highlight. Tracked via a set of seen
  report IDs in `localStorage` (`SEEN_KEY` in `app.js`) — the very first
  load establishes a baseline silently (nothing is flagged "new" the first
  time you ever see it), and every load after that only flags genuinely new
  items.
- **Cache visibility**: the status line shows a "refreshed at HH:MM:SS" time
  and, when applicable, how many of your watched companies were served from
  the in-memory NSM cache (see below) rather than freshly fetched.
- **Download CSV**: exports the currently-displayed report list (company,
  title, category, date, link) as a CSV file — a quick audit trail outside
  the browser.
- **RSS feed**: the "RSS feed" link points at `/api/feed` with your current
  watchlist/time-period/category settings baked in (as an encrypted token
  when `VIEW_TOKEN_SECRET` is set — see "Encrypted view links" — otherwise
  as readable query params) — paste
  that URL into any feed reader to get "new report" notifications without
  this app needing to run its own email/push pipeline. See `lib/buildFeed.js`.
- **Filing calendar**: the floating calendar button (bottom-right) opens a
  month grid superimposing recent filings and estimated Half-year/Annual due
  dates for a user-editable subset of your watchlist and report types
  (independent of the main list's own settings) — see `app.js`'s
  `openCalendarOverlay()`. Its "Add to Calendar" link is a subscribable
  `.ics` feed (same `v`-token/readable-params handling as the RSS feed
  above) for the trusts/categories currently ticked, so the same filings and
  due-date estimates show up in Google/Outlook/Apple Calendar too — see
  `lib/buildIcs.js` and `/api/calendar.ics`.
- **Per-company filing history**: the clock icon next to each company in the
  sidebar opens a modal showing that company's full filing history for the
  last 365 days (every item NSM returns, not just ones matching your current
  category filter) — useful for "did I actually miss anything" checks
  without fiddling with the time-period dropdown.
- **Auto-refresh + browser notifications**: the "Auto-refresh" setting
  polls `/api/reports` on an interval (5/15/30 minutes) via `setInterval`
  while the tab stays open. Turning it on requests browser notification
  permission; if granted, a newly-seen report triggers an OS notification
  **only while the tab is in the background** — a foreground tab already
  shows the "NEW" badge, so a popup on top of that would be redundant. This
  is plain browser `Notification`, not push: it stops working the moment
  the tab or browser is closed (see "Known limitations").
- **Filter and sort**: a text box above the report list filters by company
  or title client-side (no re-fetch), and a sort dropdown reorders by date
  or company name (persisted in `localStorage`). Both act purely on
  `lastReports`, the same in-memory list the CSV export reads from.
- **Manual theme toggle**: Auto/Light/Dark in the header, persisted in
  `localStorage` and applied via a `data-theme` attribute that overrides the
  `prefers-color-scheme` media query the app otherwise follows.
- **Export/import your watchlist**: "Export list" downloads your companies
  as JSON; "Import list" reads one back in, merging new entries and skipping
  ones you already have (by LEI) or that aren't validly formed — the fix for
  the fact that the watchlist otherwise lives only in one browser's
  `localStorage` with no backup.
- **Shareable URL**: the address bar always reflects your current
  companies/time-period/categories after a load (via
  `history.replaceState`, so it doesn't spam browser history) — copy it to
  bookmark or share a specific view. That's a single encrypted `v` param
  when `VIEW_TOKEN_SECRET` is set (see "Encrypted view links"), otherwise
  readable `leis`/`days`/`categories` params. Opening either kind of link
  **only ever adds** those companies to your watchlist
  (or adopts the days/categories as your active settings) — it never removes
  or replaces anything already saved, so a shared link can't clobber your
  list even if it names totally different companies.
- **Per-report email notification**: a "Send Notification" button on each
  report emails a summary of it on click — see "Email notifications" below.
- **Sector/portfolio grouping**: tag each company with a free-text group
  (e.g. "Income trusts", "Client A") in Edit companies, then filter the main
  report list to one group via the "Group" dropdown above it — see "Sector/
  portfolio grouping and watchlist views" below.
- **Multiple watchlist views**: save the current group filter, time period,
  report types, and keyword as a named "view" (Views panel in the sidebar),
  and switch between saved views instead of re-entering settings each time —
  see the same section below.
- **Real push notifications**: a "Push" button in the header turns on
  browser/OS push notifications for this browser — unlike auto-refresh's
  in-tab notifications, these keep arriving with the tab (or the whole
  browser) closed. See "Push notifications" below.

### Why LEI, not ISIN or ticker

The NSM has no ISIN field at all — filings are indexed by **LEI** (Legal
Entity Identifier, a 20-character code) and company name, confirmed from a
real search export. Add a company via the main form using its LEI (look one
up at [search.gleif.org](https://search.gleif.org/) if you only know its
ISIN or name).

### Sector/portfolio grouping and watchlist views

Each company can be tagged with a free-text **group** (e.g. "Income
trusts", "Client A", "Growth") from the Edit companies overlay — a plain
text field next to its name, with autocomplete against groups already in
use so retyping one is a matter of picking it from the list rather than
remembering the exact spelling. A company with no group set shows up under
"Ungrouped" wherever groups are listed. This is purely a label on the one
shared watchlist, not a separate list of companies — renaming a company or
moving it between groups is a single edit, immediately reflected wherever
that group is used.

The main report list's **Group** dropdown (next to the text filter above
the table) filters to one group (or "Ungrouped", or "All groups") — purely
client-side over whatever's already loaded, the same way the text filter
works.

**Views** (the "Views" panel in the sidebar, below Search settings) are
named, saved combinations of **group filter + time period + report types +
keyword** — not a separate company list. Save the current combination as a
new view, switch between saved views from the dropdown, update a view's
saved settings to match whatever's currently applied, or delete one.
Selecting a view applies its settings and reloads the report list; picking
"— All (no view) —" goes back to whatever the group filter/Search
settings/keyword are set to directly. Views live in this browser's
`localStorage` only (like Search settings/theme/sort), the same as every
other per-browser preference in this app — they are not shared across
browsers/devices even when the watchlist itself is (`DATABASE_URL` set),
and they reference groups by name, so renaming or deleting the only group a
view filters to leaves that view matching nothing until it's pointed at a
different group.

### Email notifications

Each report in the list has a **Send Notification** button that emails a
summary of that report (company, title, type, publish date, link) on click,
with the linked document attached as a PDF when the report has one. This is
the manual, one-off path — see "Automatic email digests" below for
subscriptions that send on a schedule without anyone clicking anything.

The attachment uses Resend's `path` attachment option — Resend fetches the
document itself server-side from the report's `url` (NSM's document links
are public, no auth needed), rather than this app downloading and
re-uploading it. Filename is taken from the URL when it looks like a real
filename, otherwise falls back to `report.pdf` (`filenameFromUrl()` in
`lib/sendNotification.js`). Resend caps attachments at 40MB per email; what
happens for an oversized or unreachable document (the whole send fails, or
the attachment is silently dropped) isn't confirmed from this environment —
first real oversized/broken link is the test.

Sending goes through the [Resend](https://resend.com) API via their
official Node SDK (`lib/sendNotification.js`, `/api/notify`), not SMTP. It's
split into two halves with different requirements:

- **Sending config (server-side, required):** `RESEND_API_KEY`,
  `NOTIFY_EMAIL_FROM` — see `.env.example`. These are secrets, so they're
  only ever set as environment variables on whichever platform you deploy to
  (or your shell for local dev) — there's no UI for them, and nothing is
  hardcoded or committed to the repo. If either is missing, clicking the
  button shows an error naming which one, rather than silently failing.
- **Recipient address:** the first time you click Send Notification, an
  overlay asks for the email that should receive notifications and saves it
  to that browser's `localStorage` — it's then sent as `to` on every subsequent notify request
  from that browser. **That per-browser recipient is only honoured when
  `APP_PASSWORD` is set** (see "Authentication") — otherwise anyone with the
  URL could use `/api/notify` to send mail from your verified domain to any
  address. Without `APP_PASSWORD`, emails only ever go to the server-side
  `NOTIFY_EMAIL_TO` (required in that case), and a request naming any other
  recipient is refused. With `APP_PASSWORD` set, `NOTIFY_EMAIL_TO` is
  optional and only a fallback for a request that doesn't supply its own
  `to`.

This hasn't been exercised against the real Resend API from this environment
(no network access here to verify it end-to-end) — the first real click
after you configure credentials is effectively the integration test.

#### Setup

1. Sign up at [resend.com](https://resend.com) — the free tier covers
   100 emails/day / 3,000/month, comfortably enough for a personal
   watchlist app.
2. **Get a `from` address.** Two options:
   - Fastest to test with: `onboarding@resend.dev`, Resend's shared sandbox
     sender — no verification needed, but it **only delivers to the email
     address you signed up to Resend with**, nobody else. Fine for
     confirming the integration works, not for real use.
   - For a real recipient: **verify your own domain** (Domains → Add
     Domain, then add the DNS records Resend gives you) and use any address
     on it, e.g. `notify@yourdomain.com`.
3. **Create an API key**: API Keys → Create API Key. "Sending access" is
   enough; you don't need full account access.
4. Set `RESEND_API_KEY` (the key from step 3) and `NOTIFY_EMAIL_FROM` (the
   address from step 2) as environment variables — Render/Northflank
   (service → Environment) or Vercel (Project Settings → Environment
   Variables); locally, in your `.env`.
5. In the app itself, set the recipient (Send Notification overlay) to
   whichever address should actually receive the notifications —
   independent of the Resend account, and can
   be anything as long as you're using a verified domain in step 2 (stays
   restricted to your own signup address if you used the sandbox sender).
   This needs `APP_PASSWORD` set; without it, set `NOTIFY_EMAIL_TO` and
   enter that same address.

#### This deployment's setup

`trusts.tomhyde.co.uk` is verified with Resend (DKIM/SPF/DMARC records
added, sending enabled) — no longer restricted to the sandbox sender or a
single recipient. `NOTIFY_EMAIL_FROM` should be set to
`notify@trusts.tomhyde.co.uk` (as a Northflank secret file at
`/etc/secrets/NOTIFY_EMAIL_FROM`, per "Secret files instead of secret
variables" below) alongside `RESEND_API_KEY`. With both set, plus
`APP_PASSWORD` (e.g. `/etc/secrets/APP_PASSWORD`, which is what enables the
in-app recipient), the recipient in the app itself can be any address, not
just the Resend account's own signup email.

### Automatic email digests

The **Notifications** button (top-left, next to the title) opens a
subscription manager, independent of the manual Send Notification flow
above: each email address gets its own schedule (paused / daily / monthly /
as they occur), its own matrix of which trusts, and which report types per
trust, it should be notified about, and an optional **keyword filter**
(e.g. "delisting", "merger") — a filing mentioning that word is included in
the digest even for a company/report-type combination the matrix hasn't
otherwise selected, the same "OR'd with the category match" relationship
the main report list's own Keyword field has (`lib/fetchReports.js`'s
`matchesKeyword`). Leave it blank for category/trust matching only, as
before.

- **Daily** and **monthly** send one collated email — everything that
  matched since the last send — at a GMT time of day you choose per
  subscription (monthly always fires on the 1st).
- **As they occur** sends the moment a new Half-year or Annual Financial
  Report is found for a watched trust — the only two categories with an
  actual filing deadline worth hearing about immediately (see "Estimated
  filing due dates" below) — with no fixed heartbeat, and never an empty
  email. The other four report types aren't offered for this schedule.

Every digest email's footer links back to the Notifications overlay
(`${APP_URL}/#notifications`) so adjusting or pausing a subscription never
requires hunting for the button — set **`APP_URL`** to your deployment's
own public URL to enable it (omitted otherwise).

This genuinely runs without a browser tab open: subscriptions live in
Postgres (`lib/subscriptionStore.js`, `notification_subscriptions` table,
auto-created on first use) rather than `localStorage`, and `server.js` runs
a self-rescheduling loop (`runDueDigests()`) that sends whatever's due,
checking every 5 minutes normally or every minute while any subscription is
set to "as they occur". Requires:

- **`DATABASE_URL`** — see "Persistent cache (Postgres)" below for setup.
  Without it, the Notifications overlay shows a message explaining that a
  database is needed, and `/api/subscriptions` is a no-op. This is the one
  feature in the app that doesn't degrade to a simpler in-memory fallback —
  a subscription has to survive process restarts and Render free-tier
  spin-downs to mean anything as "automatic".
- **`RESEND_API_KEY` / `NOTIFY_EMAIL_FROM`** — same sending config as manual
  notifications above.
- Same recipient policy as manual sends: without `APP_PASSWORD`, only the
  fixed `NOTIFY_EMAIL_TO` address can be subscribed (creating a
  subscription for any other address is rejected) — otherwise this would be
  an open relay for recurring, not just one-off, email.

A brand-new subscription's first send covers exactly one cycle back (a
"daily" or "as they occur" subscription's first email covers the last 24h,
"monthly" the last 30 days) rather than its entire history, so turning one
on doesn't suddenly dump a backlog on someone. Only relevant on
Render/Northflank/local (where
`server.js` is a long-running process) — the Vercel deployment's `api/*.js`
functions are serverless with nothing to run a background loop, so
automatic digests don't fire there without separately configuring Vercel
Cron to hit a due-check endpoint (not currently wired up).

## Push notifications

The **Push** button in the header (next to Diagnostics) turns on real
browser/OS push notifications for that browser — the actual fix for the
limitation the rest of this README calls out repeatedly: auto-refresh's
own in-tab notifications (`notifyNewReports()` in `app.js`) only fire while
that tab is open, because they're the plain `Notification` API with
nothing behind them once the tab or browser closes. Push instead goes
through a service worker (`sw.js`) and the browser vendor's own push
service (the same mechanism most installed web apps use for notifications),
so it keeps working with this site closed entirely — the only feature in
this app that does.

- **What it notifies for**: whichever companies are currently enabled in
  your watchlist, and the current Search settings' report types/keyword —
  the same criteria the main report list itself uses, not a separate
  picker. Turning Push on takes a snapshot of those; adding/removing a
  company, or changing categories/keyword and hitting Apply, re-syncs an
  already-active subscription automatically (`maybeSyncPushSubscription()`
  in `app.js`) so it doesn't quietly fall out of date. It does **not**
  follow the Group filter or a saved view — those affect what the *page*
  displays, not what's pushed.
- **Setup**: needs `DATABASE_URL` (subscriptions are stored in Postgres,
  the same database as automatic email digests — see "Persistent cache
  (Postgres)"/"Automatic email digests" above) plus a VAPID key pair
  (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`), which identifies this
  deployment to push services so they know a delivery genuinely came from
  it. Generate one with:
  ```
  npx web-push generate-vapid-keys
  ```
  and set both as environment variables (or secret files — see "Secret
  files instead of secret variables" below). Optionally also set
  `VAPID_SUBJECT` to a `mailto:`/`https:` URI a push service could use to
  reach this deployment's operator (required by the VAPID spec, never shown
  to a subscriber) — defaults to a placeholder if unset. Without both keys
  set, the Push button never appears, same "missing config just disables
  the feature" pattern as email notifications.
- **How it's checked**: `server.js`'s existing digest-scheduler loop
  (`lib/digestScheduler.js`'s `runDuePush()`) checks every push
  subscription on the same tick as due email digests — unlike email, a
  push subscription has no schedule of its own to be "due" against, so
  every one is checked every tick, and any push subscription existing at
  all forces the loop's fastest cadence (the same one "as they occur" email
  subscriptions already use). Only relevant on Render/Northflank/local
  (`server.js` staying alive between requests) — like automatic email
  digests, this does not run on Vercel's serverless `api/*.js` functions
  without separately configuring Vercel Cron.
- **A subscription that goes stale** (permission revoked, browser site data
  cleared, the underlying push endpoint expired) is detected the next time
  a push actually fails to deliver with a 404/410 from the push service
  (`lib/webPush.js`'s `sendPush()`) and removed from the database
  automatically (`runDuePush()`), rather than retried forever.

## Authentication

By default the whole app — every page and API route, including
`/api/notify` — is open to anyone with the URL, same as before (though
`/api/notify` then only sends to `NOTIFY_EMAIL_TO` — see "Email
notifications"). Set
`APP_PASSWORD` to require an HTTP Basic Auth login (the browser's own
username/password popup, no custom login page) before anything loads.
Username defaults to `admin`; set `APP_USERNAME` to change it.

This is enforced on every deployment method:

- **server.js** (local dev, Render, Northflank) checks it itself, on every
  request, before any routing — see `lib/basicAuth.js`.
- **Vercel** uses `middleware.js` at the repo root (Vercel Edge Middleware),
  which runs before both the static files and every `api/*.js` function.
  It's a separate, more restricted runtime from `server.js`'s plain Node
  process (no `Buffer`, no Node `crypto`, no filesystem), so it
  re-implements the same check with only Web-standard APIs (`atob`,
  `TextDecoder`, `crypto.subtle`) rather than importing `lib/basicAuth.js`
  — keep the two in sync if this logic ever changes.

Both compare credentials as SHA-256 digests in constant time, so response
timing doesn't reveal how close a guess was. `/api/notify` also rejects any
POST whose `Content-Type` isn't `application/json`: browsers resend cached
Basic Auth credentials automatically, so without that check another website
could make a logged-in visitor's browser submit a hidden form that sends an
email. A JSON content type forces a CORS preflight, which this app never
approves.

Set `APP_USERNAME`/`APP_PASSWORD` as environment variables the same way as
any other secret in this project (or as secret files — see "Secret files
instead of secret variables" below). Was added specifically to stop an
anonymous visitor from triggering the "Send Notification" button (which
sends real email from this deployment's verified domain) — protecting the
whole app was simpler and more robust than gating that one endpoint alone.

## Encrypted view links

By default, shareable links, the RSS feed URL, and the filing calendar's
`.ics` feed URL carry your companies and settings as readable query params
(`?leis=…&days=7&categories=…`). Anyone who sees the URL can read them,
including through browser history, your hosting provider's request logs,
screenshots, and link previews in chat apps. Set `VIEW_TOKEN_SECRET` to
replace them with a single encrypted `?v=<token>` param. The address bar,
the RSS feed link, the "Add to Calendar" link, and the app's own
`/api/reports` requests all switch to it.

- **How it works** (`lib/viewToken.js`, `/api/view`): the browser POSTs its
  current view to `/api/view`, and the server returns it compressed and
  encrypted with AES-256-GCM, under a key derived from `VIEW_TOKEN_SECRET`.
  The key never leaves the server. Opening a link sends the token back to
  `/api/view` to decrypt, and `/api/reports`/`/api/feed`/`/api/calendar.ics`
  accept `v` directly. An edited or truncated token is rejected rather than
  opening a different view.
- **What it doesn't do:** anyone who opens a link still sees that view. The
  server decrypts it for them, and opening it adds its companies to their
  watchlist as before, so `APP_PASSWORD` is still what controls access. A
  token's length also hints at roughly how many companies it holds.
- **The secret** must be at least 32 characters (e.g. the output of
  `openssl rand -base64 32`). Set it like any other secret, as an env var or
  a secret file. The Render Blueprint generates one automatically.
- **Changing the secret breaks every existing encrypted link and RSS feed
  subscription.** They'll show "Invalid view link" and need re-copying from
  the app.
- **Without it**, nothing changes and links stay readable. Readable links
  (old bookmarks, existing feed subscriptions) also keep working after you
  enable it, and the address bar switches to the encrypted form on the next
  load.

## Deploying (Vercel)

This repo needs no build step — Vercel's zero-config Node setup serves the
root static files and auto-detects every file under `api/` (including
`api/notify.js`) as a serverless function. Just import the repo into
Vercel — no environment variables required for the base app. Set
`RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` too (Project Settings → Environment
Variables) if you want the "Send Notification" button to work — see "Email
notifications" above.

## Deploying (Render)

`server.js` is a plain persistent Node server (not serverless functions), so
it maps directly onto a Render **Web Service** — Render doesn't need
`api/reports.js` at all, since `server.js` already serves `/api/reports`
itself. `render.yaml` in the repo root is a Blueprint for this: in the
Render dashboard, **New → Blueprint**, point it at this repo. It builds with
`npm install` and starts with `npm start`; Render sets `PORT` itself, which
`server.js` already reads. No environment variables required for the base
app — the Blueprint prompts for `RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` (see
"Email notifications" above) only if you want the optional "Send
Notification" button to work, and for `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
(see "Push notifications" above) only if you want the optional "Push"
button to work; leave any/all of them unset otherwise. `DATABASE_URL` is
already wired automatically from the Blueprint's own database, so the
shared watchlist, automatic email digests, and push notifications all use
the same one.

Without the blueprint, the same result comes from **New → Web Service** →
connect the repo → Build Command `npm install`, Start Command `npm start`.

## Deploying (Northflank)

`server.js` is the same plain persistent Node server used for Render above,
so it works the same way here: no serverless function support needed,
`api/*.js` is ignored, `server.js` alone serves the whole app.

1. **New → Service → Combined service**, connect this GitHub repo.
2. **Build**: Northflank tries a **Buildpack** first, which should
   auto-detect this as a standard Node app with no extra config — build
   command `npm install`, start command `npm start` if it asks. If
   buildpack detection has trouble (Northflank's own docs list a Dockerfile
   as the documented fallback), this repo also has a working `Dockerfile`
   — choose **Dockerfile** as the build type instead and it picks that up.
3. **Ports — the one genuinely different step from Render.** Northflank
   does **not** auto-inject a `PORT` env var the way Render does; you set
   it yourself (or rely on `server.js`'s own default). Either:
   - leave `PORT` unset and add a port in the service's **Ports & DNS**
     settings for **3000**, protocol HTTP, public; or
   - set `PORT` to whatever value you prefer and match that same number in
     **Ports & DNS**.
   Skipping this step is the most likely way a first deploy here goes
   "build succeeded, site unreachable" — the container runs, nothing routes
   to it.
4. No environment variables are required for the base app either way. Add
   `RESEND_API_KEY`/`NOTIFY_EMAIL_FROM` (service → Environment) if you want
   the optional "Send Notification" button to work — see "Email
   notifications" above; add `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` if you
   want the optional "Push" button to work — see "Push notifications"
   above; Northflank has no blueprint file to pre-fill any of these like
   Render's, so set them yourself.

### Secret files instead of secret variables

Some Northflank plans/projects only offer **Secret Files** (mount a file
into the container), not individual **Secret Variables**. `server.js`
handles this itself: for `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM`,
`NOTIFY_EMAIL_TO`, `DATABASE_URL`, `DATABASE_SSL_CA`, `APP_USERNAME`,
`APP_PASSWORD`, `VIEW_TOKEN_SECRET`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`, if the real environment variable
isn't set, it falls back to reading a file named exactly after that
variable under `/etc/secrets` (e.g. `/etc/secrets/RESEND_API_KEY`) and uses
its trimmed contents as the value — no environment variable needed at all.

To use this: in Northflank, create a secret file per credential you need,
with the **mount path set to `/etc/secrets/<VARIABLE_NAME>`** (matching the
name exactly, no file extension) and the file's **content set to just the
raw value** (e.g. the file at `/etc/secrets/RESEND_API_KEY` contains only
`re_your_api_key`, nothing else). A real environment variable, if you're
later able to set one, always takes priority over the file for the same
name. Override the base directory with `SECRET_FILE_DIR` if you'd rather
mount your files somewhere other than `/etc/secrets`.

### Optional: Postgres addon for the persistent cache

If you also want the Postgres-backed NSM cache (see "Persistent cache
(Postgres)" above) rather than Render's approach of provisioning one
separately and copying a connection string by hand, Northflank's own
Postgres addon is more directly integrated: **Addons → PostgreSQL**, then
link its generated `DATABASE_URL` secret to the service as an environment
variable. Northflank's addon already names it `DATABASE_URL` in exactly
the `postgresql://user:pass@host:5432/dbname` shape `lib/cacheStore.js`
expects — no reformatting needed, unlike copying Render's connection
string by hand.

**This wasn't build-tested in this environment** — the sandbox this was
written in blocks Docker Hub registry pulls (even through its own network
proxy), so the `Dockerfile` above couldn't actually be built and run here.
It follows the standard, widely-used Node Docker pattern (and matches
Northflank's own documented example closely), but the same "first real
deploy is the real test" caveat applies as everywhere else undocumented or
unverifiable from this sandbox has come up in this project.

## API integration notes

### NSM search (reports)

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
  against free text, since we have confirmed real values this time.
- `download_link` in the response is a path relative to
  `https://data.fca.org.uk/artefacts/` (confirmed by comparing a CSV export's
  full download URL against the API's relative one for the same document).
- The four-element `company_lei` value array (`["", "<LEI>", "disclose_org",
  "related_org"]`) is used exactly as captured from a real browser request —
  the leading empty string and the two flag strings are unexplained (there's
  no documentation to explain them) and kept as-is rather than guessed at.
- No API key, and no documented rate limit — meaning also no documented
  *allowance*. Keep usage light (this app already does, at one request per
  company per refresh) and don't assume it can take sustained/bulk traffic.
- **Each company's raw results are cached** for `NSM_CACHE_TTL_MINUTES`
  (default 10, `fetchForLeiCached()` in `lib/fetchReports.js`) — a refresh
  within that window reuses the cached data instead of re-querying NSM, so
  with a 21-company watchlist a burst of refreshes costs 21 requests once,
  not 21 every time. Keyed only by LEI, not by the requested time
  period/report types, since those are both filtered afterwards against the
  same raw item list; a request needing a longer window than what's cached
  (a bigger `size`) is treated as a miss and re-fetched. In-memory by
  default (zero setup, but wiped on process restart); set `DATABASE_URL` to
  back it with Postgres instead — see "Persistent cache (Postgres)" below.
  Set `NSM_CACHE_TTL_MINUTES=0` to disable caching entirely.

### Persistent cache (Postgres)

By default the NSM cache above lives in memory, which is wiped every time
the Node process restarts. On Render's **free** web service plan that
happens after every idle spin-down — the next request cold-starts a fresh
process with an empty cache, and would otherwise hit NSM once per watched
company all at once, exactly the burst the cache exists to avoid.

Setting `DATABASE_URL` makes `lib/cacheStore.js` store that same cache in
Postgres instead (a single `nsm_cache` table: `lei` primary key, `items`
JSONB, `size`, `fetched_at` — created automatically on first use). With no
`DATABASE_URL` set, nothing changes: the app runs exactly as before,
in-memory, zero setup. A Postgres outage or bad connection string doesn't
break report loading either — a failed cache read/write is logged and
treated as a cache miss, falling through to a fresh NSM fetch.

**Setup on Render**: Render dashboard → **New → PostgreSQL**, then copy its
**Internal Database URL** into your web service's `DATABASE_URL` environment
variable (same Render region as the web service, so the internal URL is
reachable). **Know the tradeoff before you provision one**: Render's free
Postgres plan **expires and is deleted after 30 days** — fine for testing
this, but not a real long-term store unless you're on a paid database plan.
This isn't wired into `render.yaml` as a Blueprint resource deliberately,
so deploying the Blueprint never silently provisions a database (and its
30-day clock) you didn't ask for.

Anywhere else (Neon, Supabase, your own Postgres, local dev), the same
`DATABASE_URL` env var works the same way — this is a plain `pg.Pool`
connection over TLS, **with the server's certificate verified by default**.
If your provider's certificate isn't signed by a CA in Node's default trust
store, the cache logs a certificate error and falls back to fresh NSM
fetches (reports still load). Fix that by setting `DATABASE_SSL_CA` to the
provider's CA certificate (PEM text, as an env var or secret file). Only as
a last resort, `DATABASE_SSL_VERIFY=false` skips verification: the
connection is still encrypted, but anyone who can intercept it could
impersonate the database. An `sslmode` parameter in `DATABASE_URL` itself
overrides both settings.
- **Batching multiple LEIs into a single request is untested.** The
  `company_lei` value array has only ever been sent/confirmed with one LEI;
  whether NSM's search accepts several at once (which would cut the
  21-request refresh down to 1-3) is unconfirmed and not relied on, per the
  same "verify before building" approach used throughout this integration.
- A handful of filings come through a different shape (seen once: a "Direct
  Upload" PDF factsheet with `ContentVersionId`/`html_link` fields instead
  of the usual RNS/PRN shape). `normalise()` handles this by only relying on
  fields both shapes share.

### Known limitations

- **CORS headers in the real request (`Origin`/`Referer`) are browser-only
  concerns** and don't apply to this server-to-server call, but the
  server-side code sends browser-like headers anyway (`BROWSER_LIKE_HEADERS`
  in `lib/fetchReports.js`) in case the endpoint also enforces them
  server-side as informal bot filtering — unconfirmed either way, since it
  can't be tested from a sandboxed environment with no network access to
  `data.fca.org.uk`.
- No pagination: `size` per company scales with the chosen time period
  (`resultsPerCompany()` in `lib/fetchReports.js`, ~15 items/day of
  headroom, capped at 1000). Fine for a normal company's filing volume (the
  real capture showed roughly 10-15 items/week for one company), but a
  company with unusually heavy filing activity in the selected window could
  still exceed it and silently miss older items.
- The debug panel ("All items returned in this period") shows every item
  for every watched company, un-truncated — safe to leave on since it's
  scoped to your own watchlist rather than a market-wide dump, but a long
  time period with many watched companies could still make it sizeable.
- **Report-type matching is exact and case-insensitive**, not a substring
  match — typing `Half-year` alone won't match `"Half-year Financial
  Report"`. Type (or paste) the full category name as it appears in a real
  filing.
- A stale browser `localStorage` entry from before the ISIN→LEI switch (an
  `isin` field instead of `lei`) is silently dropped on load rather than
  migrated, since there's no way to derive an LEI from an old ISIN entry
  automatically — see `loadWatchlist()` in `app.js`.
- **Auto-refresh's own in-tab notifications only run while the tab is
  open** — that polling loop and its plain-`Notification` popups stop the
  moment the tab or browser closes. Three alternatives that don't: the RSS
  feed and the filing calendar's `.ics` feed (both poll on the *reader's*
  own schedule, not this app's), and the "Push" button (see "Push
  notifications" above), which is the one option actually delivered by
  this app itself with nothing open — the other two are also unaffected by
  the deployment-specific caveats below, since a feed reader/calendar app
  keeps polling regardless of what this deployment has configured.
- **Push notifications need both a database and a VAPID key pair
  configured** (see "Push notifications") — without either, the Push
  button never appears rather than failing when clicked. Like automatic
  email digests, the scheduler that actually checks and sends pushes only
  runs on Render/Northflank/local (`server.js` staying alive between
  requests), not on Vercel's serverless functions without separately
  configuring Vercel Cron. A push subscription is also tied to one specific
  browser profile/installation — clearing that browser's site data (or the
  OS revoking notification permission) silently ends delivery until Push is
  turned on again there; there's no cross-device sync of push subscriptions
  the way the shared watchlist has.
- **A push subscription mirrors your enabled watchlist and Search
  settings, not the Group filter or a saved view** — turning Push on
  notifies for whatever the *unfiltered* active watchlist and current
  report types/keyword would show, kept in sync automatically as those
  change (see "Push notifications"), but narrowing the on-screen list to
  one group or view doesn't narrow what gets pushed.
- **Sector/portfolio groups and watchlist views are both per-browser**,
  even when the watchlist itself is shared across visitors
  (`DATABASE_URL` set — see "The user's actual, editable watchlist" in
  Project layout below): a company's `group` tag *is* stored server-side
  alongside the rest of that shared row (`lib/watchlistStore.js`) and so is
  visible to every visitor, but **views themselves live only in
  `localStorage`** (see "Sector/portfolio grouping and watchlist views"
  above) — one browser's saved views are invisible to another browser/
  device, even one pointed at the same shared watchlist.
- **The keyword digest filter matches only the filing's title** (NSM's
  `headline` field, via `lib/fetchReports.js`'s `normalise()`), the same
  as the main report list's own Keyword field — not the linked document's
  full text, which this app never downloads or parses.
- The "seen reports" set behind the NEW badge is capped at the most recent
  1000 entries (`MAX_SEEN` in `app.js`) and lives in that browser's
  `localStorage` — clearing site data resets it, which just means the next
  load re-establishes a fresh baseline (nothing incorrectly flagged, just a
  one-time loss of "what's new" history).
- The per-company history modal always requests 365 days for that one LEI,
  which is `MAX_WINDOW_DAYS` in `lib/fetchReports.js` — it shows everything
  NSM will return for that window, not literally all-time history.

## Testing

```
npm test
```

Runs `node --test test/` (Node's built-in test runner - no extra dependency
needed). Covers the automatic email digest system end to end, including the
push-notification scheduler added alongside it (both share
`lib/digestScheduler.js`'s check loop):

- `test/digestScheduler.test.js` - the due-check/send loop for both email
  (`runDueDigests`) and push (`runDuePush`), plus the poll-interval logic
  (`computePollIntervalMinutes`, including its `hasPush` branch), all
  against a fake in-memory store and a fake sender. No network, no database.
- `test/sendDigest.test.js` - digest-window calculation, per-trust/per-category
  matching (including the keyword-filter OR-relationship added for keyword
  digest alerts), HTML building, and the recipient security gate
  (`digestSendAllowed`), all pure functions in `lib/sendDigest.js`.
- `test/subscriptionsApi.test.js` - the real `/api/subscriptions*` routes in
  `server.js`, hit as real HTTP requests against a real (in-process) server -
  only `lib/subscriptionStore.js` is swapped for an in-memory fake, so this
  never touches Postgres.
- `test/subscriptionStore.test.js` - real CRUD against Postgres. **Skipped by
  default.** Set `TEST_DATABASE_URL` to a disposable database to run it:
  ```
  TEST_DATABASE_URL=postgres://user:pass@host:5432/dbname npm test
  ```
  Deliberately a separate env var from `DATABASE_URL` (which your own shell
  or `.env` might have set for running the app itself), so this suite can
  never accidentally run against a real database just because one happens
  to be configured - only ever the one you explicitly hand it here. It
  cleans up the rows it creates, but should still only ever point at
  something disposable, never production.

`npm test` also runs `gilt-ladder/test/` - the Gilt Ladder's bond maths,
calendar, curve parsing, ladder construction, and its mount under
`/gilt-ladder/`. None of those tests need the network.

Nothing else in the app (the NSM integration, the frontend, CSV/RSS export,
manual "Send Notification") has automated coverage yet - this suite is
scoped specifically to the recurring-digest and push-notification systems.
`lib/pushStore.js`'s real Postgres CRUD and `lib/webPush.js`'s actual
delivery through a push service have no automated test of their own (the
same "first real deploy/click is the real test" caveat as elsewhere in this
README applies) - only the pure scheduling/filtering logic around them is
covered here.

## Project layout

```
index.html, style.css, app.js   Frontend: LEI watchlist manager (localStorage) + reports list
api/reports.js                  Vercel serverless function: GET /api/reports
api/watchlist.js                Vercel serverless function: GET /api/watchlist (seeds a fresh browser)
api/feed.js                     Vercel serverless function: GET /api/feed (RSS feed of matching reports)
api/notify.js                   Vercel serverless function: POST /api/notify (email a report - see "Email notifications")
api/view.js                     Vercel serverless function: POST/GET /api/view (create/open encrypted view links - see "Encrypted view links")
lib/viewToken.js                AES-256-GCM view tokens for shareable links and /api/reports + /api/feed (shared by api/ and server.js)
lib/fetchReports.js             NSM search call + filtering logic (shared by api/ and server.js)
lib/cacheStore.js               Optional Postgres-backed NSM cache (used when DATABASE_URL is set - see README)
lib/buildFeed.js                Builds the RSS 2.0 XML for /api/feed (shared by api/ and server.js)
lib/sendNotification.js         Email sending via the Resend API (shared by api/ and server.js)
lib/basicAuth.js                HTTP Basic Auth check used by server.js (see "Authentication") - Vercel's middleware.js re-implements the same check separately
lib/watchlistStore.js           Postgres-backed shared company watchlist (DATABASE_URL) - now also stores each company's group tag
lib/subscriptionStore.js        Postgres-backed automatic email digest subscriptions - now also stores each subscription's keyword filter
lib/sendDigest.js               Builds/sends one email digest (category + keyword matching, HTML) - server.js only
lib/digestScheduler.js          Due-check/send loop for both email digests (runDueDigests) and push (runDuePush) - server.js only
lib/pushStore.js                Postgres-backed Web Push subscriptions (DATABASE_URL) - server.js only, no in-memory fallback (see "Push notifications")
lib/webPush.js                  Thin VAPID/web-push wrapper - sends one push notification, server.js only
lib/sendPush.js                 Checks one push subscription's watched companies/categories/keyword for anything new and sends a push if so
sw.js                            Service worker behind Web Push - handles 'push'/'notificationclick', nothing else (no offline caching)
middleware.js                   Vercel Edge Middleware - the Vercel-side half of "Authentication", gates every route before it reaches api/ or the static files
server.js                       Plain Node dev server (static files + /api/reports + /api/watchlist + /api/feed + /api/notify + /api/view + /api/companies + /api/subscriptions + /api/push/*)
config/watchlist.js             Default company list - seeds a fresh browser, and fallback for /api/reports called with no `leis` param
Dockerfile, .dockerignore       Fallback build path for Northflank (or anywhere else that wants a container) - see "Deploying (Northflank)"
gilt-ladder/                    Gilt Ladder, served by server.js at /gilt-ladder/ via gilt-ladder/router.js - self-contained, see gilt-ladder/README.md
```

Note: `/api/companies`, `/api/subscriptions*`, `/api/due-dates`,
`/api/calendar.ics`, and `/api/push/*` (sector/portfolio groups, automatic
email digests + keyword filter, filing due dates, the `.ics` calendar feed,
and push notifications respectively) only exist on `server.js` - unlike
`/api/reports`/`/api/feed`/`/api/notify`/`/api/view`, there is no matching
`api/*.js` file for a Vercel serverless deployment, since each needs either
a persistent database connection lifecycle or (push/digests) a long-running
process to schedule checks from, neither of which fits Vercel's per-request
serverless functions. A Vercel deployment still gets the core report list,
RSS feed, manual "Send Notification", and encrypted view links - just not
the shared watchlist, automatic digests, or push notifications. Multiple
watchlist views are unaffected either way, since they're entirely
client-side (`localStorage`, no API route at all).
