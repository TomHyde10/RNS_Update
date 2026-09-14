// Service worker behind Web Push notifications (see lib/webPush.js and
// app.js's subscribeToPush()). Deliberately does nothing else - no offline
// caching, no fetch interception - this app has no interest in working
// offline, only in receiving push events while no tab is open. Registered
// at the root scope (see app.js's registerServiceWorker() and server.js's
// STATIC_FILES, which serves this file from '/', not a subdirectory).

self.addEventListener('install', () => {
  // Activate immediately rather than waiting for every open tab to close -
  // there's no previous version of this worker's own behaviour that an
  // already-open tab could be relying on.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The payload is whatever lib/sendPush.js's buildPayload() sent -
// { title, body, url } - JSON-encoded. A push arriving with no data at all
// (shouldn't happen from this app, but a push service is free to redeliver
// oddly) still shows a generic notification rather than silently doing
// nothing, since a "silent" push without a resulting notification can get a
// browser to eventually revoke the subscription's permission entirely.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON - fall back to the generic notification below.
  }

  const title = data.title || 'RNS Update';
  const options = {
    body: data.body || 'New report activity.',
    data: { url: data.url || '/' },
    tag: 'rns-update', // collapses several rapid pushes into one notification instead of stacking
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focuses an already-open tab on this site if one exists, otherwise opens a
// new one - same "don't pile up windows" behaviour a native app's
// notification click would have.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })
  );
});
