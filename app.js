const STORAGE_KEY = 'rns-watchlist';
const SETTINGS_KEY = 'rns-settings';
const LEI_RE = /^[A-Z0-9]{20}$/;
const DEFAULT_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report'];

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

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const days = parseInt(parsed.days, 10);
    const categories = Array.isArray(parsed.categories) && parsed.categories.length ? parsed.categories : DEFAULT_CATEGORIES;
    return { days: Number.isNaN(days) ? 7 : days, categories };
  } catch {
    return { days: 7, categories: DEFAULT_CATEGORIES };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

async function loadReports() {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('reports');
  const debugEl = document.getElementById('debug');
  const watchlist = loadWatchlist();
  const settings = loadSettings();

  listEl.innerHTML = '';
  debugEl.textContent = '';

  if (watchlist.length === 0) {
    statusEl.textContent = 'Add a company LEI above to see its reports.';
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
    const res = await fetch(`/api/reports?${params.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      if (data.details) debugEl.textContent = JSON.stringify(data.details, null, 2);
      return;
    }

    statusEl.textContent = `${data.count} report(s) found in the last ${data.days} day(s) (scanned ${data.scanned} item(s) across ${watchlist.length} compan${watchlist.length === 1 ? 'y' : 'ies'}, matching: ${data.categories.join(', ')}).`;

    if (data.count === 0) {
      listEl.innerHTML = '<li class="empty">No matching reports in the selected time period.</li>';
    }

    const namesByLei = new Map(watchlist.map((c) => [c.lei, c.name]));

    for (const report of data.reports) {
      const li = document.createElement('li');
      li.className = 'report';
      const date = report.publishedAt ? new Date(report.publishedAt).toLocaleString() : 'Unknown date';
      const company = (namesByLei.get(report.lei) || '').trim() || report.company;
      const titleHtml = report.url
        ? `<a href="${escapeHtml(report.url)}" target="_blank" rel="noopener">${escapeHtml(report.title)}</a>`
        : escapeHtml(report.title);

      li.innerHTML = `
        <div class="report-company">${escapeHtml(company)}</div>
        <div class="report-title">${titleHtml}</div>
        <div class="report-meta">${escapeHtml(report.category || '')} · ${escapeHtml(date)}</div>
      `;
      listEl.appendChild(li);
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

function initSettingsForm() {
  const daysSelect = document.getElementById('days-select');
  const categoriesInput = document.getElementById('categories-input');
  const settings = loadSettings();

  daysSelect.value = String(settings.days);
  categoriesInput.value = settings.categories.join(', ');

  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const categories = categoriesInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    saveSettings({
      days: parseInt(daysSelect.value, 10),
      categories: categories.length ? categories : DEFAULT_CATEGORIES,
    });
    loadReports();
  });

  document.getElementById('categories-reset').addEventListener('click', () => {
    categoriesInput.value = DEFAULT_CATEGORIES.join(', ');
  });
}

initSettingsForm();

renderWatchlist();
loadReports();
