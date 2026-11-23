// 认证：游客静默建号/手机验证码（DEV_OTP 固定码）/游客升级保作品/refresh 轮换/me（2026-11-23）
'use strict';
const config = require('../config');
const store = require('../core/store');
const U = require('../core/util');
const credits = require('./credits');

// —— token 签发：access（短期）+ refresh（轮换），会话表存哈希 ——
function issueSession(userId) {
  const sid = U.uid('s_');
  const access = U.uid('at_') + U.sha256hex(U.uid('')).slice(0, 24);
  const refresh = U.uid('rt_') + U.sha256hex(U.uid('')).slice(0, 24);
  store.run(
    'INSERT INTO sessions(id,user_id,refresh_token_hash,access_token_hash,access_expire_at,expire_at,created_at) VALUES(?,?,?,?,?,?,?)',
    sid, userId, U.sha256hex(refresh), U.sha256hex(access), U.isoAfterMs(config.accessTokenTtlMs), U.isoAfterMs(config.refreshTokenTtlMs), U.nowIso());
  return { access_token: access, refresh_token: refresh };
}
function rotateSession(sid) {
  const access = U.uid('at_') + U.sha256hex(U.uid('')).slice(0, 24);
  const refresh = U.uid('rt_') + U.sha256hex(U.uid('')).slice(0, 24);
  store.run('UPDATE sessions SET access_token_hash=?, access_expire_at=?, refresh_token_hash=?, expire_at=? WHERE id=?',
    U.sha256hex(access), U.isoAfterMs(config.accessTokenTtlMs), U.sha256hex(refresh), U.isoAfterMs(config.refreshTokenTtlMs), sid);
  return { access_token: access, refresh_token: refresh };
}

// Bearer access 中间件：ctx.requireUser 使用
function userFromRequest(ctx) {
  const h = String((ctx.headers && ctx.headers.authorization) || '');
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  if (!m) return null;
  const s = store.get('SELECT * FROM sessions WHERE access_token_hash=?', U.sha256hex(m[1]));
  if (!s || U.isPast(s.access_expire_at) || U.isPast(s.expire_at)) return null;
  const user = store.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!user || user.status !== 'active') return null;
  return user;
}
function requireUser(ctx) {
  const u = userFromRequest(ctx);
  if (!u) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  return u;
}
function userShape(u) {
  return { id: u.id, nickname: u.nickname || '音乐旅人', phone_masked: u.phone ? U.maskPhone(u.phone) : null, is_guest: !u.phone };
}

// POST /v1/auth/guest —— 首启静默游客；带 device_key 则同设备复用游客号
function guest(ctx) {
  const body = ctx.body || {};
  const deviceKey = String(body.device_key || '').trim();
  let user = null;
  if (deviceKey) user = store.get('SELECT * FROM users WHERE guest_key=?', U.sha256hex(deviceKey));
  if (!user) {
    const id = U.uid('u_');
    const nickname = '音乐旅人' + String(U.randInt(9000) + 1000);
    store.run('INSERT INTO users(id,guest_key,nickname,status,created_at) VALUES(?,?,?,?,?)',
      id, deviceKey ? U.sha256hex(deviceKey) : U.uid('gk_'), nickname, 'active', U.nowIso());
    user = store.get('SELECT * FROM users WHERE id=?', id);
    store.log('auth.guest', { user_id: id });
  }
  const tokens = issueSession(user.id);
  return { status: 200, body: { ...tokens, user: { id: user.id, nickname: user.nickname, is_guest: true } } };
}

// POST /v1/auth/phone/request-code
function requestCode(ctx) {
  const phone = String((ctx.body || {}).phone || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new U.ApiError('BAD_REQUEST', '手机号格式不正确');
  if (!U.allowRate('sms:' + phone, 3, 300000)) throw new U.ApiError('RATE_LIMITED', '获取验证码过于频繁，请稍后再试');
  if (!U.allowRate('smsip:' + (ctx.ip || 'x'), 10, 600000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const code = config.DEV_OTP || String(U.randInt(900000) + 100000);
  store.run('INSERT INTO sms_codes(phone,code_hash,expire_at,tries,created_at) VALUES(?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expire_at=excluded.expire_at, tries=0, created_at=excluded.created_at',
    phone, U.sha256hex(code), U.isoAfterMs(config.otpTtlMs), 0, U.nowIso());
  store.log('auth.request_code', { phone: U.maskPhone(phone) });
  return { status: 200, body: { sent: true } };
}

// POST /v1/auth/phone/verify —— 游客带 token 调用则原号升级（作品保留）
function verifyCode(ctx) {
  const body = ctx.body || {};
  const phone = String(body.phone || '').trim();
  const code = String(body.code || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new U.ApiError('BAD_REQUEST', '手机号格式不正确');
  if (!code) throw new U.ApiError('BAD_REQUEST', '请输入验证码');
  const row = store.get('SELECT * FROM sms_codes WHERE phone=?', phone);
  if (!row || U.isPast(row.expire_at)) throw new U.ApiError('BAD_REQUEST', '验证码已过期，请重新获取');
  if ((row.tries || 0) >= 5) throw new U.ApiError('RATE_LIMITED', '验证码错误次数过多，请重新获取');
  if (!U.timingSafeEq(U.sha256hex(code), row.code_hash)) {
    store.run('UPDATE sms_codes SET tries=tries+1 WHERE phone=?', phone);
    throw new U.ApiError('BAD_REQUEST', '验证码不正确');
  }
  store.run('DELETE FROM sms_codes WHERE phone=?', phone);
  let user = userFromRequest(ctx); // 游客升级：当前会话用户绑定手机，作品全保留
  if (user) {
    const taken = store.get('SELECT id FROM users WHERE phone=? AND id<>?', phone, user.id);
    if (taken) throw new U.ApiError('BAD_REQUEST', '该手机号已绑定其他账号');
    store.run('UPDATE users SET phone=?, status=? WHERE id=?', phone, 'active', user.id);
    store.log('auth.upgrade', { user_id: user.id });
  } else {
    user = store.get('SELECT * FROM users WHERE phone=?', phone);
    if (!user) {
      const id = U.uid('u_');
      store.run('INSERT INTO users(id,phone,nickname,status,created_at) VALUES(?,?,?,?,?)',
        id, phone, '音乐旅人' + String(U.randInt(9000) + 1000), 'active', U.nowIso());
      user = store.get('SELECT * FROM users WHERE id=?', id);
      store.log('auth.register', { user_id: id });
    }
  }
  const tokens = issueSession(user.id);
  const fresh = store.get('SELECT * FROM users WHERE id=?', user.id);
  return { status: 200, body: { ...tokens, user: { id: fresh.id, nickname: fresh.nickname, is_guest: false } } };
}

// POST /v1/auth/refresh —— refresh 轮换
function refresh(ctx) {
  const rt = String((ctx.body || {}).refresh_token || '').trim();
  if (!rt) throw new U.ApiError('BAD_REQUEST', '缺少 refresh_token');
  const s = store.get('SELECT * FROM sessions WHERE refresh_token_hash=?', U.sha256hex(rt));
  if (!s || U.isPast(s.expire_at)) throw new U.ApiError('UNAUTHORIZED', '登录已过期，请重新登录');
  const tokens = rotateSession(s.id);
  return { status: 200, body: tokens };
}

// GET /v1/me
function me(ctx) {
  const user = requireUser(ctx);
  const c = credits.summary(user.id);
  return { status: 200, body: { user: userShape(user), credits: c, prefs: store.allPrefs(user.id) } };
}

module.exports = {
  userFromRequest, requireUser, userShape, issueSession,
  routes: [
    { m: 'POST', p: '/v1/auth/guest', h: guest },
    { m: 'POST', p: '/v1/auth/phone/request-code', h: requestCode },
    { m: 'POST', p: '/v1/auth/phone/verify', h: verifyCode },
    { m: 'POST', p: '/v1/auth/refresh', h: refresh },
    { m: 'GET', p: '/v1/me', h: me },
  ],
};
