// Minimal service worker: phones only show notifications through one.
// It caches nothing — the page always needs live market data anyway.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
    return cs.length ? cs[0].focus() : self.clients.openWindow('./');
  }));
});
