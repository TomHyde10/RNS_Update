# RNS Update

A lightweight site that shows **half-year and annual report** RNS
disclosures from the last 7 days, for a list of companies you manage
yourself in the page, using the [Ticker API](https://developers.ticker.app/docs).

Static HTML/CSS/JS frontend + a small serverless function that calls Ticker
server-side, so the API key never reaches the browser.

## Setup

1. `cp .env.example .env` and set `TICKER_API_KEY` to your real key.
2. Run locally:
   ```
   npm start
   ```
   then open http://localhost:3000.
3. Add companies to track using the ISIN field at the top of the page (an
   optional display name is stored alongside it). The list is kept in the
   browser's `localStorage`, per browser/device — there's no server-side
   watchlist to edit anymore.

`config/watchlist.js` still exists as a fallback: if `/api/reports` is
called with no `isins` query parameter (e.g. hitting the API directly), it
uses that file's list instead. The web UI always passes its own `isins`, so
editing that file has no effect on the page.

## Deploying (Vercel)

This repo needs no build step — Vercel's zero-config Node setup serves the
root static files and auto-detects `api/reports.js` as a serverless
function. Just import the repo into Vercel and set `TICKER_API_KEY` as an
environment variable in the project settings (Settings → Environment
Variables). Any other platform that runs a plain Node server also works via
`npm start`.

## Deploying (Render)

`server.js` is a plain persistent Node server (not serverless functions), so
it maps directly onto a Render **Web Service** — Render doesn't need
`api/reports.js` at all, since `server.js` already serves `/api/reports`
itself. `render.yaml` in the repo root is a Blueprint for this:

1. In the Render dashboard: **New → Blueprint**, point it at this repo. It
   will read `render.yaml` and create a Web Service with:
   - Build command: `npm install`
   - Start command: `npm start`
2. After the service is created, set `TICKER_API_KEY` under its
   **Environment** tab (the blueprint declares the var but marks it
   `sync: false`, so Render prompts you for the real value rather than
   storing it in the repo).
3. Render sets `PORT` itself; `server.js` already reads
   `process.env.PORT`, so no change is needed there.

Without the blueprint, the same result comes from **New → Web Service** →
connect the repo → Build Command `npm install`, Start Command `npm start`,
then add `TICKER_API_KEY` as an environment variable.

## API integration notes

Field names and the request/response shape are now taken from the official
Ticker API reference (https://developers.ticker.app/api-reference), not
guessed:

```
GET https://api.tickerapp.net/v2/disclosures/sources/rns/items?isins=<isin1,isin2>&pageSize=<n>&dateFrom=<yyyy-mm-dd>
x-api-key: <your key>
```

- ISINs from the page's `localStorage`-backed list are passed straight
  through via the `isins` query parameter, so Ticker does the filtering —
  the app never pulls a large page and filters client-side.
- `dateFrom` defaults to 7 days before the request (`defaultDateFrom()` in
  `lib/fetchReports.js`), so only the last week of disclosures is fetched.
- Item fields are read from the confirmed response shape: `headline`,
  `timestamp`, `issuer.name`, `issuer.instrument.isin`,
  `issuer.instrument.symbol.mnemonic`, and `category[].name`.
- Results are further filtered to half-year/annual reports only
  (`REPORT_KEYWORDS` in `lib/fetchReports.js`), matched against the headline
  and category name — see the caveat below.
- A `429` is reported distinctly (it can be either the per-second throttle
  or the weekly quota); one retry with backoff is attempted if the response
  carries a `Retry-After` header, otherwise the error is surfaced
  immediately rather than spinning against a quota that won't clear until
  the weekly reset.

### Still unconfirmed / worth checking once you have a real key

- **`publication` entry shape.** The reference response shows
  `"publication": [...]` without specifying the fields on each entry.
  `documentUrlOf()` in `lib/fetchReports.js` defensively tries
  `url`/`link`/`href`/`documentUrl`. Check the "Raw JSON" debug panel on the
  page and fix this lookup if the guess is wrong.
- **Half-year/annual report filtering** still matches on headline/category-name
  keywords (`REPORT_KEYWORDS` in `lib/fetchReports.js`) rather than
  the `fcaCategory`/`tickerCategory` codes, since the code-to-meaning mapping
  (e.g. which of `AA, BC, CS, CU, DD, DI, HO, ME, RE, TU, XX` means
  "results") isn't in the reference excerpt available. If you confirm the
  mapping, filtering via `fcaCategories`/`tickerCategories` server-side would
  be more efficient than the keyword heuristic.
- Only a single page is fetched (no `pageCursor` pagination) — fine for a
  small watchlist's recent activity, but deep history for an active issuer
  could span more than one page.

## Project layout

```
index.html, style.css, app.js   Frontend: ISIN watchlist manager (localStorage) + reports list
api/reports.js                  Vercel serverless function entrypoint
lib/fetchReports.js             Ticker API call + filtering logic (shared by api/ and server.js)
server.js                       Plain Node dev server (static files + /api/reports)
config/watchlist.js             Fallback ISIN list, used only when /api/reports is called with no `isins` param
```
