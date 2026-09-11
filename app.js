const STORAGE_KEY = 'rns-watchlist';
const SETTINGS_KEY = 'rns-settings';
const SEEN_KEY = 'rns-seen-reports';
const HISTORY_CACHE_KEY = 'rns-history-cache';
const SORT_KEY = 'rns-sort';
const THEME_KEY = 'rns-theme';
const NOTIFY_EMAIL_KEY = 'rns-notify-email';
const LEI_RE = /^[A-Z0-9]{20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report'];
const KNOWN_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report', 'Net Asset Value(s)', 'Dividend Declaration'];
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

let lastReports = [];
let lastNewKeys = new Set();
let autoRefreshTimer = null;
let currentHistoryLei = null;
let currentHistoryName = null;

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];

    // Drop entries left over from before the ISIN->LEI rename (they carry
    // an `isin` field instead of `lei` and would otherwise render as
    // "(undefined)" with no way to recover the LEI automatically) or any
    // other entry missing a validly-formed LEI.
    const cleaned = list.filter((c) => c && typeof c.lei === 'string' && LEI_RE.test(c.lei.toUpperCase()));
    if (cleaned.length !== list.length) saveWatchlist(cleaned);
    return cleaned;
  } catch {
    return [];
  }
}

function saveWatchlist(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// Ensures the server's default companies (config/watchlist.js, via
// /api/watchlist) are present every time the page starts up, not just on
// first visit - any missing default is merged back in on every load, so
// removing one via the UI only lasts until the next reload. Companies you've
// added beyond the defaults are left untouched either way. If the fetch
// fails, this just leaves whatever's already in localStorage alone.
async function initWatchlist() {
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
    // Leave localStorage as-is - proceed with whatever's already there.
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
    return { days: Number.isNaN(days) ? 7 : days, categories, autoRefreshMinutes };
  } catch {
    return { days: 7, categories: DEFAULT_CATEGORIES, autoRefreshMinutes: 0 };
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

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  // Cap so this can't grow unbounded over months of use - Set iteration
  // preserves insertion order, so slicing from the end keeps the most
  // recently seen entries.
  const arr = [...set].slice(-MAX_SEEN);
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
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

function getNotifyEmail() {
  return (localStorage.getItem(NOTIFY_EMAIL_KEY) || '').trim();
}

function setNotifyEmail(email) {
  localStorage.setItem(NOTIFY_EMAIL_KEY, email.trim());
}

function renderNotifyEmailDisplay() {
  const el = document.getElementById('notify-email-display');
  el.textContent = getNotifyEmail() || 'not set';
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
      renderNotifyEmailDisplay();
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function renderWatchlist() {
  const listEl = document.getElementById('company-list');
  const watchlist = loadWatchlist();

  listEl.innerHTML = '';
  for (const company of watchlist) {
    const li = document.createElement('li');
    li.className = 'company-tag';
    li.innerHTML = `
      <span>${escapeHtml(company.name || company.lei)}${company.name ? ` <span class="lei">(${escapeHtml(company.lei)})</span>` : ''}</span>
      <button type="button" class="history-company" data-lei="${escapeHtml(company.lei)}" data-name="${escapeHtml(company.name || company.lei)}" aria-label="Filing history" title="Filing history">&#128337;</button>
      <button type="button" class="remove-company" data-lei="${escapeHtml(company.lei)}" aria-label="Remove">&times;</button>
    `;
    listEl.appendChild(li);
  }

  listEl.querySelectorAll('.remove-company').forEach((btn) => {
    btn.addEventListener('click', () => {
      const remaining = loadWatchlist().filter((c) => c.lei !== btn.dataset.lei);
      saveWatchlist(remaining);
      renderWatchlist();
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
  renderWatchlist();
  return true;
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
    renderWatchlist();
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
    const titleHtml = report.url
      ? `<a href="${escapeHtml(report.url)}" target="_blank" rel="noopener" class="report-title-link">${escapeHtml(report.title)}</a>`
      : escapeHtml(report.title);

    tr.innerHTML = `
      <td class="col-company">${escapeHtml(report.company)}</td>
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
          body: JSON.stringify({ ...report, to: email }),
        });
        const result = await res.json();
        statusSpan.textContent = result.ok ? 'Notification sent' : `Failed: ${result.error || res.status}`;
      } catch (err) {
        statusSpan.textContent = `Failed: ${err}`;
      } finally {
        btn.disabled = false;
      }
    });

    listEl.appendChild(tr);
  }
}

// Merges companies/settings carried in the URL's query string (see
// syncUrlWithState, called at the end of every successful loadReports())
// into whatever's already saved - purely additive for companies (never
// removes or replaces an existing one), so opening someone's shared link
// can only add to your list, never silently clobber it. Settings
// (days/categories) are overwritten since that's just a view preference,
// not data, and easily changed back via the form.
function parseLeisFromParam(param) {
  return [...new Set((param || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => LEI_RE.test(s)))];
}

function adoptUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const urlLeis = parseLeisFromParam(params.get('leis'));
  const daysParam = parseInt(params.get('days'), 10);
  const categoriesParam = (params.get('categories') || '').split(',').map((s) => s.trim()).filter(Boolean);

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

  if (!Number.isNaN(daysParam) || categoriesParam.length > 0) {
    const settings = loadSettings();
    saveSettings({
      days: Number.isNaN(daysParam) ? settings.days : daysParam,
      categories: categoriesParam.length ? categoriesParam : settings.categories,
      autoRefreshMinutes: settings.autoRefreshMinutes,
    });
  }
}

function syncUrlWithState(params) {
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

async function loadReports() {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('reports');
  const debugEl = document.getElementById('debug');
  const feedLink = document.getElementById('feed-link');
  const watchlist = loadWatchlist();
  const settings = loadSettings();

  listEl.innerHTML = '';
  debugEl.textContent = '';
  lastReports = [];
  lastNewKeys = new Set();

  if (watchlist.length === 0) {
    statusEl.textContent = 'Add a company LEI above to see its reports.';
    feedLink.removeAttribute('href');
    return;
  }

  statusEl.textContent = 'Loading…';

  try {
    const leis = watchlist.map((c) => c.lei).join(',');
    const params = new URLSearchParams({
      leis,
      days: String(settings.days),
      categories: settings.categories.join(','),
    });
    feedLink.href = `/api/feed?${params.toString()}`;
    syncUrlWithState(params);

    const res = await fetch(`/api/reports?${params.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      if (data.details) debugEl.textContent = JSON.stringify(data.details, null, 2);
      return;
    }

    const cachedCount = (data.cachedLeis || []).length;
    const refreshedAt = new Date().toLocaleTimeString();
    statusEl.textContent = `${data.count} report(s) found in the last ${data.days} day(s) (scanned ${data.scanned} item(s) across ${watchlist.length} compan${watchlist.length === 1 ? 'y' : 'ies'}, matching: ${data.categories.join(', ')}). Refreshed at ${refreshedAt}${cachedCount ? ` (${cachedCount} of ${watchlist.length} from cache)` : ''}.`;

    const namesByLei = new Map(watchlist.map((c) => [c.lei, c.name]));
    const resolvedReports = data.reports.map((r) => ({
      ...r,
      company: (namesByLei.get(r.lei) || '').trim() || r.company,
    }));
    lastReports = resolvedReports;

    const seenBefore = loadSeen();
    const isBaseline = seenBefore.size === 0;
    const newReports = resolvedReports.filter((r) => !seenBefore.has(reportKey(r)));
    lastNewKeys = isBaseline ? new Set() : new Set(newReports.map(reportKey));

    renderReportsList();

    const updatedSeen = new Set(seenBefore);
    for (const report of resolvedReports) updatedSeen.add(reportKey(report));
    saveSeen(updatedSeen);

    if (!isBaseline && newReports.length > 0) {
      notifyNewReports(newReports, settings);
    }

    // Every item the NSM search returned for these companies in the
    // selected time period (matched or not) - since company_lei actually
    // filters server-side, this is a short, focused list rather than a
    // market-wide dump.
    debugEl.textContent = JSON.stringify(data.scannedItems || [], null, 2);
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err}`;
  }
}

function renderHistoryItems(items, statusSuffix) {
  const listEl = document.getElementById('history-list');
  const statusEl = document.getElementById('history-status');

  statusEl.textContent = (items.length
    ? `${items.length} filing(s) in the last 365 days.`
    : 'No filings found in the last 365 days.') + statusSuffix;

  listEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    const date = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString() : 'Unknown date';
    const typeHtml = item.url
      ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.type || 'Unknown type')}</a>`
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
  const listEl = document.getElementById('history-list');
  const statusEl = document.getElementById('history-status');

  titleEl.textContent = `Filing history: ${displayName}`;
  overlay.hidden = false;

  const cache = loadHistoryCache();
  const cached = cache[lei];
  const now = Date.now();

  if (!force && cached && now - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    const cachedAt = new Date(cached.fetchedAt).toLocaleTimeString();
    renderHistoryItems(cached.items, ` (cached, loaded at ${cachedAt} — hit Refresh for the latest)`);
    return;
  }

  listEl.innerHTML = '';
  statusEl.textContent = 'Loading…';

  try {
    const params = new URLSearchParams({ leis: lei, days: '365' });
    const res = await fetch(`/api/reports?${params.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      return;
    }

    const items = (data.scannedItems || []).slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    cache[lei] = { items, fetchedAt: now };
    saveHistoryCache(cache);

    renderHistoryItems(items, '');
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err}`;
  }
}

document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-overlay').hidden = true;
});

document.getElementById('history-refresh').addEventListener('click', () => {
  if (currentHistoryLei) openHistoryOverlay(currentHistoryLei, currentHistoryName, { force: true });
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

document.getElementById('refresh').addEventListener('click', loadReports);
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

document.getElementById('bulk-resolve-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('bulk-status');
  const inputEl = document.getElementById('bulk-isin-input');
  const isins = [...new Set(inputEl.value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];

  if (isins.length === 0) return;

  statusEl.textContent = `Resolving ${isins.length} ISIN(s)…`;

  try {
    const res = await fetch(`/api/resolve?isins=${encodeURIComponent(isins.join(','))}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      return;
    }

    const watchlist = loadWatchlist();
    const existingLeis = new Set(watchlist.map((c) => c.lei));
    const lines = [];
    let added = 0;

    for (const r of data.results) {
      if (r.error) {
        lines.push(`✗ ${r.isin}: ${r.error}`);
        continue;
      }
      if (existingLeis.has(r.lei)) {
        lines.push(`- ${r.isin}: already in your list (${r.name || r.lei})`);
        continue;
      }
      watchlist.push({ lei: r.lei, name: r.name || '' });
      existingLeis.add(r.lei);
      lines.push(`✓ ${r.isin} → ${r.name || r.lei}`);
      added++;
    }

    saveWatchlist(watchlist);
    renderWatchlist();
    statusEl.textContent = lines.join('\n');
    if (added > 0) {
      inputEl.value = '';
      loadReports();
    }
  } catch (err) {
    statusEl.textContent = `Failed to resolve: ${err}`;
  }
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
  const autoRefreshSelect = document.getElementById('auto-refresh-select');
  const settings = loadSettings();

  daysSelect.value = String(settings.days);
  autoRefreshSelect.value = String(settings.autoRefreshMinutes);

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
    const autoRefreshMinutes = parseInt(autoRefreshSelect.value, 10) || 0;

    if (autoRefreshMinutes > 0 && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    const newSettings = {
      days: parseInt(daysSelect.value, 10),
      categories: gatherCategories(),
      autoRefreshMinutes,
    };
    saveSettings(newSettings);
    setupAutoRefresh(newSettings);
    loadReports();
  });

  document.getElementById('categories-reset').addEventListener('click', () => {
    for (const value of KNOWN_CATEGORIES) {
      const checkbox = document.querySelector(`#categories-fieldset input[value="${CSS.escape(value)}"]`);
      if (checkbox) checkbox.checked = DEFAULT_CATEGORIES.includes(value);
    }
    categoriesOtherInput.value = '';
  });

  setupAutoRefresh(settings);
}

function initReportControls() {
  document.getElementById('sort-select').value = loadSort();
}

document.getElementById('notify-email-change').addEventListener('click', () => {
  openNotifyEmailOverlay();
});

(async () => {
  initTheme();
  adoptUrlParams();
  await initWatchlist();
  initSettingsForm();
  initReportControls();
  renderWatchlist();
  renderNotifyEmailDisplay();
  loadReports();
})();
