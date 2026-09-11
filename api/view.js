// Vercel Node serverless function for encrypted view links (see lib/viewToken.js):
//   POST /api/view  (application/json { leis, days, categories }) -> { token } (null without VIEW_TOKEN_SECRET)
//   GET  /api/view?v=<token>                                     -> { leis, days, categories }
const { sealView, openView } = require('../lib/viewToken');

module.exports = (req, res) => {
  if (req.method === 'GET') {
    const { view, status, error } = openView((req.query || {}).v);
    if (error) {
      res.status(status).json({ error });
      return;
    }
    res.status(200).json(view);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Same Content-Type rule as api/notify.js.
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    res.status(415).json({ error: 'Content-Type must be application/json' });
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

  const { token, status, error } = sealView(body);
  if (error) {
    res.status(status).json({ error });
    return;
  }
  res.status(200).json({ token });
};
