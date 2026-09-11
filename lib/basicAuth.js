// HTTP Basic Auth gate for server.js (the plain Node server used for local
// dev, Render, and Northflank). Vercel deployments are instead protected by
// middleware.js at the repo root, which runs on Vercel's separate Edge
// Runtime and re-implements this same check with only Web-standard APIs
// (no Buffer) - keep the two in sync if this logic changes.
//
// Disabled by default: with no APP_PASSWORD set, checkBasicAuth() always
// returns true (same "optional, zero setup" pattern as the rest of this
// app's env vars) - set APP_PASSWORD to actually require a login.
const crypto = require('crypto');

const REALM = 'RNS Update';

function isAuthConfigured() {
  return Boolean(process.env.APP_PASSWORD);
}

function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep === -1) return null;
    return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

// Constant-time comparison. Both sides are hashed first so timingSafeEqual
// always gets equal-length inputs (it throws otherwise), which also keeps
// the expected value's length from leaking through response timing.
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function checkBasicAuth(authorizationHeader) {
  if (!isAuthConfigured()) return true;

  const creds = parseBasicAuth(authorizationHeader);
  if (!creds) return false;

  const expectedUsername = process.env.APP_USERNAME || 'admin';
  // Both checked unconditionally - no early exit on a wrong username.
  const usernameOk = safeEqual(creds.username, expectedUsername);
  const passwordOk = safeEqual(creds.password, process.env.APP_PASSWORD);
  return usernameOk && passwordOk;
}

module.exports = { isAuthConfigured, checkBasicAuth, REALM };
