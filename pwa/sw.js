// Minimal service worker — enables PWA installability
const CACHE = 'nyxia-pwa-v1';
const PRECACHE = ['/', '/manifest.json', '/icon-192.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  // Network-first — always try live; fall back to cache for shell only
  if (e.request.url.includes('/message') || e.request.url.includes('/health')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
