/**
 * ════════════════════════════════════════════════════════════════
 * NEXUS LAUNCHER — sw.js  (cache version 2.0.0)
 *
 * IMPORTANT: bumping CACHE_VERSION forces all users to discard
 * their old cache and download every shell file fresh.
 * Do this any time you fix a CSS/JS/HTML bug.
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ── Bump this string whenever you deploy a fix ── */
const CACHE_VERSION = 'nexus-v2.0.0';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const CDN_CACHE     = `${CACHE_VERSION}-cdn`;

/* ── Files to pre-cache on install ── */
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './favicon.ico',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-144.png',
  './icons/icon-96.png',
];

/* ── CDN origins to cache opportunistically ── */
const CDN_ORIGINS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

/* ════════════════════════════════════════════════════════════════
   INSTALL — pre-cache the app shell, then skip waiting
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('install', evt => {
  evt.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        console.log('[SW v2] Pre-caching shell…');
        return cache.addAll(SHELL_FILES);
      })
      .then(() => {
        console.log('[SW v2] Shell cached — skipWaiting');
        return self.skipWaiting();
      })
      .catch(err => {
        /* Log but don't let a single failed asset block installation */
        console.error('[SW v2] Pre-cache error:', err);
      })
  );
});

/* ════════════════════════════════════════════════════════════════
   ACTIVATE — delete every cache that doesn't match our version
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('activate', evt => {
  evt.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('nexus-') && !k.startsWith(CACHE_VERSION))
          .map(k => {
            console.log('[SW v2] Deleting stale cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => {
      console.log('[SW v2] Activated — claiming clients');
      return self.clients.claim();
    })
  );
});

/* ════════════════════════════════════════════════════════════════
   FETCH — routing strategy per request type
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('fetch', evt => {
  const { request } = evt;
  const url = new URL(request.url);

  /* Only handle GET */
  if (request.method !== 'GET') return;

  /* Only handle http/https (not chrome-extension://, data:, blob:, etc.) */
  if (!['http:', 'https:'].includes(url.protocol)) return;

  /* Never intercept the service worker script itself */
  if (url.pathname.endsWith('/sw.js')) return;

  /* Never intercept blob: URLs — they're launched apps */
  if (url.protocol === 'blob:') return;

  /* CDN resources → stale-while-revalidate */
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    evt.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  /* Same-origin app shell → cache first */
  if (url.origin === self.location.origin) {
    evt.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  /* Everything else → network first with cache fallback */
  evt.respondWith(networkFirst(request, SHELL_CACHE));
});

/* ════════════════════════════════════════════════════════════════
   CACHE STRATEGY HELPERS
   ════════════════════════════════════════════════════════════════ */

/** Cache First: serve from cache; fetch & store if not cached */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback();
  }
}

/** Stale While Revalidate: serve cache immediately, update in background */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || offlineFallback();
}

/** Network First: try network, fall back to cache */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback();
  }
}

/** Minimal offline fallback page */
function offlineFallback() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NEXUS — Offline</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#070a14;color:#00d2ff;font-family:monospace;
         display:flex;align-items:center;justify-content:center;
         height:100vh;text-align:center;padding:20px}
    h1{font-size:clamp(16px,4vw,24px);letter-spacing:.2em;margin-bottom:12px}
    p{color:#7a90b8;font-size:13px;letter-spacing:.08em}
  </style>
</head>
<body>
  <div>
    <h1>⬡ NEXUS LAUNCHER</h1>
    <h1 style="color:#d0dcf0">YOU ARE OFFLINE</h1>
    <p style="margin-top:16px">Reconnect to the internet and reload.</p>
    <p>Your library is still available locally.</p>
  </div>
</body>
</html>`,
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/* ════════════════════════════════════════════════════════════════
   MESSAGE HANDLER
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('message', evt => {
  if (evt.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (evt.data?.type === 'GET_VERSION')  evt.ports[0]?.postMessage({ version: CACHE_VERSION });
});
