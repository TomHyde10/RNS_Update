# RNS Update

A lightweight site that shows company report disclosures for a time period
and set of report types you choose, for a list of companies you manage
yourself in the page — sourced directly from the FCA's **National Storage
Mechanism** (data.fca.org.uk), the UK regulator's public repository for
company disclosures. No API key, no account, no cost.

Static HTML/CSS/JS frontend + a small serverless function that proxies the
NSM search so the browser doesn't need to talk to it directly.

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
   beyond the defaults (LEI field, or the bulk ISIN box) are untouched by
   this and persist normally. The list otherwise lives in that browser's
   `localStorage`.
3. Under "Search settings", choose a **time period** (24 hours to 90 days)
   and the **report types** to match — a comma-separated list matched
   exactly against the filing's category (defaults to "Half-year Financial
   Report, Annual Financial Report"; try adding e.g. `Net Asset Value(s)` or
   `Dividend Declaration` to widen it, or clear the field and hit Apply to
   fall back to the default). These are also saved to `localStorage` and
   sent to `/api/reports` as `days` and `categories` query params.

`config/watchlist.js` serves two roles: it's what `/api/watchlist` seeds a
brand-new browser with (see above), and it's also the fallback `/api/reports`
itself falls back to when called with no `leis` query parameter (e.g.
hitting the API directly).

### Why LEI, not ISIN or ticker

The NSM has no ISIN field at all — filings are indexed by **LEI** (Legal
Entity Identifier, a 20-character code) and company name, confirmed from a
real search export. Rather than requiring everyone to look up LEIs by hand,
the "Add multiple companies by ISIN" box on the page resolves ISINs to LEIs
automatically via [GLEIF](https://www.gleif.org/en/lei-data/gleif-api)'s
free, public, keyless lookup API (`lib/resolveIsin.js`, `/api/resolve`) — a
genuinely documented API, unlike the NSM search itself. Paste one ISIN per
line (or comma/space-separated) and it adds each resolved company straight
to your watchlist, reporting per-ISIN failures (not found, GLEIF
unreachable, etc.) rather than failing the whole batch. You can still add a
company directly by LEI via the main form if you already know it.

### Email notifications

Each report in the list has a **Send Notification** button that emails a
summary of that report (company, title, type, publish date, link) on click.
It's manual/on-demand for now — nothing is sent automatically when a new
report appears.

Sending goes through standard SMTP via [nodemailer](https://nodemailer.com/)
(`lib/sendNotification.js`, `/api/notify`) — a genuinely documented,
well-established mechanism, unlike the NSM integration below. It's split
into two halves with different requirements:

- **Sending account (server-side, required):** `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL_FROM` — see `.env.example`. These
  are secrets, so they're only ever set as environment variables on
  whichever platform you deploy to (or your shell for local dev) — there's
  no UI for them, and nothing is hardcoded or committed to the repo. If any
  are missing, clicking the button shows an error naming which ones, rather
  than silently failing.
- **Recipient address (per-browser, no deployment step needed):** the first
  time you click Send Notification (or via the "Notification email" panel
  in the sidebar), an overlay asks for the email that should receive
  notifications and saves it to that browser's `localStorage` — it's then
  sent as `to` on every subsequent notify request from that browser. Setting
  `NOTIFY_EMAIL_TO` server-side is optional and only used as a fallback for
  a request that doesn't supply its own `to`.

Note this means the sending account credentials are still a hard requirement
regardless of the overlay — there is currently no way to configure those
through the UI, since they're secrets that shouldn't live in browser storage
or be resent with every request.

**The sending account and the recipient don't need to be related.** If your
recipient is an organisation mailbox that can't itself be used to send (e.g.
your Microsoft 365 admin hasn't enabled SMTP AUTH for it — see below), send
*through* a different account entirely and just set the recipient (via the
overlay, or `NOTIFY_EMAIL_TO`) to your org address. The email still lands in
your org inbox; only the outbound relay is a separate account.

This hasn't been exercised against a real SMTP server from this environment
(no network access here to verify it end-to-end) — the first real click
after you configure credentials is effectively the integration test.

#### Sending via SendGrid (recommended when your own mailbox can't send)

`render.yaml` pre-fills `SMTP_HOST=smtp.sendgrid.net`, `SMTP_PORT=587`, and
`SMTP_USER=apikey` (that's a literal fixed value SendGrid requires as the
username, not a placeholder — the real secret is the API key, which goes in
`SMTP_PASS`). Setup, one-time:

1. Sign up at [sendgrid.com](https://sendgrid.com) — the free tier covers
   100 emails/day, which is comfortably enough for a personal watchlist app.
2. **Verify a sender identity**: Settings → Sender Authentication → Single
   Sender Verification, and verify the address you want emails to appear
   *from* (click the confirmation link SendGrid emails to it). SendGrid
   refuses to send for an unverified `from` address, so this step is
   mandatory, not optional — you can't skip straight to creating an API key.
3. **Create an API key**: Settings → API Keys → Create API Key. Restricted
   Access with just "Mail Send" permission is enough; you don't need Full
   Access.
4. On Render (dashboard → your service → Environment, after the Blueprint
   deploys), set the two secrets it prompts for: `SMTP_PASS` = the API key
   from step 3, `NOTIFY_EMAIL_FROM` = the verified address from step 2.
5. In the app itself, set the recipient (Send Notification overlay, or the
   "Notification email" sidebar panel) to your organisation email address —
   that's independent of the SendGrid account and can be anything.

#### Sending via a Microsoft 365 / Outlook (organisation) mailbox instead

If you'd rather send *from* the org mailbox directly (not just receive into
it), swap `render.yaml`'s `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER` to
`smtp.office365.com` / `587` / your mailbox address, and know the most
common blocker first: Microsoft disabled basic SMTP AUTH tenant-wide by
default from late 2022 onward. If your organisation's admin hasn't
explicitly re-enabled "Authenticated SMTP" for your mailbox, every send
will fail with `535 5.7.139 Authentication unsuccessful` regardless of what
credentials you use — no client-side fix exists, it's a tenant/mailbox
setting only an Exchange admin can change. If your account also has MFA
enforced, a normal password won't authenticate either; you'd need an app
password, which itself requires per-user MFA and admin permission. This is
exactly the scenario SendGrid above sidesteps entirely.

## Deploying (Vercel)

This repo needs no build step — Vercel's zero-config Node setup serves the
root static files and auto-detects `api/reports.js` as a serverless
function. Just import the repo into Vercel — no environment variables
required.

## Deploying (Render)

`server.js` is a plain persistent Node server (not serverless functions), so
it maps directly onto a Render **Web Service** — Render doesn't need
`api/reports.js` at all, since `server.js` already serves `/api/reports`
itself. `render.yaml` in the repo root is a Blueprint for this: in the
Render dashboard, **New → Blueprint**, point it at this repo. It builds with
`npm install` and starts with `npm start`; Render sets `PORT` itself, which
`server.js` already reads. No environment variables required.

Without the blueprint, the same result comes from **New → Web Service** →
connect the repo → Build Command `npm install`, Start Command `npm start`.

## API integration notes

### GLEIF (ISIN → LEI resolution)

```
GET https://api.gleif.org/api/v1/lei-records?filter[isin]=<ISIN>
```

Confirmed from a real response: `data[0].attributes.lei` and
`data[0].attributes.entity.legalName.name`. One request per ISIN
(`resolveIsins()` in `lib/resolveIsin.js`) — this only runs when you
resolve companies to add, not on every report refresh, so the per-ISIN
request count is an acceptable tradeoff against guessing whether
`filter[isin]` accepts a comma-separated batch in one call (unconfirmed,
so not relied on). Unlike the NSM search below, this is a real documented
public API, so it's treated as comparatively solid ground.

### NSM search (reports)

This is **not a documented public API** — there is no official developer
API for the NSM. The request shape below was captured by watching the
actual browser network traffic on data.fca.org.uk (DevTools → Network tab)
while performing a real search, not from any published reference. That
means it could change, add rate limiting, or start blocking non-browser
traffic without notice, with no changelog to warn us. Treat this
integration as inherently more fragile than a documented API, and revisit
it if reports stop showing up.

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
  response where every hit matched the requested LEI. This is the opposite
  of what we found with Ticker's `isins` param, and it's why the app makes
  **one request per watched company** (`fetchForLei()` in
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
- **Each company's raw results are cached in memory** for `NSM_CACHE_TTL_MINUTES`
  (default 10, `fetchForLeiCached()` in `lib/fetchReports.js`) — a refresh
  within that window reuses the cached data instead of re-querying NSM, so
  with a 21-company watchlist a burst of refreshes costs 21 requests once,
  not 21 every time. Keyed only by LEI, not by the requested time
  period/report types, since those are both filtered afterwards against the
  same raw item list; a request needing a longer window than what's cached
  (a bigger `size`) is treated as a miss and re-fetched. This only helps on
  a persistent process (Render, local dev) — Vercel's serverless functions
  don't guarantee memory survives between invocations, so the cache is
  largely ineffective there. Set `NSM_CACHE_TTL_MINUTES=0` to disable it.
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
  for every watched company, un-truncated — safe to leave on since it's no
  longer a market-wide dump like the old Ticker version could produce, but
  a long time period with many watched companies could make it sizeable.
- **Report-type matching is exact and case-insensitive**, not a substring
  match — typing `Half-year` alone won't match `"Half-year Financial
  Report"`. Type (or paste) the full category name as it appears in a real
  filing.
- A stale browser `localStorage` entry from before the ISIN→LEI switch (an
  `isin` field instead of `lei`) is silently dropped on load rather than
  migrated, since there's no way to derive an LEI from an old ISIN entry
  automatically — see `loadWatchlist()` in `app.js`.

## Project layout

```
index.html, style.css, app.js   Frontend: LEI watchlist manager (localStorage) + reports list
api/reports.js                  Vercel serverless function: GET /api/reports
api/resolve.js                  Vercel serverless function: GET /api/resolve (ISIN -> LEI via GLEIF)
api/watchlist.js                Vercel serverless function: GET /api/watchlist (seeds a fresh browser)
api/notify.js                   Vercel serverless function: POST /api/notify (emails a report notification)
lib/fetchReports.js             NSM search call + filtering logic (shared by api/ and server.js)
lib/resolveIsin.js              GLEIF ISIN->LEI resolution (shared by api/ and server.js)
lib/sendNotification.js         SMTP email sending via nodemailer (shared by api/ and server.js)
server.js                       Plain Node dev server (static files + /api/reports + /api/resolve + /api/watchlist + /api/notify)
config/watchlist.js             Default company list - seeds a fresh browser, and fallback for /api/reports called with no `leis` param
```
