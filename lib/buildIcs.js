// Builds an RFC 5545 iCalendar (.ics) feed superimposing recent filings and
// estimated Half-year/Annual due dates for a set of companies - the same
// two sources the in-app filing calendar overlay uses (see app.js's
// loadCalendarData()), but as a feed any calendar app (Google/Outlook/Apple
// Calendar) can subscribe to and poll on its own schedule - the same "let
// an existing tool do the polling" idea as the RSS feed (lib/buildFeed.js),
// just landing in a calendar instead of a feed reader.

// RFC 5545 §3.1: content lines SHOULD be folded at 75 octets, continued by
// a CRLF followed by a single leading space. Not every real calendar client
// enforces this, but it's cheap to do correctly rather than rely on every
// consumer being lenient about an overlong line.
const FOLD_LIMIT = 75;

function foldLine(line) {
  if (line.length <= FOLD_LIMIT) return line;
  let out = line.slice(0, FOLD_LIMIT);
  let rest = line.slice(FOLD_LIMIT);
  while (rest.length > 0) {
    // One less than the limit, since the leading continuation space itself
    // counts towards each folded line's own 75-octet budget.
    out += `\r\n ${rest.slice(0, FOLD_LIMIT - 1)}`;
    rest = rest.slice(FOLD_LIMIT - 1);
  }
  return out;
}

// TEXT-value escaping per RFC 5545 §3.3.11 - backslash, semicolon, comma,
// and newline all need escaping. Unrelated to (and much simpler than)
// lib/buildFeed.js's XML escaping, so deliberately not shared with it.
function escapeIcsText(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// All-day DATE value (YYYYMMDD) in UTC - a filing's "day" is what matters
// here, not a specific time, so there's no timezone conversion to get
// wrong by picking UTC over local time.
function toIcsDate(iso) {
  // `new Date(null)` and `new Date(undefined)` behave differently (epoch
  // vs Invalid Date) - reject both explicitly up front rather than relying
  // on Number.isNaN alone to catch every falsy input.
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function toIcsTimestamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

// `now` is injectable for tests (DTSTAMP is otherwise always "right now",
// which a test can't assert an exact value against).
function buildEvent({ uid, dateIso, summary, description, url }, now = new Date()) {
  const dtStart = toIcsDate(dateIso);
  if (!dtStart) return null;

  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${toIcsTimestamp(now)}`,
    `DTSTART;VALUE=DATE:${dtStart}`,
    `SUMMARY:${escapeIcsText(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (url) lines.push(`URL:${escapeIcsText(url)}`);
  lines.push('END:VEVENT');
  return lines;
}

// `reports` - normalised fetchReports() reports (lei/company/title/
// category/publishedAt/url/id), one VEVENT per filing on the day it
// published. `dueInfo` - lib/dueDates.js's computeDueInfo() output, keyed
// by lei; one VEVENT per category per company that has an estimate,
// whether it's already passed (overdue) or still ahead - matching the
// in-app calendar's own "show it either way" behaviour. `namesByLei` -
// Map(lei -> display name), since computeDueInfo() itself only knows
// LEIs, not names.
function buildIcsFeed({ reports, dueInfo, namesByLei, calendarName, now = new Date() }) {
  const nameFor = (lei) => (namesByLei && namesByLei.get(lei)) || lei;
  const events = [];

  for (const r of reports || []) {
    const event = buildEvent({
      uid: `filed-${r.id || `${r.lei}-${r.title}-${r.publishedAt}`}@rns-update`,
      dateIso: r.publishedAt,
      summary: `${r.company}: ${r.title}`,
      description: r.category || '',
      url: r.url,
    }, now);
    if (event) events.push(...event);
  }

  for (const [lei, info] of Object.entries(dueInfo || {})) {
    for (const [key, label] of [['halfYear', 'Half-year Financial Report'], ['annual', 'Annual Financial Report']]) {
      const entry = info[key];
      if (!entry || !entry.dueDate) continue;
      const event = buildEvent({
        uid: `due-${lei}-${key}@rns-update`,
        dateIso: entry.dueDate,
        summary: `Est. ${label} due - ${nameFor(lei)}`,
        description: `Estimated from this company's own past filing pattern and the FCA's usual reporting deadlines - not a confirmed date. Status: ${entry.status}.`,
      }, now);
      if (event) events.push(...event);
    }
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RNS Update//Filing Calendar//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(calendarName || 'RNS Update')}`,
    // Both forms exist because calendar clients don't agree on which one
    // they honour - neither is universally supported, so a subscriber may
    // still poll more (or less) often than this regardless.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
    ...events,
    'END:VCALENDAR',
  ];

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = { buildIcsFeed, escapeIcsText, foldLine, toIcsDate };
