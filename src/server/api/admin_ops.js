// 运营后台业务接口（2026-11-24）：审核词库 / 举报队列 / 用户运营 / 积分调额与账本 /
// 审计消费 / 运营配置（定价·版本策略·公告·功能开关灰度·历史回滚）/ 运营看板。均需管理员登录。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const rules = require('../core/rules');
const AC = require('../core/appconfig');
const auth = require('./admin');
const U = require('../core/util');

const requireAdmin = auth.requireAdmin;
function actor(ctx) { const a = auth.adminFromRequest(ctx); return (a && a.username) || 'admin'; }

// —————————————————————————————— 内容审核 ——————————————————————————————

// GET /admin/moderation/words
function wordsGet(ctx) {
  requireAdmin(ctx);
  const f = config.moderationWordFile;
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { text = ''; }
  return { status: 200, body: { text, stats: rules.stats(), enabled: AC.moderationEnabled() } };
}

// POST /admin/moderation/words {text, enabled?}
function wordsSet(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  if (typeof b.text !== 'string') throw new U.ApiError('BAD_REQUEST', '缺少词库文本');
  if (b.text.length > 200000) throw new U.ApiError('BAD_REQUEST', '词库过大');
  if (b.enabled !== undefined) {
    AC.save({ moderation_enabled: !!b.enabled }, actor(ctx), '审核开关');
  }
  const f = config.moderationWordFile;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, b.text, 'utf8');
  const stats = rules.reload();
  store.log('moderation.words_update', { by: actor(ctx), plain: stats.plain, regex: stats.regex });
  return { status: 200, body: { ok: true, stats, enabled: AC.moderationEnabled() } };
}

// GET /admin/moderation/reports?status=&limit=&offset=
function reportsList(ctx) {
  requireAdmin(ctx);
  let sql = `SELECT r.*, w.title AS work_title, w.visibility AS work_visibility, w.status AS work_status,
                    u.nickname AS reporter_nickname
             FROM reports r LEFT JOIN works w ON w.id=r.work_id
             LEFT JOIN users u ON u.id=r.user_id WHERE 1=1`;
  const p = [];
  if (ctx.query.status) { sql += ' AND r.status=?'; p.push(String(ctx.query.status)); }
  sql += ' ORDER BY r.rowid DESC LIMIT ? OFFSET ?';
  p.push(U.clamp(Number(ctx.query.limit) || 50, 1, 500), U.clamp(Number(ctx.query.offset) || 0, 0, 1 << 30));
  const items = store.all(sql, ...p).map((r) => ({
    id: r.id, work_id: r.work_id, reason: r.reason, status: r.status, created_at: r.created_at,
    reporter: r.user_id ? { id: r.user_id, nickname: r.reporter_nickname } : null,
    work: r.work_id ? { id: r.work_id, title: r.work_title, visibility: r.work_visibility, status: r.work_status } : null,
  }));
  const total = store.get('SELECT COUNT(*) c FROM reports').c;
  return { status: 200, body: { items, total, open: (store.get("SELECT COUNT(*) c FROM reports WHERE status='open'") || {}).c } };
}

// POST /admin/moderation/reports/:id/decide {action: dismiss|takedown|restore, note?}
function reportDecide(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  const action = String(b.action || '');
  const r = store.get('SELECT * FROM reports WHERE id=?', ctx.params.id);
  if (!r) throw new U.ApiError('NOT_FOUND', '举报不存在');
  if (!['dismiss', 'takedown', 'restore'].includes(action)) throw new U.ApiError('BAD_REQUEST', 'action 仅支持 dismiss / takedown / restore');
  const now = U.nowIso();
  store.tx(() => {
    if (action === 'dismiss') {
      store.run("UPDATE reports SET status='dismissed' WHERE id=?", ctx.params.id);
    } else if (action === 'takedown') {
      store.run("UPDATE reports SET status='actioned' WHERE id=?", ctx.params.id);
      if (r.work_id) store.run("UPDATE works SET visibility='private' WHERE id=?", r.work_id);
    } else {
      store.run("UPDATE reports SET status='restored' WHERE id=?", ctx.params.id);
      if (r.work_id) store.run("UPDATE works SET visibility='public' WHERE id=?", r.work_id);
    }
  });
  store.log('moderation.decide', { by: actor(ctx), report_id: ctx.params.id, action, work_id: r.work_id, note: b.note || '' });
  return { status: 200, body: { ok: true, action } };
}

// —————————————————————————————— 用户运营 ——————————————————————————————

// GET /admin/users?q=&status=&limit=&offset=
function usersList(ctx) {
  requireAdmin(ctx);
  let sql = `SELECT u.*,
               (SELECT COUNT(*) FROM works w WHERE w.user_id=u.id) AS works_count,
               (SELECT balance_after FROM credit_ledger cl WHERE cl.user_id=u.id ORDER BY rowid DESC LIMIT 1) AS balance
             FROM users u WHERE 1=1`;
  const p = [];
  const q = String(ctx.query.q || '').trim();
  if (q) { sql += ' AND (u.id LIKE ? OR u.phone LIKE ? OR u.nickname LIKE ?)'; p.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (ctx.query.status) { sql += ' AND u.status=?'; p.push(String(ctx.query.status)); }
  sql += ' ORDER BY u.rowid DESC LIMIT ? OFFSET ?';
  p.push(U.clamp(Number(ctx.query.limit) || 50, 1, 500), U.clamp(Number(ctx.query.offset) || 0, 0, 1 << 30));
  const items = store.all(sql, ...p).map((u) => ({
    id: u.id, nickname: u.nickname, phone: u.phone ? U.maskPhone(u.phone) : null,
    is_guest: !u.phone, status: u.status || 'active', created_at: u.created_at,
    works_count: u.works_count || 0, balance: u.balance == null ? 0 : u.balance,
  }));
  const total = (store.get('SELECT COUNT(*) c FROM users') || {}).c || 0;
  return { status: 200, body: { items, total } };
}

// GET /admin/users/:id
function userDetail(ctx) {
  requireAdmin(ctx);
  const u = store.get('SELECT * FROM users WHERE id=?', ctx.params.id);
  if (!u) throw new U.ApiError('NOT_FOUND', '用户不存在');
  const works = store.all('SELECT id,title,status,visibility,created_at FROM works WHERE user_id=? ORDER BY rowid DESC LIMIT 20', u.id);
  const jobs = store.all('SELECT id,type,status,error_code,credits_cost,created_at FROM jobs WHERE user_id=? ORDER BY rowid DESC LIMIT 20', u.id);
  const ledger = store.all('SELECT delta,reason,balance_after,created_at FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 20', u.id);
  const mvCount = (store.get('SELECT COUNT(*) c FROM mv_projects WHERE user_id=?', u.id) || {}).c || 0;
  const personaCount = (store.get('SELECT COUNT(*) c FROM personas WHERE user_id=?', u.id) || {}).c || 0;
  return {
    status: 200,
    body: {
      user: {
        id: u.id, nickname: u.nickname, phone: u.phone ? U.maskPhone(u.phone) : null,
        is_guest: !u.phone, status: u.status || 'active', created_at: u.created_at,
        balance: store.getBalance(u.id),
      },
      counts: { works: works.length, mv_projects: mvCount, personas: personaCount },
      works, jobs, ledger,
    },
  };
}

// POST /admin/users/:id/status {status: active|disabled}
function userStatus(ctx) {
  requireAdmin(ctx);
  const status = String((ctx.body || {}).status || '');
  if (!['active', 'disabled'].includes(status)) throw new U.ApiError('BAD_REQUEST', 'status 仅支持 active / disabled');
  const u = store.get('SELECT * FROM users WHERE id=?', ctx.params.id);
  if (!u) throw new U.ApiError('NOT_FOUND', '用户不存在');
  store.run('UPDATE users SET status=? WHERE id=?', status, ctx.params.id);
  if (status === 'disabled') store.run("UPDATE sessions SET expire_at=? WHERE user_id=? AND expire_at>?", U.nowIso(), ctx.params.id); // 立即踢下线
  store.log('admin.user_status', { by: actor(ctx), user_id: ctx.params.id, status });
  return { status: 200, body: { ok: true, status } };
}

// POST /admin/credits/adjust {user_id, delta, reason}
function creditsAdjust(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  const userId = String(b.user_id || '');
  const delta = Math.trunc(Number(b.delta) || 0);
  if (!userId) throw new U.ApiError('BAD_REQUEST', '缺少 user_id');
  if (!delta) throw new U.ApiError('BAD_REQUEST', 'delta 不能为 0');
  if (Math.abs(delta) > 100000) throw new U.ApiError('BAD_REQUEST', '单次调额过大');
  const u = store.get('SELECT id FROM users WHERE id=?', userId);
  if (!u) throw new U.ApiError('NOT_FOUND', '用户不存在');
  const reason = 'admin_adjust:' + String(b.reason || 'manual').slice(0, 60);
  const after = store.tx(() => store.appendLedger(userId, delta, reason, 'admin', actor(ctx)));
  const bus = require('../core/bus');
  try { bus.creditDelta(userId, delta, after); } catch (e) { /* 在线推送失败无碍 */ }
  store.log('admin.credit_adjust', { by: actor(ctx), user_id: userId, delta, balance_after: after, reason });
  return { status: 200, body: { ok: true, balance_after: after } };
}

// GET /admin/credits/ledger?user_id=&reason=&limit=&offset=
function creditsLedger(ctx) {
  requireAdmin(ctx);
  let sql = 'SELECT * FROM credit_ledger WHERE 1=1'; const p = [];
  if (ctx.query.user_id) { sql += ' AND user_id=?'; p.push(String(ctx.query.user_id)); }
  if (ctx.query.reason) { sql += ' AND reason LIKE ?'; p.push('%' + String(ctx.query.reason) + '%'); }
  sql += ' ORDER BY rowid DESC LIMIT ? OFFSET ?';
  p.push(U.clamp(Number(ctx.query.limit) || 50, 1, 500), U.clamp(Number(ctx.query.offset) || 0, 0, 1 << 30));
  return { status: 200, body: { items: store.all(sql, ...p) } };
}

// —————————————————————————————— 审计消费 ——————————————————————————————

// GET /admin/audit?kind=&limit=&offset=
function auditList(ctx) {
  requireAdmin(ctx);
  let sql = 'SELECT * FROM audit WHERE 1=1'; const p = [];
  if (ctx.query.kind) { sql += ' AND kind LIKE ?'; p.push('%' + String(ctx.query.kind) + '%'); }
  sql += ' ORDER BY rowid DESC LIMIT ? OFFSET ?';
  p.push(U.clamp(Number(ctx.query.limit) || 50, 1, 500), U.clamp(Number(ctx.query.offset) || 0, 0, 1 << 30));
  return { status: 200, body: { items: store.all(sql, ...p).map((r) => ({ id: r.id, kind: r.kind, obj: U.jparse(r.obj, {}), created_at: r.created_at })) } };
}

// —————————————————————————————— 运营配置 ——————————————————————————————

// GET /admin/config/app
function configGet(ctx) {
  requireAdmin(ctx);
  const c = AC.current();
  return { status: 200, body: { version: c.version, blob: c.blob, defaults: AC.defaultBlob() } };
}

// POST /admin/config/app {patch, reason}
function configSet(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  const patch = b.patch || b;
  if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) throw new U.ApiError('BAD_REQUEST', '缺少 patch');
  sanitizeVersionPolicy(patch);
  const r = AC.save(patch, actor(ctx), b.reason);
  return { status: 200, body: { ok: true, version: r.version, blob: r.blob } };
}

function sanitizeVersionPolicy(patch) {
  const vp = patch.version_policy; if (!vp) return;
  if (vp.update_mode && !['none', 'recommended', 'required'].includes(vp.update_mode)) throw new U.ApiError('BAD_REQUEST', 'update_mode 无效');
  if (vp.download_url && !/^https?:\/\//i.test(vp.download_url)) throw new U.ApiError('BAD_REQUEST', 'download_url 需为 http(s) 地址');
  if (vp.check_interval_sec != null) vp.check_interval_sec = U.clamp(Number(vp.check_interval_sec), 60, 86400);
  const an = patch.announcement;
  if (an && an.text != null) an.text = String(an.text).slice(0, 500);
}

// GET /admin/config/history
function configHistory(ctx) {
  requireAdmin(ctx);
  return { status: 200, body: { items: AC.history(ctx.query.limit) } };
}

// POST /admin/config/rollback {version}
function configRollback(ctx) {
  requireAdmin(ctx);
  const v = Number((ctx.body || {}).version);
  if (!Number.isFinite(v) || v <= 0) throw new U.ApiError('BAD_REQUEST', '缺少 version');
  const r = AC.rollback(v, actor(ctx));
  return { status: 200, body: { ok: true, version: r.version, rolled_back_to: v, blob: r.blob } };
}

// GET /admin/config/features
function featuresGet(ctx) {
  requireAdmin(ctx);
  return { status: 200, body: { items: AC.flagsAll() } };
}

// POST /admin/config/features {key, enabled, grayscale}
function featuresSet(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  const f = AC.setFlag(b.key, { enabled: b.enabled, grayscale: b.grayscale }, actor(ctx));
  return { status: 200, body: { ok: true, flag: f } };
}

// GET /admin/config/events?kind=&limit=  （运营事件：配置变更/开关变更留痕）
function eventsList(ctx) {
  requireAdmin(ctx);
  return { status: 200, body: { items: AC.opsEvents(ctx.query.kind, ctx.query.limit) } };
}

// —————————————————————————————— 运营看板 ——————————————————————————————

// GET /admin/metrics/overview?range=7（近 N 天；带 30s 内存缓存）
let _mCache = { key: '', at: 0, data: null };
function metricsOverview(ctx) {
  requireAdmin(ctx);
  const range = U.clamp(Number(ctx.query.range) || 7, 1, 90);
  const key = 'r' + range;
  const now = Date.now();
  if (_mCache.key === key && now - _mCache.at < 30000) return { status: 200, body: _mCache.data };

  const since = new Date(now - range * 86400000).toISOString();
  const sinceDay = new Date(now - 86400000).toISOString();
  const one = (sql, ...p) => { const r = store.get(sql, ...p); return r ? Number(r.c) : 0; };

  const users = {
    total: one('SELECT COUNT(*) c FROM users'),
    new: one('SELECT COUNT(*) c FROM users WHERE created_at>=?', since),
    bound_phone: one("SELECT COUNT(*) c FROM users WHERE phone IS NOT NULL AND phone<>''"),
  };
  const dau = one('SELECT COUNT(DISTINCT user_id) c FROM jobs WHERE created_at>=?', sinceDay);
  const mau = one('SELECT COUNT(DISTINCT user_id) c FROM jobs WHERE created_at>=?', since);
  const works = {
    total: one('SELECT COUNT(*) c FROM works'),
    new: one('SELECT COUNT(*) c FROM works WHERE created_at>=?', since),
    public: one("SELECT COUNT(*) c FROM works WHERE visibility='public'"),
  };
  const jobsTotal = one('SELECT COUNT(*) c FROM jobs WHERE created_at>=?', since);
  const jobsDone = one("SELECT COUNT(*) c FROM jobs WHERE status='done' AND created_at>=?", since);
  const jobsFailed = one("SELECT COUNT(*) c FROM jobs WHERE status='failed' AND created_at>=?", since);
  const queue = {
    queued: one("SELECT COUNT(*) c FROM jobs WHERE status='queued'"),
    leased: one("SELECT COUNT(*) c FROM jobs WHERE status='leased'"),
    running: one("SELECT COUNT(*) c FROM jobs WHERE status='running'"),
  };
  const byType = store.all(
    'SELECT type, COUNT(*) n, SUM(status=\'done\') done_n, AVG(julianday(updated_at)-julianday(created_at))*86400.0 avg_sec FROM jobs WHERE created_at>=? GROUP BY type ORDER BY n DESC LIMIT 20', since)
    .map((r) => ({ type: r.type, n: r.n, done: r.done_n || 0, avg_sec: r.avg_sec == null ? null : Math.round(r.avg_sec * 10) / 10 }));
  const errTop = store.all(
    "SELECT error_code, COUNT(*) n FROM jobs WHERE status='failed' AND created_at>=? GROUP BY error_code ORDER BY n DESC LIMIT 10", since)
    .map((r) => ({ code: U.sanitizeEngineNames(r.error_code || 'UNKNOWN'), n: r.n }));
  const granted = one("SELECT COALESCE(SUM(delta),0) c FROM credit_ledger WHERE delta>0 AND reason<>'refund' AND created_at>=?", since);
  const consumed = one("SELECT COALESCE(SUM(-delta),0) c FROM credit_ledger WHERE delta<0 AND reason<>'daily_expire' AND created_at>=?", since);
  const mvCount = one('SELECT COUNT(*) c FROM mv_projects WHERE created_at>=?', since);
  const reportsOpen = one("SELECT COUNT(*) c FROM reports WHERE status='open'");
  const executors = store.all('SELECT id,lanes,version,last_seen FROM executors ORDER BY last_seen DESC LIMIT 20')
    .map((e) => ({ id: e.id, lanes: U.jparse(e.lanes, []), version: e.version, last_seen: e.last_seen, online: e.last_seen && (now - Date.parse(e.last_seen)) < 180000 }));
  let storage = { files: 0, bytes: 0 };
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else { storage.files++; try { storage.bytes += fs.statSync(abs).size; } catch (e) { /* 忽略 */ } }
      }
    };
    if (fs.existsSync(config.paths.out)) walk(config.paths.out);
  } catch (e) { /* 观测不阻断 */ }

  const data = {
    range_days: range, generated_at: U.nowIso(),
    users: { ...users, dau, mau },
    works,
    jobs: {
      total: jobsTotal, done: jobsDone, failed: jobsFailed,
      success_rate: jobsTotal ? Math.round((jobsDone / jobsTotal) * 1000) / 10 : null,
      by_type: byType, error_top: errTop, queue,
    },
    credits: { granted, consumed, net: granted - consumed },
    mv: { projects: mvCount },
    moderation: { reports_open: reportsOpen },
    executors,
    storage,
    flags: AC.flagsAll(),
    config_version: AC.currentVersion(),
  };
  _mCache = { key, at: now, data };
  return { status: 200, body: data };
}

module.exports = {
  routes: [
    // 审核
    { m: 'GET', p: '/admin/moderation/words', h: wordsGet },
    { m: 'POST', p: '/admin/moderation/words', h: wordsSet },
    { m: 'GET', p: '/admin/moderation/reports', h: reportsList },
    { m: 'POST', p: '/admin/moderation/reports/:id/decide', h: reportDecide },
    // 用户与积分
    { m: 'POST', p: '/admin/credits/adjust', h: creditsAdjust },
    { m: 'GET', p: '/admin/credits/ledger', h: creditsLedger },
    { m: 'POST', p: '/admin/users/:id/status', h: userStatus },
    { m: 'GET', p: '/admin/users/:id', h: userDetail },
    { m: 'GET', p: '/admin/users', h: usersList },
    // 审计与事件
    { m: 'GET', p: '/admin/audit', h: auditList },
    { m: 'GET', p: '/admin/config/events', h: eventsList },
    // 配置
    { m: 'POST', p: '/admin/config/app', h: configSet },
    { m: 'GET', p: '/admin/config/app', h: configGet },
    { m: 'POST', p: '/admin/config/rollback', h: configRollback },
    { m: 'GET', p: '/admin/config/history', h: configHistory },
    { m: 'POST', p: '/admin/config/features', h: featuresSet },
    { m: 'GET', p: '/admin/config/features', h: featuresGet },
    // 看板
    { m: 'GET', p: '/admin/metrics/overview', h: metricsOverview },
  ],
};
