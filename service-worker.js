// Service worker de Recuperación Activa
// - Guarda en caché la página y los iconos para que la app abra al instante y muestre
//   algo útil aunque no haya conexión (estrategia: red primero, caché si falla).
// - NUNCA cachea /api/ (datos de usuario, pagos, chat): siempre va a la red.
// - El detector de movimiento (MediaPipe) se guarda tras el primer uso: el corrector
//   de cámara puede abrirse sin conexión la segunda vez.
const VERSION = 'ra-v16';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const CDN_MODELOS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;            // datos siempre en vivo
  const esModelo = CDN_MODELOS.includes(url.hostname) && /mediapipe|pose_landmarker|hand_landmarker|tasks-vision/.test(url.href);
  if (url.origin !== location.origin && !esModelo) return;  // vídeos de YouTube, fotos, fuentes: no se tocan
  if (esModelo) {                                           // modelos: caché primero (pesan varios MB)
    e.respondWith(caches.match(req).then(h => h || fetch(req).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); return r; })));
    return;
  }
  e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); } return r; })
    .catch(() => caches.match(req).then(h => h || caches.match('/index.html'))));
});
