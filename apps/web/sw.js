/**
 * Service Worker for Sound Explorer PWA.
 * Uses network-first strategy so users always get fresh code when online,
 * with cache fallback for offline use.
 */

// Keep in sync with js/version.js
const CACHE_VERSION = '0.7.5';
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

// Install: cache the app shell, then activate immediately.
// All fetches use cache:'reload' to bypass the HTTP cache and get fresh files.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: 'reload' }).then((res) => {
            if (!res.ok) throw new Error(`Failed to cache ${url}: ${res.status}`);
            return cache.put(url, res);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// Activate: delete old caches, take control of all tabs, notify them.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key.startsWith('sound-explorer-v') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    }).then(() => {
      return self.clients.claim();
    }).then(() => {
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
        });
      });
    })
  );
});

// Fetch: network-first for navigation and same-origin requests.
// Try the network, update the cache on success, fall back to cache on failure.
// This ensures users always get the latest version when online.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // For navigation requests (page loads), always go to network first
  // and fall back to the cached index.html for offline support.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // For all other same-origin requests: network first, cache fallback.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response && response.status === 200 && response.type === 'basic') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});

// Handle skip-waiting message from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
