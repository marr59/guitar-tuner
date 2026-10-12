/* Guitar Tuner service worker.
   Strategy: network-first, cache fallback.
   Rationale: the site is deployed with `git pull`, so a cache-first shell would
   pin users to an old build. Network-first keeps them current when online and
   still works fully offline (which matters in a rehearsal room or basement). */
const VERSION = "v57";
const CACHE = "tuner-" + VERSION;
const SHELL = [
  "./", "./index.html", "./tunings.json", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The catalogue is half a megabyte and network-first was re-downloading it on
// every single launch — the app asked for it with cache: no-cache, so neither
// the service worker nor the browser cache ever answered. Serve it from cache
// at once and refresh in the background instead: the tuner opens instantly, a
// new catalogue lands on the next launch, and a rehearsal room with no signal
// still gets the whole thing. Code keeps network-first, so a fix still ships
// the moment it is pushed.
const STALE_WHILE_REVALIDATE = /tunings\.json$/;

function staleWhileRevalidate(req) {
  return caches.open(CACHE).then(c =>
    c.match(req).then(hit => {
      const fresh = fetch(req).then(res => {
        if (res && res.status === 200) c.put(req, res.clone());
        return res;
      });
      return hit || fresh;            // кэш есть — отдаём сразу, сеть догоняет
    }).catch(() => fetch(req))
  );
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // let fonts/CDN go straight to network

  if (STALE_WHILE_REVALIDATE.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req));
    return;
  }

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html")))
  );
});
