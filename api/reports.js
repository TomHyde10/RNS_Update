// Vercel Node serverless function: GET /api/reports?isins=<a,b,c>&pageSize=200
const { fetchReports } = require('../lib/fetchReports');

module.exports = async (req, res) => {
  const { status, body } = await fetchReports({
    isins: req.query && req.query.isins,
    pageSize: req.query && req.query.pageSize,
  });
  res.status(status).json(body);
};
