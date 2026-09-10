// Vercel Node serverless function: GET /api/feed?leis=<a,b,c>&days=<n>&categories=<a,b,c>
// Same query params as /api/reports, returned as an RSS 2.0 feed instead of
// JSON, so any feed reader can watch this list without the app needing its
// own notification/email pipeline.
const { fetchReports } = require('../lib/fetchReports');
const { buildRssFeed } = require('../lib/buildFeed');

module.exports = async (req, res) => {
  const q = req.query || {};
  const { status, body } = await fetchReports({ leis: q.leis, days: q.days, categories: q.categories });

  if (status !== 200) {
    res.status(status).json(body);
    return;
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const siteUrl = `${proto}://${req.headers.host}/`;
  const feedUrl = `${proto}://${req.headers.host}${req.url}`;

  const xml = buildRssFeed({
    reports: body.reports,
    feedUrl,
    siteUrl,
    title: 'RNS Update',
    description: `Report disclosures for ${body.leis.length} compan${body.leis.length === 1 ? 'y' : 'ies'}, matching: ${body.categories.join(', ')}`,
  });

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.status(200).send(xml);
};
