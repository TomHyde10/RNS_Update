// Vercel Node serverless function: GET /api/reports?leis=<a,b,c>&days=<n>&categories=<a,b,c>
const { fetchReports } = require('../lib/fetchReports');

module.exports = async (req, res) => {
  const q = req.query || {};
  const { status, body } = await fetchReports({ leis: q.leis, days: q.days, categories: q.categories });
  res.status(status).json(body);
};
