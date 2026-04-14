const CACHE_NAME = 'branch-v2'
const PRECACHE = ['/', '/logo.png']

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  )
  // Don't skipWaiting — let the user navigate naturally to pick up the new SW
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Skip non-GET, API, and socket requests entirely
  if (e.request.method !== 'GET') return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return

  // Static assets (fonts, images, sounds) - cache-first
  const isStaticAsset = /\.(png|jpg|jpeg|svg|gif|ico|woff2?|ttf|eot|mp3|wav|m4a|ogg)$/i.test(url.pathname)

  if (isStaticAsset) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone))
          }
          return res
        }).catch(() => caches.match(e.request))
      })
    )
    return
  }

  // Everything else (HTML, JS, CSS) - network-first with cache fallback
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone()
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone))
      }
      return res
    }).catch(() => caches.match(e.request))
  )
})
