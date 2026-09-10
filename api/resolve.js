// Vercel Node serverless function: GET /api/resolve?isins=<a,b,c>
const { resolveIsins } = require('../lib/resolveIsin');

module.exports = async (req, res) => {
  const raw = (req.query && req.query.isins) || '';
  const isins = String(raw)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (isins.length === 0) {
    res.status(400).json({ error: 'No isins provided' });
    return;
  }

  const results = await resolveIsins(isins);
  res.status(200).json({ results });
};
