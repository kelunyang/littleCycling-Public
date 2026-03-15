/**
 * Service Worker that caches map tiles in Cache Storage for offline/repeat use.
 * Tiles are matched by URL patterns for Mapbox, OpenFreeMap, and AWS terrain.
 *
 * Strategy: Cache-first — serve from cache if available, otherwise fetch from
 * network, cache the response, then return it.
 */

const CACHE_NAME = 'tile-cache-v1';
const MAX_CACHE_ENTRIES = 4000;

/** URL patterns that should be cached. */
const TILE_PATTERNS = [
  /tiles\.openfreemap\.org/,
  /api\.mapbox\.com\/v4/,
  /api\.mapbox\.com\/styles/,
  /api\.mapbox\.com\/fonts/,
  /api\.mapbox\.com\/sprites/,
  /\.tiles\.mapbox\.com/,
  /s3\.amazonaws\.com\/elevation-tiles-prod/,
];

function isTileRequest(url) {
  return TILE_PATTERNS.some((pattern) => pattern.test(url));
}

/** Evict oldest entries when cache grows too large. */
async function trimCache() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  if (keys.length > MAX_CACHE_ENTRIES) {
    const excess = keys.length - MAX_CACHE_ENTRIES;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET' || !isTileRequest(request.url)) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // Cache-first
      const cached = await cache.match(request);
      if (cached) {
        return cached;
      }

      // Fetch from network
      const response = await fetch(request);

      // Only cache successful responses
      if (response.ok) {
        cache.put(request, response.clone());
        // Periodically trim (don't block response)
        trimCache();
      }

      return response;
    })(),
  );
});
