const CACHE_NAME = 'predicapp-v1.2';
const STATIC = ['./', './index.html', './manifest.json', './assets/icons/icon-192x192.png', './assets/icons/icon-512x512.png', './assets/offline.html'];

self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.url.includes('localhost') || e.request.url.includes('127.0.0.1')) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    const c = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(e.request, c)); return res;
  })));
});