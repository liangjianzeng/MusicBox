// 音乐助手 API（契约 v3.1 / 架构 l2，2026-11-24）——把 MV 已验证的助手治理范式横向搬到「音乐创作」域。
// 三域全量：意图卡指挥(set_card/regenerate-from-intent) ｜ 作品微调(adjust_params) ｜ 候选与二次创作(regenerate/cover/extend)。
// 门控（与 MV requireEnabled 同构）：总闸 MB_MUSIC_ASSISTANT=1 或 后台 music_assistant 开关任一开启，否则 404（保留 v1 行为）；
//   再按 music_assistant 灰度到用户；LLM 增强另受 assistant_chat_music 灰度。付费动作一律确认票，确认后唯一执行器落扣费。
'use strict';
const config = require('../config');
const store = require('../core/store');
const auth = require('./auth');
const U = require('../core/util');
const AC = require('../core/appconfig');
const facade = require('../l2music/facade');
const gov = require('../l2music/governance');
const exec = require('../l2music/execute');

// 灰度总开关：环境总闸 或 后台功能开关（可按用户灰度）任一开启；都关 → 404（对齐 MV 接口门控语义）
function requireEnabled(ctx) {
  if (config.music.assistant.enabled) return auth.userFromRequest(ctx);
  const u = ctx && auth.userFromRequest(ctx);
  if (AC.featureOn('music_assistant', u && u.id)) return u;
  throw new U.ApiError('NOT_FOUND', '接口不存在');
}

// POST /v1/music/assistant/messages {session_id?, text, chips[]}
async function assistantMessages(ctx) {
  const user = requireEnabled(ctx);
  if (!user) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  ctx.user = user;
  return facade.handleMessages(ctx);
}

// POST /v1/music/tickets/:id/confirm {ver, hash} —— 五连校验后一次性消费并执行（付费唯一落点）
async function ticketConfirm(ctx) {
  const user = requireEnabled(ctx);
  if (!user) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  const t = gov.verifyAndConsumeTicket(ctx.params.id, ctx.body || {}, user);
  const subject = { type: t.subject_type, id: t.subject_id };
  try {
    const r = await exec.executeMusicTicketAction(user, subject, t.action, t.args, { id: t.id });
    return { status: 200, body: { ok: true, action: t.action, reply: r.reply, job_id: r.job_id || null, credits_charged: r.credits_charged || 0 } };
  } catch (e) {
    // 票已消费（不退还确认），如实回执；失败已记 works/engine 审计，不重复扣费
    store.log('music.assistant.exec_fail', { user_id: user.id, ticket_id: t.id, action: t.action, err: String((e && e.message) || e).slice(0, 160) });
    if (e && e.name === 'ApiError') throw e;
    throw new U.ApiError('INTERNAL', '执行没成功，请稍后重试或让助手重新发起');
  }
}

// POST /v1/music/tickets/:id/deny —— 拒绝（记 denied）
function ticketDeny(ctx) {
  const user = requireEnabled(ctx);
  if (!user) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  return { status: 200, body: gov.denyTicket(ctx.params.id, user) };
}

module.exports = {
  requireEnabled,
  routes: [
    { m: 'POST', p: '/v1/music/assistant/messages', h: assistantMessages },
    { m: 'POST', p: '/v1/music/tickets/:id/confirm', h: ticketConfirm },
    { m: 'POST', p: '/v1/music/tickets/:id/deny', h: ticketDeny },
  ],
};
