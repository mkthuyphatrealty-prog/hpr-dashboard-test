// /api/auth/login · logout · me · check · setpw · forgot
import { json, randTok, sha256, hashPw, safeEq, sessCookie, SESSION_DAYS, getUser, gas, mailHtml, origin } from '../_lib.js';

const okEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const pwOk = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200 && /[A-Za-zÀ-ỹ]/.test(p) && /\d/.test(p);
const body = async (request) => { try { return await request.json(); } catch (e) { return {}; } };

async function accountByToken(env, token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const a = await env.DB.prepare('SELECT * FROM accounts WHERE token_hash = ?').bind(await sha256(token)).first();
  if (!a || !a.token_exp || a.token_exp < Date.now() || !a.active) return null;
  return a;
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  if (!env.DB) return json({ error: 'Chưa gắn cơ sở dữ liệu DB (D1)' }, 500);
  const act = params.action, method = request.method;
  try {
    if (act === 'me' && method === 'GET') {
      const u = await getUser(request, env);
      if (!u) return json({ error: 'Chưa đăng nhập' }, 401);
      return json({ email: u.email, name: u.name, pos: u.pos, perms: [...u.perms] });
    }
    if (act === 'logout' && method === 'POST') {
      const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)hpr_s=([A-Za-z0-9_-]{20,})/);
      if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(m[1])).run();
      return json({ ok: true }, 200, { 'set-cookie': sessCookie('', 0) });
    }
    if (act === 'login' && method === 'POST') {
      const b = await body(request), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
      const bad = (msg, s = 401) => json({ error: msg || 'Gmail hoặc mật khẩu không đúng.' }, s);
      const a = okEmail(email) ? await env.DB.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first() : null;
      if (!a) { await hashPw(pw, 'x'); return bad(); }
      if (!a.active) return bad('Tài khoản đã bị khóa. Liên hệ Giám đốc Marketing.', 403);
      if (a.status !== 'active' || !a.hash) return bad('Tài khoản chưa tạo mật khẩu. Mở email mời trong Gmail để tạo mật khẩu.', 403);
      if (a.lock_until && a.lock_until > Date.now()) return bad(`Tài khoản tạm khóa do nhập sai 5 lần. Thử lại sau ${Math.ceil((a.lock_until - Date.now()) / 60000)} phút hoặc dùng "Quên mật khẩu".`, 429);
      if (!safeEq(await hashPw(pw, a.salt), a.hash)) {
        const f = (a.fails || 0) + 1;
        if (f >= 5) { await env.DB.prepare('UPDATE accounts SET fails = 0, lock_until = ? WHERE email = ?').bind(Date.now() + 15 * 60000, email).run(); return bad('Sai mật khẩu 5 lần. Tài khoản tạm khóa 15 phút.', 429); }
        await env.DB.prepare('UPDATE accounts SET fails = ? WHERE email = ?').bind(f, email).run();
        return bad(`Gmail hoặc mật khẩu không đúng. Còn ${5 - f} lần thử.`);
      }
      const tok = randTok(), exp = Date.now() + SESSION_DAYS * 864e5;
      await env.DB.batch([
        env.DB.prepare('UPDATE accounts SET fails = 0, lock_until = 0 WHERE email = ?').bind(email),
        env.DB.prepare('INSERT INTO sessions (token_hash, email, exp, created_at) VALUES (?, ?, ?, ?)').bind(await sha256(tok), email, exp, Date.now()),
        env.DB.prepare('DELETE FROM sessions WHERE exp < ?').bind(Date.now()),
      ]);
      ctx.waitUntil(gas(env, 'batch', { ops: [{ op: 'append', sheet: 'Lịch sử', rows: [{ at: Date.now(), by: a.name, code: '—', action: 'Đăng nhập', detail: email }] }] }).catch(() => {}));
      return json({ ok: true }, 200, { 'set-cookie': sessCookie(tok, SESSION_DAYS * 86400) });
    }
    if (act === 'check' && method === 'POST') {
      const a = await accountByToken(env, (await body(request)).token);
      if (!a) return json({ error: 'Link đã được dùng, đã hết hạn, hoặc tài khoản đã bị khóa. Liên hệ Giám đốc Marketing để được gửi lại.' }, 400);
      return json({ name: a.name, email: a.email, type: a.token_type });
    }
    if (act === 'setpw' && method === 'POST') {
      const b = await body(request), a = await accountByToken(env, b.token);
      if (!a) return json({ error: 'Link đã được dùng, đã hết hạn, hoặc tài khoản đã bị khóa.' }, 400);
      if (!pwOk(b.password)) return json({ error: 'Mật khẩu cần ít nhất 8 ký tự, có chữ cái và chữ số.' }, 400);
      const salt = randTok(16), first = a.token_type === 'invite';
      await env.DB.batch([
        env.DB.prepare("UPDATE accounts SET status = 'active', salt = ?, hash = ?, fails = 0, lock_until = 0, token_hash = NULL, token_exp = NULL, token_type = NULL WHERE email = ?").bind(salt, await hashPw(b.password, salt), a.email),
        env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(a.email),
      ]);
      ctx.waitUntil(gas(env, 'batch', { ops: [{ op: 'append', sheet: 'Lịch sử', rows: [{ at: Date.now(), by: a.name, code: '—', action: first ? 'Kích hoạt tài khoản' : 'Đặt lại mật khẩu', detail: a.email }] }] }).catch(() => {}));
      return json({ ok: true, email: a.email, first });
    }
    if (act === 'forgot' && method === 'POST') {
      const email = String((await body(request)).email || '').trim().toLowerCase();
      const a = okEmail(email) ? await env.DB.prepare("SELECT * FROM accounts WHERE email = ? AND active = 1 AND status = 'active'").bind(email).first() : null;
      if (a && !(a.token_type === 'reset' && a.token_exp - 47.9 * 3600e3 > Date.now())) { // chống gửi liên tục: tối đa 1 email / 6 phút
        const tok = randTok();
        await env.DB.prepare("UPDATE accounts SET token_hash = ?, token_exp = ?, token_type = 'reset' WHERE email = ?").bind(await sha256(tok), Date.now() + 48 * 3600e3, email).run();
        const url = `${origin(request)}/#setpw=${tok}`;
        await gas(env, 'batch', { ops: [{ op: 'mail', to: email, subject: 'Đặt lại mật khẩu HPR Performance', html: mailHtml('Đặt lại mật khẩu', [`Chào ${a.name},`, 'Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản HPR Performance.', 'Bấm nút bên dưới để đặt mật khẩu mới. Link chỉ dùng được một lần và hết hạn sau 48 giờ. Nếu bạn không yêu cầu, hãy bỏ qua email này.'], { url, text: 'Đặt lại mật khẩu' }) }] });
      }
      return json({ ok: true, msg: 'Nếu Gmail này có trong hệ thống, link đặt lại mật khẩu đã được gửi. Kiểm tra cả thư mục Spam.' });
    }
    return json({ error: 'Không hỗ trợ' }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}
