// notam-proxy — Cloudflare Worker (ADS-B 중계)
// GET /health            → {ok:true}
// GET /adsb/reg/HL8510   → {src, ac:[...], errs}
// GET /icn/reg/HL8511?from=YYYYMMDDHHmm&to=YYYYMMDDHHmm (KST) → 인천공항 도착·출발 기록 중 해당 기체만
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


// ---- 인천공항 운항 현황: 하루치(도착/출발)를 받아 5분간 보관 ----
const ICN_BASE = 'https://apis.data.go.kr/B551177/statusOfAllFltDeOdp';
async function icnDay(op, date, env, ctx, stat) {
  const cacheKey = new Request(`https://icn-cache.local/${op}/${date}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) { stat.cached++; return hit.json(); }
  const all = [];
  for (let page = 1; page <= 3; page++) {
    const q = new URLSearchParams({ serviceKey: env.ICN_KEY, type: 'json', searchDate: date, searchFrom: '0000', searchTo: '2400', searchdtCode: 'S', numOfRows: '1000', pageNo: String(page) });
    const r = await fetch(`${ICN_BASE}/${op}?${q}`, { headers: { 'Accept': 'application/json' } });
    stat.calls++;
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch (e) { throw new Error(`${op} ${date}: 응답 형식 오류 ${txt.slice(0, 80)}`); }
    const body = (j.response || j).body || {}, head = (j.response || j).header || {};
    if (head.resultCode && head.resultCode !== '00') throw new Error(`${op} ${date}: ${head.resultCode} ${head.resultMsg || ''}`);
    let items = body.items; if (items && !Array.isArray(items)) items = items.item ? [].concat(items.item) : [];
    items = items || [];
    for (const x of items) {
      const reg = String(x.aircraftRegNo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!reg || reg === '-') continue;
      all.push({ reg, flt: x.flightId, cs: x.codeshare, ap: x.airportCode, apn: x.airport, sch: x.scheduleDatetime, est: x.estimatedDatetime,
        stand: x.fstandPosition, gate: x.gateNumber, term: x.terminalId, rmk: x.remark, sub: x.aircraftSubtype });
    }
    if (all.length + 0 >= (+body.totalCount || 0) || items.length < 1000) break;
  }
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(all), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' } })));
  return all;
}
function kstDates(from, to) {
  const d0 = Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8)), d1 = Date.UTC(+to.slice(0, 4), +to.slice(4, 6) - 1, +to.slice(6, 8));
  const out = []; for (let d = d0; d <= d1 && out.length < 4; d += 864e5) out.push(new Date(d).toISOString().slice(0, 10).replace(/-/g, ''));
  return out;
}
async function icnByReg(reg, from, to, env, ctx) {
  const R = reg.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const stat = { calls: 0, cached: 0 }, errs = [];
  const res = { reg: R, from, to, arr: [], dep: [] };
  for (const date of kstDates(from, to)) {
    for (const [op, key] of [['getFltArrivalsDeOdp', 'arr'], ['getFltDeparturesDeOdp', 'dep']]) {
      try {
        const rows = await icnDay(op, date, env, ctx, stat);
        rows.forEach(x => { const t = x.est || x.sch || ''; if (x.reg === R && t >= from && t <= to && x.cs !== 'Slave') res[key].push(x); });
      } catch (e) { errs.push(e.message); }
    }
  }
  const by = (a, b) => String(a.est || a.sch).localeCompare(String(b.est || b.sch));
  res.arr.sort(by); res.dep.sort(by);
  return { ...res, errs, ...stat };
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true, v: '1.3', icnKey: !!env.ICN_KEY }, 200, origin);
    const m = url.pathname.match(/^\/adsb\/reg\/([A-Za-z0-9-]{3,10})$/);
    if (m) {
      const r = await adsbByReg(m[1]);
      return json(r, r.fail ? 502 : 200, origin);
    }
    const ir = url.pathname.match(/^\/icn\/reg\/([A-Za-z0-9-]{3,10})$/);
    if (ir) {
      if (!env.ICN_KEY) return json({ error: 'Worker에 ICN_KEY 비밀값이 없습니다' }, 500, origin);
      const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
      if (!/^\d{12}$/.test(from) || !/^\d{12}$/.test(to) || from > to) return json({ error: 'from/to는 YYYYMMDDHHmm (KST)' }, 400, origin);
      const r = await icnByReg(ir[1], from, to, env, ctx);
      return json(r, 200, origin);
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
