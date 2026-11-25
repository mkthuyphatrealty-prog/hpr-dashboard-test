// Thư viện dùng chung cho đăng nhập, phân quyền và giao việc (không phải một route).
// Biến môi trường cần có: DB (D1 binding), TASKS_URL (URL web app Apps Script "Giao việc MKT"), TASKS_KEY (mã khóa bí mật).

export const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const enc = new TextEncoder();
export const b64u = (buf) => {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const randTok = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export const sha256 = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
export async function hashPw(pw, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, k, 256));
}
export const safeEq = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

export const PERMS_ALL = ['tab:overview', 'tab:campaign', 'tab:content', 'tab:time', 'tab:customer', 'tab:meet', 'tab:team', 'tab:health', 'phone',
  't:own', 't:viewAll', 't:assign', 't:review', 't:ext', 't:rank', 't:log', 't:staff', 't:perm'];
export const TAB_PERMS = PERMS_ALL.filter((p) => p.startsWith('tab:'));
export const SESSION_DAYS = 7;
export const sessCookie = (tok, maxAge) => `hpr_s=${tok}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function rolePerms(env, name) {
  const r = await env.DB.prepare('SELECT perms, locked FROM roles WHERE name = ?').bind(name).first();
  if (!r) return new Set(['t:own']);
  if (r.locked) return new Set(PERMS_ALL);
  const s = new Set(JSON.parse(r.perms || '[]')); s.add('t:own'); return s;
}

// Người đang đăng nhập (null nếu chưa đăng nhập / phiên hết hạn / tài khoản bị khóa)
export async function getUser(request, env) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)hpr_s=([A-Za-z0-9_-]{20,})/);
  if (!m || !env.DB) return null;
  const row = await env.DB.prepare('SELECT a.email, a.name, a.pos, a.active, s.exp FROM sessions s JOIN accounts a ON a.email = s.email WHERE s.token_hash = ?').bind(await sha256(m[1])).first();
  if (!row || row.exp < Date.now() || !row.active) return null;
  return { email: row.email, name: row.name, pos: row.pos, perms: await rolePerms(env, row.pos) };
}
export const can = (u, k) => !!u && (k === 't:own' || u.perms.has(k));

// Gọi Apps Script "Giao việc MKT" (đọc/ghi Google Sheet, gửi email)
export async function gas(env, action, payload = {}) {
  if (!env.TASKS_URL || !env.TASKS_KEY) throw new Error('Thiếu biến môi trường TASKS_URL hoặc TASKS_KEY');
  const r = await fetch(env.TASKS_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: env.TASKS_KEY, action, ...payload }), redirect: 'follow' });
  const t = await r.text(); let j;
  try { j = JSON.parse(t); } catch (e) { throw new Error('Apps Script Giao việc trả về không hợp lệ (HTTP ' + r.status + ')'); }
  if (j.error) throw new Error('Apps Script: ' + j.error);
  return j;
}

// Nội dung email
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function mailHtml(title, lines, btn) {
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f2c37;line-height:1.6">
<div style="background:#0c3341;color:#fff;padding:14px 18px;border-radius:12px 12px 0 0"><b>HPR Performance</b> · Marketing &amp; Sales</div>
<div style="border:1px solid #dde5e8;border-top:0;padding:18px;border-radius:0 0 12px 12px">
<h2 style="margin:0 0 10px;font-size:18px">${esc(title)}</h2>${lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join('')}
${btn ? `<p><a href="${esc(btn.url)}" style="display:inline-block;background:#14b8a6;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-weight:bold">${esc(btn.text)}</a></p>` : ''}
<p style="font-size:12px;color:#6a8590;margin-top:16px">Email tự động từ hệ thống HPR Performance. Vui lòng không trả lời email này.</p></div></div>`;
}
export const origin = (request) => new URL(request.url).origin;
