/* Timeline Trace — Service Worker
 * Caches app shell only. User JSON never passes through fetch().
 */

const PRECACHE = "timeline-trace-local-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./new_icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
  "./favicon-16.png",
];

function cacheName() {
  return `${PRECACHE}::${self.registration.scope}`;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(cacheName());
      await cache.addAll(APP_SHELL);
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const keep = cacheName();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("timeline-trace") && k !== keep)
          .map((k) => caches.delete(k))
      );
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

  const sameScope = url.href.startsWith(self.registration.scope);
  if (!sameScope) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache  = await caches.open(cacheName());
        const cached = await cache.match("./index.html");
        if (cached) return cached;
        return fetch(req);
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache  = await caches.open(cacheName());
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (req.method === "GET" && res?.ok) {
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});
