// Vercel Node serverless function: GET /api/reports?pageSize=200
const { fetchReports } = require('../lib/fetchReports');

module.exports = async (req, res) => {
  const { status, body } = await fetchReports({ pageSize: req.query && req.query.pageSize });
  res.status(status).json(body);
};
