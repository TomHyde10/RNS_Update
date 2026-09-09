async function loadReports() {
  const statusEl = document.getElementById('status');
  const listEl = document.getElementById('reports');
  const debugEl = document.getElementById('debug');

  statusEl.textContent = 'Loading…';
  listEl.innerHTML = '';
  debugEl.textContent = '';

  try {
    const res = await fetch('/api/reports');
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      if (data.details) debugEl.textContent = data.details;
      return;
    }

    statusEl.textContent = `${data.count} financial report(s) found (scanned ${data.scanned} recent RNS items).`;

    if (data.count === 0) {
      listEl.innerHTML = '<li class="empty">No matching financial reports yet.</li>';
    }

    for (const report of data.reports) {
      const li = document.createElement('li');
      li.className = 'report';
      const date = report.publishedAt ? new Date(report.publishedAt).toLocaleString() : 'Unknown date';
      const titleHtml = report.url
        ? `<a href="${escapeHtml(report.url)}" target="_blank" rel="noopener">${escapeHtml(report.title)}</a>`
        : escapeHtml(report.title);

      li.innerHTML = `
        <div class="report-company">${escapeHtml(report.company)}</div>
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

document.getElementById('refresh').addEventListener('click', loadReports);
loadReports();
