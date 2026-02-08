/* Timeline Trace (Local) - Service Worker
 * Scope is limited to this repo/subdirectory to avoid collisions with other PWAs.
 * This SW caches only the app shell (not user JSON).
 */

const PRECACHE = "timeline-trace-local-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
  "./favicon-16.png",
];

// Build a scope-specific cache name to be extra safe when multiple PWAs are hosted.
function cacheName() {
  // registration.scope ends with a trailing slash
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
          .filter((k) => k.startsWith(PRECACHE) && k !== keep)
          .map((k) => caches.delete(k))
      );
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin requests inside our scope; everything else passes through
  if (url.origin !== self.location.origin) return;

  // Important: NEVER cache or read local files. We only cache app shell assets.
  // File input JSON never goes through fetch(), so it is not intercepted here.

  const sameScope = url.href.startsWith(self.registration.scope);
  if (!sameScope) return;

  // Navigation requests -> serve cached index.html for offline
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(cacheName());
        const cached = await cache.match("./index.html");
        if (cached) return cached;
        return fetch(req);
      })()
    );
    return;
  }

  // Cache-first for app shell assets; network fallback.
  event.respondWith(
    (async () => {
      const cache = await caches.open(cacheName());
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;

      const res = await fetch(req);
      // Cache only GET responses within scope
      if (req.method === "GET" && res && res.ok) {
        // only store same-origin assets
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});
