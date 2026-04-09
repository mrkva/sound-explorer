/**
 * Service Worker for Sound Explorer PWA.
 * Caches app shell for offline use and signals the page when updates are available.
 */

// Keep in sync with js/version.js
const CACHE_VERSION = '0.3.13';
const CACHE_NAME = 'sound-explorer-v' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './css/main.css',
  './js/app.js',
  './js/audio-engine.js',
  './js/spectrogram.js',
  './js/wav-parser.js',
  './js/fft-worker.js',
  './js/render-worker.js',
  './js/version.js',
  './js/fft-core.js',
  './js/colormaps.js',
  './js/ixml.js',
  './js/frm.js',
  './js/live-capture.js',
  './img/logo_black.png',
  './img/logo_white.png',
  './img/icon.svg',
  './img/icon-192.png',
  './img/icon-512.png',
  './manifest.json'
];

// Install: cache the app shell (bypass HTTP cache to ensure fresh files)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res))
        )
      );
    })
  );
});

// Activate: delete old caches, then notify all clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith('sound-explorer-v') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => {
      // Tell all open tabs that this new SW is now active
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
});

// Fetch: serve from cache, fall back to network (and update cache)
self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // Return cached version immediately, but also fetch update in background
      const fetchPromise = fetch(event.request).then((response) => {
        // Only cache valid responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Network failed, cached version (if any) was already returned
      });

      return cached || fetchPromise;
    })
  );
});

// Handle skip-waiting message from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
