// Vercel Node serverless function: POST /api/notify
// Body: { lei, id, title, publishedAt, to } - identifiers used to look up
// and re-verify the report server-side (see findReport() in
// lib/fetchReports.js), plus the recipient address. The email's actual
// subject/body/attachment are always built from that authoritative lookup,
// never from client-supplied text, so a POST can't be used to mail
// arbitrary attacker-authored content or fetch an arbitrary attachment URL.
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
