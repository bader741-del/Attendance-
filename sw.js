/* Service Worker — منصة مراقبة الدوام */
const CACHE = 'mksh-attendance-v3';
const CORE = [
  './',
  './index.html',
  './admin.html',
  './employee.html',
  './hospital-map.html',
  './hospital-map.css',
  './hospital-map.js',
  './style.css',
  './script.js',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// شبكة أولاً مع الرجوع للذاكرة المؤقتة (يعمل دون اتصال)
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // بيانات Supabase حية — لا تُخزَّن مؤقتاً أبداً
  if (e.request.url.includes('supabase.co')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        if (res.ok && (e.request.url.startsWith(self.location.origin) || e.request.url.includes('cdnjs.cloudflare.com') || e.request.url.includes('fonts.g'))) {
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('./index.html')))
  );
});
