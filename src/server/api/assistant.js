// 统一创作助手 REST（契约 v4.0）。总闸关闭/灰度未命中统一 404；鉴权与既有用户体系一致。
'use strict';
const AC = require('../core/appconfig');
const U = require('../core/util');
const auth = require('./auth');
const admin = require('./admin');
const core = require('../l2assistant/core');
const facade = require('../l2assistant/facade');

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
    { m: 'GET', p: '/v1/assistant/tasks', h: tasksGet },
    { m: 'GET', p: '/v1/assistant/tickets', h: ticketsGet },
    { m: 'POST', p: '/v1/assistant/tickets/:id/confirm', h: ticketConfirm },
    { m: 'POST', p: '/v1/assistant/tickets/:id/deny', h: ticketDeny },
    { m: 'GET', p: '/v1/assistant/events', h: eventsGet },
    { m: 'POST', p: '/v1/assistant/feedback', h: feedbackPost },
    { m: 'GET', p: '/v1/admin/assistant/metrics', h: metricsGet },
  ],
};
