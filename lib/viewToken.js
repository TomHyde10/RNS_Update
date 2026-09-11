// Encrypted view links: with VIEW_TOKEN_SECRET set, the shareable
// address-bar URL, the RSS feed link, and the app's own /api/reports requests
// carry one opaque `v` token instead of readable leis/days/categories params,
// so which companies you watch doesn't show up in browser history, hosting
// request logs, screenshots, or link previews. The key never leaves the
// server, and AES-256-GCM means an edited or truncated token fails to open
// rather than decrypting to some other view.
//
// This hides a link's contents from anyone who only sees the URL - not from
// whoever opens it (the server decrypts it for them; APP_PASSWORD remains the
// actual access control). Changing VIEW_TOKEN_SECRET invalidates every
// existing token. Optional: with no secret, sealing returns `token: null` and
// the frontend keeps using readable params, which stay accepted either way.
const crypto = require('crypto');
const zlib = require('zlib');
const { parseLeis, parseWindowDays, parseCategories } = require('./fetchReports');

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SECRET_LENGTH = 32;
const MAX_TOKEN_LENGTH = 8192;
const MAX_PAYLOAD_BYTES = 64 * 1024;

function getKey() {
  const secret = process.env.VIEW_TOKEN_SECRET;
  if (!secret) {
    return { status: 501, error: "Encrypted view links aren't enabled on this deployment (VIEW_TOKEN_SECRET isn't set)." };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return { status: 500, error: `VIEW_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters.` };
  }
  return { key: Buffer.from(crypto.hkdfSync('sha256', secret, 'rns-update', 'view-token', 32)) };
}

// Same validation /api/reports applies to readable params, so a token only
// ever holds values that request could have used anyway.
function normalizeView(input) {
  const { leis, days, categories } = input && typeof input === 'object' ? input : {};
  return { leis: parseLeis(leis), days: parseWindowDays(days), categories: parseCategories(categories).list };
}

// Token layout (base64url): version byte | 12-byte IV | ciphertext | 16-byte
// GCM tag, with the version byte authenticated as AAD. LEIs are fixed-length
// so they're packed without separators, and the payload is deflated before
// encrypting - together that keeps a 20-odd company token shorter than the
// readable query string it replaces.
function sealView(input) {
  const { key, status, error } = getKey();
  // No secret isn't an error when sealing - it just means readable params
  // (and not a failed request logged on every page load).
  if (status === 501) return { token: null };
  if (error) return { status, error };

  const view = normalizeView(input);
  const payload = zlib.deflateRawSync(JSON.stringify({ l: view.leis.join(''), d: view.days, c: view.categories }));

  const header = Buffer.from([VERSION]);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);

  return { token: Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]).toString('base64url') };
}

function openView(token) {
  const { key, status, error } = getKey();
  if (error) return { status, error };

  const invalid = {
    status: 400,
    error: 'Invalid view link - it may be incomplete, or VIEW_TOKEN_SECRET has changed since it was created.',
  };
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return invalid;

  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 1 + IV_BYTES + TAG_BYTES || buf[0] !== VERSION) return invalid;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(buf.subarray(0, 1));
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    const payload = Buffer.concat([decipher.update(buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]);
    const data = JSON.parse(zlib.inflateRawSync(payload, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8'));
    return { view: normalizeView({ leis: String(data.l || '').match(/.{20}/g) || [], days: data.d, categories: data.c }) };
  } catch {
    return invalid;
  }
}

// For /api/reports and /api/feed: the view from an encrypted `v` param when
// present, otherwise the readable leis/days/categories params as before.
// `get` reads one query param by name.
function resolveReportQuery(get) {
  const token = get('v');
  if (token == null || token === '') {
    return { query: { leis: get('leis'), days: get('days'), categories: get('categories') } };
  }
  const { view, status, error } = openView(token);
  return error ? { status, error } : { query: view };
}

module.exports = { sealView, openView, resolveReportQuery };
