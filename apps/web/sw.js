// Zipply service worker (P7-02). Caches the app shell only: the built HTML, scripts, styles, fonts,
// icons and manifest listed at build time. It never caches or reads files, manifests, SDP, room data
// or messages: every other request goes to the network untouched. The build replaces __SHELL__.
const { version, urls } = self.__SHELL__;
const CACHE = `zipply-shell-${version}`;
const SHELL = new Set(urls);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(urls.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('zipply-') && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Only on the user's request (the update notice), so a running transfer is never reloaded away.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !SHELL.has(url.pathname)) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(url.pathname))
      .then((hit) => hit ?? fetch(request)),
  );
});
