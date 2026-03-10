/**
 * ════════════════════════════════════════════════════════════════
 * NEXUS LAUNCHER — sw.js (Service Worker)
 *
 * Strategy:
 *  • App Shell (HTML, CSS, JS, icons, manifest) → Cache First
 *    The launcher itself loads instantly from cache, even offline.
 *  • External CDN resources (JSZip, Google Fonts) → Stale-While-Revalidate
 *    Served from cache immediately; updated in background.
 *  • Everything else → Network First with cache fallback
 *
 * User app data (uploaded HTML/ZIP files) is stored in IndexedDB by
 * app.js — the service worker does NOT manage that data; it only caches
 * the launcher shell itself.
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ── Cache name — bump the version string to force a full refresh ── */
const CACHE_VERSION  = 'nexus-v1.0.0';
const SHELL_CACHE    = `${CACHE_VERSION}-shell`;
const CDN_CACHE      = `${CACHE_VERSION}-cdn`;

/* ── App shell files to pre-cache on install ───────────────────── */
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

/* ── CDN URLs to cache opportunistically ───────────────────────── */
const CDN_ORIGINS = [
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

/* ════════════════════════════════════════════════════════════════
   INSTALL — pre-cache the app shell
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell…');
        return cache.addAll(SHELL_FILES);
      })
      .then(() => {
        console.log('[SW] Shell cached. Skipping waiting…');
        return self.skipWaiting(); // Activate immediately
      })
      .catch((err) => {
        console.error('[SW] Pre-cache failed:', err);
      })
  );
});

/* ════════════════════════════════════════════════════════════════
   ACTIVATE — clean up stale caches from old versions
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('nexus-') && !key.startsWith(CACHE_VERSION))
            .map((key) => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
        )
      )
      .then(() => {
        console.log('[SW] Activated. Claiming clients…');
        return self.clients.claim(); // Take control of all open tabs
      })
  );
});

/* ════════════════════════════════════════════════════════════════
   FETCH — routing strategy
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('fetch', (evt) => {
  const { request } = evt;
  const url = new URL(request.url);

  /* Skip non-GET requests and chrome-extension:// etc. */
  if (request.method !== 'GET') return;
  if (!['http:', 'https:'].includes(url.protocol)) return;

  /* ── blob: URLs (launched apps) — never intercept ─────────── */
  if (url.protocol === 'blob:') return;

  /* ── CDN resources → Stale-While-Revalidate ────────────────── */
  if (CDN_ORIGINS.some((origin) => url.hostname.includes(origin))) {
    evt.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  /* ── App shell (same origin) → Cache First ─────────────────── */
  if (url.origin === self.location.origin) {
    evt.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  /* ── Everything else → Network First with fallback ─────────── */
  evt.respondWith(networkFirst(request, SHELL_CACHE));
});

/* ════════════════════════════════════════════════════════════════
   STRATEGY HELPERS
   ════════════════════════════════════════════════════════════════ */

/**
 * Cache First — return cached response immediately; if not cached,
 * fetch from network and store in cache for next time.
 */
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
    // Offline and not cached — return a minimal offline page
    return offlineFallback();
  }
}

/**
 * Stale While Revalidate — return cached immediately, then update
 * the cache in the background.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || (await fetchPromise) || offlineFallback();
}

/**
 * Network First — try network; fall back to cache if offline.
 */
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

/**
 * Minimal offline fallback response shown when the shell itself is unavailable.
 * In practice this shouldn't happen since the shell is pre-cached on install.
 */
function offlineFallback() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>NEXUS — Offline</title>
  <style>
    body { background:#06080f; color:#00e5ff; font-family:monospace;
           display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
    p { font-size:18px; letter-spacing:.2em; text-align:center; }
    small { display:block; margin-top:12px; color:#6b80a8; font-size:12px; }
  </style>
</head>
<body>
  <p>⬡ NEXUS LAUNCHER<br><br>YOU ARE OFFLINE
    <small>Reconnect to the internet to reload the launcher shell.</small>
  </p>
</body>
</html>`,
    {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

/* ════════════════════════════════════════════════════════════════
   MESSAGE HANDLER — allows the app to trigger SW updates
   ════════════════════════════════════════════════════════════════ */
self.addEventListener('message', (evt) => {
  if (evt.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (evt.data?.type === 'GET_VERSION') {
    evt.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
});
