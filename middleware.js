// Vercel Edge Middleware: gates every request (static files and every
// api/*.js function) behind HTTP Basic Auth, so a Vercel deployment gets
// the same protection as server.js's equivalent check (see
// lib/basicAuth.js) on Render/Northflank/local. Runs on Vercel's Edge
// Runtime - a separate, more restricted runtime from server.js's plain
// Node process (no Buffer, no Node crypto, no filesystem, Web-standard APIs
// only), so this re-implements the same check with atob()/TextDecoder and
// crypto.subtle instead of importing lib/basicAuth.js. Keep the two in sync
// if this logic changes.
//
// Disabled by default: with no APP_PASSWORD set, every request passes
// through unmodified (same "optional, zero setup" pattern as this app's
// other env vars) - set APP_PASSWORD to actually require a login.
export const config = {
  matcher: '/:path*',
};

const encoder = new TextEncoder();

// Constant-time comparison of SHA-256 digests - the Edge equivalent of
// safeEqual() in lib/basicAuth.js (no crypto.timingSafeEqual here).
async function safeEqual(a, b) {
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

export default async function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return;

  const expectedUsername = process.env.APP_USERNAME || 'admin';
  const header = request.headers.get('authorization');

  if (header && header.startsWith('Basic ')) {
    try {
      // atob() returns one char per byte - decode those bytes as UTF-8 so a
      // non-ASCII password matches here exactly as it does via Buffer in
      // lib/basicAuth.js.
      const binary = atob(header.slice('Basic '.length).trim());
      const decoded = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
      const sep = decoded.indexOf(':');
      if (sep !== -1) {
        // Both checked unconditionally - no early exit on a wrong username.
        const usernameOk = await safeEqual(decoded.slice(0, sep), expectedUsername);
        const passwordOk = await safeEqual(decoded.slice(sep + 1), password);
        if (usernameOk && passwordOk) return;
      }
    } catch {
      // Malformed header - fall through to the 401 below.
    }
  }

  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="RNS Update"' },
  });
}
