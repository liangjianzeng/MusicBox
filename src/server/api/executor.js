// 执行器拉单口（CONTRACTS §4 六端点）：X-Executor-Token 校验/long-poll/complete multipart 回填（2026-11-23）
'use strict';
const config = require('../config');
const store = require('../core/store');
const engine = require('../core/engine');
const lanes = require('../lanes');
const M = require('../core/modelnodes');
const U = require('../core/util');

// X-Executor-Token 校验（恒定时间比较）
function assertToken(ctx) {
  const tok = (ctx.headers || {})['x-executor-token'] || '';
  if (!tok || !U.timingSafeEq(tok, config.executorToken)) {
    throw new U.ApiError('FORBIDDEN', '执行器令牌无效');
  }
}
// 执行器身份：body.executor_id 优先，兼容 X-Executor-Id 头
function exId(ctx) {
  return String((ctx.body && ctx.body.executor_id) || (ctx.headers && ctx.headers['x-executor-id']) || '').trim() || null;
}

// POST /executor/register {lanes, version} → {executor_id, poll_interval_ms}
function register(ctx) {
  assertToken(ctx);
  const b = ctx.body || {};
  const wanted = U.toArr(b.lanes).map(x => String(x).toLowerCase());
  if (!wanted.length) throw new U.ApiError('BAD_REQUEST', '缺少 lanes');
  const known = new Set(lanes.allLanes());
  for (const l of wanted) {
    if (!known.has(l)) throw new U.ApiError('BAD_REQUEST', `不支持的 lane: ${U.sanitizeEngineNames(l)}`);
  }
  const id = String(b.executor_id || '').trim() || U.uid('ex_');
  const exists = store.get('SELECT id FROM executors WHERE id=?', id);
  if (exists) store.run('UPDATE executors SET lanes=?, version=?, last_seen=? WHERE id=?', U.jstr(wanted), String(b.version || ''), U.nowIso(), id);
  else store.run('INSERT INTO executors(id,lanes,version,last_seen,created_at) VALUES(?,?,?,?,?)', id, U.jstr(wanted), String(b.version || ''), U.nowIso(), U.nowIso());
  store.log('executor.register', { executor_id: id, lanes: wanted, version: String(b.version || '') });
  // 下发运行时节点配置（后台可配，执行器据此调用生成端点，而非仅靠环境变量）
  return { status: 200, body: { executor_id: id, poll_interval_ms: 1500, nodes: M.nodesForExecutor() } };
}

// POST /executor/poll {lanes} → {job: leaseJob|null}（服务端挂起最多 25s）
async function poll(ctx) {
  assertToken(ctx);
  const b = ctx.body || {};
  // 不允许匿名领单：旧写法 `exId(ctx) || 'ex_anon'` 会把任务租给一个不存在的执行器，
  // 之后真执行器的 progress/complete 全被归属校验拒掉（任务只能空转到 attempts 用尽 → 退款）。
  // 身份缺失说明调用方没先 register 或没带 id —— 直接拒，别留下租不出去的租约。
  const executorId = exId(ctx);
  if (!executorId) throw new U.ApiError('BAD_REQUEST', '领单必须携带执行器身份（先 POST /executor/register，并在后续请求带 x-executor-id 或 body.executor_id）');
  store.run('UPDATE executors SET last_seen=? WHERE id=?', U.nowIso(), executorId);
  // 幽灵 poll 防线：领单前检查连接是否仍存活（executor 崩溃/被杀时不把 job 租给死会话）
  const isAlive = () => !!(ctx.req && ctx.req.socket && !ctx.req.socket.destroyed);
  const job = await engine.poll(b.lanes, executorId, isAlive);
  if (!job) return { status: 200, body: { job: null } };
  return {
    status: 200,
    body: {
      job: {
        id: job.id, type: job.type,
        payload: U.jparse(job.payload, {}) || {},
        lease_expire_at: job.lease_expire_at,
      },
    },
  };
}

// POST /executor/jobs/:id/progress {progress, note}
function progress(ctx) {
  assertToken(ctx);
  const b = ctx.body || {};
  engine.progress(ctx.params.id, exId(ctx), { progress: b.progress, note: b.note });
  return { status: 200, body: { ok: true } };
}

// POST /executor/jobs/:id/complete —— multipart(files=..., result=JSON 字符串)
// files 落 var/out/<yyyy-mm>/；result.files {逻辑名: 上传字段名} → *_url 回填
async function complete(ctx) {
  assertToken(ctx);
  const ct = (ctx.headers || {})['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) throw new U.ApiError('BAD_REQUEST', 'complete 需使用 multipart/form-data');
  const mp = U.parseMultipart(ctx.raw, ct);
  let result = {};
  if (mp.fields && mp.fields.result) {
    try { result = JSON.parse(mp.fields.result); } catch (e) { throw new U.ApiError('BAD_REQUEST', 'result 不是合法 JSON'); }
  }
  const r = await engine.complete(ctx.params.id, exId(ctx), result, mp.files || []);
  return { status: 200, body: r || { ok: true } };
}

// POST /executor/jobs/:id/fail {code, message}
function fail(ctx) {
  assertToken(ctx);
  const b = ctx.body || {};
  engine.fail(ctx.params.id, exId(ctx), { code: b.code, message: b.message });
  return { status: 200, body: { ok: true } };
}

// POST /executor/heartbeat {job_id?}
function heartbeat(ctx) {
  assertToken(ctx);
  const b = ctx.body || {};
  const r = engine.heartbeat(exId(ctx), b.job_id);
  return { status: 200, body: r };
}

module.exports = {
  routes: [
    { m: 'POST', p: '/executor/register', h: register },
    { m: 'POST', p: '/executor/poll', h: poll },
    { m: 'POST', p: '/executor/jobs/:id/progress', h: progress },
    { m: 'POST', p: '/executor/jobs/:id/complete', h: complete, raw: true, limitMb: config.engine.maxUploadMb + 2 },
    { m: 'POST', p: '/executor/jobs/:id/fail', h: fail },
    { m: 'POST', p: '/executor/heartbeat', h: heartbeat },
  ],
};
