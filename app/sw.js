// ChiSave service worker — makes the app work offline and installable.
// Cache-first for the app shell; the app's data (stock, sales, regulars)
// lives in the browser's storage, not in this cache.
// Cache name carries a build stamp (YYYYMMDDHHMM). build.py rewrites it
// on every build, so a new deploy always changes sw.js — which is what
// makes the browser notice the new version and update installed apps.
// Never ship two different builds with the same stamp.
const CACHE = "chisave-202611240617";
const SHELL = ["./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // Only handle our own files. Open Food Facts lookups always go to the network.
  if (!event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
