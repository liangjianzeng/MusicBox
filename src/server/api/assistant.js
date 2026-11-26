// 统一创作助手 REST（契约 v4.0）。总闸关闭/灰度未命中统一 404；鉴权与既有用户体系一致。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const AC = require('../core/appconfig');
const U = require('../core/util');
const auth = require('./auth');
const admin = require('./admin');
const core = require('../l2assistant/core');
const facade = require('../l2assistant/facade');
const UP = config.upload;

function requireEnabled(ctx) {
  const user = auth.userFromRequest(ctx);
  if (!AC.featureOn('assistant_core', user && user.id)) throw new U.ApiError('NOT_FOUND', '接口不存在');
  if (!user) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  return user;
}
function bootstrap(ctx) {
  const user = requireEnabled(ctx);
  return facade.bootstrap(user).then((body) => ({ status: 200, body }));
}
function sessionsCreate(ctx) {
  const user = requireEnabled(ctx), b = ctx.body || {};
  if (b.title !== undefined && String(b.title).length > 80) throw new U.ApiError('BAD_REQUEST', 'title 不超过 80 字');
  let refs = [];
  if (b.context !== undefined) {
    if (!b.context || typeof b.context !== 'object' || Array.isArray(b.context)) throw new U.ApiError('BAD_REQUEST', 'context 格式无效');
    refs = core.resolveRefs(user, b.context.refs, null).refs;
  }
  const session = core.createSession(user, { title: b.title, surface: b.context && b.context.surface, refs });
  return { status: 201, body: { session: core.sessionShape(session) } };
}
function messagesGet(ctx) {
  const user = requireEnabled(ctx);
  return { status: 200, body: core.getMessages(user, ctx.params.id, ctx.query.after_seq) };
}
async function messagesPost(ctx) {
  const user = requireEnabled(ctx);
  const body = await facade.handleMessage(user, ctx.body || {});
  return { status: 200, body };
}
// —— POST /v1/assistant/image multipart(file; jpg/png ≤8MB; consent='true') ——
// 图片用于统一助手理解；PIPL consent 前置、72h TTL、sha256 去重；端侧只拍照不落库。
async function imagePost(ctx) {
  const user = requireEnabled(ctx);
  if (!U.allowRate('assistant:image:' + user.id, 20, 3600000)) throw new U.ApiError('RATE_LIMITED', '上传过于频繁，请稍后再试');
  const ct = (ctx.headers || {})['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) throw new U.ApiError('BAD_REQUEST', '请以 multipart/form-data 上传文件');
  const mp = U.parseMultipart(ctx.raw, ct);
  const fields = mp.fields || {};
  if (String(fields.consent || '').toLowerCase() !== 'true') throw new U.ApiError('BAD_REQUEST', '请先勾选图片使用授权（consent=true）');
  const file = (mp.files || []).find((f) => f.field === 'file') || (mp.files || [])[0];
  if (!file || !file.data || !file.data.length) throw new U.ApiError('BAD_REQUEST', '缺少上传文件（字段名 file）');
  if (file.data.length > UP.imageMaxMb * 1024 * 1024) throw new U.ApiError('BAD_REQUEST', '图片需不超过 ' + UP.imageMaxMb + 'MB');
  const ext = (path.extname(file.filename).slice(1) || '').toLowerCase();
  if (!UP.imageExts.includes(ext)) throw new U.ApiError('BAD_REQUEST', '仅支持 jpg 或 png 图片');
  const head = file.data.slice(0, 8);
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff; // JPEG FFD8FF
  const isPng = head.toString('hex', 0, 4) === '89504e47'; // PNG 89504E47
  if (!(isJpg || isPng)) throw new U.ApiError('BAD_REQUEST', '文件内容与格式不符');
  const sha = U.sha256hex(file.data);
  const dup = store.get("SELECT * FROM uploads WHERE user_id=? AND kind='assistant' AND sha256=? AND expire_at>?", user.id, sha, U.nowIso());
  if (dup) return { status: 200, body: { image_id: dup.id } }; // sha256 去重：复用未过期同一图片
  const dir = config.paths.uploads;
  fs.mkdirSync(dir, { recursive: true });
  const rel = U.uid('up_') + '.' + ext;
  fs.writeFileSync(path.join(dir, rel), file.data);
  const id = U.uid('ul_');
  store.run('INSERT INTO uploads(id,user_id,kind,path,bytes,sha256,mime,expire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, user.id, 'assistant', path.join(dir, rel), file.data.length, sha,
    isPng ? 'image/png' : 'image/jpeg',
    U.isoAfterMs(UP.ttlHours * 3600 * 1000), U.nowIso());
  store.log('assistant.image.upload', { user_id: user.id, upload_id: id, bytes: file.data.length });
  return { status: 200, body: { image_id: id } };
}
function tasksGet(ctx) {
  const user = requireEnabled(ctx);
  return { status: 200, body: { items: core.listTasks(user, ctx.query.limit) } };
}
function ticketsGet(ctx) {
  const user = requireEnabled(ctx);
  return { status: 200, body: { items: core.listTickets(user, ctx.query.limit) } };
}
async function ticketConfirm(ctx) {
  const user = requireEnabled(ctx);
  return { status: 200, body: await facade.confirm(user, ctx.params.id, ctx.body || {}) };
}
function ticketDeny(ctx) {
  const user = requireEnabled(ctx);
  const ticket = core.withEvents(user.id, (events) => core.denyTicket(user, ctx.params.id, events));
  return { status: 200, body: { ok: true, ticket: core.ticketShape(ticket, true) } };
}
function eventsGet(ctx) {
  const user = requireEnabled(ctx);
  return { status: 200, body: core.getEvents(user, ctx.query.after_seq, ctx.query.limit) };
}
function feedbackPost(ctx) {
  const user = requireEnabled(ctx), b = ctx.body || {};
  return { status: 200, body: core.recordFeedback(user, b.message_id, b.result, null) };
}
function metricsGet(ctx) {
  admin.requireAdmin(ctx); // 独立管理员鉴权，不读取任何用户原文或他人会话内容
  return { status: 200, body: core.assistantMetrics(ctx.query.days) };
}

module.exports = {
  requireEnabled,
  routes: [
    { m: 'GET', p: '/v1/assistant/bootstrap', h: bootstrap },
    { m: 'POST', p: '/v1/assistant/sessions', h: sessionsCreate },
    { m: 'GET', p: '/v1/assistant/sessions/:id/messages', h: messagesGet },
    { m: 'POST', p: '/v1/assistant/messages', h: messagesPost },
    // raw:true 必须显式声明：否则走 index.js 的 1MB JSON body 上限，「图片 ≤8MB」永远先失败
    { m: 'POST', p: '/v1/assistant/image', h: imagePost, raw: true, limitMb: 12 },
    { m: 'GET', p: '/v1/assistant/tasks', h: tasksGet },
    { m: 'GET', p: '/v1/assistant/tickets', h: ticketsGet },
    { m: 'POST', p: '/v1/assistant/tickets/:id/confirm', h: ticketConfirm },
    { m: 'POST', p: '/v1/assistant/tickets/:id/deny', h: ticketDeny },
    { m: 'GET', p: '/v1/assistant/events', h: eventsGet },
    { m: 'POST', p: '/v1/assistant/feedback', h: feedbackPost },
    { m: 'GET', p: '/v1/admin/assistant/metrics', h: metricsGet },
  ],
};
