/**
 * Softrafing Velocidades — Service Worker
 * Enables offline shell + faster reloads. Does NOT run GPS in background
 * (browsers do not expose geolocation to service workers).
 */

const CACHE = 'stfvel-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './capture/capture.html',
  './capture/capture.js',
  './viewer/viewer.html',
  './viewer/viewer.js',
  './viewer/playback.js',
  './css/styles.css',
  './lib/db.js',
  './lib/geo.js',
  './lib/gpx.js',
  './lib/supabase.js',
  './Images/Softrafingvel.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] skip', url, err.message))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin GETs; let everything else pass through
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first: always try fresh. Fall back to cache only if offline/failure,
  // so new deploys are picked up immediately without bumping CACHE each time.
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || caches.match('./index.html'))
      )
  );
});
