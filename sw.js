// ─────────────────────────────────────────────
//  sw.js  —  Service Worker
//  Mejoras: pre-caché funcional, fallback
//           offline real, estrategia explícita
//           (Cache First + Network Fallback),
//           código legible y comentado
// ─────────────────────────────────────────────

const CACHE_NAME = 'predicapp-v2.0';

// Assets que se pre-cachean en la instalación
// (garantizan funcionamiento 100% offline)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './ui.js',
  './db.js',
  './config.js',
  './auth.js',
  './reservations.js',
  './toast.js',
  './style.css',
  './manifest.json',
  './assets/offline.html',
  './assets/icons/icon-192x192.png',
  './assets/icons/icon-512x512.png'
];

// ── Instalación: pre-cachear todos los assets estáticos ───────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting()) // activar inmediatamente
      .catch(err => console.error('[SW] Pre-caché fallido:', err))
  );
});

// ── Activación: limpiar cachés antiguas ───────────────────────
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
      .then(() => clients.claim()) // tomar control inmediatamente
  );
});

// ── Fetch: estrategia Cache First → Network → Offline ─────────
self.addEventListener('fetch', event => {
  const { request } = event;

  // Ignorar peticiones no-GET y extensiones de desarrollo
  if (request.method !== 'GET') return;
  if (isDevUrl(request.url))    return;

  event.respondWith(handleFetch(request));
});

async function handleFetch(request) {
  // 1. Buscar en caché
  const cached = await caches.match(request);
  if (cached) return cached;

  // 2. Intentar red
  try {
    const response = await fetch(request);

    // Solo cachear respuestas válidas
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }

    return response;
  } catch {
    // 3. Sin caché y sin red → página offline personalizada
    const offlinePage = await caches.match('./assets/offline.html');
    if (offlinePage) return offlinePage;

    // Último recurso: respuesta de error limpia
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
