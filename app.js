const STORAGE_KEY = 'rns-watchlist';
const SETTINGS_KEY = 'rns-settings';
const SEEN_KEY = 'rns-seen-reports';
const LEI_RE = /^[A-Z0-9]{20}$/;
const DEFAULT_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report'];
const KNOWN_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report', 'Net Asset Value(s)', 'Dividend Declaration'];
const MAX_SEEN = 1000;

let lastReports = [];
let autoRefreshTimer = null;

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
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rns-reports-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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

    if (data.count === 0) {
      listEl.innerHTML = '<li class="empty">No matching reports in the selected time period.</li>';
    }

    const namesByLei = new Map(watchlist.map((c) => [c.lei, c.name]));
    const resolvedReports = data.reports.map((r) => ({
      ...r,
      company: (namesByLei.get(r.lei) || '').trim() || r.company,
    }));
    lastReports = resolvedReports;

    const seenBefore = loadSeen();
    const isBaseline = seenBefore.size === 0;
    const newReports = resolvedReports.filter((r) => !seenBefore.has(reportKey(r)));

    for (const report of resolvedReports) {
      const li = document.createElement('li');
      const isNew = !isBaseline && !seenBefore.has(reportKey(report));
      li.className = isNew ? 'report report-new' : 'report';
      const date = report.publishedAt ? new Date(report.publishedAt).toLocaleString() : 'Unknown date';
      const titleHtml = report.url
        ? `<a href="${escapeHtml(report.url)}" target="_blank" rel="noopener">${escapeHtml(report.title)}</a>`
        : escapeHtml(report.title);

      li.innerHTML = `
        <div class="report-company">${escapeHtml(report.company)}${isNew ? '<span class="new-badge">NEW</span>' : ''}</div>
        <div class="report-title">${titleHtml}</div>
        <div class="report-meta">${escapeHtml(report.category || '')} · ${escapeHtml(date)}</div>
      `;
      listEl.appendChild(li);
    }

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

async function openHistoryOverlay(lei, displayName) {
  const overlay = document.getElementById('history-overlay');
  const titleEl = document.getElementById('history-title');
  const listEl = document.getElementById('history-list');
  const statusEl = document.getElementById('history-status');

  titleEl.textContent = `Filing history: ${displayName}`;
  listEl.innerHTML = '';
  statusEl.textContent = 'Loading…';
  overlay.hidden = false;

  try {
    const params = new URLSearchParams({ leis: lei, days: '365' });
    const res = await fetch(`/api/reports?${params.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      return;
    }

    const items = (data.scannedItems || []).slice().sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    statusEl.textContent = items.length
      ? `${items.length} filing(s) in the last 365 days.`
      : 'No filings found in the last 365 days.';

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
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err}`;
  }
}

document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-overlay').hidden = true;
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

(async () => {
  await initWatchlist();
  initSettingsForm();
  renderWatchlist();
  loadReports();
})();
