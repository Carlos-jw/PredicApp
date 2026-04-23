/**
 * No pre-cacheamos *.js: cache.addAll con fallos de red deja a veces archivos
 * truncados → "SyntaxError: expected expression, got end of script".
 * Los módulos siempre van por red si hay conexión.
 */
const APP_CACHE = 'predicapp-shell-v14';
/** Sin `style.css` sin query: el HTML usa `style.css?v=…` y Cache API es por URL completa. */
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/assets/manifest.json',
  '/assets/192x192.png',
  '/assets/512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== APP_CACHE && key.startsWith('predicapp-'))
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

function isOurScript(url) {
  const p = url.pathname || '';
  return p.endsWith('.js');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  /**
   * No interceptar otros orígenes (Firestore Listen en firestore.googleapis.com,
   * Firebase Auth, gstatic, fuentes, etc.). Sin `respondWith`, el navegador
   * atiende la petición fuera del SW y evita errores engañosos si falla la red.
   */
  if (url.origin !== self.location.origin) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith((async () => {

    const isNavigationRequest =
      event.request.mode === 'navigate' || event.request.destination === 'document';

    if (isNavigationRequest) {
      try {
        const response = await fetch(event.request);
        const cache = await caches.open(APP_CACHE);
        cache.put('/index.html', response.clone());
        return response;
      } catch (error) {
        return (await caches.match('/index.html')) || Response.error();
      }
    }

    /** Módulos JS del mismo origen: nunca desde Cache Storage (evita caché corrupta). */
    if (isOurScript(url)) {
      return fetch(event.request);
    }

    const cached = await caches.match(event.request);
    if (cached) return cached;

    try {
      const response = await fetch(event.request);
      if (response && response.ok && new URL(event.request.url).origin === self.location.origin) {
        const cache = await caches.open(APP_CACHE);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const fallback = await caches.match('/index.html');
      return fallback || Response.error();
    }
  })());
});
