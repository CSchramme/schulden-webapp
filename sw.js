'use strict';

// Bei größeren Änderungen hochzählen, dann wird der alte Cache aufgeräumt.
const CACHE = 'schulden-v2';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Zuerst aus dem Netz (damit Updates sofort ankommen), ohne Netz aus dem Cache.
// Die Daten (api/) laufen nie über den Cache.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request.mode === 'navigate' ? request : new Request(request.url, { cache: 'no-cache' })).then(
    (response) => {
      if (response.ok && !response.redirected) cache.put(request, response.clone());
      return response;
    }
  );
  network.catch(() => {}); // Fehler wird unten behandelt
  // Bei sehr langsamer Verbindung nach 4 Sekunden lieber den Cache nehmen.
  const timeout = new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // offline
  }
  const cached =
    (await cache.match(request, { ignoreSearch: true })) ||
    (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
  return cached || network;
}
