// Shareable plan links: a whole plan - liabilities, tax rate, quotes, what you
// already hold - sealed into one opaque token that travels in the URL.
//
// A plan is a statement of what you owe and when, and roughly what you are
// worth. That does not belong in browser history, hosting request logs, a
// screenshot or a link preview, so the URL carries ciphertext rather than a
// readable query string. AES-256-GCM means an edited or truncated token fails
// to open rather than quietly decrypting to some other plan.
//
// This hides a link's contents from anyone who only sees the URL - not from
// whoever opens it, since the server decrypts it for them. APP_PASSWORD
// remains the actual access control.
//
// The secret is the host's VIEW_TOKEN_SECRET, so a deployment has one secret
// rather than two, but the HKDF `info` label differs from the RNS view token's.
// That gives a different key from the same secret: an RNS view link cannot be
// opened as a plan, or the reverse, even though both are base64url blobs of
// the same shape. Changing the secret invalidates every existing link.
const crypto = require('crypto');
const zlib = require('zlib');

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SECRET_LENGTH = 32;
// Long enough for a plan worth sharing, short enough to stay a usable URL.
// Anything bigger is a plan that wants saving server-side, not linking.
const MAX_TOKEN_LENGTH = 8192;
const MAX_PAYLOAD_BYTES = 256 * 1024;

function getKey() {
  const secret = process.env.VIEW_TOKEN_SECRET;
  if (!secret) {
    return {
      status: 501,
      error: "Shareable plan links aren't enabled on this deployment (VIEW_TOKEN_SECRET isn't set).",
    };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return { status: 500, error: `VIEW_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters.` };
  }
  return { key: Buffer.from(crypto.hkdfSync('sha256', secret, 'rns-update', 'gilt-ladder-plan', 32)) };
}

const num = (value) => (value == null || value === '' ? null : Number(value));

// Only these fields are carried. A token seals what the server chose to seal,
// never whatever shape the caller happened to post: an unknown key in, an
// unknown key out, and the request body would become an open channel into
// buildLadder's options.
function normalizePlan(input) {
  const plan = input && typeof input === 'object' ? input : {};
  return {
    liabilities: (Array.isArray(plan.liabilities) ? plan.liabilities : []).map((l) => ({
      date: String((l && l.date) || ''),
      amount: num(l && l.amount),
      ...(l && l.repeat
        ? { repeat: { every: String(l.repeat.every || ''), count: num(l.repeat.count) } }
        : {}),
      ...(l && l.escalation ? { escalation: num(l.escalation) } : {}),
    })),
    observedPrices: (Array.isArray(plan.observedPrices) ? plan.observedPrices : []).map((p) => ({
      isin: String((p && p.isin) || '').trim().toUpperCase(),
      clean: num(p && p.clean),
    })),
    existingHoldings: (Array.isArray(plan.existingHoldings) ? plan.existingHoldings : []).map((h) => ({
      isin: String((h && h.isin) || '').trim().toUpperCase(),
      nominal: num(h && h.nominal),
    })),
    portfolioValue: num(plan.portfolioValue),
    otherIncome: num(plan.otherIncome),
    marginalRate: num(plan.marginalRate),
    lotSize: num(plan.lotSize),
    bufferBusinessDays: num(plan.bufferBusinessDays),
    accruedIncomeScheme: plan.accruedIncomeScheme == null ? 'auto' : plan.accruedIncomeScheme,
    reinvestment: plan.reinvestment === 'forward' ? 'forward' : 'none',
  };
}

// Token layout (base64url): version byte | 12-byte IV | ciphertext | 16-byte
// GCM tag, with the version byte authenticated as AAD. The payload is deflated
// before encrypting, which matters here: a 25-year drawdown series expands to
// a lot of very similar JSON.
function sealPlan(input) {
  const { key, status, error } = getKey();
  if (error) return { status, error };

  const payload = zlib.deflateRawSync(JSON.stringify(normalizePlan(input)));

  const header = Buffer.from([VERSION]);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const token = Buffer.concat([header, iv, ciphertext, cipher.getAuthTag()]).toString('base64url');

  if (token.length > MAX_TOKEN_LENGTH) {
    return {
      status: 413,
      error: 'This plan is too large to put in a link. Save it instead, or reduce the number of liabilities.',
    };
  }
  return { token };
}

function openPlan(token) {
  const { key, status, error } = getKey();
  if (error) return { status, error };

  const invalid = {
    status: 400,
    error: 'Invalid plan link - it may be incomplete, or VIEW_TOKEN_SECRET has changed since it was created.',
  };
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return invalid;
  }

  const buf = Buffer.from(token, 'base64url');
  if (buf.length < 1 + IV_BYTES + TAG_BYTES || buf[0] !== VERSION) return invalid;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 1 + IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(buf.subarray(0, 1));
    decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
    const payload = Buffer.concat([
      decipher.update(buf.subarray(1 + IV_BYTES, buf.length - TAG_BYTES)),
      decipher.final(),
    ]);
    // Re-normalised on the way out as well as in. Authentication proves this
    // server sealed the token, not that what it sealed is still acceptable -
    // the token may predate a change to what a plan may contain.
    return { plan: normalizePlan(JSON.parse(zlib.inflateRawSync(payload, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString('utf8'))) };
  } catch {
    return invalid;
  }
}

module.exports = { sealPlan, openPlan, normalizePlan, MAX_TOKEN_LENGTH };
