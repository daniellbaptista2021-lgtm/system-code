const CACHE_NAME = "system-code-v1";
const urlsToCache = ["/chat.html", "/logo.png", "/icon-192.png", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  e.respondWith(fetch(e.request).then(r => {
    if (!r || r.status !== 200) return r;
    const c = r.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(e.request, c));
    return r;
  }).catch(() => caches.match(e.request).then(r => r || new Response("Offline"))));
});
