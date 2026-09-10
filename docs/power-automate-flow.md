# Power Automate: recurring RNS check → Outlook email

A native Power Automate cloud flow that re-implements this project's core
logic — the FCA NSM search, date/category filtering — directly as flow
actions, so it runs on a recurring schedule **without this Node app needing
to be deployed anywhere**. On each run it emails you (via Outlook) any
report matching your watched companies and categories since the last run.

This is a hand-authored build guide, not an importable flow package. There
is no way to test an actual Power Automate flow from this environment (no
network access to Power Automate's APIs, no PAC CLI), so every action below
is specified precisely enough to build in Studio, but **the first real run
is the actual integration test** — same caveat this project has carried for
every undocumented external API it touches.

## Before you start: licensing

**The built-in generic `HTTP` action is Premium-only** — it requires a
Power Automate Premium or Process license, not just a standard Microsoft
365 seat. If your tenant doesn't have that, adding the `HTTP` action in
Studio will show it flagged Premium and the flow won't run without a
license upgrade or admin-granted Process license. Check this before
building the rest — there's no free-tier workaround for calling an
arbitrary external REST API like the NSM search endpoint. (The `Office 365
Outlook` connector used later for sending the email is a standard
connector and needs no premium license.)

Sources: [Power Automate licensing FAQ](https://learn.microsoft.com/en-us/power-platform/admin/power-automate-licensing/faqs), [Microsoft Learn Q&A on HTTP action licensing](https://learn.microsoft.com/en-us/answers/questions/687015/which-license-do-i-need-to-use-an-http-action-and?page=1).

## What this deliberately doesn't replicate

This flow reuses only the verified NSM request/response shape from
`lib/fetchReports.js` — it does **not** replicate:
- Server-side NSM response caching (`fetchForLeiCached`) — not needed here
  since the flow itself only runs once per recurrence interval.
- The "seen reports" dedup used by the web app's NEW badge — this flow uses
  a simpler date-window approach instead (see "Deduplication" below), with
  a small known gap at run boundaries.
- PDF/document summarisation (the Summarise button, Claude API) — out of
  scope for this ask; the email links to each document instead of
  summarising it. Adding that later is a straightforward extra `HTTP`
  action per matched report calling the Claude API the same way
  `lib/summarise.js` does — ask if you want that built out too.
- Per-viewer settings (time period, category checkboxes) — this flow has
  one fixed schedule and one fixed category list, edited by changing the
  flow itself, not through any UI.

## Flow outline

```
Recurrence (trigger)
  → Initialize variables (LEIs, CompanyNames, WatchedCategories, WindowStart, WindowEndIso, MatchingReports)
  → Apply to each LEI in LEIs
      → HTTP: POST to the NSM search endpoint
      → Parse JSON
      → Apply to each hit in the response
          → Condition: within date window AND category matches
              → Append to array variable: MatchingReports
  → Condition: length(MatchingReports) > 0
      → Apply to each Report in MatchingReports
          → Append to string variable: EmailBodyHtml
      → Send an email (V2) [Office 365 Outlook]
```

## Step by step

### 1. Trigger: Recurrence

- **Interval**: `1`, **Frequency**: `Day` (or `Hour` if you want more
  frequent checks — just remember to keep step 5 in sync, see the warning
  there).
- Set a **Time zone** and **Start time** if you want it to fire at a
  specific time of day rather than relative to creation time.

### 2. Initialize variable — `LEIs` (Array)

Value (paste as-is — this is the exact LEI list from `config/watchlist.js`,
already resolved from your original ISIN list; two names are independently
confirmed, the rest are blank and will fall back to whatever NSM's own
`company` field returns):

```json
[
  "5299008VJFXCUD2EG312",
  "549300HV0VXCRONER808",
  "213800F3NOTF47H6AO55",
  "549300XODK7D2K2KYV43",
  "549300PXALXKUMU9JM18",
  "549300QNAI4XRPEB4G65",
  "5493007GCUW7G2BKY360",
  "549300UC0QPP7Y0W8056",
  "213800G37DCS3Q9IJM38",
  "529900S0Y9ZINCHB3O93",
  "5493007C3I0O5PJKR078",
  "549300NF03XVC5IFB447",
  "5493003YBCY4W1IMJU04",
  "549300TN1O5392UC4K19",
  "549300OMDPMJU23SSH75",
  "2138008U8QPGAESFYA48",
  "5493006R74BNJSJKCB17",
  "VLGEI9B8R0REWKB0LN95",
  "549300SSPK3AXNJOC673",
  "549300OPJXU72JMCYU09",
  "5493002NMTB70RZBXO96"
]
```

> As noted in `config/watchlist.js`, two of these (`549300HV0VXCRONER808` =
> Edinburgh Investment Trust, `549300UC0QPP7Y0W8056` = Fidelity European
> Trust) sat one position later than expected against the original ISIN
> list, hinting the list may not be a clean 1:1 match — this was never
> fully resolved. Check the first few emails against what you actually
> expect to see.

### 3. Initialize variable — `CompanyNames` (Object)

Used to show a friendly name in the email instead of a raw LEI when NSM's
own `company` field is blank. Extend this as you confirm more names.

```json
{
  "549300HV0VXCRONER808": "Edinburgh Investment Trust plc",
  "549300UC0QPP7Y0W8056": "Fidelity European Trust plc"
}
```

### 4. Initialize variable — `WatchedCategories` (Array)

```json
["Half-year Financial Report", "Annual Financial Report"]
```

Confirmed real values from a live NSM capture (see `lib/fetchReports.js`).
Matching in this flow is **case-sensitive exact match** — unlike the web
app's case-insensitive comparison — so type any additions exactly as NSM
returns them (e.g. `Net Asset Value(s)`, `Dividend Declaration`).

### 5. Initialize variable — `WindowStart` (String)

Expression (click the "fx" / expression editor, don't type this as literal
text):

```
subtractFromTime(utcNow(), 1, 'Day')
```

**⚠ This `1, 'Day'` must match your Recurrence interval from step 1.** If
you change the trigger to run every 6 hours, change this to
`subtractFromTime(utcNow(), 6, 'Hour')`. If they drift out of sync you'll
either miss reports (window shorter than the actual gap between runs) or
get duplicate emails (window longer than the gap).

### 6. Initialize variable — `WindowEndIso` (String)

Expression:

```
utcNow('yyyy-MM-ddTHH:mm:ssZ')
```

**This exact format matters.** `utcNow()` alone includes milliseconds
(e.g. `2026-09-10T13:45:00.4567Z`) — a real captured request against this
endpoint with a millisecond-bearing timestamp returned a 404 "Unable to
search the data" (see `toIsoNoMillis()` in `lib/fetchReports.js`, added
specifically to fix this). The custom format string above strips them.

### 7. Initialize variable — `MatchingReports` (Array)

Value: `[]`

### 8. Apply to each — `LEIs`

Input: `variables('LEIs')`

#### 8a. HTTP

- **Method**: `POST`
- **URI**: `https://api.data.fca.org.uk/search?index=nsm-search`
- **Headers**:
  ```json
  {
    "content-type": "application/json",
    "accept": "application/json, text/plain, */*",
    "origin": "https://data.fca.org.uk",
    "referer": "https://data.fca.org.uk/",
    "user-agent": "Mozilla/5.0 (compatible; PowerAutomate-RNS-Update/1.0)"
  }
  ```
- **Body** (use the expression editor for the two interpolated values —
  `@{items('Apply_to_each')}` is the current LEI, `@{variables('WindowEndIso')}`
  is from step 6):
  ```json
  {
    "from": 0,
    "size": 100,
    "sort": "submitted_date",
    "sortorder": "desc",
    "criteriaObj": {
      "criteria": [
        { "name": "company_lei", "value": ["", "@{items('Apply_to_each')}", "disclose_org", "related_org"] },
        { "name": "latest_flag", "value": "Y" }
      ],
      "dateCriteria": [
        { "name": "publication_date", "value": { "from": null, "to": "@{variables('WindowEndIso')}" } },
        { "name": "submitted_date", "value": { "from": null, "to": "@{variables('WindowEndIso')}" } }
      ]
    }
  }
  ```
  This is the exact request shape captured from a real browser session —
  including the unexplained `["", "<LEI>", "disclose_org", "related_org"]`
  array and `from: null` on both date criteria. This is an **undocumented,
  reverse-engineered API** (see `lib/fetchReports.js`'s comments) — it
  could change or start blocking non-browser traffic without notice, and
  deviating from this exact shape is what caused the 404 above. Treat it
  as fragile.
- **size: 100** assumes daily/near-daily runs (roughly 10-15 filings/week
  per company in the real capture, so 100 is comfortable headroom). If you
  lengthen the recurrence interval significantly, raise this.

#### 8b. Parse JSON

Content: `body('HTTP')`

Schema: use **"Generate from sample"** and paste a response shaped like
this (trimmed to the fields this flow actually reads — see `normalise()`
and `documentUrlOf()` in `lib/fetchReports.js` for where these field names
come from):

```json
{
  "hits": {
    "hits": [
      {
        "_source": {
          "lei": "549300HV0VXCRONER808",
          "company": "Edinburgh Investment Trust plc",
          "headline": "Half-year Report",
          "type": "Half-year Financial Report",
          "publication_date": "2026-09-01T09:00:00Z",
          "document_date": null,
          "submitted_date": "2026-09-01T09:00:00Z",
          "download_link": "some/relative/path.pdf",
          "html_link": null,
          "disclosure_id": "abc123",
          "_id": "xyz789"
        }
      }
    ]
  }
}
```

#### 8c. Apply to each — hits

Input: `body('Parse_JSON')?['hits']?['hits']`

##### Condition — within window and category matches

```
and(
  greaterOrEquals(
    coalesce(
      items('Apply_to_each_2')?['_source']?['publication_date'],
      items('Apply_to_each_2')?['_source']?['document_date'],
      items('Apply_to_each_2')?['_source']?['submitted_date']
    ),
    variables('WindowStart')
  ),
  contains(
    variables('WatchedCategories'),
    items('Apply_to_each_2')?['_source']?['type']
  )
)
```

(Rename `Apply_to_each_2` to whatever Studio actually names your inner
loop — it auto-numbers when you have two nested loops with the same
default name. Check the action's own name in the designer.)

##### If yes → Append to array variable: `MatchingReports`

Value (Compose the object first if you find that easier to read/debug,
then append the Compose output — or paste this expression directly into
the "Value" field):

```
{
  "company": coalesce(
    variables('CompanyNames')?[items('Apply_to_each_2')?['_source']?['lei']],
    items('Apply_to_each_2')?['_source']?['company'],
    items('Apply_to_each_2')?['_source']?['lei']
  ),
  "title": coalesce(
    items('Apply_to_each_2')?['_source']?['headline'],
    items('Apply_to_each_2')?['_source']?['type'],
    '(untitled)'
  ),
  "category": items('Apply_to_each_2')?['_source']?['type'],
  "publishedAt": coalesce(
    items('Apply_to_each_2')?['_source']?['publication_date'],
    items('Apply_to_each_2')?['_source']?['document_date'],
    items('Apply_to_each_2')?['_source']?['submitted_date']
  ),
  "url": if(
    not(empty(items('Apply_to_each_2')?['_source']?['download_link'])),
    concat('https://data.fca.org.uk/artefacts/', items('Apply_to_each_2')?['_source']?['download_link']),
    items('Apply_to_each_2')?['_source']?['html_link']
  )
}
```

This mirrors `normalise()` and `documentUrlOf()` in `lib/fetchReports.js`
field-for-field, including the same fallback order.

### 9. Condition — anything to send?

```
greater(length(variables('MatchingReports')), 0)
```

If false: nothing happens, matching the web app's own philosophy of only
notifying when there's actually something new.

#### If yes:

##### 9a. Initialize variable — `EmailBodyHtml` (String)

Value: `<ul>`

##### 9b. Apply to each — `MatchingReports`

Append to string variable `EmailBodyHtml`:

```
concat(
  '<li><b>', items('Apply_to_each_3')?['company'], '</b>: ',
  items('Apply_to_each_3')?['title'],
  ' (', items('Apply_to_each_3')?['category'], ') - ',
  formatDateTime(items('Apply_to_each_3')?['publishedAt'], 'dd MMM yyyy'),
  ' - <a href="', items('Apply_to_each_3')?['url'], '">View document</a></li>'
)
```

##### 9c. Append to string variable — `EmailBodyHtml`

Value: `</ul>`

##### 9d. Send an email (V2) — Office 365 Outlook

- **To**: your address
- **Subject**: expression `concat('RNS Update: ', string(length(variables('MatchingReports'))), ' new report(s)')`
- **Body**: `variables('EmailBodyHtml')` — set the body's format to HTML
  (the "..." menu on the Body field → "Enter raw text mode" is *off*, i.e.
  keep it in rich text/HTML mode) so the `<ul>`/`<li>`/`<a>` tags render.

This uses your own Microsoft 365 identity via OAuth — no SMTP, no app
password, no SMTP-AUTH tenant policy to fight, unlike a self-hosted email
setup would need.

## Deduplication

There's no persistent store here (no SharePoint list, no Dataverse) — the
date window in steps 5-6 is the entire dedup mechanism, matched to the
recurrence interval. This is simple and needs no extra setup, but has one
real gap: if a run is delayed or skipped (Power Automate throttling, a
connector outage), the fixed window doesn't expand to cover the gap, so a
report published during a missed run could be missed entirely rather than
just arriving late. For a personal watchlist checked daily this is a small
risk; if you want it eliminated, the standard fix is to persist the actual
last-successful-run timestamp somewhere (a one-row SharePoint list or a
small JSON file in OneDrive, read at the start of each run and written at
the end) instead of deriving the window from `utcNow()` — ask if you want
that built out.

## Testing

Power Automate lets you **Save** and then **Test → Manually** run the flow
immediately rather than waiting for the schedule, and the run history shows
each action's actual input/output — use that to check the HTTP action's
raw response the first few times, the same way this project's own
development relied on real captured responses rather than guessing at the
NSM API's shape.
