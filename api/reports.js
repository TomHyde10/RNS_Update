// Vercel Node serverless function: GET /api/reports?leis=<a,b,c>&days=<n>&categories=<a,b,c>
// or GET /api/reports?v=<encrypted view token> (see lib/viewToken.js).
const { fetchReports } = require('../lib/fetchReports');
const { resolveReportQuery } = require('../lib/viewToken');

module.exports = async (req, res) => {
  const q = req.query || {};
  const resolved = resolveReportQuery((key) => q[key]);
  const { status, body } = resolved.error
    ? { status: resolved.status, body: { error: resolved.error } }
    : await fetchReports(resolved.query);
  res.status(status).json(body);
};
