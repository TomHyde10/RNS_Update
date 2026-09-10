// Vercel Node serverless function: GET /api/reports?isins=<a,b,c>
const { fetchReports } = require('../lib/fetchReports');

module.exports = async (req, res) => {
  const { status, body } = await fetchReports({ isins: req.query && req.query.isins });
  res.status(status).json(body);
};
