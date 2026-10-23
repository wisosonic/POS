// The till's service worker (built into dist/sw.js by vite.config.ts, which fills in the two values below).
// Its one job: if the browser is restarted while the server is unreachable, the app still opens, and the till's own
// saved catalog and waiting-sales outbox take it from there. It never touches /api: money data is never served from here.
const VERSION = '__VERSION__';
const PRECACHE = '__PRECACHE__'; // replaced by a list of paths
const SHELL = `till-shell-${VERSION}`;
const PICTURES = 'till-pictures'; // product pictures are named by their content, so a cached one is never stale

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('till-shell-') && n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // A page: ask the server (so an update shows at once); if it cannot be reached, open the cached app, which routes by itself.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches
          .open(SHELL)
          .then((c) => c.match('/index.html'))
          .then((r) => r ?? Response.error()),
      ),
    );
    return;
  }

  // The app's own files (hashed names, never change): cache first.
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Product pictures: keep the ones that were looked at, so they still show offline.
  if (url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      caches.open(PICTURES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void cache.put(req, res.clone());
        return res;
      }),
    );
  }
});
