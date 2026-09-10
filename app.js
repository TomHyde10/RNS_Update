const STORAGE_KEY = 'rns-watchlist';
const LEI_RE = /^[A-Z0-9]{20}$/;

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

  listEl.innerHTML = '';
  debugEl.textContent = '';

  if (watchlist.length === 0) {
    statusEl.textContent = 'Add a company LEI above to see its reports.';
    return;
  }

  statusEl.textContent = 'Loading…';

  try {
    const leis = watchlist.map((c) => c.lei).join(',');
    const res = await fetch(`/api/reports?leis=${encodeURIComponent(leis)}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      if (data.details) debugEl.textContent = JSON.stringify(data.details, null, 2);
      return;
    }

    statusEl.textContent = `${data.count} report(s) found since ${data.dateFrom} (scanned ${data.scanned} item(s) across ${watchlist.length} compan${watchlist.length === 1 ? 'y' : 'ies'}).`;

    if (data.count === 0) {
      listEl.innerHTML = '<li class="empty">No half-year or annual reports in the last week.</li>';
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

    // Every item the NSM search returned for these companies this week
    // (matched or not) - since company_lei actually filters server-side,
    // this is a short, focused list rather than a market-wide dump.
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

renderWatchlist();
loadReports();
