// sw.js — Eclipse Service Worker
// Intercepts /apps/{id}/... routes → serve from IDB
// Caches shell files for offline use (but NOT remote game artwork)

const SHELL_CACHE  = 'eclipse-shell-v4';
const SCOPE_PATH   = new URL(self.registration.scope).pathname;
const SHELL_FILES  = [
  SCOPE_PATH,
  `${SCOPE_PATH}index.html`,
  `${SCOPE_PATH}app.js`,
  `${SCOPE_PATH}db.js`,
  `${SCOPE_PATH}sw.js`,
  `${SCOPE_PATH}style.css`,
  `${SCOPE_PATH}Eclipse.png`,
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300&display=swap',
];

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(err => {
        console.warn('[Eclipse SW] Shell cache failed (some files may be missing):', err);
        return self.skipWaiting();
      })
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── IDB helpers (inlined — SW can't use ES module imports) ──────────────────
const DB_NAME = 'eclipse-store';
const DB_VER  = 1;
let _swDB     = null;

function swOpenDB() {
  if (_swDB) return Promise.resolve(_swDB);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('app-files')) db.createObjectStore('app-files');
      if (!db.objectStoreNames.contains('app-meta'))  db.createObjectStore('app-meta');
    };
    r.onsuccess = e => { _swDB = e.target.result; res(_swDB); };
    r.onerror   = e => rej(e.target.error);
  });
}

function swGetFile(appId, rel) {
  return swOpenDB().then(db => new Promise((res, rej) => {
    const tx  = db.transaction('app-files', 'readonly');
    const req = tx.objectStore('app-files').get(`${appId}/${rel}`);
    req.onsuccess = e => res(e.target.result ?? null);
    req.onerror   = e => rej(e.target.error);
  }));
}

// ─── MIME type map ────────────────────────────────────────────────────────────
function mimeFor(path) {
  const ext = path.split('.').pop().toLowerCase().split('?')[0];
  return ({
    html: 'text/html', htm: 'text/html',
    js:   'application/javascript', mjs: 'application/javascript',
    css:  'text/css',
    png:  'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif:  'image/gif', webp: 'image/webp', avif: 'image/avif',
    svg:  'image/svg+xml',
    wasm: 'application/wasm',
    json: 'application/json',
    mp3:  'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    mp4:  'video/mp4', webm: 'video/webm',
    ttf:  'font/ttf', woff: 'font/woff', woff2: 'font/woff2',
    map:  'application/json',
    swf:  'application/x-shockwave-flash',
    txt:  'text/plain', xml: 'application/xml',
  })[ext] || 'application/octet-stream';
}

// ─── Fetch handler ────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Intercept installed-app requests: {scope}/apps/{id}/...
  const relPathFromScope = url.origin === self.location.origin && url.pathname.startsWith(SCOPE_PATH)
    ? url.pathname.slice(SCOPE_PATH.length)
    : null;
  const appMatch = relPathFromScope?.match(/^apps\/([^/]+)\/(.*)$/);
  if (appMatch) {
    event.respondWith(serveAppFile(appMatch[1], appMatch[2] || 'index.html'));
    return;
  }

  // 2. Shell files — cache-first
  //    NOTE: We intentionally do NOT cache remote artwork (githubusercontent, etc.)
  //    so we never waste storage on store-browse images.
  const isShellOrigin = url.origin === self.location.origin;
  const isFont        = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

  if (isShellOrigin || isFont) {
    event.respondWith(networkFirstShell(event.request));
    return;
  }

  // 3. Everything else (remote images, CDN assets): network only, no caching
  //    Falls through to browser default — no event.respondWith means normal fetch.
});

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Offline and uncached resource', { status: 503 });
  }
}

async function serveAppFile(appId, relPath) {
  // Decode any percent-encoding from the URL
  const decoded = decodeURIComponent(relPath);

  try {
    let buf = await swGetFile(appId, decoded);

    // If not found and path looks like a directory, try index.html
    if (!buf && !decoded.includes('.')) {
      const idx = decoded ? decoded.replace(/\/$/, '') + '/index.html' : 'index.html';
      buf = await swGetFile(appId, idx);
    }

    if (buf) {
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type':   mimeFor(decoded),
          'Cache-Control':  'no-cache',
          'Cross-Origin-Opener-Policy':   'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        }
      });
    }

    return new Response(`Eclipse: file not found in storage — ${decoded}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });

  } catch (err) {
    return new Response(`Eclipse SW error: ${err}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

// ─── Message channel ─────────────────────────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'ping') event.source?.postMessage('pong');
});
