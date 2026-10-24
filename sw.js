/* Shabdah — service worker
   ------------------------------------------------------------------
   Two caching strategies, chosen by what the request is for:

   * App shell and data (HTML, CSS, JS, JSON) — network first, so a
     redeploy is picked up immediately, falling back to cache offline.
   * Card images and audio — cache first, because they never change
     once generated and there are thousands of them.

   Bump CACHE_VERSION on every deploy. Old caches are deleted on
   activate, so a stale stylesheet can never outlive a release.       */

const CACHE_VERSION = 'v88';
const SHELL_CACHE   = `ptw-shell-${CACHE_VERSION}`;
const ASSET_CACHE   = `ptw-assets-${CACHE_VERSION}`;

const SHELL_FILES = [
  './', './index.html', './styles.css', './script.js', './auth.js',
  './srs.js', './notes.js', './reviews.js', './account.js', './stats.js',
  './entitlement.js', './nav-data.js',
  './about.html', './pricing.html', './pricing-config.js', './how-to-use.html',
  './contact.html', './methodology.html',
  './terms.html', './privacy.html', './404.html',
  './sources-and-licenses.html', './thank-you.html',
  './reader.html', './bookmarklet.html', './mobile-lookup.js',
  './offline-download.js', './gen-dict.js', './custom-cards.js',
  './situations.html', './situations.js',
  './data/cards.json', './data/categories.json', './data/search_index.json',
  './data/card_enrichment.json', './data/phrases.json', './data/offline-manifest.json', './data/grammar.json',
  './data/profession_categories.json',
  './data/situations_categories.json', './data/situations_scenarios.json',
  // sentence-search-index.json is large (~15-20MB) and loaded lazily on first
  // sentence search -- not precached, but will be cached after first fetch
  './assets/icons/shabdah-logo.png', './site.webmanifest',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll fails wholesale if any single file 404s, which would leave
      // the site with no offline support at all. Cache what we can.
      .then(cache => Promise.allSettled(SHELL_FILES.map(f => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never touch Supabase, fonts, Paddle

  const isMedia = /\.(png|jpe?g|webp|svg|gif|mp3|ogg|wav|m4a|woff2?)$/i.test(url.pathname);

  if (isMedia) {
    // Cache first — these are immutable once generated.
    event.respondWith(
      caches.match(request).then(async cached => {
        if (!cached) {
          return fetch(request).then(res => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(ASSET_CACHE).then(cache => cache.put(request, copy));
            }
            return res;
          });
        }
        // Audio playback (Safari/iOS in particular) issues a Range
        // request even for short clips. The cached entry is a plain 200
        // response with no Content-Range/Accept-Ranges -- some browsers
        // reject that as a response to a ranged request instead of just
        // playing the whole thing, which read as "offline audio doesn't
        // work" even though the correct bytes were sitting in the cache
        // the whole time. Serve a real 206 for the requested range so a
        // ranged request gets a response shaped the way it expects.
        const range = request.headers.get('range');
        if (!range) return cached;
        const bytes = await cached.arrayBuffer();
        const total = bytes.byteLength;
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] ? parseInt(m[1], 10) : 0;
        let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start) || start < 0) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end) return cached; // malformed range -- fall back to the full body
        const slice = bytes.slice(start, end + 1);
        return new Response(slice, {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': cached.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(slice.byteLength),
            'Accept-Ranges': 'bytes',
          },
        });
      })
    );
    return;
  }

  // Network first — freshness matters for the shell and the data files.
  // A plain fetch() can take several seconds to actually reject when the
  // device has no route to the internet at all (as opposed to a fast DNS
  // failure) -- some browsers/network stacks retry before giving up. That
  // reads as "the app is frozen" even though the correct cached copy is
  // sitting right there. Race the network against a short timer so a
  // slow-to-fail fetch can't hold up a page that's fully cached already.
  event.respondWith(
    Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ])
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request)
        .then(cached => cached || caches.match('./404.html')))
  );
});

// ── Offline download message handlers ─────────────────────────────────
// These allow the main thread (offline-download.js's OfflineDownloadManager)
// to request bulk category downloads and check cache status without going
// through the fetch event.

self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'PTW_DOWNLOAD_ASSETS':
      handleDownloadAssets(event, payload);
      break;
    case 'PTW_CHECK_CACHED':
      handleCheckCached(event, payload);
      break;
    case 'PTW_GET_CACHE_SIZE':
      handleGetCacheSize(event);
      break;
    case 'PTW_CLEAR_CATEGORY':
      handleClearCategory(event, payload);
      break;
  }
});

// fetch() has no built-in timeout. Inside handleDownloadAssets' batches of 5,
// a single request that hangs (dropped connection, unresponsive server --
// anything short of an actual network error) blocks the whole
// Promise.all(batch) forever, since it waits for every member to settle.
// That freezes the batch's other 4 URLs too, with no PTW_DOWNLOAD_PROGRESS
// message for any of them (observed live, 2026-10-05: an offline download
// stuck at a fixed file count and percentage with no error surfaced for well
// past offline-download.js's own 20s client-side stall timeout). Aborting
// a single asset fetch after a bounded wait turns that failure mode into a
// normal per-URL "failed" progress message -- the existing retry/error
// handling in handleDownloadAssets already covers that correctly.
async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Download a list of assets, reporting progress back to the client
async function handleDownloadAssets(event, payload) {
  const { urls, categoryId } = payload || {};
  if (!urls || !Array.isArray(urls)) {
    event.source?.postMessage({ type: 'PTW_DOWNLOAD_ERROR', error: 'No URLs provided' });
    return;
  }

  const total = urls.length;
  let completed = 0;
  let failed = 0;

  const cache = await caches.open(ASSET_CACHE);

  // Download in batches to avoid overwhelming the network
  const BATCH_SIZE = 5;

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (url) => {
      try {
        // Check if already cached
        const cached = await cache.match(url);
        if (cached) {
          completed++;
          event.source?.postMessage({
            type: 'PTW_DOWNLOAD_PROGRESS',
            completed,
            total,
            failed,
            url,
            status: 'already_cached'
          });
          return;
        }

        // Fetch and cache
        const response = await fetchWithTimeout(url);
        if (response.ok) {
          await cache.put(url, response);
          completed++;
          event.source?.postMessage({
            type: 'PTW_DOWNLOAD_PROGRESS',
            completed,
            total,
            failed,
            url,
            status: 'downloaded'
          });
        } else {
          failed++;
          event.source?.postMessage({
            type: 'PTW_DOWNLOAD_PROGRESS',
            completed,
            total,
            failed,
            url,
            status: 'failed',
            error: `HTTP ${response.status}`
          });
        }
      } catch (err) {
        failed++;
        event.source?.postMessage({
          type: 'PTW_DOWNLOAD_PROGRESS',
          completed,
          total,
          failed,
          url,
          status: 'failed',
          error: err.message
        });
      }
    }));
  }

  event.source?.postMessage({
    type: 'PTW_DOWNLOAD_COMPLETE',
    completed,
    total,
    failed,
    categoryId
  });
}

// Check which URLs from a list are already cached
async function handleCheckCached(event, payload) {
  const { urls } = payload || {};
  if (!urls || !Array.isArray(urls)) {
    event.source?.postMessage({ type: 'PTW_CHECK_CACHED_RESULT', cached: [], notCached: [] });
    return;
  }

  const cache = await caches.open(ASSET_CACHE);
  const cached = [];
  const notCached = [];

  for (const url of urls) {
    const match = await cache.match(url);
    if (match) {
      cached.push(url);
    } else {
      notCached.push(url);
    }
  }

  event.source?.postMessage({
    type: 'PTW_CHECK_CACHED_RESULT',
    cached,
    notCached,
    total: urls.length
  });
}

// Get total cache size and count
async function handleGetCacheSize(event) {
  let totalSize = 0;
  let fileCount = 0;

  try {
    const cacheNames = await caches.keys();

    for (const name of cacheNames) {
      if (!name.startsWith('ptw-')) continue;

      const cache = await caches.open(name);
      const requests = await cache.keys();

      for (const request of requests) {
        const response = await cache.match(request);
        if (response) {
          // Clone and read to get actual size
          const blob = await response.clone().blob();
          totalSize += blob.size;
          fileCount++;
        }
      }
    }
  } catch (err) {
    console.warn('Error calculating cache size:', err);
  }

  event.source?.postMessage({
    type: 'PTW_CACHE_SIZE_RESULT',
    totalSize,
    fileCount,
    formattedSize: formatBytes(totalSize)
  });
}

// Clear cached assets for a specific category
async function handleClearCategory(event, payload) {
  const { urls, categoryId } = payload || {};
  if (!urls || !Array.isArray(urls)) {
    event.source?.postMessage({ type: 'PTW_CLEAR_COMPLETE', categoryId, deleted: 0 });
    return;
  }

  const cache = await caches.open(ASSET_CACHE);
  let deleted = 0;

  for (const url of urls) {
    const success = await cache.delete(url);
    if (success) deleted++;
  }

  event.source?.postMessage({
    type: 'PTW_CLEAR_COMPLETE',
    categoryId,
    deleted,
    total: urls.length
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
