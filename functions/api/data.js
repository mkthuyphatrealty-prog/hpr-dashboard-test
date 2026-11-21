// Cloudflare Pages Function: /api/data
// Lấy dữ liệu từ Google Apps Script (kèm khoá bí mật), chỉ trả về cho người đã đăng nhập qua Cloudflare Access.
// Biến môi trường cần đặt trong Cloudflare Pages > Settings > Variables and Secrets:
//   APPS_SCRIPT_URL  – URL web app Apps Script (…/exec)
//   DATA_KEY         – khoá bí mật, trùng với Script Property DATA_KEY trong Apps Script
//   ACCESS_TEAM      – tên team Zero Trust, ví dụ "huyphat" (từ huyphat.cloudflareaccess.com)
//   ACCESS_AUD       – Application Audience (AUD) Tag của ứng dụng Access
//   CACHE_SECONDS    – (tuỳ chọn) sau bao nhiêu giây thì cập nhật ngầm dữ liệu mới, mặc định 60

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
  const ttl = Number(env.CACHE_SECONDS || 60);
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__hpr_data_cache_v2`);
  const headers = (extra) => ({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });

  // Lấy dữ liệu mới từ Apps Script và lưu vào bộ nhớ đệm của Cloudflare (giữ tối đa 1 ngày, coi là "mới" trong ttl giây)
  const pull = async (force) => {
    const r = await fetch(`${env.APPS_SCRIPT_URL}?key=${encodeURIComponent(env.DATA_KEY)}${force ? '&fresh=1' : ''}`, { redirect: 'follow' });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apps Script trả lỗi HTTP ${r.status}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Apps Script không trả về JSON — kiểm tra lại quyền "Anyone" khi triển khai'); }
    if (parsed.error) throw new Error('Apps Script: ' + parsed.error);
    await cache.put(cacheKey, new Response(text, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 's-maxage=86400', 'x-hpr-at': String(Date.now()) } }));
    return text;
  };

  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const age = (Date.now() - Number(hit.headers.get('x-hpr-at') || 0)) / 1000;
      // Còn mới: trả ngay. Đã cũ: vẫn trả ngay bản cũ, đồng thời cập nhật ngầm cho lần sau.
      if (age >= ttl) waitUntil(pull(false).catch(() => {}));
      return new Response(hit.body, { headers: headers({ 'x-hpr-cache': age < ttl ? 'hit' : 'stale' }) });
    }
  }
  try {
    const text = await pull(fresh);
    return new Response(text, { headers: headers({ 'x-hpr-cache': 'miss' }) });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
