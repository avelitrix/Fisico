const CACHE='fisico-v1-4';
const ASSETS=['./','./index.html','./styles.css','./app.js','./sample-data.js','./manifest.webmanifest','./icons/icon.svg'];
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)))});
self.addEventListener('activate',event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))),self.clients.claim()])));
self.addEventListener('fetch',event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));
