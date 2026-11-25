// Cloudflare Pages Function: /api/data
// Lấy dữ liệu Meta Ads + Google Sheet từ Apps Script, CHỈ trả về cho người đã đăng nhập và có quyền xem dashboard.
// Người không có quyền "Hiện số điện thoại" nhận bản đã che số điện thoại/email khách ngay từ máy chủ.
// Biến môi trường: APPS_SCRIPT_URL, DATA_KEY, DB (D1), CACHE_SECONDS (tuỳ chọn, mặc định 60)
import { json, getUser, TAB_PERMS } from './_lib.js';

const maskPhone = (v) => { const s = String(v ?? ''); return s.length < 4 ? s : '•••••••' + s.slice(-3); };
const maskEmail = (v) => { const s = String(v ?? ''); const i = s.indexOf('@'); return i < 1 ? (s ? '•••' : '') : s[0] + '•••' + s.slice(i); };
function masked(text) {
  const j = JSON.parse(text);
  (j.sales || []).forEach((r) => { r.phone = maskPhone(r.phone); });
  (j.customers || []).forEach((r) => { r.phone = maskPhone(r.phone); if (r.email) r.email = maskEmail(r.email); });
  return JSON.stringify(j);
}

export async function onRequestGet({ request, env, waitUntil }) {
  for (const k of ['APPS_SCRIPT_URL', 'DATA_KEY']) if (!env[k]) return json({ error: `Thiếu biến môi trường ${k}` }, 500);
  const u = await getUser(request, env).catch(() => null);
  if (!u) return json({ error: 'Chưa đăng nhập' }, 401);
  if (!TAB_PERMS.some((p) => u.perms.has(p))) return json({ updatedAt: new Date().toISOString(), ads: [], sales: [], customers: [], warnings: [], restricted: true });
  const full = u.perms.has('phone');

  const url = new URL(request.url);
  const fresh = url.searchParams.get('fresh') === '1';
  const ttl = Number(env.CACHE_SECONDS || 60);
  const cache = caches.default;
  const keyFull = new Request(`${url.origin}/__hpr_data_cache_v3_full`), keyMask = new Request(`${url.origin}/__hpr_data_cache_v3_mask`);
  const headers = (extra) => ({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  const put = (key, body, at) => cache.put(key, new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 's-maxage=86400', 'x-hpr-at': String(at) } }));

  // Lấy dữ liệu mới, lưu 2 bản vào bộ nhớ đệm: bản đầy đủ và bản đã che số điện thoại
  const pull = async (force) => {
    const r = await fetch(`${env.APPS_SCRIPT_URL}?key=${encodeURIComponent(env.DATA_KEY)}${force ? '&fresh=1' : ''}`, { redirect: 'follow' });
    const text = await r.text();
    if (!r.ok) throw new Error(`Apps Script trả lỗi HTTP ${r.status}`);
    if (text.trim()[0] !== '{') throw new Error('Apps Script không trả về JSON — kiểm tra lại quyền "Anyone" khi triển khai');
    const m = masked(text), at = Date.now();
    if (/^\{"error"/.test(text)) throw new Error('Apps Script: ' + JSON.parse(text).error);
    await Promise.all([put(keyFull, text, at), put(keyMask, m, at)]);
    return full ? text : m;
  };

  if (!fresh) {
    const hit = await cache.match(full ? keyFull : keyMask);
    if (hit) {
      const age = (Date.now() - Number(hit.headers.get('x-hpr-at') || 0)) / 1000;
      if (age >= ttl) waitUntil(pull(false).catch(() => {}));
      return new Response(hit.body, { headers: headers({ 'x-hpr-cache': age < ttl ? 'hit' : 'stale' }) });
    }
  }
  try {
    return new Response(await pull(fresh), { headers: headers({ 'x-hpr-cache': 'miss' }) });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}
