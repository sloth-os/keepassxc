/* KeePassXC Web service worker — offline-capable app shell.
 *
 * Everything runs NETWORK-FIRST: pages and assets (including the ~10 MB
 * wasm engine) are fetched from the network, mirrored into a cache named
 * after VERSION, and served from that cache when the fetch fails
 * (offline). Network-first is deliberate:
 *   - on publish day the OLD worker must not answer the NEW worker's
 *     precache fetches from the old cache — that would fill the new
 *     cache with stale bytes and pin clients behind the publish forever;
 *   - an already-open tab picks up a publish on its next reload by
 *     itself, so no "reload to update" nudge is needed in the page.
 *
 * VERSION is stamped at publish time from a hash of the site files
 * (scripts/publish-site.sh) so every publish gets a fresh cache name;
 * activate() deletes the stale ones. web/sw.js in the repo keeps the
 * placeholder — only the published copy is stamped.
 */
const VERSION = '981220e604ef';
const CACHE = `kpxc-${VERSION}`;
const url = (p) => new URL(p, self.location).href;
const PRECACHE = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'wasm/keepassxc.js',
  'wasm/keepassxc.wasm',
  'wasm/keepassxc.data',
].map(url);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' bypasses the HTTP cache, whose freshness window
    // (GitHub Pages serves max-age=600) could otherwise hand the OLD
    // bytes to the NEW cache right after a publish.
    await Promise.all(PRECACHE.map(async (u) => {
      const res = await fetch(u, { cache: 'reload' });
      if (!res.ok) throw new Error(`precache ${u}: HTTP ${res.status}`);
      await cache.put(u, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const reqUrl = new URL(req.url);
  if (reqUrl.origin !== self.location.origin) return;
  // Only requests inside our scope; everything else passes through
  // untouched (including the scope root without its trailing slash).
  const scopePath = new URL(self.registration.scope).pathname;
  if (!reqUrl.pathname.startsWith(scopePath) && `${reqUrl.pathname}/` !== scopePath) return;

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const hit = (await caches.match(req)) || (await caches.match(url('index.html')));
    if (hit) return hit;
    return new Response('Offline and nothing cached yet — go online once, then retry.', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
