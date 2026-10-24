// notam-proxy — Cloudflare Worker (ADS-B 중계)
// GET /health            → {ok:true}
// GET /adsb/reg/HL8510   → {src, ac:[...], errs}
// GET /dgk/B551177/<서비스>/<기능>?파라미터 → 공공데이터포털(인천공항) 중계. 인증키는 Worker 비밀값 ICN_KEY에서 붙임
const ALLOW_ORIGINS = ['https://fly-smart-team.github.io'];

function cors(origin) {
  const ok = ALLOW_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin || '');
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOW_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
const json = (obj, status, origin) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) },
});

// 출처 하나 조회 (최대 5초)
async function one(name, url) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'notam-lite-proxy/1.1 (personal, non-commercial)', 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return { src: name, ac: j.ac || j.aircraft || [], ms: Date.now() - t0 };
  } catch (e) {
    throw new Error(`${name}: ${e.name === 'AbortError' ? '시간 초과(5초)' : e.message}`);
  } finally { clearTimeout(timer); }
}

// 세 곳 동시 조회 → 가장 먼저 성공한 결과 사용
async function adsbByReg(reg) {
  const r = encodeURIComponent(reg.toUpperCase().replace(/[^A-Z0-9-]/g, ''));
  const jobs = [
    one('adsb.fi', `https://opendata.adsb.fi/api/v2/registration/${r}`),
    one('adsb.lol', `https://api.adsb.lol/v2/reg/${r}`),
    one('airplanes.live', `https://api.airplanes.live/v2/reg/${r}`),
  ];
  try {
    // 기체가 잡힌 결과 우선, 없으면 빈 결과라도 성공으로
    const withAc = await Promise.any(jobs.map(p => p.then(x => x.ac.length ? x : Promise.reject(new Error('empty')))));
    return { ...withAc, errs: [] };
  } catch (_) {
    const all = await Promise.allSettled(jobs);
    const ok = all.find(x => x.status === 'fulfilled');
    const errs = all.filter(x => x.status === 'rejected').map(x => x.reason.message);
    if (ok) return { ...ok.value, errs };
    return { src: null, ac: [], errs, fail: true };
  }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, v: '1.2', icnKey: !!env.ICN_KEY }, 200, origin);
    const m = url.pathname.match(/^\/adsb\/reg\/([A-Za-z0-9-]{3,10})$/);
    if (m) {
      const r = await adsbByReg(m[1]);
      return json(r, r.fail ? 502 : 200, origin);
    }
    if (url.pathname.startsWith('/dgk/')) {
      if (!env.ICN_KEY) return json({ error: 'Worker에 ICN_KEY 비밀값이 없습니다' }, 500, origin);
      const path = url.pathname.slice(5);
      if (!/^B551177\/[A-Za-z0-9_\/-]+$/.test(path)) return json({ error: 'bad path' }, 400, origin);
      const q = new URLSearchParams(url.search);
      q.set('serviceKey', env.ICN_KEY);
      if (!q.has('type')) q.set('type', 'json');
      try {
        const r = await fetch(`https://apis.data.go.kr/${path}?${q}`, { headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        return new Response(text, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin) } });
      } catch (e) { return json({ error: '공공데이터포털 접속 실패: ' + e.message }, 502, origin); }
    }
    return json({ error: 'not found' }, 404, origin);
  },
};
