// Vercel Edge Middleware: gates every request (static files and every
// api/*.js function) behind HTTP Basic Auth, so a Vercel deployment gets
// the same protection as server.js's equivalent check (see
// lib/basicAuth.js) on Render/Northflank/local. Runs on Vercel's Edge
// Runtime - a separate, more restricted runtime from server.js's plain
// Node process (no Buffer, no filesystem, Web-standard APIs only), so this
// re-implements the same check with atob() instead of importing
// lib/basicAuth.js. Keep the two in sync if this logic changes.
//
// Disabled by default: with no APP_PASSWORD set, every request passes
// through unmodified (same "optional, zero setup" pattern as this app's
// other env vars) - set APP_PASSWORD to actually require a login.
export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return;

  const expectedUsername = process.env.APP_USERNAME || 'admin';
  const header = request.headers.get('authorization');

  if (header && header.startsWith('Basic ')) {
    try {
      const decoded = atob(header.slice('Basic '.length).trim());
      const sep = decoded.indexOf(':');
      const username = sep === -1 ? decoded : decoded.slice(0, sep);
      const suppliedPassword = sep === -1 ? '' : decoded.slice(sep + 1);
      if (username === expectedUsername && suppliedPassword === password) {
        return;
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
