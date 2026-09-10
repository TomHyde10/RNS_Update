// Builds a standard RSS 2.0 feed from the same report objects fetchReports()
// already produces - lets any feed reader (many of which can themselves
// email or push you) watch this without the app needing to run its own
// notification pipeline.
function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  }[c]));
}

function toRfc822(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

function itemGuid(report) {
  return report.id || `${report.lei}|${report.title}|${report.publishedAt}`;
}

function buildRssFeed({ reports, feedUrl, siteUrl, title, description }) {
  const items = reports
    .map((r) => {
      const link = r.url || siteUrl;
      const pubDate = toRfc822(r.publishedAt);
      return `    <item>
      <title>${escapeXml(`${r.company}: ${r.title}`)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(itemGuid(r))}</guid>
      ${pubDate ? `<pubDate>${pubDate}</pubDate>` : ''}
      <description>${escapeXml(`${r.category || ''} - ${r.company}`)}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(description)}</description>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}

module.exports = { buildRssFeed };
