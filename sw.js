/**
 * Service worker — app shell only.
 *
 * Precaches the HTML/CSS/JS/vendor files so the app launches with no
 * network at all. Map tiles and vector data are NOT cached here: the Cache
 * API is capped at ~50 MB per partition on iOS, so they live in IndexedDB
 * (see js/store.js). Third-party requests (tile servers, Overpass, PAD-US,
 * Nominatim, Open-Meteo) pass straight through.
 *
 * Bump CACHE_VERSION whenever any shell file changes; the app shows a
 * "reload for update" toast when a new worker takes over.
 */

const CACHE_VERSION = 'trailapp-shell-v2.0.0';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/panels.js',
  './js/config.js',
  './js/geo.js',
  './js/tiles.js',
  './js/store.js',
  './js/backend.js',
  './js/overpass.js',
  './js/services.js',
  './js/graph.js',
  './js/downloader.js',
  './js/map-layers.js',
  './js/map-trails.js',
  './js/map-boundaries.js',
  './js/map-pois.js',
  './js/map-tools.js',
  './js/gps.js',
  './js/annotations.js',
  './js/ui.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/maplibre/maplibre-gl.mjs',
  './vendor/maplibre/maplibre-gl-shared.mjs',
  './vendor/maplibre/maplibre-gl-worker.mjs',
  './vendor/maplibre/maplibre-gl.css',
  './vendor/maplibre/leaflet-maplibre-gl.js',
  './vendor/opentrailmap-foot-access.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Add one at a time so a single missing optional file doesn't fail install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch((err) => console.warn('[sw] skip', url, err.message))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles/APIs: network only

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) {
      // Refresh in the background so the next launch gets any change.
      fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res.ok && (req.destination === 'script' || req.destination === 'style' || req.destination === 'image' || req.mode === 'navigate' || url.pathname.endsWith('.json') || url.pathname.endsWith('.mjs'))) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
