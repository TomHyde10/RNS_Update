// Vercel Node serverless function: GET /api/reports?leis=<a,b,c>
const { fetchReports } = require('../lib/fetchReports');

module.exports = async (req, res) => {
  const { status, body } = await fetchReports({ leis: req.query && req.query.leis });
  res.status(status).json(body);
};
