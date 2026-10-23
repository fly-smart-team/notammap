// NOTAM Lite 중계 서버 (Cloudflare Workers, 무료 플랜)
// 브라우저가 직접 부를 수 없는 외부 API를 대신 호출하고 CORS 헤더를 붙여 돌려줍니다.
//   GET /adsb/reg/HL8381   → 무료 ADS-B(adsb.fi → adsb.lol → airplanes.live) 기번 조회
//   GET /health            → 동작 확인
// 나중에 공공데이터(게이트·입항편)는 /icn/... 경로로 추가 (인증키는 Worker 환경변수에 저장)

const ALLOW_ORIGINS = ['https://fly-smart-team.github.io'];   // 이 사이트에서만 사용 허용

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

async function adsbByReg(reg) {
  const r = encodeURIComponent(reg.toUpperCase().replace(/[^A-Z0-9-]/g, ''));
  const srcs = [
    ['adsb.fi', `https://opendata.adsb.fi/api/v2/registration/${r}`],
    ['adsb.lol', `https://api.adsb.lol/v2/reg/${r}`],
    ['airplanes.live', `https://api.airplanes.live/v2/reg/${r}`],
  ];
  const errs = [];
  for (const [name, url] of srcs) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'notam-lite-proxy (personal, non-commercial)' }, cf: { cacheTtl: 20 } });
      if (!res.ok) { errs.push(`${name}: HTTP ${res.status}`); continue; }
      const j = await res.json();
      return { src: name, ac: j.ac || j.aircraft || [], errs };
    } catch (e) { errs.push(`${name}: ${e.message}`); }
  }
  return { src: null, ac: [], errs, fail: true };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true }, 200, origin);
    const m = url.pathname.match(/^\/adsb\/reg\/([A-Za-z0-9-]{3,10})$/);
    if (m) {
      const r = await adsbByReg(m[1]);
      return json(r, r.fail ? 502 : 200, origin);
    }
    return json({ error: 'not found' }, 404, origin);
  },
};
