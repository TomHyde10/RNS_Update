// Minimal local dev server: serves the static frontend and mounts /api/reports,
// so the site can be run with just `node server.js` (no Vercel CLI needed).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// Some platforms (e.g. Northflank on certain plans) only support mounting
// secret *files* into the container, not secret environment variables. For
// each of these optional config values, if a real env var isn't already
// set, fall back to reading one from a file named after it under
// SECRET_FILE_DIR (default /etc/secrets) - the file's whole trimmed content
// becomes the value. Mount your secret file at e.g. /etc/secrets/RESEND_API_KEY
// (exact name, no extension) in the platform's UI and this picks it up with
// no environment variable needed at all. A real env var, if set, always wins.
// Runs before the lib/ requires below, since lib/cacheStore.js reads
// DATABASE_URL at load time.
const SECRET_FILE_DIR = process.env.SECRET_FILE_DIR || '/etc/secrets';
for (const key of ['RESEND_API_KEY', 'NOTIFY_EMAIL_FROM', 'NOTIFY_EMAIL_TO', 'DATABASE_URL', 'DATABASE_SSL_CA', 'APP_USERNAME', 'APP_PASSWORD', 'VIEW_TOKEN_SECRET']) {
  if (process.env[key]) continue;
  try {
    process.env[key] = fs.readFileSync(path.join(SECRET_FILE_DIR, key), 'utf8').trim();
  } catch {
    // No secret file for this key - leave it unset, same as not configuring it.
  }
}

const { fetchReports, LEI_RE } = require('./lib/fetchReports');
const { buildRssFeed } = require('./lib/buildFeed');
const { sendNotification } = require('./lib/sendNotification');
const watchlist = require('./config/watchlist');
const { checkBasicAuth, REALM } = require('./lib/basicAuth');
const { sealView, openView, resolveReportQuery } = require('./lib/viewToken');
const subscriptionStore = require('./lib/subscriptionStore');
const { digestSendAllowed, sendDigestForSubscription } = require('./lib/sendDigest');
const digestScheduler = require('./lib/digestScheduler');
const watchlistStore = require('./lib/watchlistStore');

const PORT = process.env.PORT || 3000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// How often the process checks whether any subscription is due - not the
// subscriptions' own frequency (every hour/day/week, set per-subscription
// and stored in notification_subscriptions.frequency_minutes), just how
// finely that due-check is polled.
const DIGEST_CHECK_INTERVAL_MS = 5 * 60 * 1000;

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html' },
  '/index.html': { file: 'index.html', type: 'text/html' },
  '/style.css': { file: 'style.css', type: 'text/css' },
  '/app.js': { file: 'app.js', type: 'text/javascript' },
};

// Reads a POST's JSON body and passes it to onBody, or responds with an error
// itself. Any non-JSON Content-Type is rejected first: browsers resend cached
// Basic Auth credentials automatically, so a cross-site <form> post
// (text/plain, urlencoded, multipart - no CORS preflight) could otherwise act
// as a logged-in visitor. Requiring application/json forces a preflight,
// which never succeeds here (preflights carry no credentials, and no CORS
// headers are sent).
function readJsonBody(req, res, onBody) {
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    return;
  }

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    onBody(body);
  });
}

const server = http.createServer(async (req, res) => {
  // Gated on every request, before any routing - protects the static
  // frontend and every /api/* route alike. No-op (always passes) when
  // APP_PASSWORD isn't set, so this doesn't affect a deployment that hasn't
  // opted in. See lib/basicAuth.js.
  if (!checkBasicAuth(req.headers['authorization'])) {
    res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${REALM}"`, 'Content-Type': 'text/plain' });
    res.end('Authentication required.');
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host}`);

  if (parsed.pathname === '/api/reports') {
    const resolved = resolveReportQuery((key) => parsed.searchParams.get(key));
    const { status, body } = resolved.error
      ? { status: resolved.status, body: { error: resolved.error } }
      : await fetchReports(resolved.query);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  if (parsed.pathname === '/api/feed') {
    const resolved = resolveReportQuery((key) => parsed.searchParams.get(key));
    const { status, body } = resolved.error
      ? { status: resolved.status, body: { error: resolved.error } }
      : await fetchReports(resolved.query);

    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    const siteUrl = `http://${req.headers.host}/`;
    const feedUrl = `http://${req.headers.host}${req.url}`;
    const xml = buildRssFeed({
      reports: body.reports,
      feedUrl,
      siteUrl,
      title: 'RNS Update',
      description: `Report disclosures for ${body.leis.length} compan${body.leis.length === 1 ? 'y' : 'ies'}, matching: ${body.categories.join(', ')}`,
    });
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(xml);
    return;
  }

  if (parsed.pathname === '/api/watchlist') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ companies: watchlist }));
    return;
  }

  // The user's actual, editable watchlist (distinct from the hardcoded
  // defaults above) - shared across every visitor once DATABASE_URL is
  // set, so a rename/add/remove is permanent regardless of device or
  // browser. app.js falls back to localStorage itself when `enabled` is
  // false here, exactly like the notification subscriptions' own
  // enabled/disabled split.
  if (parsed.pathname === '/api/companies' && req.method === 'GET') {
    if (!watchlistStore.enabled) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: false, companies: [] }));
      return;
    }
    try {
      const companies = await watchlistStore.listCompanies();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, companies }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to load companies: ${err.message || err}` }));
    }
    return;
  }

  // Full-list replace, matching the client's own saveWatchlist(list)
  // exactly - the whole desired list is sent every time (add/rename/
  // toggle/remove/bulk-add/import all go through this one call), rather
  // than one endpoint per kind of edit.
  if (parsed.pathname === '/api/companies' && req.method === 'PUT') {
    readJsonBody(req, res, async (body) => {
      if (!watchlistStore.enabled) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'A shared watchlist needs a database on this deployment (DATABASE_URL is not set).' }));
        return;
      }
      const list = Array.isArray(body.companies) ? body.companies : [];
      const valid = list
        .filter((c) => c && typeof c.lei === 'string' && LEI_RE.test(c.lei.toUpperCase()))
        .map((c) => ({ lei: c.lei.toUpperCase(), name: typeof c.name === 'string' ? c.name.trim() : '', enabled: c.enabled !== false }));
      try {
        const companies = await watchlistStore.replaceCompanies(valid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ companies }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to save companies: ${err.message || err}` }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/view' && req.method === 'GET') {
    const { view, status, error } = openView(parsed.searchParams.get('v'));
    res.writeHead(error ? status : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(error ? { error } : view));
    return;
  }

  if (parsed.pathname === '/api/view' && req.method === 'POST') {
    readJsonBody(req, res, (body) => {
      const { token, status, error } = sealView(body);
      res.writeHead(error ? status : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error ? { error } : { token }));
    });
    return;
  }

  if (parsed.pathname === '/api/notify' && req.method === 'POST') {
    readJsonBody(req, res, async (body) => {
      const { status, ...result } = await sendNotification(body);
      res.writeHead(result.ok ? 200 : status || 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (parsed.pathname === '/api/subscriptions' && req.method === 'GET') {
    if (!subscriptionStore.enabled) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: false, subscriptions: [] }));
      return;
    }
    try {
      const subscriptions = await subscriptionStore.listSubscriptions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, subscriptions }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to load subscriptions: ${err.message || err}` }));
    }
    return;
  }

  if (parsed.pathname === '/api/subscriptions' && req.method === 'POST') {
    readJsonBody(req, res, async (body) => {
      if (!subscriptionStore.enabled) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Automatic email digests need a database on this deployment (DATABASE_URL is not set).' }));
        return;
      }

      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!EMAIL_RE.test(email)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "That doesn't look like a valid email address." }));
        return;
      }
      if (!digestSendAllowed(email)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Without APP_PASSWORD, this deployment only sends to its NOTIFY_EMAIL_TO address.' }));
        return;
      }

      try {
        const subscription = await subscriptionStore.createSubscription({
          email,
          frequencyMinutes: parseInt(body.frequencyMinutes, 10) || 0,
          prefs: body.prefs && typeof body.prefs === 'object' ? body.prefs : {},
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ subscription }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to save subscription: ${err.message || err}` }));
      }
    });
    return;
  }

  if (parsed.pathname.startsWith('/api/subscriptions/') && req.method === 'PUT') {
    const id = decodeURIComponent(parsed.pathname.slice('/api/subscriptions/'.length));
    readJsonBody(req, res, async (body) => {
      if (!subscriptionStore.enabled) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Automatic email digests need a database on this deployment (DATABASE_URL is not set).' }));
        return;
      }
      try {
        const subscription = await subscriptionStore.updateSubscription(id, {
          frequencyMinutes: parseInt(body.frequencyMinutes, 10) || 0,
          prefs: body.prefs && typeof body.prefs === 'object' ? body.prefs : {},
        });
        if (!subscription) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No subscription with that id.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ subscription }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Failed to save subscription: ${err.message || err}` }));
      }
    });
    return;
  }

  // Manually triggers a real send for one subscription right now, using the
  // same sendDigestForSubscription()+markSent() the scheduler itself calls -
  // not a fake "test" email, an actual early send, so someone setting up a
  // digest can confirm delivery/formatting works without waiting for its
  // frequency to come due. If nothing's matched since the last send, this
  // still returns 200 with sent:false - "nothing new right now" is a normal
  // outcome, not an error.
  if (parsed.pathname.startsWith('/api/subscriptions/') && parsed.pathname.endsWith('/send-now') && req.method === 'POST') {
    const id = decodeURIComponent(parsed.pathname.slice('/api/subscriptions/'.length, -'/send-now'.length));
    if (!subscriptionStore.enabled) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Automatic email digests need a database on this deployment (DATABASE_URL is not set).' }));
      return;
    }
    try {
      const subscriptions = await subscriptionStore.listSubscriptions();
      const subscription = subscriptions.find((s) => s.id === id);
      if (!subscription) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No subscription with that id.' }));
        return;
      }
      const result = await sendDigestForSubscription(subscription);
      const sentAt = new Date();
      await subscriptionStore.markSent(subscription.id, sentAt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...result, lastSentAt: sentAt.toISOString() }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to send: ${err.message || err}` }));
    }
    return;
  }

  if (parsed.pathname.startsWith('/api/subscriptions/') && req.method === 'DELETE') {
    const id = decodeURIComponent(parsed.pathname.slice('/api/subscriptions/'.length));
    if (!subscriptionStore.enabled) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Automatic email digests need a database on this deployment (DATABASE_URL is not set).' }));
      return;
    }
    try {
      await subscriptionStore.deleteSubscription(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to delete subscription: ${err.message || err}` }));
    }
    return;
  }

  const staticEntry = STATIC_FILES[parsed.pathname];
  if (!staticEntry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  fs.readFile(path.join(__dirname, staticEntry.file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': staticEntry.type });
    res.end(data);
  });
});

// Checks every subscription against its own frequency and sends any that
// are due. Runs from a plain setInterval rather than an external cron,
// since this process (unlike the Vercel serverless functions in api/*.js)
// stays alive between requests - see the "truly automatic" tradeoff noted
// in lib/subscriptionStore.js. A subscription's own due-ness is time-based
// (last_sent_at + its frequency), so a missed or delayed tick just sends
// slightly late rather than skipping content. The actual due-check/send
// logic lives in lib/digestScheduler.js (unit-tested there against a fake
// store and sender) - this just supplies the real ones.
function runDueDigests() {
  return digestScheduler.runDueDigests({ subscriptionStore, sendDigestForSubscription });
}

server.listen(PORT, () => {
  console.log(`RNS Update running at http://localhost:${PORT}`);
  if (subscriptionStore.enabled) {
    // unref() so this timer alone can't keep the process alive - in normal
    // operation the still-listening HTTP server already does that; this
    // just stops the interval from being a second, redundant reason to
    // stay up (and from blocking a clean exit in test/subscriptionsApi.test.js,
    // which closes the server between test files but has no handle on
    // this timer to clear otherwise).
    setInterval(runDueDigests, DIGEST_CHECK_INTERVAL_MS).unref();
    runDueDigests(); // catch up on anything due right after a cold start
  }
});

// Not used by the app itself (nothing else requires this file) - only so
// test/subscriptionsApi.test.js can await the real `listening` event
// instead of guessing with a timeout before firing requests at it.
module.exports = { server };
