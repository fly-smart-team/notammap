// NOTAM FIR Map Lite — 오프라인 캐시 서비스 워커
// 전략: 저장본으로 즉시 열고(오프라인 OK), 온라인이면 백그라운드에서 새 버전을 받아 다음 실행부터 적용
const CACHE = 'notam-lite-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const EXTRA = ['./787.html'];   // 같은 저장소의 다른 페이지 (있으면 함께 저장)

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(CORE);
    await Promise.all(EXTRA.map(u => c.add(u).catch(() => { })));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function notify(msg) {
  const cs = await self.clients.matchAll({ type: 'window' });
  cs.forEach(c => c.postMessage(msg));
}
// 페이지 새 버전을 받아 저장본과 다르면 교체 (index.html이면 화면에 알림)
async function refresh(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) return;
    const c = await caches.open(CACHE);
    const old = await c.match(path);
    const fresh = await res.clone().text();
    const prev = old ? await old.text() : '';
    if (fresh !== prev) {
      const mk = () => new Response(fresh, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      await c.put(path, mk());
      if (path === './index.html') await c.put('./', mk());
      if (prev) notify({ type: 'updated', path });
    }
  } catch (err) { /* 오프라인: 저장본 유지 */ }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 기상(METAR)·지도 타일 등 외부 요청은 그대로 통과
  if (req.mode === 'navigate') {
    const scope = new URL(self.registration.scope).pathname;
    let rel = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : url.pathname.replace(/^\//, '');
    const path = (rel === '' || rel === 'index.html') ? './index.html' : './' + rel;
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(path);
      if (hit) { e.waitUntil(refresh(path)); return hit; }
      try { const res = await fetch(req); if (res.ok) c.put(path, res.clone()); return res; }
      catch (err) { return new Response('오프라인 저장본이 없습니다. 온라인에서 한 번 열어 주세요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }); }
    })());
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
    return res;
  })));
});
self.addEventListener('message', e => { if (e.data === 'check-update') e.waitUntil(refresh('./index.html')); });
