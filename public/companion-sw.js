/* Shiba Companion offline shell. API responses and credentials are never put
 * in Cache Storage; encrypted summaries live only in device-bound IndexedDB. */
const CACHE = 'shiba-companion-shell-v1';
const SHELL = ['/companion', '/companion/manifest.webmanifest', '/shiba-logo.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && url.pathname.startsWith('/companion')) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/companion')));
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) void cache.put(event.request, response.clone());
      return response;
    }))));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).pathname.startsWith('/companion'));
    return existing ? existing.focus() : self.clients.openWindow('/companion');
  }));
});
