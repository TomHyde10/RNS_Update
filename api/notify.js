// Vercel Node serverless function: POST /api/notify
// Body: { company, title, category, publishedAt, url, lei } - the report to
// email a notification about.
const { sendNotification } = require('../lib/sendNotification');

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

  const result = await sendNotification(body || {});
  res.status(result.ok ? 200 : 502).json(result);
};
