// Cloudflare Pages Function: /api/data
// Lấy dữ liệu từ Google Apps Script (kèm khoá bí mật), chỉ trả về cho người đã đăng nhập qua Cloudflare Access.
// Biến môi trường cần đặt trong Cloudflare Pages > Settings > Variables and Secrets:
//   APPS_SCRIPT_URL  – URL web app Apps Script (…/exec)
//   DATA_KEY         – khoá bí mật, trùng với Script Property DATA_KEY trong Apps Script
//   ACCESS_TEAM      – tên team Zero Trust, ví dụ "huyphat" (từ huyphat.cloudflareaccess.com)
//   ACCESS_AUD       – Application Audience (AUD) Tag của ứng dụng Access
//   CACHE_SECONDS    – (tuỳ chọn) số giây giữ dữ liệu tạm, mặc định 300

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function verifyAccess(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return 'Chưa đăng nhập Cloudflare Access';
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return 'Token không hợp lệ';
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  const certs = await (await fetch(`https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } })).json();
  const jwk = (certs.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return 'Không tìm thấy khoá xác thực';
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return 'Chữ ký token sai';
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return 'Token không dành cho ứng dụng này';
  if (payload.exp && payload.exp * 1000 < Date.now()) return 'Token đã hết hạn';
  return null;
}

export async function onRequestGet({ request, env, waitUntil }) {
  for (const k of ['APPS_SCRIPT_URL', 'DATA_KEY', 'ACCESS_TEAM', 'ACCESS_AUD']) if (!env[k]) return json({ error: `Thiếu biến môi trường ${k}` }, 500);
  const denied = await verifyAccess(request, env).catch((e) => 'Lỗi xác thực: ' + e.message);
  if (denied) return json({ error: denied }, 401);

  const url = new URL(request.url);
  const fresh = url.searchParams.get('fresh') === '1';
  const ttl = Number(env.CACHE_SECONDS || 300);
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__hpr_data_cache`);
  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-hpr-cache': 'hit' } });
  }
  const r = await fetch(`${env.APPS_SCRIPT_URL}?key=${encodeURIComponent(env.DATA_KEY)}`, { redirect: 'follow' });
  const text = await r.text();
  if (!r.ok) return json({ error: `Apps Script trả lỗi HTTP ${r.status}` }, 502);
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return json({ error: 'Apps Script không trả về JSON — kiểm tra lại quyền "Anyone" khi triển khai' }, 502); }
  if (parsed.error) return json({ error: 'Apps Script: ' + parsed.error }, 502);
  waitUntil(cache.put(cacheKey, new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `s-maxage=${ttl}` } })));
  return new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-hpr-cache': 'miss' } });
}
