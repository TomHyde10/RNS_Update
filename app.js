const STORAGE_KEY = 'rns-watchlist';
const ISIN_RE = /^[A-Z0-9]{12}$/;

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveWatchlist(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
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
      <span>${escapeHtml(company.name || company.isin)}${company.name ? ` <span class="isin">(${escapeHtml(company.isin)})</span>` : ''}</span>
      <button type="button" class="remove-company" data-isin="${escapeHtml(company.isin)}" aria-label="Remove">&times;</button>
    `;
    listEl.appendChild(li);
  }

  listEl.querySelectorAll('.remove-company').forEach((btn) => {
    btn.addEventListener('click', () => {
      const remaining = loadWatchlist().filter((c) => c.isin !== btn.dataset.isin);
      saveWatchlist(remaining);
      renderWatchlist();
      loadReports();
    });
  });
}

function addCompany(isin, name) {
  const errorEl = document.getElementById('isin-error');
  const normalisedIsin = isin.trim().toUpperCase();

  if (!ISIN_RE.test(normalisedIsin)) {
    errorEl.textContent = 'That doesn\'t look like a valid ISIN (12 letters/digits, e.g. GB00BK1PKQ95).';
    errorEl.hidden = false;
    return false;
  }

  const watchlist = loadWatchlist();
  if (watchlist.some((c) => c.isin === normalisedIsin)) {
    errorEl.textContent = 'That ISIN is already in your list.';
    errorEl.hidden = false;
    return false;
  }

  errorEl.hidden = true;
  watchlist.push({ isin: normalisedIsin, name: name.trim() });
  saveWatchlist(watchlist);
  renderWatchlist();
  return true;
}

async function loadReports() {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('reports');
  const debugEl = document.getElementById('debug');
  const watchlist = loadWatchlist();

  listEl.innerHTML = '';
  debugEl.textContent = '';

  if (watchlist.length === 0) {
    statusEl.textContent = 'Add a company ISIN above to see its reports.';
    return;
  }

  statusEl.textContent = 'Loading…';

  try {
    const isins = watchlist.map((c) => c.isin).join(',');
    const res = await fetch(`/api/reports?isins=${encodeURIComponent(isins)}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      if (data.details) debugEl.textContent = data.details;
      return;
    }

    statusEl.textContent = `${data.count} report(s) found since ${data.dateFrom} (scanned ${data.scanned} recent RNS item(s)).`;

    if (data.count === 0) {
      listEl.innerHTML = '<li class="empty">No half-year or annual reports in the last week.</li>';
    }

    const namesByIsin = new Map(watchlist.map((c) => [c.isin, c.name]));

    for (const report of data.reports) {
      const li = document.createElement('li');
      li.className = 'report';
      const date = report.publishedAt ? new Date(report.publishedAt).toLocaleString() : 'Unknown date';
      const company = (namesByIsin.get(report.isin) || '').trim() || report.company;
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

    if (data.reports[0]) {
      debugEl.textContent = JSON.stringify(data.reports[0].raw, null, 2);
    }
  } catch (err) {
    statusEl.textContent = `Failed to load: ${err}`;
  }
}

document.getElementById('add-company-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const isinInput = document.getElementById('isin-input');
  const nameInput = document.getElementById('name-input');

  if (addCompany(isinInput.value, nameInput.value)) {
    isinInput.value = '';
    nameInput.value = '';
    isinInput.focus();
    loadReports();
  }
});

document.getElementById('refresh').addEventListener('click', loadReports);

renderWatchlist();
loadReports();
