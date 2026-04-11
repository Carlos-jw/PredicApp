// ─────────────────────────────────────────────
//  sw.js  —  Service Worker (GitHub Pages)
//  Base: https://TU-USUARIO.github.io/PredicApp/
// ─────────────────────────────────────────────

const CACHE_NAME = 'predicapp-v2.0';
const BASE = '/PredicApp';

const PRECACHE_ASSETS = [
  `${BASE}/`,
  `${BASE}/index.html`,
  `${BASE}/app.js`,
  `${BASE}/ui.js`,
  `${BASE}/db.js`,
  `${BASE}/config.js`,
  `${BASE}/auth.js`,
  `${BASE}/reservations.js`,
  `${BASE}/toast.js`,
  `${BASE}/style.css`,
  `${BASE}/manifest.json`,
  `${BASE}/assets/offline.html`,
  `${BASE}/assets/icons/icon-192x192.png`,
  `${BASE}/assets/icons/icon-512x512.png`
];

// ── Instalación ───────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.error('[SW] Pre-caché fallido:', err))
  );
});

// ── Activación: limpiar cachés antiguas ───────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME)
            .map(key => {
              console.log('[SW] Eliminando caché antigua:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => clients.claim())
  );
});

// ── Fetch: Cache First → Network → Offline ────
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (isDevUrl(request.url))    return;

  event.respondWith(handleFetch(request));
});

async function handleFetch(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const offline = await caches.match(`${BASE}/assets/offline.html`);
    if (offline) return offline;
    return new Response('Sin conexión', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

function isDevUrl(url) {
  return url.includes('localhost') ||
         url.includes('127.0.0.1') ||
         url.includes('chrome-extension');
}
