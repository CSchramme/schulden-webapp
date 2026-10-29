'use strict';

// Wird beim Veröffentlichen automatisch durch den Commit-Hash ersetzt (siehe .github/workflows/pages.yml),
// damit jede neue Version den alten Cache ablöst.
const VERSION = '__VERSION__';
const CACHE = `schulden-${VERSION}`;

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

// Zuerst aus dem Cache (funktioniert offline), sonst aus dem Netz.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached =
        (await cache.match(request, { ignoreSearch: true })) ||
        (request.mode === 'navigate' ? await cache.match('./index.html') : undefined);
      return cached || fetch(request);
    })
  );
});
