# RNS Update

A lightweight site that shows recent **financial report** RNS disclosures
(annual reports, final/interim results, etc.) for a watchlist of companies,
using the [Ticker API](https://developers.ticker.app/docs).

Static HTML/CSS/JS frontend + a small serverless function that calls Ticker
server-side, so the API key never reaches the browser.

## Setup

1. `cp .env.example .env` and set `TICKER_API_KEY` to your real key.
2. Edit `config/watchlist.js` to list the companies to track (ISIN + display name).
3. Run locally:
   ```
   npm start
   ```
   then open http://localhost:3000.

## Deploying (Vercel)

This repo needs no build step — Vercel's zero-config Node setup serves the
root static files and auto-detects `api/reports.js` as a serverless
function. Just import the repo into Vercel and set `TICKER_API_KEY` as an
environment variable in the project settings (Settings → Environment
Variables). Any other platform that runs a plain Node server also works via
`npm start`.

## Known limitations / things to verify

This was built without network access to `developers.ticker.app` or
`api.tickerapp.net` (blocked by the build environment's egress policy), so
only one endpoint and its auth header were confirmed:

```
GET https://api.tickerapp.net/v2/disclosures/sources/rns/items?pageSize=<n>
X-Api-Key: <your key>
```

Everything downstream of that — the exact field names for an item's ISIN,
title, category, date, and document URL — is guessed defensively in
`lib/fetchReports.js` (it tries several likely field names per value). Once
you run this with real network access:

- Open the "Raw JSON" panel at the bottom of the page (or call
  `/api/reports` directly) to see the actual fields Ticker returns for an
  item, and adjust `isinOf()` / `normalise()` in `lib/fetchReports.js` if
  the guesses were wrong.
- `FINANCIAL_REPORT_KEYWORDS` in the same file is a keyword heuristic for
  picking "financial report"-type disclosures out of the general RNS feed
  (which also carries trading updates, director dealings, AGM notices,
  etc.) — check it matches Ticker's actual category values and tighten it
  if needed.
- The fetch only pulls one page (`pageSize`, default 200, max 500) with no
  pagination — fine for a small watchlist's recent activity, but it won't
  surface older reports if `pageSize` isn't large enough. Check the docs for
  a pagination/cursor parameter if you need deeper history.
- If Ticker's API supports filtering by ISIN or category as query
  parameters, it would be more efficient to pass those directly instead of
  filtering client-side — worth checking the docs for.

## Project layout

```
index.html, style.css, app.js   Frontend (served as-is, no build step)
api/reports.js                  Vercel serverless function entrypoint
lib/fetchReports.js             Ticker API call + filtering logic (shared by api/ and server.js)
server.js                       Plain Node dev server (static files + /api/reports)
config/watchlist.js             Companies to track (ISIN + name)
```
