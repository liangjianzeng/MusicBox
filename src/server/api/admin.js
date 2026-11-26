// 运营后台鉴权（2026-11-24；2026-11-26 抢救 P0-3 加固）：独立于用户体系的管理员登录 + requireAdmin。
// 首启按环境变量种子一个管理员（MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD）；口令 scrypt 加盐存 admins 表。
// 加固点：① 明文口令不再进任何日志；② 旧无盐 sha256 行登录成功后自动升级；③ 登录限流；④ 令牌带 12h 过期。
'use strict';
const config = require('../config');
const store = require('../core/store');
const U = require('../core/util');
const SEC = require('../core/security');

const ADMIN_TOKEN_TTL_MS = 12 * 3600 * 1000; // 管理员令牌有效期（此前永不过期）
const LOGIN_RATE = { limit: 10, windowMs: 5 * 60 * 1000 }; // 同 IP 5 分钟最多 10 次登录尝试

// 首启种子管理员（幂等）
function initDefaultAdmin() {
  const existing = store.get('SELECT id FROM admins WHERE status<>\'disabled\'');
  if (existing) return existing;
  const envStr = (n, d) => (process.env[n] === undefined || process.env[n] === '') ? d : process.env[n];
  const username = envStr('MB_ADMIN_USERNAME', 'admin');
  const password = envStr('MB_ADMIN_PASSWORD', 'admin1234');
  const id = U.uid('ad_');
  store.run('INSERT INTO admins(id,username,password_hash,status,last_seen,created_at) VALUES(?,?,?,?,?,?)',
    id, username, SEC.hashPassword(password), 'active', U.nowIso(), U.nowIso());
  // 提醒运维改默认口令：只报键名，绝不回显口令本身（明文入日志曾是 P0）
  if (!process.env.MB_ADMIN_USERNAME || !process.env.MB_ADMIN_PASSWORD) {
    // eslint-disable-next-line no-console
    console.warn(new Date().toISOString(),
      '[admin] 已种子内置默认管理员（未设置 MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD）。'
      + '请尽快显式配置这两个环境变量后重启，并用 /admin/password 或改库轮换口令。');
  }
  return { id, username };
}

function adminFromRequest(ctx) {
  const h = String((ctx.headers || {}).authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const s = store.get('SELECT * FROM admins WHERE token=?', m[1]);
  if (!s || s.status !== 'active') return null;
  if (U.isPast(s.token_expire_at)) return null; // 令牌过期（此前无过期机制）
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
  const ip = String((ctx.headers || {})['x-forwarded-for'] || ctx.socket?.remoteAddress || 'local').split(',')[0].trim();
  if (!U.allowRate('admin_login:' + ip, LOGIN_RATE.limit, LOGIN_RATE.windowMs)) {
    throw new U.ApiError('RATE_LIMITED', '登录尝试过于频繁，请稍后再试');
  }
  const b = ctx.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const a = store.get('SELECT * FROM admins WHERE username=?', username);
  if (!a || a.status !== 'active' || !SEC.verifyPassword(password, a.password_hash)) {
    store.log('admin.login_failed', { username }); // 审计失败尝试（不含口令）
    throw new U.ApiError('UNAUTHORIZED', '用户名或密码错误');
  }
  if (SEC.isLegacyHash(a.password_hash)) { // 旧无盐 sha256 → 就地升级为 scrypt
    store.run('UPDATE admins SET password_hash=? WHERE id=?', SEC.hashPassword(password), a.id);
  }
  const token = U.uid('at_') + U.sha256hex(U.uid('')).slice(0, 24);
  store.run('UPDATE admins SET token=?, last_seen=?, token_expire_at=? WHERE id=?',
    token, U.nowIso(), U.isoAfterMs(ADMIN_TOKEN_TTL_MS), a.id);
  store.log('admin.login', { admin_id: a.id, username });
  return { status: 200, body: { token, admin: adminShape(a), expire_at: U.isoAfterMs(ADMIN_TOKEN_TTL_MS) } };
}

module.exports = {
  initDefaultAdmin, requireAdmin, adminFromRequest, adminShape, login,
  routes: [{ m: 'POST', p: '/admin/login', h: login }],
};

module.exports = {
  initDefaultAdmin, requireAdmin, adminFromRequest, adminShape, login,
  routes: [{ m: 'POST', p: '/admin/login', h: login }],
};
