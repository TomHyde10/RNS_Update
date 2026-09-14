// Thin wrapper around the `web-push` package (RFC 8030 Web Push over VAPID)
// - the actual fix for the limitation noted throughout this app's README:
// "Auto-refresh and its notifications only run while the tab is open." A
// push subscription (see lib/pushStore.js) is tied to the browser, not a
// tab, and delivery goes through the browser vendor's own push service
// (Chrome/Firefox/etc.), so a notification can show up even with this site
// closed entirely - the same mechanism most native apps use for
// notifications on the web.
//
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY identify this deployment to push
// services (proving it's the same server that created a subscription, not
// just anyone who found the endpoint URL) - generate a pair with
// `npx web-push generate-vapid-keys` and set both as env vars (or secret
// files - see server.js's SECRET_FILE_DIR handling). Entirely optional:
// with neither set, `configured` is false, /api/push/public-key reports
// push as unavailable, and the rest of the app is unaffected - same
// "missing config just disables the one feature" pattern as
// RESEND_API_KEY/NOTIFY_EMAIL_FROM for email.
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
// A contact URI push services may use to reach this deployment's operator
// about a misbehaving sender - required by the VAPID spec, but never shown
// to a subscriber. Defaults to a placeholder rather than failing setup
// entirely over an unset email; set VAPID_SUBJECT to your own
// mailto:/https: URI for a real deployment.
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:admin@example.com').trim();

const configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// `subscription` is { endpoint, keys: { p256dh, auth } } - exactly the
// shape PushSubscription.toJSON() produces in the browser (see app.js's
// subscribeToPush()). `payload` is JSON-serialised and delivered to the
// service worker's 'push' event (see sw.js) - kept small (title/body/url)
// since push payloads are size-limited by the push service, well below
// anything this app would ever need to send.
async function sendPush(subscription, payload) {
  if (!configured) {
    throw new Error("Push notifications aren't configured on this deployment (missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).");
  }
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    // 404/410 means the push service has permanently invalidated this
    // subscription (the user uninstalled/reset the browser, revoked
    // notification permission, etc.) - the caller should delete it rather
    // than treat this as a transient failure worth retrying.
    if (err.statusCode === 404 || err.statusCode === 410) return { ok: false, gone: true };
    throw err;
  }
}

module.exports = { sendPush, configured, publicKey: configured ? VAPID_PUBLIC_KEY : null };
