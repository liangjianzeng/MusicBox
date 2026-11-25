// 音乐助手治理层（契约 v3.1 / 架构 l2，2026-11-24）——复用 l2/governance_core，只定义音乐 scope 的工具白名单与实体归属。
// 纪律：白名单恰 8 项（对齐 ADR-MV-7 封顶）；花钱大门（generate/boot）不入白名单，付费动作一律 expensive→确认票；
//       助手侧昂贵动作必须过票（把 works.adjust 的"NL 直接扣费"通道收编进确认票治理，A1 资金路径人工过目）。
'use strict';
const config = require('../config');
const store = require('../core/store');
const AC = require('../core/appconfig');
const lex = require('../rules/mv_lexicon');
const core = require('../l2/governance_core');

const AUDIT = 'music.assistant';
const CREDITS_SCOPE = 300; // scope 级预算兜底（无基准时用；fuse 基准优先取项目/作品累计）

// ———— 工具白名单（恰 8 项）+ 参数域（复用 core.gateTool 的 kind）————
const C = () => AC.credits();
const TOOLS = {
  'music.query_status': {          // 只读：查作品/任务进度、位次、ETA
    expensive: false, params: {}, est: () => ({ credits: 0, minutes: 0 }), readOnly: true,
  },
  'music.set_title': {             // 免费：改作品标题
    expensive: false, params: { title: { kind: 'string', min: 1, max: 60 } }, est: () => ({ credits: 0, minutes: 0 }),
  },
  'music.set_card': {              // 免费：改意图卡参数（mood/vocal/sec/bpm/count/scene_desc）——意图卡指挥
    expensive: false,
    params: {
      mood: { kind: 'string', min: 1, max: 20, optional: true },
      vocal: { kind: 'enum', values: ['song', 'instrumental', 'unknown'], optional: true },
      sec: { kind: 'integer', min: config.gen.sec_min, max: config.gen.sec_max, optional: true },
      bpm: { kind: 'integer', min: 40, max: 200, optional: true },
      count: { kind: 'integer', min: config.gen.count_min, max: config.gen.count_max, optional: true },
      scene_desc: { kind: 'string', min: 1, max: 300, optional: true },
    },
    est: () => ({ credits: 0, minutes: 0 }),
  },
  'music.adjust_params': {         // 昂贵（10⚡）：对已生成曲自然语言微调（再欢快/纯音乐/换女声/长一点）
    expensive: true,
    params: { text: { kind: 'string', min: 1, max: 200 } },
    est: () => ({ credits: C().adjust || 10, minutes: 1 }),
  },
  'music.regenerate': {            // 昂贵（per_candidate×count）：按当前参数重出 N 个候选（二次创作·换一批）
    expensive: true,
    params: { count: { kind: 'integer', min: config.gen.count_min, max: config.gen.count_max, optional: true } },
    est: (args) => ({ credits: (C().per_candidate || 15) * (Number(args && args.count) || config.gen.count_default), minutes: 2 }),
  },
  'music.cover': {                 // 昂贵（cover⚡）：用某声音人格翻自
    expensive: true,
    params: {
      persona_id: { kind: 'entity', of: 'persona' },
      cover_strength: { kind: 'integer', min: 0, max: 100, optional: true },
    },
    est: () => ({ credits: C().cover || 20, minutes: 3 }),
  },
  'music.extend': {                // 昂贵（extend⚡）：续写时长
    expensive: true,
    params: { sec: { kind: 'integer', min: config.gen.sec_min, max: config.gen.sec_max, optional: true } },
    est: () => ({ credits: C().extend || 20, minutes: 2 }),
  },
};

// ———— 实体归属校验（助手 args 里的实体 id 一律服务端按 chips/属主核对，不信 LLM/文本）————
// ctx 由 facade 注入：{ user, ownedWorkIds:Set, ownedIntentIds:Set, ownedCandidateIds:Set, ownedJobIds:Set }
function entityCheck(kind, raw, ctx) {
  const id = String(raw || '').trim();
  if (!id) return { ok: false, code: 'BAD_REQUEST', message: '缺少实体 id' };
  const user = ctx && ctx.user;
  if (kind === 'persona') {
    const p = store.get('SELECT user_id,is_public FROM personas WHERE id=?', id);
    if (!p) return { ok: false, code: 'NOT_FOUND', message: '声音人格不存在' };
    if (user && p.user_id !== user.id && !p.is_public) return { ok: false, code: 'FORBIDDEN', message: '该声音人格不可用' };
    return { ok: true, value: id };
  }
  if (kind === 'work') {
    if (!(ctx.ownedWorkIds && ctx.ownedWorkIds.has(id))) return { ok: false, code: 'FORBIDDEN', message: '该作品不属于你' };
    return { ok: true, value: id };
  }
  if (kind === 'intent') {
    if (!(ctx.ownedIntentIds && ctx.ownedIntentIds.has(id))) return { ok: false, code: 'FORBIDDEN', message: '该意图卡不属于你' };
    return { ok: true, value: id };
  }
  if (kind === 'candidate') {
    if (!(ctx.ownedCandidateIds && ctx.ownedCandidateIds.has(id))) return { ok: false, code: 'FORBIDDEN', message: '该候选不属于你' };
    return { ok: true, value: id };
  }
  if (kind === 'job') {
    if (!(ctx.ownedJobIds && ctx.ownedJobIds.has(id))) return { ok: false, code: 'FORBIDDEN', message: '该任务不属于你' };
    return { ok: true, value: id };
  }
  return { ok: false, code: 'BAD_REQUEST', message: '未知实体类型' };
}

// ———— 包装 core（固定本 scope 的 audit kind / 净化 / 实体校验）————
function gateTool(tool, args, ctx) {
  return core.gateTool(TOOLS, tool, args, ctx, { auditKind: AUDIT, sanitize: (x) => lex.sanitize(String(x)), entityCheck });
}
function isInjection(text, ctx) { return core.isInjection(text, ctx, AUDIT); }
function issueTicket(user, subject, action, args, est, opts) {
  return core.issueTicket(TOOLS, user, subject, action, args, est, Object.assign({ auditKind: AUDIT }, opts || {}));
}

module.exports = {
  AUDIT, TOOLS, CREDITS_SCOPE,
  isInjection, gateTool, entityCheck,
  issueTicket,
  fetchPendingTickets: (subjectType, subjectId) => core.fetchPendingTickets('music', subjectType, subjectId, AUDIT),
  verifyAndConsumeTicket: (id, body, user) => core.verifyAndConsumeTicket(id, body, user, { auditKind: AUDIT }),
  denyTicket: (id, user) => core.denyTicket(id, user, { auditKind: AUDIT }),
  fuseCheck: (session, subject, cost, baseResolver, spentResolver) =>
    core.fuseCheck(session, subject, cost, { auditKind: AUDIT, scopeBudget: CREDITS_SCOPE, baseResolver, spentResolver }),
  createSession: (user, subject) => core.createSession(user, subject, { auditKind: AUDIT }),
  getSession: (id) => core.getSession(id),
  recordResult: (session, summary, meta) => core.recordResult(session, summary, meta, { auditKind: AUDIT, sanitize: (x) => lex.sanitize(String(x)) }),
  recentResults: (sid, n) => core.recentResults(sid, n),
  // 供上层（facade）复用的 core 原语
  core,
};
