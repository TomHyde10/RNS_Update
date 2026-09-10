// Vercel Node serverless function: GET /api/watchlist
// Returns config/watchlist.js's list so the page can seed a fresh browser's
// localStorage with it on first visit (see initWatchlist() in app.js).
const watchlist = require('../config/watchlist');

module.exports = async (req, res) => {
  res.status(200).json({ companies: watchlist });
};
