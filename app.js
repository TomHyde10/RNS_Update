const STORAGE_KEY = 'rns-watchlist';
const SETTINGS_KEY = 'rns-settings';
const SEEN_KEY = 'rns-seen-reports';
const HISTORY_CACHE_KEY = 'rns-history-cache';
const DUE_DATES_CACHE_KEY = 'rns-due-dates-cache';
const SORT_KEY = 'rns-sort';
const THEME_KEY = 'rns-theme';
const NOTIFY_EMAIL_KEY = 'rns-notify-email';
const WATCHLIST_COLLAPSED_KEY = 'rns-watchlist-collapsed';
const SETTINGS_COLLAPSED_KEY = 'rns-settings-collapsed';
const SIDEBAR_WIDTH_KEY = 'rns-sidebar-width';
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;
const LEI_RE = /^[A-Z0-9]{20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report'];
const KNOWN_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report', 'Net Asset Value(s)', 'Dividend Declaration', 'Portfolio Update', 'Miscellaneous'];
const MAX_SEEN = 1000;
const SORT_OPTIONS = ['date-desc', 'date-asc', 'company-asc', 'company-desc'];
const THEME_OPTIONS = ['auto', 'light', 'dark'];
// Same TTL philosophy as the server's NSM cache (NSM_CACHE_TTL_MINUTES) but
// entirely client-side: re-opening the same company's history within this
// window reuses what's already in localStorage instead of hitting
// /api/reports (and, on a cache miss server-side, the NSM API behind it)
// again. Independent of the server cache - this is about avoiding the round
// trip from the browser at all, not just avoiding the upstream NSM call.
const HISTORY_CACHE_TTL_MINUTES = 10;
const HISTORY_CACHE_TTL_MS = HISTORY_CACHE_TTL_MINUTES * 60 * 1000;
// Entries older than this are dropped on save even if never re-requested,
// so removing a company from your watchlist doesn't leave its history
// cached in localStorage forever.
const HISTORY_CACHE_PRUNE_MS = 24 * 60 * 60 * 1000;
// Due status changes at most daily (it's derived from filing dates, not
// anything minute-to-minute), so this is much longer-lived than the
// history cache above - no point re-checking every page load.
const DUE_DATES_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let lastReports = [];
let lastNewKeys = new Set();
let autoRefreshTimer = null;
let dueInfoByLei = {};
let currentHistoryLei = null;
let currentHistoryName = null;
let currentHistoryItems = [];

// Where the watchlist actually lives: 'server' once DATABASE_URL is set on
// this deployment (shared across every visitor, survives everything - see
// lib/watchlistStore.js), or 'local' (this browser's localStorage only)
// otherwise. Decided once at startup by initWatchlist() below.
// loadWatchlist() itself stays a plain synchronous read of this in-memory
// cache regardless of backend, so the many existing call sites throughout
// this file don't need to change - only the handful of functions that
// populate or persist it do (this block, plus initWatchlist()).
let watchlistCache = [];
let watchlistBackend = 'local';

function loadWatchlist() {
  return watchlistCache;
}

// Drops entries left over from before the ISIN->LEI rename (they carry an
// `isin` field instead of `lei` and would otherwise render as
// "(undefined)" with no way to recover the LEI automatically) or any other
// entry missing a validly-formed LEI.
function cleanWatchlist(list) {
  return Array.isArray(list) ? list.filter((c) => c && typeof c.lei === 'string' && LEI_RE.test(c.lei.toUpperCase())) : [];
}

function loadWatchlistFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return cleanWatchlist(raw ? JSON.parse(raw) : []);
  } catch {
    return [];
  }
}

// Full-list replace either way, matching lib/watchlistStore.js's
// replaceCompanies() contract exactly: every caller already follows
// "load the list, mutate it locally, call saveWatchlist(list) with the
// whole thing" (add/rename/toggle/remove/bulk-add/import alike), so this
// is the only function that needed to become backend-aware - none of
// those callers had to change.
function saveWatchlist(list) {
  watchlistCache = list;
  if (watchlistBackend === 'server') {
    fetch('/api/companies', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: list }),
    }).catch((err) => console.error('Failed to save watchlist:', err));
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }
}

// Decides which backend the watchlist lives in and populates the initial
// in-memory cache from it, then merges in the server's default companies
// (see mergeDefaultsIntoWatchlist below) exactly as before.
async function initWatchlist() {
  try {
    const res = await fetch('/api/companies');
    const { ok, data } = await parseJsonResponse(res);
    if (ok && data.enabled) {
      watchlistBackend = 'server';
      watchlistCache = cleanWatchlist(data.companies);

      // First time this deployment's database is used, migrate whatever
      // this browser already had in localStorage instead of silently
      // starting the shared list empty.
      if (watchlistCache.length === 0) {
        const local = loadWatchlistFromLocalStorage();
        if (local.length > 0) saveWatchlist(local);
      }
    } else {
      watchlistBackend = 'local';
      watchlistCache = loadWatchlistFromLocalStorage();
    }
  } catch {
    watchlistBackend = 'local';
    watchlistCache = loadWatchlistFromLocalStorage();
  }

  await mergeDefaultsIntoWatchlist();
}

// Ensures the server's default companies (config/watchlist.js, via
// /api/watchlist) are present every time the page starts up, not just on
// first visit - any missing default is merged back in on every load, so
// removing one via the UI only lasts until the next reload. Companies
// you've added beyond the defaults are left untouched either way. If the
// fetch fails, this just leaves the watchlist as initWatchlist() already
// found it.
async function mergeDefaultsIntoWatchlist() {
  try {
    const res = await fetch('/api/watchlist');
    if (!res.ok) return;

    const data = await res.json();
    const companies = Array.isArray(data.companies) ? data.companies : [];
    const defaults = companies
      .filter((c) => c && typeof c.lei === 'string' && LEI_RE.test(c.lei.toUpperCase()))
      .map((c) => ({ lei: c.lei.toUpperCase(), name: (c.name || '').trim() }));

    const existing = loadWatchlist();
    const existingLeis = new Set(existing.map((c) => c.lei));
    const merged = existing.slice();

    for (const d of defaults) {
      if (!existingLeis.has(d.lei)) {
        merged.push(d);
        existingLeis.add(d.lei);
      }
    }

    if (merged.length !== existing.length) saveWatchlist(merged);
  } catch {
    // Leave the watchlist as-is - proceed with whatever's already there.
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const days = parseInt(parsed.days, 10);
    const categories = Array.isArray(parsed.categories) && parsed.categories.length ? parsed.categories : DEFAULT_CATEGORIES;
    const autoRefreshMinutes = [0, 5, 15, 30].includes(parseInt(parsed.autoRefreshMinutes, 10))
      ? parseInt(parsed.autoRefreshMinutes, 10)
      : 0;
    const keyword = typeof parsed.keyword === 'string' ? parsed.keyword.trim() : '';
    return { days: Number.isNaN(days) ? 7 : days, categories, autoRefreshMinutes, keyword };
  } catch {
    return { days: 7, categories: DEFAULT_CATEGORIES, autoRefreshMinutes: 0, keyword: '' };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// Tracks which reports have already been shown, so a later load can flag
// only genuinely new ones instead of re-highlighting the whole list every
// time. Keyed by the report's own id when present, falling back to a
// composite of fields that should be stable for the same filing.
function reportKey(r) {
  return r.id || `${r.lei}|${r.title}|${r.publishedAt}`;
}

// Where "seen" state actually lives: 'server' once DATABASE_URL is set on
// this deployment (shared across every visitor, so a "New" badge reflects
// what the team has seen, not just this one browser - see
// lib/seenStore.js), or 'local' (this browser's localStorage only)
// otherwise. Decided once at startup by initSeenBackend() below, unlike
// the watchlist there's no in-memory cache to keep in sync - loadSeen()/
// saveSeen() are only ever used from the one async loadReports() flow, so
// they can just stay async themselves rather than needing that pattern.
let seenBackend = 'local';

async function initSeenBackend() {
  try {
    const res = await fetch('/api/seen');
    const { ok, data } = await parseJsonResponse(res);
    seenBackend = ok && data.enabled ? 'server' : 'local';
  } catch {
    seenBackend = 'local';
  }
}

function loadSeenFromLocalStorage() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

async function loadSeen() {
  if (seenBackend !== 'server') return loadSeenFromLocalStorage();
  try {
    const res = await fetch('/api/seen');
    const { ok, data } = await parseJsonResponse(res);
    if (ok) return new Set(data.keys);
  } catch {
    // A transient network hiccup shouldn't make everything look "new" -
    // fall back to whatever this browser already has cached locally.
  }
  return loadSeenFromLocalStorage();
}

// `newKeys` is just the reports currently on screen, not an accumulated
// history - additive either way (server: INSERT ... ON CONFLICT DO
// NOTHING; local: merged into `previousSet`, then capped) - so the caller
// never has to compute the full merged set itself.
async function saveSeen(newKeys, previousSet) {
  if (seenBackend === 'server') {
    if (newKeys.length === 0) return;
    try {
      await fetch('/api/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: newKeys }),
      });
    } catch (err) {
      console.error('Failed to save seen reports:', err);
    }
    return;
  }

  const merged = new Set(previousSet);
  for (const key of newKeys) merged.add(key);
  // Cap so this can't grow unbounded over months of use - Set iteration
  // preserves insertion order, so slicing from the end keeps the most
  // recently seen entries.
  localStorage.setItem(SEEN_KEY, JSON.stringify([...merged].slice(-MAX_SEEN)));
}

function loadSort() {
  const v = localStorage.getItem(SORT_KEY);
  return SORT_OPTIONS.includes(v) ? v : 'date-desc';
}

function saveSort(v) {
  localStorage.setItem(SORT_KEY, v);
}

function sortReports(reports, sortBy) {
  const arr = reports.slice();
  switch (sortBy) {
    case 'date-asc':
      arr.sort((a, b) => new Date(a.publishedAt || 0) - new Date(b.publishedAt || 0));
      break;
    case 'company-asc':
      arr.sort((a, b) => a.company.localeCompare(b.company));
      break;
    case 'company-desc':
      arr.sort((a, b) => b.company.localeCompare(a.company));
      break;
    case 'date-desc':
    default:
      arr.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  }
  return arr;
}

function loadTheme() {
  const t = localStorage.getItem(THEME_KEY);
  return THEME_OPTIONS.includes(t) ? t : 'auto';
}

function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function initTheme() {
  const select = document.getElementById('theme-select');
  const theme = loadTheme();
  select.value = theme;
  applyTheme(theme);
  select.addEventListener('change', () => {
    localStorage.setItem(THEME_KEY, select.value);
    applyTheme(select.value);
  });
}

// The Companies panel is a <details> element so it can be collapsed once a
// watchlist is set up and rarely needs editing - state persisted the same
// way as the other small UI preferences above (theme, sort, etc.).
function initWatchlistCollapse() {
  const details = document.getElementById('watchlist-manager');
  details.open = localStorage.getItem(WATCHLIST_COLLAPSED_KEY) !== 'true';
  details.addEventListener('toggle', () => {
    localStorage.setItem(WATCHLIST_COLLAPSED_KEY, String(!details.open));
  });
}

// Search settings is a <details> element too, but collapsed by default
// (unlike Companies above) since it's set up once and rarely revisited -
// only stays open across reloads once the user has explicitly opened it.
function initSettingsCollapse() {
  const details = document.getElementById('settings-manager');
  details.open = localStorage.getItem(SETTINGS_COLLAPSED_KEY) === 'false';
  details.addEventListener('toggle', () => {
    localStorage.setItem(SETTINGS_COLLAPSED_KEY, String(!details.open));
  });
}

// Drag handle between the sidebar and the reports table - width is a CSS
// custom property on .layout (see style.css) rather than a class/inline
// width on .sidebar itself, so both the sidebar and the drag handle's own
// grid column move together from one source of truth. Persisted per
// browser like the other small UI preferences (theme, collapse state).
function initSidebarResize() {
  const layoutEl = document.querySelector('.layout');
  const resizer = document.getElementById('sidebar-resizer');
  if (!layoutEl || !resizer) return;

  let width = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
  if (Number.isNaN(width)) width = SIDEBAR_WIDTH_DEFAULT;

  function applyWidth(px) {
    width = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, px));
    layoutEl.style.setProperty('--sidebar-width', `${width}px`);
  }

  applyWidth(width);

  let dragging = false;

  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applyWidth(e.clientX - layoutEl.getBoundingClientRect().left);
  });

  function stopDragging() {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }
  resizer.addEventListener('pointerup', stopDragging);
  resizer.addEventListener('pointercancel', stopDragging);

  // Keyboard equivalent for the drag - the resizer is a focusable
  // role="separator", the standard pattern for an accessible splitter.
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    applyWidth(width + (e.key === 'ArrowRight' ? 16 : -16));
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    e.preventDefault();
  });
}

function getNotifyEmail() {
  return (localStorage.getItem(NOTIFY_EMAIL_KEY) || '').trim();
}

function setNotifyEmail(email) {
  localStorage.setItem(NOTIFY_EMAIL_KEY, email.trim());
}

// Shows the "where should notifications go?" overlay. Resolves with the
// saved email on Save, or null on Cancel - the caller decides what to do
// with either outcome (e.g. proceed to send, or just leave settings as-is).
function openNotifyEmailOverlay() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('notify-email-overlay');
    const form = document.getElementById('notify-email-form');
    const input = document.getElementById('notify-email-input');
    const errorEl = document.getElementById('notify-email-error');
    const cancelBtn = document.getElementById('notify-email-cancel');

    input.value = getNotifyEmail();
    errorEl.hidden = true;
    overlay.hidden = false;
    input.focus();

    function cleanup() {
      overlay.hidden = true;
      form.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
    }

    function onSubmit(e) {
      e.preventDefault();
      const email = input.value.trim();
      if (!EMAIL_RE.test(email)) {
        errorEl.textContent = 'That doesn\'t look like a valid email address.';
        errorEl.hidden = false;
        return;
      }
      setNotifyEmail(email);
      cleanup();
      resolve(email);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    form.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Per-company filing history cache, keyed by LEI: { [lei]: { items,
// fetchedAt } }. Reused by openHistoryOverlay() to avoid re-fetching
// /api/reports every time the same company's history is opened.
function loadHistoryCache() {
  try {
    const raw = localStorage.getItem(HISTORY_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveHistoryCache(cache) {
  const now = Date.now();
  const pruned = {};
  for (const [lei, entry] of Object.entries(cache)) {
    if (entry && now - entry.fetchedAt < HISTORY_CACHE_PRUNE_MS) pruned[lei] = entry;
  }
  localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(pruned));
}

function loadDueDatesCache() {
  try {
    const raw = localStorage.getItem(DUE_DATES_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && parsed.dueInfo ? parsed : null;
  } catch {
    return null;
  }
}

// checkedLeis is stored alongside dueInfo (which - see lib/dueDates.js -
// omits a LEI entirely when it genuinely has no matching filings, the same
// shape as "never checked at all") so a newly-added company can be told
// apart from one that was already checked and came back with nothing.
function saveDueDatesCache(dueInfo, checkedLeis) {
  localStorage.setItem(DUE_DATES_CACHE_KEY, JSON.stringify({ dueInfo, checkedLeis, fetchedAt: Date.now() }));
}

// Checks every enabled watchlist company's Half-year/Annual Financial
// Report status (see lib/dueDates.js) - cached client-side since this
// changes at most daily, so a normal page reload doesn't re-check it every
// time. Not awaited from the startup sequence: this is a nice-to-have
// indicator, not something the main report list should ever wait on.
async function checkDueDates({ force = false } = {}) {
  const enabledLeis = loadWatchlist().filter(isCompanyEnabled).map((c) => c.lei);
  if (enabledLeis.length === 0) {
    dueInfoByLei = {};
    renderDueDatesPill();
    return;
  }

  const cached = loadDueDatesCache();
  const cacheCoversWatchlist = cached && enabledLeis.every((lei) => (cached.checkedLeis || []).includes(lei));
  if (!force && cacheCoversWatchlist && Date.now() - cached.fetchedAt < DUE_DATES_CACHE_TTL_MS) {
    dueInfoByLei = cached.dueInfo;
    renderDueDatesPill();
    return;
  }

  try {
    const res = await fetch(`/api/due-dates?leis=${encodeURIComponent(enabledLeis.join(','))}`);
    const { ok, data } = await parseJsonResponse(res);
    if (!ok) return; // silently skip - this is a bonus indicator, not core functionality

    dueInfoByLei = data.dueInfo || {};
    saveDueDatesCache(dueInfoByLei, enabledLeis);
    renderDueDatesPill();
  } catch {
    // Same reasoning as above - a failed due-date check shouldn't surface
    // as an error anywhere the main report list is concerned with.
  }
}

// Flattens dueInfoByLei into one row per flagged (due-soon/overdue)
// report type, worst-first, with the company name resolved from the
// current watchlist for display.
function flaggedDueDates() {
  const namesByLei = new Map(loadWatchlist().map((c) => [c.lei, c.name || c.lei]));
  const rows = [];
  for (const [lei, info] of Object.entries(dueInfoByLei)) {
    for (const [key, label] of [['annual', 'Annual Financial Report'], ['halfYear', 'Half-year Financial Report']]) {
      const entry = info[key];
      if (entry && (entry.status === 'overdue' || entry.status === 'due-soon')) {
        rows.push({ lei, name: namesByLei.get(lei) || lei, reportType: label, status: entry.status, lastFiledAt: entry.lastFiledAt });
      }
    }
  }
  rows.sort((a, b) => (a.status === b.status ? 0 : a.status === 'overdue' ? -1 : 1));
  return rows;
}

function renderDueDatesPill() {
  const pill = document.getElementById('due-dates-pill');
  const rows = flaggedDueDates();
  if (rows.length === 0) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.textContent = `⚠ ${rows.length} overdue/due soon`;
}

function renderDueDatesOverlay() {
  const listEl = document.getElementById('due-dates-list');
  const rows = flaggedDueDates();

  listEl.innerHTML = '';
  if (rows.length === 0) {
    listEl.innerHTML = '<li class="hint">Nothing flagged right now.</li>';
    return;
  }

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'due-dates-row';
    const lastFiled = row.lastFiledAt ? new Date(row.lastFiledAt).toLocaleDateString() : 'never seen';
    li.innerHTML = `
      <span class="due-dates-status due-dates-status-${row.status}">${row.status === 'overdue' ? 'Overdue' : 'Due soon'}</span>
      <span class="due-dates-name">${escapeHtml(row.name)}</span>
      <span class="due-dates-type">${escapeHtml(row.reportType)} - last filed ${escapeHtml(lastFiled)}</span>
    `;
    li.addEventListener('click', () => {
      document.getElementById('due-dates-overlay').hidden = true;
      openHistoryOverlay(row.lei, row.name);
    });
    listEl.appendChild(li);
  }
}

document.getElementById('due-dates-pill').addEventListener('click', () => {
  renderDueDatesOverlay();
  document.getElementById('due-dates-overlay').hidden = false;
});

document.getElementById('due-dates-close').addEventListener('click', () => {
  document.getElementById('due-dates-overlay').hidden = true;
});

// Filing calendar: a month grid superimposing recent filings and estimated
// Half-year/Annual due dates (see lib/dueDates.js) for a user-editable
// subset of the watchlist - independent of the main report list's own
// day-window/category settings, and independent of a company's "enabled"
// checkbox in Edit companies (a company can be watched here without being
// part of the active search). Which trusts are shown persists in
// localStorage across sessions; which month is displayed does not.
const CALENDAR_TRUSTS_KEY = 'rns-calendar-trusts';
let calendarSelectedLeis = new Set();
let calendarMonth = new Date();
let calendarItemsByLei = {}; // lei -> this company's own filing history (all categories)
let calendarDueInfoByLei = {}; // lei -> { halfYear, annual } (see lib/dueDates.js's computeDueInfo)

function loadCalendarTrusts() {
  try {
    const raw = localStorage.getItem(CALENDAR_TRUSTS_KEY);
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function saveCalendarTrusts() {
  localStorage.setItem(CALENDAR_TRUSTS_KEY, JSON.stringify([...calendarSelectedLeis]));
}

// Only runs once, at startup - a saved selection (even an empty one, from
// clicking "None") is always honoured as-is from then on; only a browser
// that has never opened the calendar at all gets the "every currently
// enabled company" default.
function initCalendarTrusts() {
  const saved = loadCalendarTrusts();
  calendarSelectedLeis = saved || new Set(loadWatchlist().filter(isCompanyEnabled).map((c) => c.lei));
}

// Same cache (localStorage, keyed by LEI, see loadHistoryCache()/
// saveHistoryCache() above) the filing history overlay uses, and the same
// "last 365 days, every category" request shape - a trust already opened in
// its own history view is very likely already cached here as a result, and
// vice versa. A failed fetch falls back to whatever's cached (even if
// stale) rather than showing nothing, and never throws - one bad LEI
// shouldn't blank out every other selected trust's calendar entries.
async function fetchCompanyHistoryItems(lei, { force = false } = {}) {
  const cache = loadHistoryCache();
  const cached = cache[lei];
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < HISTORY_CACHE_TTL_MS) return cached.items;

  try {
    const query = await viewQueryString({ leis: lei, days: '365' });
    const res = await fetch(`/api/reports?${query}`);
    const { ok, data } = await parseJsonResponse(res);
    if (!ok) return cached ? cached.items : [];

    const items = (data.scannedItems || []).slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    cache[lei] = { items, fetchedAt: now };
    saveHistoryCache(cache);
    return items;
  } catch {
    return cached ? cached.items : [];
  }
}

async function loadCalendarData() {
  const statusEl = document.getElementById('calendar-status');
  const leis = [...calendarSelectedLeis];

  if (leis.length === 0) {
    calendarItemsByLei = {};
    calendarDueInfoByLei = {};
    statusEl.hidden = false;
    statusEl.textContent = 'No trusts selected - tick at least one on the left.';
    return;
  }

  statusEl.hidden = false;
  statusEl.textContent = 'Loading…';
  try {
    const [itemsPerLei, dueResult] = await Promise.all([
      Promise.all(leis.map((lei) => fetchCompanyHistoryItems(lei))),
      fetch(`/api/due-dates?leis=${encodeURIComponent(leis.join(','))}`)
        .then(parseJsonResponse)
        .catch(() => ({ ok: false, data: {} })),
    ]);

    calendarItemsByLei = {};
    leis.forEach((lei, i) => { calendarItemsByLei[lei] = itemsPerLei[i]; });
    calendarDueInfoByLei = (dueResult.ok && dueResult.data.dueInfo) || {};
    statusEl.hidden = true;
  } catch (err) {
    statusEl.hidden = false;
    statusEl.textContent = `Failed to load: ${err.message || err}`;
  }
}

function calendarDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// One entry per (trust, day) - a real filing on the day it published, or an
// estimated due date (Half-year/Annual only) on the day it's estimated for,
// whether that's already in the past (overdue) or still ahead. Grouped by
// day key for O(1) lookup while building the grid below.
function buildCalendarDayEvents() {
  const byDay = new Map();
  const namesByLei = new Map(loadWatchlist().map((c) => [c.lei, c.name || c.lei]));

  const addEvent = (date, event) => {
    if (!date || Number.isNaN(date.getTime())) return;
    const key = calendarDayKey(date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(event);
  };

  for (const lei of calendarSelectedLeis) {
    const name = namesByLei.get(lei) || lei;

    for (const item of calendarItemsByLei[lei] || []) {
      addEvent(item.publishedAt ? new Date(item.publishedAt) : null, {
        type: 'filed', lei, name, category: item.type, url: item.url,
      });
    }

    const due = calendarDueInfoByLei[lei];
    if (!due) continue;
    for (const [key, label] of [['halfYear', 'Half-year Financial Report'], ['annual', 'Annual Financial Report']]) {
      const entry = due[key];
      if (entry && entry.dueDate) {
        addEvent(new Date(entry.dueDate), { type: 'due', lei, name, category: label, status: entry.status });
      }
    }
  }
  return byDay;
}

// Renders the currently selected month only - Monday-start (weekday header
// is static markup in index.html), padded with the trailing days of the
// previous/next month so every week row is a full 7 days.
function renderCalendarGrid() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  document.getElementById('calendar-month-label').textContent = calendarMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const byDay = buildCalendarDayEvents();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0..Sun=6
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const today = new Date();

  const gridEl = document.getElementById('calendar-grid');
  gridEl.innerHTML = '';

  const maxShown = 3;
  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(year, month, i - firstWeekday + 1);
    const inMonth = cellDate.getMonth() === month;
    const events = byDay.get(calendarDayKey(cellDate)) || [];
    const shown = events.slice(0, maxShown);

    const cell = document.createElement('div');
    cell.className = `calendar-cell${inMonth ? '' : ' calendar-cell-out'}${inMonth && cellDate.toDateString() === today.toDateString() ? ' calendar-cell-today' : ''}`;
    cell.innerHTML = `
      <span class="calendar-cell-date">${cellDate.getDate()}</span>
      <div class="calendar-cell-events">
        ${shown.map((e) => `
          <button type="button" class="calendar-event" data-lei="${escapeHtml(e.lei)}" data-name="${escapeHtml(e.name)}" title="${escapeHtml(e.name)} - ${escapeHtml(e.category || '')}${e.type === 'due' ? ' (estimated)' : ''}">
            <span class="calendar-dot calendar-dot-${e.type === 'due' ? 'due' : 'filed'}"></span>${escapeHtml(e.name)}
          </button>
        `).join('')}
        ${events.length > maxShown ? `<span class="calendar-more">+${events.length - maxShown} more</span>` : ''}
      </div>
    `;
    gridEl.appendChild(cell);
  }

  // Opens that trust's full history, same as clicking a due-dates-overlay
  // row does - closes this overlay first rather than stacking, since
  // there's nothing left to do here once you've jumped to one trust's
  // detail view.
  gridEl.querySelectorAll('.calendar-event').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('calendar-overlay').hidden = true;
      openHistoryOverlay(btn.dataset.lei, btn.dataset.name);
    });
  });
}

function renderCalendarTrustsList() {
  const listEl = document.getElementById('calendar-trusts-list');
  const watchlist = loadWatchlist();

  listEl.innerHTML = '';
  if (watchlist.length === 0) {
    listEl.innerHTML = '<li class="hint">Add companies to your watchlist first.</li>';
    return;
  }

  for (const company of watchlist) {
    const li = document.createElement('li');
    li.className = 'calendar-trust-row';
    li.innerHTML = `
      <label>
        <input type="checkbox" class="calendar-trust-toggle" data-lei="${escapeHtml(company.lei)}" ${calendarSelectedLeis.has(company.lei) ? 'checked' : ''} />
        ${escapeHtml(company.name || company.lei)}
      </label>
    `;
    listEl.appendChild(li);
  }

  listEl.querySelectorAll('.calendar-trust-toggle').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      if (checkbox.checked) calendarSelectedLeis.add(checkbox.dataset.lei);
      else calendarSelectedLeis.delete(checkbox.dataset.lei);
      saveCalendarTrusts();
      await loadCalendarData();
      renderCalendarGrid();
    });
  });
}

async function openCalendarOverlay() {
  document.getElementById('calendar-overlay').hidden = false;
  renderCalendarTrustsList();
  await loadCalendarData();
  renderCalendarGrid();
}

document.getElementById('calendar-button').addEventListener('click', openCalendarOverlay);

document.getElementById('calendar-close').addEventListener('click', () => {
  document.getElementById('calendar-overlay').hidden = true;
});

document.getElementById('calendar-prev').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendarGrid();
});

document.getElementById('calendar-next').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendarGrid();
});

document.getElementById('calendar-today').addEventListener('click', () => {
  calendarMonth = new Date();
  renderCalendarGrid();
});

document.getElementById('calendar-trusts-all').addEventListener('click', async () => {
  calendarSelectedLeis = new Set(loadWatchlist().map((c) => c.lei));
  saveCalendarTrusts();
  renderCalendarTrustsList();
  await loadCalendarData();
  renderCalendarGrid();
});

document.getElementById('calendar-trusts-none').addEventListener('click', async () => {
  calendarSelectedLeis = new Set();
  saveCalendarTrusts();
  renderCalendarTrustsList();
  await loadCalendarData();
  renderCalendarGrid();
});

// Reads a fetch Response as JSON, but tolerates a body that isn't valid
// JSON (a plain-text 404 from a route that doesn't exist - e.g. a dev
// server running stale code - or an HTML error page from a proxy in front
// of the real deployment) instead of letting JSON.parse throw a cryptic
// "Unexpected token" SyntaxError. Callers get the HTTP status either way, so
// existing `if (!ok) ...data.error...` checks keep working unchanged.
async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : {} };
  } catch {
    const snippet = text.trim().slice(0, 200) || '(empty response)';
    throw new Error(`Server returned ${res.status}${res.statusText ? ` ${res.statusText}` : ''}: ${snippet}`);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Report URLs come from NSM data, and escapeHtml() alone doesn't stop a
// `javascript:` URL in an href from running script when clicked - so only
// http(s) links are ever rendered as links. Returns null otherwise.
function safeHref(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// A company can be temporarily excluded from searches (the checkbox in
// renderEditCompanyList()) without removing it from the watchlist - useful
// for pausing a company you don't want to lose track of entirely. Absent
// `enabled` (every entry saved before this feature existed) counts as
// enabled, so existing watchlists aren't silently emptied.
function isCompanyEnabled(company) {
  return company.enabled !== false;
}

function setCompanyEnabled(lei, enabled) {
  const watchlist = loadWatchlist();
  const company = watchlist.find((c) => c.lei === lei);
  if (!company) return;
  company.enabled = enabled;
  saveWatchlist(watchlist);
}

function renameCompany(lei, name) {
  const watchlist = loadWatchlist();
  const company = watchlist.find((c) => c.lei === lei);
  if (!company) return;
  company.name = name.trim();
  saveWatchlist(watchlist);
}

// The Edit companies overlay is the only place the watchlist is shown or
// managed - one row per company with a checkbox (include/exclude from
// searches, greyed out when off), an editable name field (renaming wasn't
// possible at all before - only add/remove), the LEI for reference, and
// the history/remove actions.
// A rename only changes which name a company's already-fetched reports
// display under - it doesn't change what reports exist - so this patches
// lastReports in place and re-renders, instead of the full loadReports()
// network round-trip every other watchlist edit (add/remove/toggle) needs.
// That full reload firing on every single name field's blur is what made
// the report table behind the Edit companies overlay visibly reload/flicker
// while renaming several companies in a row.
function updateReportsCompanyName(lei, name) {
  if (lastReports.length === 0) return;
  const resolved = name.trim();
  let changed = false;
  for (const report of lastReports) {
    if (report.lei !== lei) continue;
    const nextCompany = resolved || report.rawCompany || report.company;
    if (report.company !== nextCompany) {
      report.company = nextCompany;
      changed = true;
    }
  }
  if (changed) renderReportsList();
}

function renderEditCompanyList() {
  const listEl = document.getElementById('edit-company-list');
  const filterText = document.getElementById('edit-company-filter').value.trim().toLowerCase();
  const fullWatchlist = loadWatchlist();
  const watchlist = filterText
    ? fullWatchlist.filter((c) => (c.name || '').toLowerCase().includes(filterText) || c.lei.toLowerCase().includes(filterText))
    : fullWatchlist;

  listEl.innerHTML = '';
  if (fullWatchlist.length === 0) {
    listEl.innerHTML = '<li class="hint">No companies yet - use Add companies to get started.</li>';
    return;
  }
  if (watchlist.length === 0) {
    listEl.innerHTML = '<li class="hint">No companies match your filter.</li>';
    return;
  }

  for (const company of watchlist) {
    const enabled = isCompanyEnabled(company);
    const li = document.createElement('li');
    li.className = enabled ? 'edit-company-row' : 'edit-company-row is-disabled';
    li.innerHTML = `
      <input type="checkbox" class="edit-company-toggle" data-lei="${escapeHtml(company.lei)}" ${enabled ? 'checked' : ''} aria-label="Include in searches" title="Include in searches" />
      <input type="text" class="edit-company-name" data-lei="${escapeHtml(company.lei)}" placeholder="${escapeHtml(company.lei)}" value="${escapeHtml(company.name || '')}" />
      <span class="lei">${escapeHtml(company.lei)}</span>
      <button type="button" class="history-company" data-lei="${escapeHtml(company.lei)}" data-name="${escapeHtml(company.name || company.lei)}" aria-label="Filing history" title="Filing history">&#128337;</button>
      <button type="button" class="remove-company" data-lei="${escapeHtml(company.lei)}" aria-label="Remove">&times;</button>
    `;
    listEl.appendChild(li);
  }

  listEl.querySelectorAll('.edit-company-toggle').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setCompanyEnabled(checkbox.dataset.lei, checkbox.checked);
      checkbox.closest('.edit-company-row').classList.toggle('is-disabled', !checkbox.checked);
      loadReports();
    });
  });

  listEl.querySelectorAll('.edit-company-name').forEach((input) => {
    input.addEventListener('change', () => {
      renameCompany(input.dataset.lei, input.value);
      updateReportsCompanyName(input.dataset.lei, input.value);
    });
  });

  listEl.querySelectorAll('.remove-company').forEach((btn) => {
    btn.addEventListener('click', () => {
      const remaining = loadWatchlist().filter((c) => c.lei !== btn.dataset.lei);
      saveWatchlist(remaining);
      renderEditCompanyList();
      loadReports();
    });
  });

  listEl.querySelectorAll('.history-company').forEach((btn) => {
    btn.addEventListener('click', () => {
      openHistoryOverlay(btn.dataset.lei, btn.dataset.name);
    });
  });
}

function addCompany(lei, name) {
  const errorEl = document.getElementById('lei-error');
  const normalisedLei = lei.trim().toUpperCase();

  if (!LEI_RE.test(normalisedLei)) {
    errorEl.textContent = 'That doesn\'t look like a valid LEI (20 letters/digits, e.g. 549300UC0QPP7Y0W8056).';
    errorEl.hidden = false;
    return false;
  }

  const watchlist = loadWatchlist();
  if (watchlist.some((c) => c.lei === normalisedLei)) {
    errorEl.textContent = 'That LEI is already in your list.';
    errorEl.hidden = false;
    return false;
  }

  errorEl.hidden = true;
  watchlist.push({ lei: normalisedLei, name: name.trim() });
  saveWatchlist(watchlist);
  renderEditCompanyList();
  return true;
}

// Finds every 20-character LEI-shaped token in pasted text, ignoring
// anything else around it (so a pasted spreadsheet column, a comma/newline
// separated list, or free text mentioning LEIs all work the same way) -
// the \b boundaries stop this from matching the first 20 characters of a
// longer alphanumeric run.
function extractLeis(text) {
  const matches = text.toUpperCase().match(/\b[A-Z0-9]{20}\b/g) || [];
  return [...new Set(matches.filter((s) => LEI_RE.test(s)))];
}

function bulkAddCompanies(text) {
  const statusEl = document.getElementById('bulk-add-status');
  const found = extractLeis(text);
  statusEl.hidden = false;

  if (found.length === 0) {
    statusEl.textContent = 'No valid LEIs found (20-character letters/digits).';
    return 0;
  }

  const watchlist = loadWatchlist();
  const existingLeis = new Set(watchlist.map((c) => c.lei));
  let added = 0;
  for (const lei of found) {
    if (!existingLeis.has(lei)) {
      watchlist.push({ lei, name: '' });
      existingLeis.add(lei);
      added++;
    }
  }

  saveWatchlist(watchlist);
  renderEditCompanyList();
  const skipped = found.length - added;
  statusEl.textContent = `Found ${found.length} LEI${found.length === 1 ? '' : 's'}, added ${added} new compan${added === 1 ? 'y' : 'ies'}${skipped ? ` (${skipped} already in your list)` : ''}.`;
  return added;
}

// Shows an OS notification for reports that appeared since the last load,
// but only when it'd actually add information: the on-screen "NEW" badge
// already covers a visible tab, so this only fires while the tab is
// backgrounded, and only if the user opted into auto-refresh (which is what
// requests notification permission in the first place).
function notifyNewReports(newReports, settings) {
  if (!settings.autoRefreshMinutes) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!document.hidden) return;

  const maxIndividual = 3;
  newReports.slice(0, maxIndividual).forEach((r) => {
    new Notification(`RNS Update: ${r.company}`, { body: r.title, tag: reportKey(r) });
  });
  if (newReports.length > maxIndividual) {
    new Notification('RNS Update', { body: `+${newReports.length - maxIndividual} more new report(s)` });
  }
}

function toCsvField(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(content, mime, filename) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportCsv() {
  if (lastReports.length === 0) return;

  const header = ['Company', 'Title', 'Category', 'Published At', 'URL'];
  const rows = lastReports.map((r) => [
    r.company,
    r.title,
    r.category || '',
    r.publishedAt ? new Date(r.publishedAt).toLocaleString() : '',
    r.url || '',
  ].map(toCsvField).join(','));

  const csv = [header.join(','), ...rows].join('\n');
  downloadBlob(csv, 'text/csv;charset=utf-8', `rns-reports-${new Date().toISOString().slice(0, 10)}.csv`);
}

function exportWatchlist() {
  const watchlist = loadWatchlist();
  downloadBlob(
    JSON.stringify(watchlist, null, 2),
    'application/json',
    `rns-watchlist-${new Date().toISOString().slice(0, 10)}.json`
  );
}

async function importWatchlistFile(file) {
  const statusEl = document.getElementById('watchlist-io-status');
  statusEl.hidden = false;

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of {"lei", "name"} entries.');

    const valid = parsed
      .filter((c) => c && typeof c.lei === 'string' && LEI_RE.test(c.lei.toUpperCase()))
      .map((c) => ({ lei: c.lei.toUpperCase(), name: (c.name || '').trim() }));

    if (valid.length === 0) {
      statusEl.textContent = 'No valid entries found in that file (expected {"lei": "...", "name": "..."} objects).';
      return;
    }

    const watchlist = loadWatchlist();
    const existingLeis = new Set(watchlist.map((c) => c.lei));
    let added = 0;
    for (const c of valid) {
      if (!existingLeis.has(c.lei)) {
        watchlist.push(c);
        existingLeis.add(c.lei);
        added++;
      }
    }

    saveWatchlist(watchlist);
    renderEditCompanyList();
    const skipped = parsed.length - valid.length;
    statusEl.textContent = `Imported ${added} new compan${added === 1 ? 'y' : 'ies'} (${valid.length - added} already in your list${skipped ? `, ${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'} skipped` : ''}).`;
    if (added > 0) loadReports();
  } catch (err) {
    statusEl.textContent = `Failed to import: ${err.message || err}`;
  }
}

function renderReportsList() {
  const listEl = document.getElementById('reports');
  const filterInput = document.getElementById('report-filter');
  const sortSelect = document.getElementById('sort-select');

  if (lastReports.length === 0) {
    listEl.innerHTML = '<tr><td colspan="5" class="empty">No matching reports in the selected time period.</td></tr>';
    return;
  }

  const filterText = filterInput.value.trim().toLowerCase();

  let visible = lastReports.filter(
    (r) => !filterText || r.company.toLowerCase().includes(filterText) || r.title.toLowerCase().includes(filterText)
  );
  visible = sortReports(visible, sortSelect.value);

  listEl.innerHTML = '';
  if (visible.length === 0) {
    listEl.innerHTML = '<tr><td colspan="5" class="empty">No reports match your filter.</td></tr>';
    return;
  }

  for (const report of visible) {
    const key = reportKey(report);
    const isNew = lastNewKeys.has(key);
    const tr = document.createElement('tr');
    tr.className = isNew ? 'report-row report-row-new' : 'report-row';
    const date = report.publishedAt ? new Date(report.publishedAt).toLocaleString() : 'Unknown date';
    const titleHref = safeHref(report.url);
    const titleHtml = titleHref
      ? `<a href="${escapeHtml(titleHref)}" target="_blank" rel="noopener" class="report-title-link">${escapeHtml(report.title)}</a>`
      : escapeHtml(report.title);

    tr.innerHTML = `
      <td class="col-company"><button type="button" class="company-link">${escapeHtml(report.company)}</button></td>
      <td class="col-title">${titleHtml}${isNew ? '<span class="pill pill-new">New</span>' : ''}</td>
      <td class="col-category">${escapeHtml(report.category || '')}</td>
      <td class="col-published">${escapeHtml(date)}</td>
      <td class="col-actions">
        <div class="actions-inner">
          <button type="button" class="send-notification">Send Notification</button>
          <span class="notify-status"></span>
        </div>
      </td>
    `;

    tr.querySelector('.company-link').addEventListener('click', () => {
      openHistoryOverlay(report.lei, report.company);
    });

    tr.querySelector('.send-notification').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const statusSpan = tr.querySelector('.notify-status');

      let email = getNotifyEmail();
      if (!email) {
        email = await openNotifyEmailOverlay();
        if (!email) return; // cancelled - leave the report row as-is
      }

      btn.disabled = true;
      statusSpan.textContent = 'Sending…';

      try {
        const res = await fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Only identifiers + recipient - the server re-derives the actual
          // email content from a fresh NSM lookup rather than trusting
          // anything else this client might send (see lib/sendNotification.js).
          body: JSON.stringify({ lei: report.lei, id: report.id, title: report.title, publishedAt: report.publishedAt, to: email }),
        });
        const { data } = await parseJsonResponse(res);
        statusSpan.textContent = data.ok ? 'Notification sent' : `Failed: ${data.error || res.status}`;
      } catch (err) {
        statusSpan.textContent = `Failed: ${err}`;
      } finally {
        btn.disabled = false;
      }
    });

    listEl.appendChild(tr);
  }
}

// Encrypted view links (lib/viewToken.js): when the deployment has
// VIEW_TOKEN_SECRET set, the address bar, the RSS feed link, and this app's
// own /api/reports requests all carry one opaque `v` token instead of
// readable leis/days/categories params. POST /api/view returning a null
// token means no secret is configured, so readable params are used for the
// rest of the session.
let viewTokensAvailable = true;
const viewTokenCache = new Map(); // JSON of a view -> its token, so an unchanged view keeps the same link
let urlViewError = null;

// `view` is { leis, days, categories } as strings (any may be omitted).
// Returns the query string to use for it: `v=<token>`, or readable params.
async function viewQueryString(view) {
  const readable = new URLSearchParams(view).toString();
  if (!viewTokensAvailable) return readable;

  const key = JSON.stringify(view);
  if (!viewTokenCache.has(key)) {
    const res = await fetch('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key });
    const { ok, status, data } = await parseJsonResponse(res);
    if (!ok) throw new Error(data.error || `Couldn't create a view link (${status})`);
    if (!data.token) {
      viewTokensAvailable = false;
      return readable;
    }
    viewTokenCache.set(key, data.token);
  }
  return new URLSearchParams({ v: viewTokenCache.get(key) }).toString();
}

// Appends `keyword` to an already-built query string (from viewQueryString
// above) rather than being part of the `view` it encrypts - see the
// matching comment on resolveReportQuery() in lib/viewToken.js for why.
function withKeyword(query, keyword) {
  if (!keyword) return query;
  const params = new URLSearchParams(query);
  params.set('keyword', keyword);
  return params.toString();
}

// Merges companies/settings carried in the URL - a `v` token or readable
// params (see syncUrlWithState, called on every loadReports())
// into whatever's already saved - purely additive for companies (never
// removes or replaces an existing one), so opening someone's shared link
// can only add to your list, never silently clobber it. Settings
// (days/categories) are overwritten since that's just a view preference,
// not data, and easily changed back via the form.
function parseLeisFromParam(param) {
  return [...new Set((param || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => LEI_RE.test(s)))];
}

async function adoptUrlParams() {
  const params = new URLSearchParams(window.location.search);
  let leisValue = params.get('leis');
  let daysValue = params.get('days');
  let categoriesValue = params.get('categories');
  // Never part of the `v` token's payload (see withKeyword()/resolveReportQuery()),
  // so unlike the three above it's read once here and never overwritten by
  // the token branch below.
  const keywordValue = params.get('keyword');

  const token = params.get('v');
  if (token) {
    try {
      const res = await fetch(`/api/view?${new URLSearchParams({ v: token })}`);
      const { ok, status, data } = await parseJsonResponse(res);
      if (!ok) throw new Error(data.error || status);
      leisValue = data.leis.join(',');
      daysValue = String(data.days);
      categoriesValue = data.categories.join(',');
      // Reopening your own link then keeps the same token in the address bar.
      viewTokenCache.set(JSON.stringify({ leis: leisValue, days: daysValue, categories: categoriesValue }), token);
    } catch (err) {
      urlViewError = `Couldn't open this link (${err.message || err}) - showing your saved view instead.`;
      return;
    }
  }

  const urlLeis = parseLeisFromParam(leisValue);
  const daysParam = parseInt(daysValue, 10);
  const categoriesParam = (categoriesValue || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (urlLeis.length > 0) {
    const watchlist = loadWatchlist();
    const existingLeis = new Set(watchlist.map((c) => c.lei));
    let added = false;
    for (const lei of urlLeis) {
      if (!existingLeis.has(lei)) {
        watchlist.push({ lei, name: '' });
        existingLeis.add(lei);
        added = true;
      }
    }
    if (added) saveWatchlist(watchlist);
  }

  if (!Number.isNaN(daysParam) || categoriesParam.length > 0 || keywordValue != null) {
    const settings = loadSettings();
    saveSettings({
      days: Number.isNaN(daysParam) ? settings.days : daysParam,
      categories: categoriesParam.length ? categoriesParam : settings.categories,
      keyword: keywordValue != null ? keywordValue.trim() : settings.keyword,
      autoRefreshMinutes: settings.autoRefreshMinutes,
    });
  }
}

function syncUrlWithState(query) {
  window.history.replaceState(null, '', `${window.location.pathname}?${query}`);
}

async function loadReports() {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('reports');
  const debugEl = document.getElementById('debug');
  const feedLink = document.getElementById('feed-link');
  const watchlist = loadWatchlist();
  // Deselected companies (the checkbox in the Edit companies overlay) stay
  // in the watchlist but are left out of the search entirely - not just
  // filtered out of the results afterwards.
  const activeWatchlist = watchlist.filter(isCompanyEnabled);
  const settings = loadSettings();

  listEl.innerHTML = '';
  debugEl.textContent = '';
  lastReports = [];
  lastNewKeys = new Set();
  document.getElementById('mark-seen').hidden = true;

  if (watchlist.length === 0) {
    statusEl.textContent = 'No companies in your watchlist yet - use Add companies to get started.';
    feedLink.removeAttribute('href');
    return;
  }

  if (activeWatchlist.length === 0) {
    statusEl.textContent = 'All companies are deselected - enable at least one in Edit companies to see its reports.';
    feedLink.removeAttribute('href');
    return;
  }

  statusEl.textContent = 'Loading…';

  try {
    const leis = activeWatchlist.map((c) => c.lei).join(',');
    const query = withKeyword(await viewQueryString({
      leis,
      days: String(settings.days),
      categories: settings.categories.join(','),
    }), settings.keyword);
    feedLink.href = `/api/feed?${query}`;
    syncUrlWithState(query);

    const res = await fetch(`/api/reports?${query}`);
    const { ok, status, data } = await parseJsonResponse(res);

    if (!ok) {
      statusEl.textContent = `Error: ${data.error || status}`;
      if (data.details) debugEl.textContent = JSON.stringify(data.details, null, 2);
      return;
    }

    const namesByLei = new Map(watchlist.map((c) => [c.lei, c.name]));
    const resolvedReports = data.reports.map((r) => ({
      ...r,
      // rawCompany keeps the NSM-supplied name around after `company` is
      // overwritten below, so a later rename (see updateReportsCompanyName())
      // can still fall back to it correctly if the custom name is cleared,
      // without needing a fresh fetch to know what it originally was.
      rawCompany: r.company,
      company: (namesByLei.get(r.lei) || '').trim() || r.company,
    }));
    lastReports = resolvedReports;

    const seenBefore = await loadSeen();
    const isBaseline = seenBefore.size === 0;
    const newReports = resolvedReports.filter((r) => !seenBefore.has(reportKey(r)));
    lastNewKeys = isBaseline ? new Set() : new Set(newReports.map(reportKey));

    // Leads with the one number that matters (how many reports), a
    // same-line "N new" callout when there's something to see, and pushes
    // everything else (scan scope, cache) down into a smaller detail line -
    // a KPI-first layout instead of one dense run-on sentence that buries
    // the headline count in prose. "Last updated" itself lives with the
    // Refresh button in the header instead, not here.
    const cachedCount = (data.cachedLeis || []).length;
    // A delta fetch still hit NSM, just for the gap since it was last
    // cached rather than a full re-fetch - broken out from a plain "loaded
    // from NSM" company so the status line reflects that most of that
    // company's reports actually came from the cache/db too.
    const deltaCount = (data.deltaLeis || []).length;
    const nsmCount = activeWatchlist.length - cachedCount - deltaCount;
    // "db" only when a cache hit is genuinely Postgres-backed (survives a
    // restart) - otherwise it's the in-memory fallback (DATABASE_URL isn't
    // set), which "db" would misleadingly imply is persistent when it isn't.
    const cacheLabel = data.cacheBackend === 'postgres' ? 'db' : 'memory';
    const refreshedAt = new Date().toLocaleTimeString();
    const newCount = !isBaseline ? newReports.length : 0;
    const keywordNote = data.keyword ? ` or mentioning "${escapeHtml(data.keyword)}"` : '';
    const deltaNote = deltaCount ? `, ${deltaCount} updated from NSM` : '';
    statusEl.innerHTML = `
      <span class="stat-figure">${data.count}</span> report${data.count === 1 ? '' : 's'}${newCount ? ` <span class="stat-new">${newCount} new</span>` : ''}
      <span class="stat-meta">last ${data.days} day${data.days === 1 ? '' : 's'} · ${activeWatchlist.length} compan${activeWatchlist.length === 1 ? 'y' : 'ies'} · ${data.scanned} scanned · matching ${escapeHtml(data.categories.join(', '))}${keywordNote}</span>
      <span class="stat-meta stat-source">${cachedCount} compan${cachedCount === 1 ? 'y' : 'ies'} loaded from ${cacheLabel}${deltaNote}, ${nsmCount} loaded from NSM</span>
    `;

    const lastUpdatedEl = document.getElementById('last-updated');
    lastUpdatedEl.textContent = `Updated ${refreshedAt}`;

    document.getElementById('mark-seen').hidden = lastNewKeys.size === 0;

    renderReportsList();

    saveSeen(resolvedReports.map(reportKey), seenBefore);

    if (!isBaseline && newReports.length > 0) {
      notifyNewReports(newReports, settings);
    }

    // Every item the NSM search returned for these companies in the
    // selected time period (matched or not) - since company_lei actually
    // filters server-side, this is a short, focused list rather than a
    // market-wide dump.
    debugEl.textContent = JSON.stringify(data.scannedItems || [], null, 2);

    // Not awaited - a nice-to-have indicator, not something a report
    // reload should ever wait on. Cheap on every call after the first:
    // checkDueDates() itself bails out fast once the watchlist's already
    // covered by a fresh-enough cache.
    checkDueDates();
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err}`;
  }
}

// A small inline bar chart (no charting library - plain SVG, matching the
// rest of the app) showing filing counts per month over the last year, so
// a burst of activity or a company having gone quiet is visible at a
// glance instead of only readable by scrolling the raw list below.
function renderHistoryActivity(items) {
  const containerEl = document.getElementById('history-activity');
  if (items.length === 0) {
    containerEl.hidden = true;
    containerEl.innerHTML = '';
    return;
  }

  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: 'short' }), count: 0 });
  }
  const byKey = new Map(months.map((m) => [m.key, m]));

  for (const item of items) {
    const d = item.publishedAt ? new Date(item.publishedAt) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    const bucket = byKey.get(`${d.getFullYear()}-${d.getMonth()}`);
    if (bucket) bucket.count++;
  }

  const maxCount = Math.max(1, ...months.map((m) => m.count));
  const barWidth = 18;
  const gap = 6;
  const chartHeight = 36;
  const width = months.length * (barWidth + gap) - gap;

  const bars = months.map((m, i) => {
    const height = m.count > 0 ? Math.max(2, Math.round((m.count / maxCount) * chartHeight)) : 0;
    const x = i * (barWidth + gap);
    return `<rect x="${x}" y="${chartHeight - height}" width="${barWidth}" height="${height}" rx="2" fill="${m.count > 0 ? 'var(--accent)' : 'var(--border)'}"><title>${escapeHtml(m.label)}: ${m.count} filing${m.count === 1 ? '' : 's'}</title></rect>`;
  }).join('');

  const labels = months.map((m, i) => {
    const x = i * (barWidth + gap) + barWidth / 2;
    return `<text x="${x}" y="${chartHeight + 11}" font-size="8" fill="var(--muted)" text-anchor="middle">${escapeHtml(m.label[0])}</text>`;
  }).join('');

  containerEl.innerHTML = `
    <p class="hint history-activity-label">Filing activity, last 12 months</p>
    <svg viewBox="0 0 ${width} ${chartHeight + 14}" width="100%" height="56" role="img" aria-label="Filings per month over the last 12 months">${bars}${labels}</svg>
  `;
  containerEl.hidden = false;
}

// Builds the "Type" filter's options from whatever categories actually
// appear in this company's own filing history, instead of the fixed
// sidebar category list - a company that's never filed a "Dividend
// Declaration" shouldn't offer it as a (permanently empty) choice here.
// Keeps the current selection if it's still a valid option.
function populateHistoryTypeFilter(items) {
  const select = document.getElementById('history-filter-type');
  const previous = select.value;
  const types = [...new Set(items.map((item) => item.type).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="all">All types</option>'
    + types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  select.value = types.includes(previous) ? previous : 'all';
}

// Applies the date range/type/quantity filter controls to the currently-
// loaded 365-day item set and re-renders the chart, list, and status line -
// entirely client-side, since every filing in range is already loaded, the
// same "fetch once, filter locally" pattern the main report table uses.
function renderHistoryView(statusSuffix = '') {
  const statusEl = document.getElementById('history-status');
  const listEl = document.getElementById('history-list');

  const days = parseInt(document.getElementById('history-filter-days').value, 10);
  const type = document.getElementById('history-filter-type').value;
  const limit = document.getElementById('history-filter-limit').value;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const matched = currentHistoryItems.filter((item) => {
    const published = item.publishedAt ? new Date(item.publishedAt).getTime() : NaN;
    if (Number.isNaN(published) || published < cutoff) return false;
    return type === 'all' || item.type === type;
  });

  const dayLabel = { 30: 'last 30 days', 90: 'last 90 days', 180: 'last 180 days', 365: 'last 365 days' }[days] || `last ${days} days`;
  statusEl.textContent = (matched.length
    ? `${matched.length} filing${matched.length === 1 ? '' : 's'} in the ${dayLabel}.`
    : `No filings found in the ${dayLabel}.`) + statusSuffix;

  renderHistoryActivity(matched);

  const shown = limit === 'all' ? matched : matched.slice(0, parseInt(limit, 10));

  listEl.innerHTML = '';
  for (const item of shown) {
    const li = document.createElement('li');
    const date = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : 'Unknown date';
    const typeHref = safeHref(item.url);
    const typeHtml = typeHref
      ? `<a href="${escapeHtml(typeHref)}" target="_blank" rel="noopener">${escapeHtml(item.type || 'Unknown type')}</a>`
      : escapeHtml(item.type || 'Unknown type');
    li.innerHTML = `
      <span class="history-date">${escapeHtml(date)}</span> ·
      <span class="history-type">${typeHtml}</span><br>
      <span class="history-headline">${escapeHtml(item.headline || '')}</span>
    `;
    listEl.appendChild(li);
  }
}

async function openHistoryOverlay(lei, displayName, { force = false } = {}) {
  currentHistoryLei = lei;
  currentHistoryName = displayName;

  const overlay = document.getElementById('history-overlay');
  const titleEl = document.getElementById('history-title');
  const leiEl = document.getElementById('history-lei');
  const statusEl = document.getElementById('history-status');

  titleEl.textContent = displayName;
  leiEl.textContent = `LEI: ${lei}`;
  // A fresh history-back-button entry per open, not per refresh/filter
  // change - so one Back press (or the on-page Back button, which just
  // calls history.back()) always returns to the report list in one step.
  if (overlay.hidden) history.pushState({ historyOverlay: true }, '');
  overlay.hidden = false;

  const cache = loadHistoryCache();
  const cached = cache[lei];
  const now = Date.now();

  if (!force && cached && now - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    currentHistoryItems = cached.items;
    populateHistoryTypeFilter(currentHistoryItems);
    const cachedAt = new Date(cached.fetchedAt).toLocaleTimeString();
    renderHistoryView(` (cached, loaded at ${cachedAt} — hit Refresh for the latest)`);
    return;
  }

  currentHistoryItems = [];
  document.getElementById('history-list').innerHTML = '';
  document.getElementById('history-activity').hidden = true;
  statusEl.textContent = 'Loading…';

  try {
    const query = await viewQueryString({ leis: lei, days: '365' });
    const res = await fetch(`/api/reports?${query}`);
    const { ok, status, data } = await parseJsonResponse(res);

    if (!ok) {
      statusEl.textContent = `Error: ${data.error || status}`;
      return;
    }

    const items = (data.scannedItems || []).slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    cache[lei] = { items, fetchedAt: now };
    saveHistoryCache(cache);

    currentHistoryItems = items;
    populateHistoryTypeFilter(currentHistoryItems);
    renderHistoryView('');
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err}`;
  }
}

function closeHistoryOverlay() {
  document.getElementById('history-overlay').hidden = true;
}

// Routes through history.back() rather than closing directly, so the
// on-page Back button and the browser/OS back button behave identically -
// both end up here via the popstate listener below.
document.getElementById('history-back').addEventListener('click', () => {
  history.back();
});

window.addEventListener('popstate', () => {
  if (!document.getElementById('history-overlay').hidden) closeHistoryOverlay();
});

document.getElementById('history-refresh').addEventListener('click', () => {
  if (currentHistoryLei) openHistoryOverlay(currentHistoryLei, currentHistoryName, { force: true });
});

['history-filter-days', 'history-filter-type', 'history-filter-limit'].forEach((id) => {
  document.getElementById(id).addEventListener('change', () => renderHistoryView());
});

document.getElementById('debug-button').addEventListener('click', () => {
  document.getElementById('debug-overlay').hidden = false;
});

document.getElementById('debug-close').addEventListener('click', () => {
  document.getElementById('debug-overlay').hidden = true;
});

document.getElementById('add-company-open').addEventListener('click', () => {
  document.getElementById('lei-error').hidden = true;
  document.getElementById('bulk-add-status').hidden = true;
  document.getElementById('bulk-add-input').value = '';
  document.getElementById('add-company-overlay').hidden = false;
  document.getElementById('lei-input').focus();
});

document.getElementById('add-company-close').addEventListener('click', () => {
  document.getElementById('add-company-overlay').hidden = true;
});

document.getElementById('add-company-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const leiInput = document.getElementById('lei-input');
  const nameInput = document.getElementById('name-input');

  if (addCompany(leiInput.value, nameInput.value)) {
    leiInput.value = '';
    nameInput.value = '';
    leiInput.focus();
    loadReports();
  }
});

document.getElementById('bulk-add-btn').addEventListener('click', () => {
  const textarea = document.getElementById('bulk-add-input');
  if (bulkAddCompanies(textarea.value) > 0) {
    textarea.value = '';
    loadReports();
  }
});

document.getElementById('edit-company-open').addEventListener('click', () => {
  renderEditCompanyList();
  document.getElementById('watchlist-io-status').hidden = true;
  document.getElementById('edit-company-overlay').hidden = false;
});

document.getElementById('edit-company-close').addEventListener('click', () => {
  document.getElementById('edit-company-overlay').hidden = true;
});

document.getElementById('edit-company-filter').addEventListener('input', renderEditCompanyList);

document.getElementById('refresh').addEventListener('click', loadReports);

// Clears the "New" badges/highlight for whatever's currently on screen
// without waiting for the next load - lastReports is already marked seen
// (server or localStorage, see saveSeen()) as of the load that produced
// it, so this only needs to reset the in-memory set that drives this
// render.
document.getElementById('mark-seen').addEventListener('click', () => {
  lastNewKeys = new Set();
  document.getElementById('mark-seen').hidden = true;
  renderReportsList();
});
document.getElementById('export-csv').addEventListener('click', exportCsv);

document.getElementById('watchlist-export').addEventListener('click', exportWatchlist);
document.getElementById('watchlist-import-btn').addEventListener('click', () => {
  document.getElementById('watchlist-import-file').click();
});
document.getElementById('watchlist-import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) importWatchlistFile(file);
  e.target.value = ''; // allow re-importing the same file again later
});

document.getElementById('report-filter').addEventListener('input', renderReportsList);
document.getElementById('sort-select').addEventListener('change', () => {
  saveSort(document.getElementById('sort-select').value);
  renderReportsList();
});

function setupAutoRefresh(settings) {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  if (!settings.autoRefreshMinutes) return;
  autoRefreshTimer = setInterval(loadReports, settings.autoRefreshMinutes * 60 * 1000);
}

function initSettingsForm() {
  const daysSelect = document.getElementById('days-select');
  const categoriesOtherInput = document.getElementById('categories-other-input');
  const keywordInput = document.getElementById('keyword-input');
  const settings = loadSettings();

  daysSelect.value = String(settings.days);
  keywordInput.value = settings.keyword;

  const knownLower = new Set(KNOWN_CATEGORIES.map((c) => c.toLowerCase()));
  for (const value of KNOWN_CATEGORIES) {
    const checkbox = document.querySelector(`#categories-fieldset input[value="${CSS.escape(value)}"]`);
    if (checkbox) checkbox.checked = settings.categories.some((c) => c.toLowerCase() === value.toLowerCase());
  }
  categoriesOtherInput.value = settings.categories.filter((c) => !knownLower.has(c.toLowerCase())).join(', ');

  function gatherCategories() {
    const checked = [...document.querySelectorAll('#categories-fieldset input:checked')].map((el) => el.value);
    const other = categoriesOtherInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const combined = [...checked, ...other];
    return combined.length ? combined : DEFAULT_CATEGORIES;
  }

  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    // Auto-refresh lives in its own header control now (initAutoRefreshControl)
    // and applies itself immediately on change - carry its current value
    // through unchanged rather than this form having any say over it.
    const newSettings = {
      days: parseInt(daysSelect.value, 10),
      categories: gatherCategories(),
      keyword: keywordInput.value.trim(),
      autoRefreshMinutes: loadSettings().autoRefreshMinutes,
    };
    saveSettings(newSettings);
    loadReports();
  });
}

// Small icon dropdown in the header (top-right) instead of a labelled
// field inside Search settings - applies immediately on change instead of
// waiting for that form's Apply button, matching Theme/Diagnostics right
// next to it.
function initAutoRefreshControl() {
  const select = document.getElementById('auto-refresh-select');
  const settings = loadSettings();
  select.value = String(settings.autoRefreshMinutes);
  setupAutoRefresh(settings);

  select.addEventListener('change', () => {
    const autoRefreshMinutes = parseInt(select.value, 10) || 0;
    if (autoRefreshMinutes > 0 && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    const newSettings = { ...loadSettings(), autoRefreshMinutes };
    saveSettings(newSettings);
    setupAutoRefresh(newSettings);
  });
}

function initReportControls() {
  document.getElementById('sort-select').value = loadSort();
}

// Automatic email digests: unlike the ad-hoc "Send Notification" flow above
// (one report, typed-in-the-moment email, sent immediately), these are
// server-side subscriptions - one row per email address, each with its own
// send frequency and its own per-trust/per-report-type selection - stored
// in Postgres and sent by a scheduler in server.js even with no browser tab
// open. Fixed to the same six categories as Search settings' checkboxes.
const NOTIFICATION_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report', 'Net Asset Value(s)', 'Dividend Declaration', 'Portfolio Update', 'Miscellaneous'];
const NOTIFICATION_CATEGORY_LABELS = {
  'Half-year Financial Report': 'Half-year',
  'Annual Financial Report': 'Annual',
  'Net Asset Value(s)': 'NAV',
  'Dividend Declaration': 'Dividend',
  'Portfolio Update': 'Portfolio',
  'Miscellaneous': 'Misc',
};
// [minutes, label] - generates each email row's own frequency <select>
// (previously one shared dropdown above the list, now per-row).
const NOTIFICATION_FREQUENCIES = [
  [0, 'Paused'],
  [60, 'Every hour'],
  [360, 'Every 6 hours'],
  [1440, 'Daily'],
  [10080, 'Weekly'],
];

let notificationsState = { enabled: false, subscriptions: [], selectedId: null };
// Which trusts currently have their per-category detail expanded - a
// session-only UI preference (not saved to the subscription), reset by
// nothing but the user collapsing them again.
let notificationsExpandedLeis = new Set();

function currentSubscription() {
  return notificationsState.subscriptions.find((s) => s.id === notificationsState.selectedId) || null;
}

function showNotificationsStatus(message) {
  const statusEl = document.getElementById('notifications-status');
  statusEl.hidden = !message;
  statusEl.textContent = message || '';
}

async function loadSubscriptions() {
  const res = await fetch('/api/subscriptions');
  const { ok, status, data } = await parseJsonResponse(res);
  if (!ok) throw new Error(data.error || `Couldn't load notifications (${status})`);

  notificationsState.enabled = Boolean(data.enabled);
  notificationsState.subscriptions = data.subscriptions || [];
  if (!notificationsState.subscriptions.some((s) => s.id === notificationsState.selectedId)) {
    notificationsState.selectedId = notificationsState.subscriptions[0] ? notificationsState.subscriptions[0].id : null;
  }
}

// Sets or clears every category at once for one trust (its row's own
// checkbox) or one category across every trust (a bulk-apply chip above
// the list) - both just call the same per-cell logic in a loop, then
// re-render so every checkbox's checked/indeterminate state and every
// chip's active state stay correct (a bulk change can flip several trusts,
// not just the one clicked).
function setAllCategoriesForTrust(lei, checked) {
  const subscription = currentSubscription();
  if (!subscription) return;
  const company = loadWatchlist().find((c) => c.lei === lei);
  if (checked) {
    subscription.prefs[lei] = { name: (company && company.name) || lei, categories: [...NOTIFICATION_CATEGORIES] };
  } else {
    delete subscription.prefs[lei];
  }
  saveCurrentSubscription();
  renderNotificationsMatrix(subscription);
}

function setCategoryForAllTrusts(category, checked) {
  const subscription = currentSubscription();
  if (!subscription) return;
  for (const company of loadWatchlist()) {
    const existing = subscription.prefs[company.lei] || { name: company.name || company.lei, categories: [] };
    const categories = new Set(existing.categories);
    if (checked) categories.add(category); else categories.delete(category);
    if (categories.size === 0) {
      delete subscription.prefs[company.lei];
    } else {
      subscription.prefs[company.lei] = { name: company.name || company.lei, categories: [...categories] };
    }
  }
  saveCurrentSubscription();
  renderNotificationsMatrix(subscription);
}

// The master "select everything" action - every category for every trust
// in one click, rather than clicking each of the six category chips (or
// each trust's own row checkbox) in turn.
function setAllCategoriesForAllTrusts(checked) {
  const subscription = currentSubscription();
  if (!subscription) return;
  for (const company of loadWatchlist()) {
    if (checked) {
      subscription.prefs[company.lei] = { name: company.name || company.lei, categories: [...NOTIFICATION_CATEGORIES] };
    } else {
      delete subscription.prefs[company.lei];
    }
  }
  saveCurrentSubscription();
  renderNotificationsMatrix(subscription);
}

// The bulk-apply chips above the list are static (never re-created), so
// their active/disabled state is refreshed here on every render instead of
// re-wiring listeners each time - those are attached once, further down.
// A chip reads "active" only when every trust already has that category -
// there's no third visual state for "some but not all" (unlike the row/
// list checkboxes below, which do show indeterminate) since a chip's own
// click always means "make this true everywhere", not "toggle this cell".
// The master "select all" chip has no data-category of its own (it isn't
// one of the per-category loop below) - handled separately since its
// active state depends on every category for every trust, not just one.
function updateNotificationsBulkChips(subscription, watchlist) {
  document.querySelectorAll('.notifications-bulk-chip[data-category]').forEach((chip) => {
    if (watchlist.length === 0) {
      chip.classList.remove('is-active');
      chip.disabled = true;
      return;
    }
    chip.disabled = false;
    const selectedCount = watchlist.filter((c) => {
      const categories = (subscription.prefs[c.lei] && subscription.prefs[c.lei].categories) || [];
      return categories.includes(chip.dataset.category);
    }).length;
    chip.classList.toggle('is-active', selectedCount === watchlist.length);
  });

  const selectAllChip = document.getElementById('notifications-select-all');
  if (watchlist.length === 0) {
    selectAllChip.classList.remove('is-active');
    selectAllChip.disabled = true;
  } else {
    selectAllChip.disabled = false;
    const everyTrustFullySelected = watchlist.every((c) => {
      const categories = (subscription.prefs[c.lei] && subscription.prefs[c.lei].categories) || [];
      return categories.length === NOTIFICATION_CATEGORIES.length;
    });
    selectAllChip.classList.toggle('is-active', everyTrustFullySelected);
  }
}

// One collapsed line per trust by default - just its name, an "all types"
// checkbox, and a count of how many report types it's watching - instead
// of always showing all six category checkboxes for all 20+ trusts at
// once. Expanding a row (notificationsExpandedLeis) reveals its individual
// category checkboxes for fine-grained selection.
function renderNotificationsMatrix(subscription) {
  const listEl = document.getElementById('notifications-matrix-body');
  const watchlist = loadWatchlist();

  listEl.innerHTML = '';
  if (watchlist.length === 0) {
    listEl.innerHTML = '<li class="empty">Add companies to your watchlist first.</li>';
    updateNotificationsBulkChips(subscription, watchlist);
    return;
  }

  for (const company of watchlist) {
    const name = company.name || company.lei;
    const selected = (subscription.prefs[company.lei] && subscription.prefs[company.lei].categories) || [];
    const allSelected = selected.length === NOTIFICATION_CATEGORIES.length;
    const expanded = notificationsExpandedLeis.has(company.lei);

    let countLabel = '';
    if (allSelected) countLabel = 'All types';
    else if (selected.length > 0) countLabel = `${selected.length} of ${NOTIFICATION_CATEGORIES.length} types`;

    const li = document.createElement('li');
    li.className = 'notifications-trust-row';
    li.innerHTML = `
      <div class="notifications-trust-summary">
        <button type="button" class="notifications-trust-expand" aria-expanded="${expanded}" aria-label="${expanded ? 'Collapse' : 'Expand'} report types for ${escapeHtml(name)}">${expanded ? '⌄' : '›'}</button>
        <input type="checkbox" class="notifications-row-all" data-lei="${escapeHtml(company.lei)}" ${allSelected ? 'checked' : ''} aria-label="All report types for ${escapeHtml(name)}" title="Notify for every report type" />
        <span class="notifications-trust-name">${escapeHtml(name)}</span>
        <span class="notifications-trust-count">${countLabel}</span>
      </div>
      <div class="notifications-trust-detail"${expanded ? '' : ' hidden'}>
        ${NOTIFICATION_CATEGORIES.map((category) => `
          <label class="notifications-detail-item">
            <input type="checkbox" class="notifications-pref" data-lei="${escapeHtml(company.lei)}" data-category="${escapeHtml(category)}" ${selected.includes(category) ? 'checked' : ''} />
            ${escapeHtml(NOTIFICATION_CATEGORY_LABELS[category])}
          </label>
        `).join('')}
      </div>
    `;
    listEl.appendChild(li);
    li.querySelector('.notifications-row-all').indeterminate = selected.length > 0 && !allSelected;
  }

  listEl.querySelectorAll('.notifications-pref').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      toggleNotificationPref(checkbox.dataset.lei, checkbox.dataset.category, checkbox.checked);
    });
  });

  listEl.querySelectorAll('.notifications-row-all').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      setAllCategoriesForTrust(checkbox.dataset.lei, checkbox.checked);
    });
  });

  listEl.querySelectorAll('.notifications-trust-expand').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lei = btn.closest('.notifications-trust-row').querySelector('.notifications-row-all').dataset.lei;
      if (notificationsExpandedLeis.has(lei)) notificationsExpandedLeis.delete(lei);
      else notificationsExpandedLeis.add(lei);
      renderNotificationsMatrix(subscription);
    });
  });

  updateNotificationsBulkChips(subscription, watchlist);
}

// One row per subscribed email - address, its own frequency select, and a
// remove button - instead of a dropdown that only shows one at a time plus
// a separate always-visible "type a new one" row. Clicking a row (anywhere
// but its own select/button) selects it as the one being configured below.
function renderNotificationsEmailList() {
  const listEl = document.getElementById('notifications-email-list');
  listEl.innerHTML = '';

  if (notificationsState.subscriptions.length === 0) {
    listEl.innerHTML = '<li class="hint notifications-email-empty">No emails yet - add one above.</li>';
    return;
  }

  for (const subscription of notificationsState.subscriptions) {
    const li = document.createElement('li');
    li.className = subscription.id === notificationsState.selectedId
      ? 'notifications-email-row is-selected'
      : 'notifications-email-row';
    li.innerHTML = `
      <span class="notifications-email-address">${escapeHtml(subscription.email)}</span>
      <select class="notifications-email-frequency">
        ${NOTIFICATION_FREQUENCIES.map(([minutes, label]) => `<option value="${minutes}" ${minutes === (subscription.frequencyMinutes || 0) ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
      <button type="button" class="notifications-send-now" title="Send this digest now, using whatever's new since its last send">Send now</button>
      <button type="button" class="notifications-send-test" title="Send a real test email right now, with recent reports regardless of what's new - doesn't affect the digest's normal schedule">Send test</button>
      <button type="button" class="remove-company" aria-label="Remove ${escapeHtml(subscription.email)}" title="Remove this email">&times;</button>
    `;

    li.addEventListener('click', (e) => {
      if (e.target.closest('select, button')) return;
      notificationsState.selectedId = subscription.id;
      renderNotificationsOverlay();
    });

    li.querySelector('.notifications-email-frequency').addEventListener('change', (e) => {
      subscription.frequencyMinutes = parseInt(e.target.value, 10) || 0;
      saveCurrentSubscription();
    });
    li.querySelector('.notifications-email-frequency').addEventListener('click', (e) => e.stopPropagation());

    li.querySelector('.notifications-send-now').addEventListener('click', () => sendSubscriptionNow(subscription));
    li.querySelector('.notifications-send-test').addEventListener('click', () => sendSubscriptionTest(subscription));
    li.querySelector('.remove-company').addEventListener('click', () => removeSubscription(subscription.id));

    listEl.appendChild(li);
  }
}

// Triggers a real send right now (same sendDigestForSubscription()+markSent()
// the scheduler itself runs, via POST /api/subscriptions/:id/send-now) -
// not a fake preview, so this is how someone setting up a digest confirms
// it actually delivers without waiting for its frequency to come due.
async function sendSubscriptionNow(subscription) {
  showNotificationsStatus(`Sending to ${subscription.email}…`);
  try {
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(subscription.id)}/send-now`, { method: 'POST' });
    const { ok, status, data } = await parseJsonResponse(res);
    if (!ok) throw new Error(data.error || `Couldn't send (${status})`);

    subscription.lastSentAt = data.lastSentAt;
    showNotificationsStatus(data.sent
      ? `Sent to ${subscription.email}: ${data.count} report${data.count === 1 ? '' : 's'}.`
      : `Nothing new to send to ${subscription.email} right now.`);
  } catch (err) {
    showNotificationsStatus(`Failed to send: ${err.message || err}`);
  }
}

// Unlike sendSubscriptionNow(), always sends a real email (recent reports,
// or a placeholder if none matched) and never updates lastSentAt - purely
// for confirming delivery/formatting on demand, without touching the
// subscription's actual send schedule.
async function sendSubscriptionTest(subscription) {
  showNotificationsStatus(`Sending test to ${subscription.email}…`);
  try {
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(subscription.id)}/send-test`, { method: 'POST' });
    const { ok, status, data } = await parseJsonResponse(res);
    if (!ok) throw new Error(data.error || `Couldn't send (${status})`);

    showNotificationsStatus(`Test sent to ${subscription.email}: ${data.count} report${data.count === 1 ? '' : 's'}.`);
  } catch (err) {
    showNotificationsStatus(`Failed to send test: ${err.message || err}`);
  }
}

async function removeSubscription(id) {
  try {
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const { ok, status, data } = await parseJsonResponse(res);
    if (!ok) throw new Error(data.error || `Couldn't remove (${status})`);

    notificationsState.subscriptions = notificationsState.subscriptions.filter((s) => s.id !== id);
    if (notificationsState.selectedId === id) {
      notificationsState.selectedId = notificationsState.subscriptions[0] ? notificationsState.subscriptions[0].id : null;
    }
    showNotificationsStatus('');
    renderNotificationsOverlay();
  } catch (err) {
    showNotificationsStatus(`Failed to remove: ${err.message || err}`);
  }
}

function renderNotificationsOverlay() {
  const unavailableEl = document.getElementById('notifications-unavailable');
  const bodyEl = document.getElementById('notifications-body');
  unavailableEl.hidden = notificationsState.enabled;
  bodyEl.hidden = !notificationsState.enabled;
  if (!notificationsState.enabled) return;

  renderNotificationsEmailList();

  const editingLabel = document.getElementById('notifications-editing-label');
  const matrixBody = document.getElementById('notifications-matrix-body');

  const subscription = currentSubscription();
  if (!subscription) {
    editingLabel.hidden = true;
    matrixBody.innerHTML = '<li class="empty">Add an email above to configure its notifications.</li>';
    document.querySelectorAll('.notifications-bulk-chip').forEach((chip) => {
      chip.classList.remove('is-active');
      chip.disabled = true;
    });
    return;
  }

  editingLabel.hidden = false;
  editingLabel.textContent = `Configuring notifications for ${subscription.email}`;
  renderNotificationsMatrix(subscription);
}

async function saveCurrentSubscription() {
  const subscription = currentSubscription();
  if (!subscription) return;
  try {
    const res = await fetch(`/api/subscriptions/${encodeURIComponent(subscription.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frequencyMinutes: subscription.frequencyMinutes, prefs: subscription.prefs }),
    });
    const { ok, status, data } = await parseJsonResponse(res);
    if (!ok) throw new Error(data.error || `Couldn't save (${status})`);
    showNotificationsStatus('');
  } catch (err) {
    showNotificationsStatus(`Failed to save: ${err.message || err}`);
  }
}

function toggleNotificationPref(lei, category, checked) {
  const subscription = currentSubscription();
  if (!subscription) return;

  const company = loadWatchlist().find((c) => c.lei === lei);
  const existing = subscription.prefs[lei] || { name: (company && company.name) || lei, categories: [] };
  const categories = new Set(existing.categories);
  if (checked) categories.add(category); else categories.delete(category);

  if (categories.size === 0) {
    delete subscription.prefs[lei];
  } else {
    subscription.prefs[lei] = { name: (company && company.name) || lei, categories: [...categories] };
  }
  saveCurrentSubscription();
  // Re-render so this trust's "All types" checkbox and this category's
  // column-header checkbox pick up the new checked/indeterminate state -
  // both depend on every cell, not just the one just clicked.
  renderNotificationsMatrix(subscription);
}

document.getElementById('notifications-button').addEventListener('click', async () => {
  document.getElementById('notifications-overlay').hidden = false;
  showNotificationsStatus('');
  try {
    await loadSubscriptions();
  } catch (err) {
    showNotificationsStatus(`Failed to load: ${err.message || err}`);
  }
  renderNotificationsOverlay();
});

document.getElementById('notifications-close').addEventListener('click', () => {
  document.getElementById('notifications-overlay').hidden = true;
});

// The bulk-apply chips are static (outside the re-rendered list), so their
// listeners are wired once here rather than in renderNotificationsMatrix().
// Mirrors clicking a native indeterminate/unchecked checkbox: not every
// trust has it yet -> select it for all of them; already active -> clear
// it from all of them.
document.querySelectorAll('.notifications-bulk-chip[data-category]').forEach((chip) => {
  chip.addEventListener('click', () => {
    setCategoryForAllTrusts(chip.dataset.category, !chip.classList.contains('is-active'));
  });
});

document.getElementById('notifications-select-all').addEventListener('click', (e) => {
  setAllCategoriesForAllTrusts(!e.currentTarget.classList.contains('is-active'));
});

document.getElementById('notifications-email-add').addEventListener('click', async () => {
  const input = document.getElementById('notifications-new-email');
  const email = input.value.trim();
  if (!EMAIL_RE.test(email)) {
    showNotificationsStatus("That doesn't look like a valid email address.");
    return;
  }

  try {
    const res = await fetch('/api/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, frequencyMinutes: 1440, prefs: {} }),
    });
    const { ok, status, data } = await parseJsonResponse(res);
    if (!ok) throw new Error(data.error || `Couldn't add (${status})`);

    notificationsState.subscriptions.push(data.subscription);
    notificationsState.selectedId = data.subscription.id;
    input.value = '';
    showNotificationsStatus('');
    renderNotificationsOverlay();
  } catch (err) {
    showNotificationsStatus(`Failed to add: ${err.message || err}`);
  }
});

(async () => {
  initTheme();
  initWatchlistCollapse();
  initSettingsCollapse();
  initSidebarResize();
  // initWatchlist() (which decides which backend the watchlist lives in
  // and populates the in-memory cache from it) and initSeenBackend() are
  // independent of each other, but adoptUrlParams() below reads/writes
  // the watchlist cache (merging any LEIs from a shared link), so it
  // needs initWatchlist() done first - not the other way around.
  await Promise.all([initWatchlist(), initSeenBackend()]);
  initCalendarTrusts();
  await adoptUrlParams();
  initSettingsForm();
  initAutoRefreshControl();
  initReportControls();
  await loadReports();
  if (urlViewError) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = `${urlViewError} ${statusEl.textContent}`;
  }
})();
