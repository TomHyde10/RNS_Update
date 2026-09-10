// Vercel Node serverless function: POST /api/summarise
// Body: { url, company, title, category } - the report to fetch and
// summarise via a self-hosted LLM (see lib/summarise.js).
const { summariseReport } = require('../lib/summarise');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
  }

  const result = await summariseReport(body || {});
  res.status(result.ok ? 200 : 502).json(result);
};
