/* 동의서 서명받기 · Cloudflare Worker  (저장소의 worker.js → 사이트의 /api)

   하는 일
     브라우저(서명 화면)  →  같은 주소의 /api  →  구글 시트 서버(Apps Script 웹 앱)
   화면 파일(public 폴더)은 Cloudflare가 그대로 내보내고, 이 파일은 /api 로 온 요청만 받습니다.
   구글 시트 서버 주소는 Cloudflare의 비밀 값 GAS_URL 에만 둡니다.
   그래서 화면 파일(index.html)·주소창·QR코드 어디에도 서버 주소가 드러나지 않습니다.

   설정
     Cloudflare › Workers & Pages › sign › 설정(Settings) › 변수 및 비밀(Variables and Secrets) › 추가(Add)
       유형  비밀(Secret)
       이름  GAS_URL
       값    https://script.google.com/macros/s/…/exec   (Apps Script › 배포 › 배포 관리 › 웹 앱 URL)

   점검
     브라우저에서  https://(내 주소)/api  를 열면 설정이 되었는지 알려 줍니다. (서버 주소는 보여 주지 않습니다)
*/

const GAS_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
const MAX_BODY = 3 * 1024 * 1024;                 /* 한 번에 받는 요청 크기 (설정 + 첨부 그림까지 넉넉히) */
const TIMEOUT_MS = 28000;                         /* 화면 쪽 기다림(30초)보다 조금 짧게 */
/* 화면 프로그램이 쓰는 요청만 통과시킨다. 화면 프로그램에 새 요청이 생기면 여기에도 적어야 한다. */
const ACTIONS = new Set(['ping', 'list', 'books', 'boot', 'lookup', 'pick', 'sign', 'create',
  'adminLogin', 'adminLoad', 'adminSaveCfg', 'adminSaveRoster', 'adminDelSig', 'adminSetPw']);

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: HEADERS });
const gasUrl = env => String((env && env.GAS_URL) || '').trim();

/* 주소창에서 /api 를 열었을 때: 설정 점검 */
function apiCheck(env) {
  const ready = GAS_RE.test(gasUrl(env));
  return json({
    ok: ready, ready,
    message: ready
      ? '준비되었습니다. 구글 시트 서버 주소(GAS_URL)가 설정되어 있습니다.'
      : 'GAS_URL 이 없거나 모양이 맞지 않습니다. Cloudflare › sign › 설정 › 변수 및 비밀 에 GAS_URL (https://script.google.com/macros/s/…/exec) 을 비밀(Secret)로 넣어 주세요.',
  }, ready ? 200 : 500);
}

/* 서명 화면이 보내는 요청 */
async function apiRelay(request, env) {
  const gas = gasUrl(env);
  if (!GAS_RE.test(gas)) return json({ ok: false, error: '서버 주소가 아직 설정되지 않았습니다. Cloudflare의 sign › 설정 › 변수 및 비밀 에 GAS_URL 을 넣어 주세요.' }, 500);

  /* 다른 사이트의 화면이 이 주소를 빌려 쓰지 못하게: 브라우저가 알려 주는 출처가 이 사이트와 같아야 한다 */
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ ok: false, error: '허용되지 않은 곳에서 온 요청입니다.' }, 403);

  let text = '';
  try { text = await request.text(); } catch (e) { return json({ ok: false, error: '요청을 읽지 못했습니다.' }, 400); }
  if (text.length > MAX_BODY) return json({ ok: false, error: '보내는 내용이 너무 큽니다. 첨부 그림을 줄여 주세요.' }, 413);

  let body = null;
  try { body = JSON.parse(text); } catch (e) { }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string' || !ACTIONS.has(body.action)) {
    return json({ ok: false, error: '알 수 없는 요청입니다.' }, 400);
  }

  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    /* Apps Script 웹 앱은 POST 를 받으면 결과 주소로 한 번 넘겨 준다(302) → 따라가서 결과를 받는다 */
    const r = await fetch(gas, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: text, redirect: 'follow', signal: ctrl.signal });
    const out = await r.text();
    try { const j = JSON.parse(out); if (!j || typeof j !== 'object') throw new Error('x'); }
    catch (e) {
      /* 로그인 화면 같은 웹 문서가 돌아온 경우 */
      return json({ ok: false, error: '구글 시트 서버가 알 수 없는 답을 보냈습니다. Apps Script 배포의 액세스 권한이 "모든 사용자"인지, GAS_URL 이 지금 쓰는 웹 앱 주소(…/exec)인지 확인해 주세요.' }, 502);
    }
    return new Response(out, { status: 200, headers: HEADERS });
  } catch (e) {
    return (e && e.name === 'AbortError')
      ? json({ ok: false, error: '구글 시트 서버의 응답이 늦습니다. 잠시 뒤 다시 해 주세요.' }, 504)
      : json({ ok: false, error: '구글 시트 서버에 연결하지 못했습니다. 잠시 뒤 다시 해 주세요.' }, 502);
  } finally { clearTimeout(timer); }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path === '/api/') {
      if (request.method === 'GET' || request.method === 'HEAD') return apiCheck(env);
      if (request.method === 'POST') return apiRelay(request, env);
      return json({ ok: false, error: '허용되지 않은 방식입니다.' }, 405);
    }
    /* 화면 파일에 없는 그 밖의 주소 */
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('찾을 수 없는 주소입니다.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' } });
  },
};
