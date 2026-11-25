// 运营后台鉴权（2026-11-24）：独立于用户体系的管理员登录 + requireAdmin 中间件。
// 首启按环境变量种子一个管理员（MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD），密码 sha256hex 存 admins 表。
'use strict';
const config = require('../config');
const store = require('../core/store');
const U = require('../core/util');

// 首启种子管理员（幂等）
function initDefaultAdmin() {
  const existing = store.get('SELECT id FROM admins WHERE status<>\'disabled\'');
  if (existing) return existing;
  const envStr = (n, d) => (process.env[n] === undefined || process.env[n] === '') ? d : process.env[n];
  const username = envStr('MB_ADMIN_USERNAME', 'admin');
  const password = envStr('MB_ADMIN_PASSWORD', 'admin1234');
  const id = U.uid('ad_');
  store.run('INSERT INTO admins(id,username,password_hash,status,last_seen,created_at) VALUES(?,?,?,?,?,?)',
    id, username, U.sha256hex(password), 'active', U.nowIso(), U.nowIso());
  // 仅在未显式配置时打印默认凭据，提醒运维尽快修改
  if (!process.env.MB_ADMIN_USERNAME || !process.env.MB_ADMIN_PASSWORD) {
    // eslint-disable-next-line no-console
    console.warn(new Date().toISOString(), '[admin] 已种子默认管理员，请尽快用 MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD 覆盖后重启；当前：', username, password);
  }
  return { id, username };
}

function adminFromRequest(ctx) {
  const h = String((ctx.headers || {}).authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const s = store.get('SELECT * FROM admins WHERE token=?', m[1]);
  if (!s || s.status !== 'active') return null;
  store.run('UPDATE admins SET last_seen=? WHERE token=?', U.nowIso(), m[1]);
  return s;
}

function requireAdmin(ctx) {
  const a = adminFromRequest(ctx);
  if (!a) throw new U.ApiError('UNAUTHORIZED', '管理员登录已过期，请重新登录');
  return a;
}

function adminShape(a) { return { id: a.id, username: a.username }; }

// POST /admin/login {username,password} → {token, admin}
async function login(ctx) {
  const b = ctx.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const a = store.get('SELECT * FROM admins WHERE username=?', username);
  if (!a || a.status !== 'active' || !U.timingSafeEq(U.sha256hex(password), a.password_hash)) {
    throw new U.ApiError('UNAUTHORIZED', '用户名或密码错误');
  }
  const token = U.uid('at_') + U.sha256hex(U.uid('')).slice(0, 24);
  store.run('UPDATE admins SET token=?, last_seen=? WHERE id=?', token, U.nowIso(), a.id);
  store.log('admin.login', { admin_id: a.id, username });
  return { status: 200, body: { token, admin: adminShape(a) } };
}

module.exports = {
  initDefaultAdmin, requireAdmin, adminFromRequest, adminShape, login,
  routes: [{ m: 'POST', p: '/admin/login', h: login }],
};
