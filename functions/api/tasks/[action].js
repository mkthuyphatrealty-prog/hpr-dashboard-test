// /api/tasks/state (GET) · /api/tasks/act (POST) · /api/tasks/cron (Apps Script gọi mỗi 15 phút, kèm mã khóa)
import { json, randTok, sha256, safeEq, getUser, can, gas, mailHtml, origin, PERMS_ALL } from '../_lib.js';

const H = 3600e3, DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const toVN = (ms) => { if (!ms && ms !== 0) return ''; const d = new Date(ms + 7 * H); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const fromVN = (s) => { if (s === '' || s == null) return null; if (/^\d{10,}$/.test(String(s))) return +s; const t = Date.parse(String(s).trim().replace(' ', 'T') + '+07:00'); return isNaN(t) ? null : t; };
const fdt = (ms) => { if (!ms) return '—'; const d = new Date(ms + 7 * H); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const str = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const bool = (v) => v === true || v === 'TRUE' || v === 'true' || v === '1' || v === 1;
const jparse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } };
const TYPES = ['Quảng cáo', 'Nội dung', 'Thiết kế / Video', 'Dữ liệu / Báo cáo', 'Sự kiện', 'Khác'];
const PRIS = ['Cao', 'Trung bình', 'Thấp'];

// ---------- chuyển dòng Sheet <-> đối tượng ----------
function rowToTask(r) {
  return {
    id: r.id, code: r.code, title: r.title, type: r.type, output: r.output, owner: r.owner, support: r.support ? r.support.split(',').filter(Boolean) : [], reviewer: r.reviewer,
    assignedAt: fromVN(r.assignedAt), checkpoint: fromVN(r.checkpoint), due: fromVN(r.due), est: +r.est || 0, priority: r.priority || 'Trung bình', status: r.status || 'todo', progress: +r.progress || 0,
    links: r.links ? r.links.split('\n').filter(Boolean) : [], notes: jparse(r.notes, []), ext: jparse(r.ext, null),
    review: r.reviewResult ? { result: r.reviewResult, score: +r.reviewScore, feedback: r.reviewFeedback, at: fromVN(r.reviewAt), by: r.reviewBy } : null,
    submittedAt: fromVN(r.submittedAt), extAsked: bool(r.extAsked), lateNoNotice: bool(r.lateNoNotice), nSoon: bool(r.nSoon), nLate: bool(r.nLate), recurKey: r.recurKey || '', recur: r.recur || '',
  };
}
function taskToRow(t) {
  return {
    id: t.id, code: t.code, title: t.title, type: t.type, output: t.output, owner: t.owner, support: t.support.join(','), reviewer: t.reviewer,
    assignedAt: toVN(t.assignedAt), checkpoint: toVN(t.checkpoint), due: toVN(t.due), est: String(t.est), priority: t.priority, status: t.status, progress: String(t.progress),
    links: t.links.join('\n'), notes: JSON.stringify(t.notes), ext: t.ext ? JSON.stringify(t.ext) : '',
    reviewResult: t.review ? t.review.result : '', reviewScore: t.review ? String(t.review.score) : '', reviewFeedback: t.review ? t.review.feedback : '', reviewAt: t.review ? toVN(t.review.at) : '', reviewBy: t.review ? t.review.by || '' : '',
    submittedAt: toVN(t.submittedAt), extAsked: t.extAsked ? 'TRUE' : 'FALSE', lateNoNotice: t.lateNoNotice ? 'TRUE' : 'FALSE', nSoon: t.nSoon ? 'TRUE' : 'FALSE', nLate: t.nLate ? 'TRUE' : 'FALSE', recurKey: t.recurKey || '', recur: t.recur || '',
  };
}
const rowToRecur = (r) => ({ id: r.id, title: r.title, type: r.type, output: r.output, owner: r.owner, freq: r.freq, dow: +r.dow, dom: +r.dom, hh: +r.hh, mm: +r.mm || 0, est: +r.est || 1, priority: r.priority || 'Trung bình', active: r.active !== 'FALSE' });
const recurToRow = (r) => ({ id: r.id, title: r.title, type: r.type, output: r.output, owner: r.owner, freq: r.freq, dow: String(r.dow), dom: String(r.dom), hh: String(r.hh), mm: String(r.mm || 0), est: String(r.est), priority: r.priority, active: r.active ? 'TRUE' : 'FALSE' });

// ---------- trạng thái ----------
const isLate = (t, now) => t.status !== 'done' && !(t.status === 'review' && t.submittedAt && t.submittedAt <= t.due) && now > t.due;
const isSoon = (t, now) => !isLate(t, now) && (t.status === 'todo' || t.status === 'doing') && t.due - now < 24 * H;

async function load(env) {
  const [acc, roles, data] = await Promise.all([
    env.DB.prepare('SELECT email, name, pos, zalo, active, status, created_at FROM accounts ORDER BY created_at').all(),
    env.DB.prepare('SELECT name, perms, locked FROM roles ORDER BY created_at').all(),
    gas(env, 'readAll'),
  ]);
  const R = roles.results.map((r) => ({ name: r.name, locked: !!r.locked, perms: r.locked ? PERMS_ALL.slice() : [...new Set(['t:own', ...jparse(r.perms, [])])] }));
  const staff = acc.results.map((a) => ({ id: a.email, email: a.email, name: a.name, pos: a.pos, zalo: a.zalo || '', active: !!a.active, status: a.status }));
  const permOf = (s) => new Set((R.find((r) => r.name === s.pos) || { perms: ['t:own'] }).perms);
  return {
    staff, roles: R, permOf,
    tasks: (data.tasks || []).filter((r) => r.id).map(rowToTask), recur: (data.recur || []).filter((r) => r.id).map(rowToRecur),
    log: (data.log || []).map((l) => ({ at: fromVN(l.at), by: l.by, code: l.code, action: l.action, detail: l.detail })),
    comments: Object.fromEntries((data.comments || []).map((c) => [c.key, c.text])),
    noti: (data.noti || []).map((n) => ({ at: fromVN(n.at), to: n.to, text: n.text })),
    ops: [], dirty: new Set(), dirtyRecur: new Set(),
  };
}

function makeCtx(W, origin) {
  const now = Date.now();
  const P = (id) => W.staff.find((s) => s.id === id) || { name: id || '—', pos: '', email: id };
  const DIR = () => W.staff.find((s) => s.active && W.permOf(s).has('t:review')) || W.staff[0];
  const link = `${origin}/#tasks`;
  const log = (byName, t, action, detail) => { const row = { at: now, by: byName || 'Hệ thống', code: t ? t.code : '—', action, detail: detail || '' }; W.log.unshift(row); W.ops.push({ op: 'append', sheet: 'Lịch sử', rows: [{ ...row, at: toVN(now) }] }); };
  const notify = (to, text, subject) => {
    const s = P(to); if (!s || !s.active) return;
    W.noti.unshift({ at: now, to, text }); W.ops.push({ op: 'append', sheet: 'Thông báo', rows: [{ at: toVN(now), to, text }] });
    if (subject && s.email) W.ops.push({ op: 'mail', to: s.email, subject: 'HPR · ' + subject, html: mailHtml(subject, [`Chào ${s.name},`, text], { url: link, text: 'Mở dashboard' }) });
  };
  const touch = (t) => W.dirty.add(t.id);
  return { now, P, DIR, log, notify, touch };
}
function flush(W) {
  if (W.dirty.size) W.ops.unshift({ op: 'upsert', sheet: 'Đầu việc', key: 'id', rows: W.tasks.filter((t) => W.dirty.has(t.id)).map(taskToRow) });
  if (W.dirtyRecur.size) W.ops.unshift({ op: 'upsert', sheet: 'Việc lặp lại', key: 'id', rows: W.recur.filter((r) => W.dirtyRecur.has(r.id)).map(recurToRow) });
}

function newCode(W, now) {
  const d = new Date(now + 7 * H), pre = `MKT-${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1)}-`;
  const max = W.tasks.filter((t) => (t.code || '').startsWith(pre)).reduce((m, t) => Math.max(m, +t.code.slice(pre.length) || 0), 0);
  return pre + String(max + 1).padStart(3, '0');
}
function addTask(W, C, o, byName) {
  const t = Object.assign({ id: 't' + randTok(9), code: newCode(W, C.now), type: 'Khác', support: [], reviewer: C.DIR().id, assignedAt: C.now, checkpoint: null, est: 1, priority: 'Trung bình', status: 'todo', progress: 0, links: [], notes: [], ext: null, review: null, submittedAt: null, extAsked: false, lateNoNotice: false, nSoon: false, nLate: false, recurKey: '', recur: '' }, o);
  W.tasks.push(t); C.touch(t);
  C.log(byName, t, 'Giao việc', `${t.title} → ${C.P(t.owner).name}, hạn ${fdt(t.due)}`);
  C.notify(t.owner, `Bạn được giao việc mới ${t.code}: "${t.title}". Hạn chót ${fdt(t.due)}.`, `Việc mới ${t.code}`);
  t.support.forEach((s) => C.notify(s, `Bạn được thêm làm người hỗ trợ việc ${t.code}: "${t.title}".`));
  return t;
}

// ---------- việc lặp lại + quét cảnh báo (chạy trong cron) ----------
function genRecur(W, C) {
  W.recur.filter((r) => r.active).forEach((r) => {
    for (let i = 0; i <= 7; i++) {
      const base = new Date(C.now + 7 * H + i * DAY); // ngày theo giờ VN
      const y = base.getUTCFullYear(), m = base.getUTCMonth(), dd = base.getUTCDate(), dow = base.getUTCDay();
      if (r.freq === 'weekly' ? dow !== r.dow : dd !== r.dom) continue;
      const due = Date.UTC(y, m, dd, r.hh, r.mm || 0) - 7 * H;
      if (due < C.now) continue;
      const key = `${r.id}@${toVN(due).slice(0, 16)}`;
      if (W.tasks.some((t) => t.recurKey === key)) continue;
      addTask(W, C, { title: r.title, type: r.type, output: r.output, owner: r.owner, est: r.est, priority: r.priority, due, recurKey: key, recur: r.freq === 'weekly' ? 'Hằng tuần' : 'Hằng tháng' }, null);
    }
  });
}
function scan(W, C) {
  W.tasks.forEach((t) => {
    if (t.status === 'done') return;
    if (isSoon(t, C.now) && !t.nSoon) { t.nSoon = true; C.touch(t); C.notify(t.owner, `Việc ${t.code} "${t.title}" sắp đến hạn (${fdt(t.due)}). Cần gia hạn thì xin trước hạn.`, `Sắp đến hạn ${t.code}`); }
    if (isLate(t, C.now) && !t.nLate) {
      t.nLate = true; if (!t.extAsked) t.lateNoNotice = true; C.touch(t);
      C.notify(t.owner, `Việc ${t.code} "${t.title}" đã TRỄ HẠN (${fdt(t.due)}).`, `TRỄ HẠN ${t.code}`);
      C.notify(C.DIR().id, `${C.P(t.owner).name} trễ hạn việc ${t.code} "${t.title}"${t.extAsked ? '' : ' – không xin gia hạn trước'}.`, `Nhân sự trễ hạn ${t.code}`);
      C.log(null, t, 'Trễ hạn', t.extAsked ? 'Có xin gia hạn trước' : 'Không xin gia hạn trước hạn');
    }
  });
}

// ---------- lời mời ----------
async function invite(env, W, C, email, byName, orig) {
  const s = C.P(email), tok = randTok();
  const st = s.status === 'active' ? 'active' : 'invited';
  await env.DB.prepare("UPDATE accounts SET status = ?, token_hash = ?, token_exp = ?, token_type = ? WHERE email = ?").bind(st, await sha256(tok), C.now + 48 * H, st === 'active' ? 'reset' : 'invite', email).run();
  s.status = st;
  W.ops.push({ op: 'mail', to: email, subject: 'Lời mời tham gia hệ thống HPR Performance', html: mailHtml('Lời mời tham gia HPR Performance', [`Chào ${s.name},`, `${byName || 'Giám đốc Marketing'} mời bạn tham gia hệ thống HPR Performance để nhận và cập nhật công việc được giao.`, 'Bấm nút bên dưới để tạo mật khẩu. Link chỉ dùng được một lần và hết hạn sau 48 giờ. Sau đó đăng nhập bằng chính Gmail này.'], { url: `${orig}/#setpw=${tok}`, text: 'Tạo mật khẩu' }) });
  C.log(byName, null, 'Gửi lời mời', `${s.name} – ${email}`);
}

// ---------- dữ liệu trả về cho trình duyệt (đã lọc theo quyền) ----------
function stateFor(W, u) {
  const me = u.email, vis = can(u, 't:viewAll') ? W.tasks : W.tasks.filter((t) => t.owner === me || t.support.includes(me));
  const codes = new Set(vis.map((t) => t.code));
  const mgr = can(u, 't:staff');
  return {
    me: { id: me, name: u.name, pos: u.pos, perms: [...u.perms] }, now: Date.now(),
    staff: W.staff.map((s) => ({ id: s.id, name: s.name, pos: s.pos, email: s.email, active: s.active, zalo: mgr ? s.zalo : '', status: mgr ? s.status : undefined })),
    roles: can(u, 't:perm') || mgr ? W.roles : [],
    tasks: vis, recur: can(u, 't:assign') ? W.recur : [],
    log: (can(u, 't:log') ? W.log : W.log.filter((l) => codes.has(l.code))).slice(0, 600),
    noti: (mgr ? W.noti : W.noti.filter((n) => n.to === me)).slice(0, 300),
    comments: can(u, 't:rank') ? W.comments : Object.fromEntries(Object.entries(W.comments).filter(([k]) => k.startsWith(me + '|'))),
  };
}

// ---------- các thao tác ----------
async function act(env, W, u, b, orig) {
  const C = makeCtx(W, orig), me = u.email, myName = u.name;
  const T = () => { const t = W.tasks.find((x) => x.id === b.id); if (!t) throw new Error('Không tìm thấy việc'); return t; };
  const need = (k) => { if (!can(u, k)) throw new Error('Bạn không có quyền thực hiện thao tác này'); };
  const visible = (t) => can(u, 't:viewAll') || t.owner === me || t.support.includes(me);
  const owner = (t) => { if (t.owner !== me) throw new Error('Chỉ người làm chính được thao tác'); };
  const staffOk = (id) => W.staff.some((s) => s.id === id && s.active);
  const taskFields = (v) => {
    const o = { title: str(v.title, 200), type: TYPES.includes(v.type) ? v.type : 'Khác', output: str(v.output, 1000), owner: str(v.owner, 120).toLowerCase(), reviewer: str(v.reviewer, 120).toLowerCase() || C.DIR().id,
      assignedAt: +v.assignedAt || C.now, checkpoint: +v.checkpoint || null, due: +v.due, est: Math.max(0, Math.min(999, +v.est || 1)), priority: PRIS.includes(v.priority) ? v.priority : 'Trung bình',
      links: (Array.isArray(v.links) ? v.links : []).map((l) => str(l, 500)).filter((l) => /^https?:\/\//i.test(l)).slice(0, 20), support: (Array.isArray(v.support) ? v.support : []).map((x) => str(x, 120).toLowerCase()).filter(staffOk) };
    o.support = o.support.filter((x) => x !== o.owner);
    if (!o.title || !o.output || !o.due) throw new Error('Cần điền Tên việc, Kết quả đầu ra và Hạn chót');
    if (!staffOk(o.owner)) throw new Error('Người làm chính không hợp lệ');
    if (o.due <= o.assignedAt) throw new Error('Hạn chót phải sau ngày giờ giao');
    if (o.checkpoint && (o.checkpoint > o.due || o.checkpoint < o.assignedAt)) throw new Error('Mốc kiểm tra phải nằm giữa ngày giao và hạn chót');
    return o;
  };
  switch (b.action) {
    case 'create': {
      need('t:assign'); const v = taskFields(b.task || {}); const t = addTask(W, C, v, myName);
      if (b.recur === 'weekly' || b.recur === 'monthly') {
        const d = new Date(v.due + 7 * H); const r = { id: 'r' + randTok(6), title: v.title, type: v.type, output: v.output, owner: v.owner, freq: b.recur, dow: d.getUTCDay(), dom: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), est: v.est, priority: v.priority, active: true };
        W.recur.push(r); W.dirtyRecur.add(r.id); t.recur = b.recur === 'weekly' ? 'Hằng tuần' : 'Hằng tháng'; t.recurKey = `${r.id}@${toVN(v.due).slice(0, 16)}`; C.log(myName, t, 'Tạo lịch lặp lại', t.recur);
      }
      return { msg: `Đã giao việc ${t.code} cho ${C.P(t.owner).name}` };
    }
    case 'edit': {
      need('t:assign'); const t = T(); if (t.status === 'done') throw new Error('Việc đã hoàn thành, không sửa được');
      const v = taskFields(b.task || {}); const L = { title: 'Tên việc', type: 'Loại', output: 'Kết quả đầu ra', owner: 'Người làm', reviewer: 'Người duyệt', assignedAt: 'Ngày giao', checkpoint: 'Mốc kiểm tra', due: 'Hạn chót', est: 'Ước tính', priority: 'Ưu tiên' };
      const ch = []; Object.keys(L).forEach((k) => { if (String(t[k] ?? '') !== String(v[k] ?? '')) ch.push(`${L[k]}: ${['owner', 'reviewer'].includes(k) ? C.P(t[k]).name + ' → ' + C.P(v[k]).name : ['assignedAt', 'checkpoint', 'due'].includes(k) ? fdt(t[k]) + ' → ' + fdt(v[k]) : t[k] + ' → ' + v[k]}`); });
      if (t.support.join() !== v.support.join()) ch.push('Người hỗ trợ'); if (t.links.join() !== v.links.join()) ch.push('Link đính kèm');
      if (v.due !== t.due) { t.nSoon = false; t.nLate = false; }
      Object.assign(t, v); C.touch(t); C.log(myName, t, 'Sửa việc', ch.join('; ') || 'Không đổi');
      if (ch.length) C.notify(t.owner, `Việc ${t.code} vừa được cập nhật: ${ch.join('; ')}`, `Cập nhật việc ${t.code}`);
      return { msg: 'Đã lưu thay đổi' };
    }
    case 'start': { const t = T(); owner(t); if (t.status !== 'todo') throw new Error('Trạng thái không hợp lệ'); t.status = 'doing'; t.progress = Math.max(t.progress, 5); C.touch(t); C.log(myName, t, 'Chuyển trạng thái', 'Chưa làm → Đang làm'); return { msg: 'Đã chuyển sang Đang làm' }; }
    case 'progress': { const t = T(); owner(t); if (t.status !== 'doing') throw new Error('Chỉ cập nhật tiến độ khi Đang làm'); const p = Math.max(0, Math.min(100, Math.round(+b.progress / 5) * 5)); C.log(myName, t, 'Cập nhật tiến độ', `${t.progress}% → ${p}%`); t.progress = p; C.touch(t); return { msg: 'Đã lưu tiến độ' }; }
    case 'note': { const t = T(); if (!visible(t)) throw new Error('Không có quyền'); const v = str(b.text, 1000); if (!v) throw new Error('Ghi chú trống'); t.notes.push({ at: C.now, by: me, text: v }); C.touch(t); C.log(myName, t, 'Thêm ghi chú', v); if (!can(u, 't:viewAll')) C.notify(C.DIR().id, `${myName} ghi chú ở việc ${t.code}: ${v}`); return { msg: 'Đã lưu ghi chú' }; }
    case 'link': { const t = T(); if (!visible(t) || t.status === 'done') throw new Error('Không có quyền'); const v = str(b.url, 500); if (!/^https?:\/\//i.test(v)) throw new Error('Link phải bắt đầu bằng http:// hoặc https://'); t.links.push(v); C.touch(t); C.log(myName, t, 'Thêm link', v); return { msg: 'Đã thêm link' }; }
    case 'submit': { const t = T(); owner(t); if (t.status !== 'doing') throw new Error('Chỉ gửi duyệt khi Đang làm'); const late = C.now > t.due; t.status = 'review'; t.progress = 100; t.submittedAt = C.now; if (late && !t.extAsked) t.lateNoNotice = true; C.touch(t); C.log(myName, t, 'Gửi duyệt', late ? 'Gửi sau hạn chót' : 'Gửi trước hạn chót'); C.notify(t.reviewer, `${myName} đã gửi duyệt việc ${t.code} "${t.title}".`, `Chờ duyệt ${t.code}`); return { msg: 'Đã gửi Giám đốc duyệt' }; }
    case 'extReq': {
      const t = T(); owner(t); if (!['todo', 'doing'].includes(t.status)) throw new Error('Không xin gia hạn được'); if (t.ext && t.ext.state === 'pending') throw new Error('Đã có đơn đang chờ duyệt');
      const v = +b.due, reason = str(b.reason, 500); if (!v || v <= t.due) throw new Error('Hạn mới phải sau hạn hiện tại'); if (!reason) throw new Error('Cần ghi lý do');
      t.ext = { due: v, reason, state: 'pending', at: C.now }; if (C.now <= t.due) t.extAsked = true; C.touch(t);
      C.log(myName, t, 'Xin gia hạn', `${fdt(t.due)} → ${fdt(v)}: ${reason}`); C.notify(C.DIR().id, `${myName} xin gia hạn việc ${t.code} đến ${fdt(v)}. Lý do: ${reason}`, `Xin gia hạn ${t.code}`); return { msg: 'Đã gửi đơn xin gia hạn' };
    }
    case 'extDecide': {
      need('t:ext'); const t = T(); if (!t.ext || t.ext.state !== 'pending') throw new Error('Không có đơn chờ duyệt');
      if (b.ok) { const old = t.due; t.due = t.ext.due; t.ext.state = 'approved'; t.nSoon = false; t.nLate = false; C.log(myName, t, 'Duyệt gia hạn', `${fdt(old)} → ${fdt(t.due)}`); C.notify(t.owner, `Đã DUYỆT gia hạn việc ${t.code} đến ${fdt(t.due)}.`, `Duyệt gia hạn ${t.code}`); }
      else { t.ext.state = 'rejected'; C.log(myName, t, 'Từ chối gia hạn', ''); C.notify(t.owner, `KHÔNG duyệt gia hạn việc ${t.code}. Hạn vẫn là ${fdt(t.due)}.`, `Từ chối gia hạn ${t.code}`); }
      C.touch(t); return { msg: b.ok ? 'Đã duyệt gia hạn' : 'Đã từ chối gia hạn' };
    }
    case 'review': {
      need('t:review'); const t = T(); if (t.status !== 'review') throw new Error('Việc chưa ở trạng thái Chờ duyệt');
      const s = Math.round(+b.score), fb = str(b.feedback, 1000), res = ['Đạt', 'Đạt có sửa', 'Không đạt'].includes(b.result) ? b.result : null;
      if (!res) throw new Error('Kết quả không hợp lệ'); if (!(s >= 1 && s <= 10)) throw new Error('Điểm phải từ 1 đến 10'); if (!fb) throw new Error('Cần ghi feedback (lý do chấm điểm)');
      t.review = { result: res, score: s, feedback: fb, at: C.now, by: me }; t.status = 'done'; C.touch(t);
      C.log(myName, t, 'Chấm điểm & hoàn thành', `${res} · ${s}/10 · ${fb}`); C.notify(t.owner, `Việc ${t.code} đã được chấm: ${res}, ${s}/10. Feedback: ${fb}`, `Kết quả việc ${t.code}`); return { msg: 'Đã chấm điểm, việc chuyển Hoàn thành' };
    }
    case 'redo': { need('t:review'); const t = T(); if (t.status !== 'review') throw new Error('Việc chưa ở trạng thái Chờ duyệt'); const why = str(b.why, 1000) || 'Cần chỉnh sửa thêm'; t.status = 'doing'; t.submittedAt = null; t.progress = Math.min(t.progress, 80); C.touch(t); C.log(myName, t, 'Yêu cầu làm lại', why); C.notify(t.owner, `Việc ${t.code} cần làm lại: ${why}`, `Làm lại việc ${t.code}`); return { msg: 'Đã trả việc về Đang làm' }; }
    case 'comment': {
      need('t:review'); const sid = str(b.staff, 120).toLowerCase(), per = ['week', 'month', 'quarter'].includes(b.period) ? b.period : null; if (!per || !W.staff.some((s) => s.id === sid)) throw new Error('Dữ liệu không hợp lệ');
      const text = str(b.text, 2000), key = `${sid}|${per}`; W.comments[key] = text; W.ops.push({ op: 'upsert', sheet: 'Nhận xét', key: 'key', rows: [{ key, text, at: toVN(C.now), by: myName }] });
      const L = { week: 'tuần này', month: 'tháng này', quarter: 'quý này' }; C.log(myName, null, 'Nhận xét nhân sự', `${C.P(sid).name} – ${L[per]}: ${text}`); C.notify(sid, `Giám đốc đã cập nhật nhận xét ${L[per]} cho bạn.`); return { msg: 'Đã lưu nhận xét' };
    }
    case 'recurStop': { need('t:assign'); const r = W.recur.find((x) => x.id === b.id); if (!r) throw new Error('Không tìm thấy'); r.active = false; W.dirtyRecur.add(r.id); C.log(myName, null, 'Dừng việc lặp lại', r.title); return { msg: 'Đã dừng việc lặp lại' }; }
    // ----- nhân sự & tài khoản -----
    case 'staffAdd': {
      need('t:staff'); const name = str(b.name, 100), email = str(b.email, 120).toLowerCase(), pos = str(b.pos, 100), zalo = str(b.zalo, 30);
      if (!name) throw new Error('Cần nhập họ tên'); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Gmail không hợp lệ');
      const role = W.roles.find((r) => r.name === pos); if (!role || role.locked) throw new Error('Vị trí không hợp lệ'); if (W.staff.some((s) => s.id === email)) throw new Error('Gmail này đã có trong hệ thống');
      await env.DB.prepare("INSERT INTO accounts (email, name, pos, zalo, active, status, fails, lock_until, created_at) VALUES (?, ?, ?, ?, 1, 'none', 0, 0, ?)").bind(email, name, pos, zalo, C.now).run();
      W.staff.push({ id: email, email, name, pos, zalo, active: true, status: 'none' }); C.log(myName, null, 'Thêm nhân sự', `${name} – ${pos} – ${email}`);
      if (b.invite) await invite(env, W, C, email, myName, orig);
      return { msg: b.invite ? `Đã thêm ${name} và gửi lời mời tới ${email}` : `Đã thêm ${name}` };
    }
    case 'staffInvite': { need('t:staff'); const s = W.staff.find((x) => x.id === str(b.email, 120).toLowerCase()); if (!s || !s.active) throw new Error('Không tìm thấy nhân sự đang hoạt động'); if (s.status === 'active') throw new Error('Tài khoản đã kích hoạt'); await invite(env, W, C, s.id, myName, orig); return { msg: `Đã gửi lời mời tới ${s.email}` }; }
    case 'staffToggle': {
      need('t:staff'); const s = W.staff.find((x) => x.id === str(b.email, 120).toLowerCase()); if (!s) throw new Error('Không tìm thấy'); if (s.id === me) throw new Error('Không tự khóa tài khoản của mình');
      if (W.roles.find((r) => r.name === s.pos && r.locked) && s.active && W.staff.filter((x) => x.active && W.roles.find((r) => r.name === x.pos && r.locked)).length < 2) throw new Error('Không khóa tài khoản Giám đốc cuối cùng');
      s.active = !s.active; await env.DB.batch([env.DB.prepare('UPDATE accounts SET active = ? WHERE email = ?').bind(s.active ? 1 : 0, s.id), env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(s.id)]);
      C.log(myName, null, s.active ? 'Mở khóa tài khoản' : 'Khóa tài khoản', s.name); return { msg: s.active ? `Đã mở khóa ${s.name}` : `Đã khóa ${s.name} – không đăng nhập được nữa` };
    }
    case 'staffPos': {
      need('t:perm'); const s = W.staff.find((x) => x.id === str(b.email, 120).toLowerCase()); const pos = str(b.pos, 100); const role = W.roles.find((r) => r.name === pos);
      if (!s || !role) throw new Error('Dữ liệu không hợp lệ'); if (s.id === me) throw new Error('Không tự đổi vị trí của mình');
      const old = s.pos; s.pos = pos; await env.DB.prepare('UPDATE accounts SET pos = ? WHERE email = ?').bind(pos, s.id).run(); C.log(myName, null, 'Đổi vị trí', `${s.name}: ${old} → ${pos}`); return { msg: `Đã đổi vị trí ${s.name}` };
    }
    case 'rolesSave': {
      need('t:perm'); const m = b.perms || {}; const stmts = [];
      W.roles.forEach((r) => { if (r.locked || !Array.isArray(m[r.name])) return; const nw = [...new Set(m[r.name].filter((k) => PERMS_ALL.includes(k)).concat('t:own'))]; const old = new Set(r.perms);
        const add = nw.filter((k) => !old.has(k)), del = [...old].filter((k) => !nw.includes(k)); if (!add.length && !del.length) return; r.perms = nw; stmts.push(env.DB.prepare('UPDATE roles SET perms = ? WHERE name = ?').bind(JSON.stringify(nw), r.name));
        C.log(myName, null, 'Đổi phân quyền', `${r.name}: ${add.length ? '+ ' + add.join(', ') : ''}${add.length && del.length ? ' · ' : ''}${del.length ? '− ' + del.join(', ') : ''}`); });
      if (stmts.length) await env.DB.batch(stmts); return { msg: 'Đã lưu phân quyền – áp dụng ngay' };
    }
    case 'roleAdd': {
      need('t:perm'); const name = str(b.name, 60); if (!name) throw new Error('Cần nhập tên vị trí'); if (W.roles.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new Error('Vị trí này đã có');
      const src = W.roles.find((r) => r.name === b.copy); const perms = src ? src.perms.slice() : ['t:own'];
      await env.DB.prepare('INSERT INTO roles (name, perms, locked, created_at) VALUES (?, ?, 0, ?)').bind(name, JSON.stringify(perms), C.now).run();
      W.roles.push({ name, perms, locked: false }); C.log(myName, null, 'Tạo vị trí', name + (src ? ` (sao chép quyền từ ${src.name})` : '')); return { msg: `Đã tạo vị trí ${name}` };
    }
    default: throw new Error('Thao tác không hỗ trợ');
  }
}

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  try {
    if (!env.DB) return json({ error: 'Chưa gắn cơ sở dữ liệu DB (D1)' }, 500);
    if (params.action === 'cron') {
      const k = request.headers.get('x-hpr-key') || new URL(request.url).searchParams.get('key') || '';
      if (!env.TASKS_KEY || !safeEq(k, env.TASKS_KEY)) return json({ error: 'Sai mã khóa' }, 403);
      const W = await load(env), C = makeCtx(W, env.PUBLIC_URL || origin(request));
      // Khởi tạo: tài khoản Giám đốc chưa được mời thì tự gửi lời mời
      for (const s of W.staff) if (s.active && s.status === 'none' && W.roles.find((r) => r.name === s.pos && r.locked)) await invite(env, W, C, s.id, 'Hệ thống HPR', env.PUBLIC_URL || origin(request));
      genRecur(W, C); scan(W, C); flush(W);
      if (W.ops.length) await gas(env, 'batch', { ops: W.ops });
      return json({ ok: true, ops: W.ops.length });
    }
    const u = await getUser(request, env);
    if (!u) return json({ error: 'Phiên đăng nhập đã hết, vui lòng đăng nhập lại' }, 401);
    if (params.action === 'state' && request.method === 'GET') return json(stateFor(await load(env), u));
    if (params.action === 'act' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch (e) { return json({ error: 'Dữ liệu không hợp lệ' }, 400); }
      const W = await load(env); const r = await act(env, W, u, b, origin(request)); flush(W);
      if (W.ops.length) await gas(env, 'batch', { ops: W.ops });
      const fresh = await getUser(request, env); // quyền có thể vừa đổi
      return json({ ...r, state: stateFor(W, fresh || u) });
    }
    return json({ error: 'Không hỗ trợ' }, 404);
  } catch (e) {
    return json({ error: e.message }, e.message.includes('quyền') ? 403 : 400);
  }
}
