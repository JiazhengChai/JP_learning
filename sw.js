/* Generated asset list/revision is refreshed by npm run build. Keep at the app root. */
const CACHE_VERSION = 'langlens-shell-953feaae1f0f8a1d';
const SHELL_FILES = [
    './', './index.html', './styles.css?v=20261023-pwa1', './favicon.svg',
    './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
    './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
    './vendor/pdf.min.js', './vendor/pdf.worker.min.js',
    './js/backup-utils.js?v=20260919-mobile1', './js/firebase-config.js?v=20260919-mobile1',
    './js/sync-core.js?v=20260919-mobile1', './js/db.js?v=20260919-mobile1',
    './js/cloud-sync.js?v=20260919-mobile1', './js/item-import-utils.js?v=20260919-mobile1',
    './js/app.js?v=20260919-mobile1', './js/pwa.js'
];
const scopedURL = path => new URL(path, self.registration.scope).href;
const shellURLs = new Set(SHELL_FILES.map(scopedURL));
const cachePrefix = `langlens:${self.registration.scope}:`;
const cacheName = cachePrefix + CACHE_VERSION;

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(cacheName);
        // A failed download keeps the previous complete app version active.
        await cache.addAll(SHELL_FILES.map(path => new Request(scopedURL(path), { cache: 'reload' })));
    })());
    // Deliberately wait for all existing windows to close before activating updates.
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key.startsWith(cachePrefix) && key !== cacheName) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});
self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    // Never cache sign-in, API calls, account records, or private attachments.
    if (url.origin !== self.location.origin) return;
    const isAppPage = request.mode === 'navigate'
        && (url.pathname === new URL(self.registration.scope).pathname
            || url.pathname === new URL('./index.html', self.registration.scope).pathname);
    if (!isAppPage && !shellURLs.has(url.href)) return;
    event.respondWith((async () => {
        const cache = await caches.open(cacheName);
        return await cache.match(isAppPage ? scopedURL('./index.html') : request) || fetch(request);
    })());
});
