// Offline support: the pages and last known statuses stay viewable without a
// connection. API responses are always fetched fresh first.
const CACHE = "svitlo-v1";
const SHELL = ["/", "/b", "/assets/app.css", "/assets/common.js", "/assets/home.js", "/assets/building.js", "/manifest.webmanifest", "/icons/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey, response.clone());
    return response;
  } catch {
    return (await cache.match(cacheKey)) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/tg/")) return;
  if (url.pathname.startsWith("/api/")) return event.respondWith(networkFirst(event.request));
  if (url.pathname.startsWith("/b/")) return event.respondWith(networkFirst(event.request, "/b"));
  event.respondWith(networkFirst(event.request));
});
