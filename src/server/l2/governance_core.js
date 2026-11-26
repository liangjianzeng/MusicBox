// 跨模块助手治理核心（契约 v3.1 / 架构 l2 门面，2026-11-24）——宿主无关的治理骨架。
// 职责：注入红线（复用 MV 同源正则）｜通用 gateTool（参数域 + 可注入实体归属校验）｜
//       确认票（hash12+ver 五连、TTL、一票一次、pending 清单）｜助手侧预算双熔断｜会话记忆（只记执行结果摘要）。
// 纪律：白名单外工具 gateTool 期即拒；args 只留白名单键、实体由服务端按 chips 注入（不信 LLM/文本 id）；
//       花钱大门（generate/boot 级）永不可票据直执——由 scope 的 tools.expensive + 上层白名单正则双保险兜住。
// 说明：MV 助手（l2mv/governance.js）保持原实现零改动以保 V13/V16 全绿；本核心供 l2music 等新 scope 复用，
//       与 l2mv 同语义（红线/gate/票/fuse 一致），后续可让 l2mv 收敛到此（Phase 5），本次不动 MV。
'use strict';
const U = require('../core/util');
const store = require('../core/store');

const TICKET_TTL_MS = 60000; // 确认票 TTL 60s（与契约 v2.14 同源）
const FUSE_RATIO = 1.2;      // 助手侧熔断比例（与 v2.11/v2.14.1 同源）

// ———— 一、注入红线（与 MV governance 同一套正则口径；命中→拒答 + 审计 injection_suspect，不给执行意图）————
// 第 10 条为聊天模板角色控制标记（成对尖括号包裹小写下划线标记），按模式匹配、不粘贴标记原文本身。
const INJECTION_PATTERNS = [
  { id: 'override_instructions', re: /(忽略|无视|忘记)[^。！？\n]{0,8}?(以上|之前|所有|全部|上述)[^。！？\n]{0,8}?(指令|规则|设定|提示词)/ },
  { id: 'role_takeover', re: /(你现在是|从现在起你是|你不再是)/ },
  { id: 'system_prompt', re: /system\s*prompt/i },
  { id: 'bypass_approval', re: /(绕过|跳过|免去)(审批|确认|批准)/ },
  { id: 'mass_delete', re: /(删除所有|删光所有|清空)(镜头|项目|作品|数据|记录|歌曲|候选|全部)?/ },
  { id: 'shell_rm', re: /rm\s+-rf/i },
  { id: 'js_exec', re: /exec\s*\(/ },
  { id: 'js_spawn', re: /spawn\s*\(/ },
  { id: 'node_child_process', re: /child_process/i },
  { id: 'chat_template_marker', re: /<\|[a-z_]+\|>/i },
  { id: 'prompt_leak', re: /(reveal|输出|打印|告诉我|显示|复述)[^。！？\n]{0,8}(系统提示|系统指令|system prompt|system 提示)/i },
  { id: 'privilege_mode', re: /以\s*(管理员|root|开发者|超级用户)\s*模式/ },
  { id: 'js_eval', re: /eval\s*\(/ },
];

// 红线扫描：命中即拒（审计 action:'injection_suspect'，ctx 可带 user_id/subject 便于取证）。auditKind 例：'music.assistant'
function isInjection(text, ctx, auditKind) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(s)) {
      store.log((auditKind || 'assistant') + '.audit', {
        action: 'injection_suspect', pattern: p.id,
        user_id: ctx && ctx.user_id || null, subject_id: ctx && ctx.subject_id || null,
        snippet: s.slice(0, 40),
      });
      return { rejected: true, pattern: p.id };
    }
  }
  return null;
}

// ———— 二、通用 gateTool：白名单外即拒 + 参数域校验 + 域外键剥除 + 实体归属（可注入）————
// params kind：string{min,max,optional} / enum{values} / integer{min,max,optional} / bool{optional}
//              entity{of:'work'|'intent'|'job'|'candidate'|'persona'|'song', optional} —— 由 scope 注入 entityCheck
// ctx = scope 自备（含归属集合）；entityCheck(kind, raw, ctx) → {ok:true,value} | {ok:false,code,message}
function gateTool(tools, tool, args, ctx, opts) {
  const def = tools[tool];
  const auditKind = (opts && opts.auditKind) || 'assistant';
  if (!def) {
    store.log(auditKind + '.audit', {
      action: 'tool_not_whitelisted', tool: String(tool).slice(0, 60),
      user_id: ctx && ctx.user && ctx.user.id || null, subject_id: ctx && ctx.subject && ctx.subject.id || null,
    });
    return { ok: false, code: 'BAD_REQUEST', message: '这个操作不在助手的职责范围内' };
  }
  const src = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const clean = {};
  const sanitize = (opts && opts.sanitize) || ((x) => String(x));
  const entityCheck = opts && opts.entityCheck;
  for (const [key, spec] of Object.entries(def.params)) {
    const v = src[key];
    if (v === undefined || v === null || v === '') {
      if (spec.optional) continue;
      return { ok: false, code: 'BAD_REQUEST', message: '缺少参数：' + key };
    }
    if (spec.kind === 'string') {
      const s = sanitize(String(v)).trim().slice(0, spec.max);
      if (s.length < (spec.min || 1)) return { ok: false, code: 'BAD_REQUEST', message: '参数不合规格：' + key };
      clean[key] = s;
    } else if (spec.kind === 'enum') {
      const s = String(v);
      if (!spec.values.includes(s)) return { ok: false, code: 'BAD_REQUEST', message: key + ' 仅支持：' + spec.values.join('/') };
      clean[key] = s;
    } else if (spec.kind === 'integer') {
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) return { ok: false, code: 'BAD_REQUEST', message: key + ' 需为整数' };
      if (spec.min != null && n < spec.min) return { ok: false, code: 'BAD_REQUEST', message: key + ' 不得小于 ' + spec.min };
      if (spec.max != null && n > spec.max) return { ok: false, code: 'BAD_REQUEST', message: key + ' 不得大于 ' + spec.max };
      clean[key] = n;
    } else if (spec.kind === 'bool') {
      clean[key] = (v === true || v === 'true' || v === 1 || v === '1');
    } else if (spec.kind === 'entity') {
      const id = String(v).trim();
      const r = entityCheck ? entityCheck(spec.of, id, ctx) : { ok: true, value: id };
      if (!r || !r.ok) {
        store.log(auditKind + '.audit', {
          action: 'entity_rejected', tool, key, of: spec.of, id: id.slice(0, 40),
          user_id: ctx && ctx.user && ctx.user.id || null, subject_id: ctx && ctx.subject && ctx.subject.id || null,
        });
        return { ok: false, code: (r && r.code) || 'FORBIDDEN', message: (r && r.message) || ('该 ' + spec.of + ' 不属于当前上下文，已拒绝') };
      }
      clean[key] = r.value;
    } else if (spec.kind === 'shotId') {
      const id = String(v).trim();
      const r = entityCheck ? entityCheck('shot', id, ctx) : { ok: true, value: id };
      if (!r || !r.ok) {
        store.log(auditKind + '.audit', {
          action: 'entity_rejected', tool, key, of: 'shot', id: id.slice(0, 40),
          user_id: ctx && ctx.user && ctx.user.id || null, subject_id: ctx && ctx.subject && ctx.subject.id || null,
        });
        return { ok: false, code: (r && r.code) || 'FORBIDDEN', message: (r && r.message) || '该镜头不属于当前上下文，已拒绝' };
      }
      clean[key] = r.value;
    } else if (spec.kind === 'shotIds') {
      if (!Array.isArray(v)) return { ok: false, code: 'BAD_REQUEST', message: key + ' 需为镜头 id 数组' };
      const ids = v.map((x) => String(x).trim()).filter(Boolean);
      if (ids.length > spec.max || ids.length < spec.min || new Set(ids).size !== ids.length) {
        return { ok: false, code: 'BAD_REQUEST', message: key + ' 需为不重复的完整镜头 id 数组' };
      }
      for (const id of ids) {
        const r = entityCheck ? entityCheck('shot', id, ctx) : { ok: true, value: id };
        if (!r || !r.ok) {
          store.log(auditKind + '.audit', {
            action: 'entity_rejected', tool, key, of: 'shot', foreign: [id].slice(0, 3),
            user_id: ctx && ctx.user && ctx.user.id || null, subject_id: ctx && ctx.subject && ctx.subject.id || null,
          });
          return { ok: false, code: (r && r.code) || 'FORBIDDEN', message: (r && r.message) || '镜头清单含非当前上下文镜头，已拒绝' };
        }
      }
      clean[key] = ids;
    } else {
      return { ok: false, code: 'INTERNAL', message: '工具参数域配置异常' };
    }
  }
  return { ok: true, args: clean };
}

// ———— 三、确认票（通用表：chat_tickets，scope/subject_* 分区）————
function canonicalArgs(args) {
  const o = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const sorted = {};
  for (const k of Object.keys(o).sort()) sorted[k] = o[k];
  return U.jstr(sorted);
}
function ticketHash(action, args, est) {
  return U.hash12([action, canonicalArgs(args), Number(est && est.credits) || 0, Number(est && est.minutes) || 0].join('|'));
}
function ticketShape(r) {
  if (!r) return null;
  return {
    id: r.id, scope: r.scope, subject_type: r.subject_type, subject_id: r.subject_id,
    action: r.action, args: U.jparse(r.args_json, {}) || {},
    est_credits: r.est_credits || 0, est_minutes: r.est_minutes || 0,
    hash: r.hash, ver: r.ver, status: r.status,
    ttl_expire_at: r.ttl_expire_at, created_at: r.created_at, consumed_at: r.consumed_at || null,
  };
}
function sweepExpiredTickets(auditKind) {
  const now = U.nowIso();
  const due = store.all("SELECT id FROM chat_tickets WHERE status='pending' AND (ttl_expire_at IS NULL OR ttl_expire_at<=? OR created_at<=?)",
    now, U.isoAfterMs(-TICKET_TTL_MS));
  if (!due.length) return 0;
  store.run("UPDATE chat_tickets SET status='expired' WHERE status='pending' AND (ttl_expire_at IS NULL OR ttl_expire_at<=? OR created_at<=?)", now, U.isoAfterMs(-TICKET_TTL_MS));
  store.log((auditKind || 'assistant') + '.ticket.expire', { count: due.length });
  return due.length;
}
// 签发：tools 白名单硬校验（白名单外不能发票）→ hash12 + ver CAS + TTL + pending + WSS（回调 pushTicket 由 scope 提供）
function issueTicket(tools, user, subject, action, args, est, opts) {
  opts = opts || {};
  const auditKind = opts.auditKind || 'assistant';
  sweepExpiredTickets(auditKind);
  if (!tools[action]) throw new U.ApiError('BAD_REQUEST', '该操作不在助手职责范围内，不能发票');
  if (est === undefined || est === null) est = (tools[action].est ? tools[action].est(args) : { credits: 0, minutes: 0 });
  const estCredits = Math.max(0, Math.trunc(Number(est.credits) || 0));
  const estMinutes = Math.max(0, Math.trunc(Number(est.minutes) || 0));
  const id = U.uid('mktick_');
  const ver = U.hash12(U.uid('tv_'));
  const hash = ticketHash(action, args, { credits: estCredits, minutes: estMinutes });
  const now = U.nowIso();
  store.run(
    'INSERT INTO chat_tickets(id,scope,subject_type,subject_id,user_id,action,args_json,est_credits,est_minutes,hash,ver,status,ttl_expire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, String(subject.scope), String(subject.type), String(subject.id), user.id, action, canonicalArgs(args),
    estCredits, estMinutes, hash, ver, 'pending', U.isoAfterMs(TICKET_TTL_MS), now);
  store.log(auditKind + '.ticket.issue', { ticket_id: id, subject_id: subject.id, user_id: user.id, action, est_credits: estCredits });
  if (typeof opts.pushTicket === 'function') { try { opts.pushTicket(user, { ticket_id: id, scope: subject.scope, subject_id: subject.id, action, est: { credits: estCredits, minutes: estMinutes } }); } catch (e) { /* 广播失败不阻断 */ } }
  return ticketShape(store.get('SELECT * FROM chat_tickets WHERE id=?', id));
}
// 五连校验后一次性消费：同用户 && hash && ver CAS && 未过期 && pending
function verifyAndConsumeTicket(id, body, user, opts) {
  opts = opts || {};
  const auditKind = opts.auditKind || 'assistant';
  sweepExpiredTickets(auditKind);
  const row = store.get('SELECT * FROM chat_tickets WHERE id=?', String(id || ''));
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效');
  const ver = body && body.ver != null ? String(body.ver) : '';
  const hash = body && body.hash != null ? String(body.hash) : '';
  if (!ver || !hash) throw new U.ApiError('BAD_REQUEST', '确认需携带 ver 与 hash（来自票面）');
  const expired = row.status !== 'pending'
    || Date.parse(String(row.created_at)) + TICKET_TTL_MS <= Date.now()
    || (row.ttl_expire_at && Date.parse(row.ttl_expire_at) <= Date.now());
  if (row.status === 'pending' && expired) store.run("UPDATE chat_tickets SET status='expired' WHERE id=?", row.id);
  if (expired) throw new U.ApiError('TICKET_UNUSABLE', '确认票已过期或已被使用，请让助手重新发起', 409);
  if (ver !== row.ver) throw new U.ApiError('STALE', '确认票版本已过期，请刷新确认面板', 409);
  if (!U.timingSafeEq(hash, row.hash)) throw new U.ApiError('FORBIDDEN', '确认票校验失败');
  const r = store.run("UPDATE chat_tickets SET status='consumed', consumed_at=? WHERE id=? AND status='pending'", U.nowIso(), row.id);
  if (r.changes !== 1) throw new U.ApiError('TICKET_UNUSABLE', '确认票已被使用', 409);
  store.log(auditKind + '.ticket.confirm', { ticket_id: row.id, subject_id: row.subject_id, user_id: user.id, action: row.action });
  return { id: row.id, scope: row.scope, subject_type: row.subject_type, subject_id: row.subject_id, action: row.action, args: U.jparse(row.args_json, {}) || {}, est_credits: row.est_credits || 0, est_minutes: row.est_minutes || 0 };
}
function denyTicket(id, user, opts) {
  opts = opts || {};
  const auditKind = opts.auditKind || 'assistant';
  sweepExpiredTickets(auditKind);
  const row = store.get('SELECT * FROM chat_tickets WHERE id=?', String(id || ''));
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效');
  if (row.status === 'pending') {
    store.run("UPDATE chat_tickets SET status='denied' WHERE id=? AND status='pending'", row.id);
    store.log(auditKind + '.ticket.deny', { ticket_id: row.id, subject_id: row.subject_id, user_id: user.id, action: row.action });
  }
  return { ok: true };
}
function fetchPendingTickets(scope, subjectType, subjectId, auditKind) {
  sweepExpiredTickets(auditKind);
  return store.all("SELECT id,action,est_credits,est_minutes,hash,ver,status,ttl_expire_at,created_at FROM chat_tickets WHERE scope=? AND subject_type=? AND subject_id=? AND status='pending' ORDER BY created_at DESC",
    String(scope), String(subjectType), String(subjectId));
}

// ———— 四、助手侧预算双熔断：代动累计花费超基准×1.2 → session broken + 审计，后续该会话一切请求拒 ————
// baseResolver(subject) → 基准积分（无则回退 scopeBudget）
function fuseCheck(session, subject, cost, opts) {
  opts = opts || {};
  const auditKind = opts.auditKind || 'assistant';
  const extra = Math.max(0, Math.trunc(Number(cost) || 0));
  if (!session || extra <= 0) return { ok: true, broken: false };
  const base = Math.max(1, Math.trunc((opts.baseResolver ? Number(opts.baseResolver(subject)) : 0) || opts.scopeBudget || 0)) || 1;
  const threshold = base * FUSE_RATIO;
  const spent = Math.trunc(Number(opts.spentResolver ? opts.spentResolver(subject) : 0) || 0);
  if (spent + extra > threshold) {
    store.run("UPDATE chat_sessions SET status='broken' WHERE id=?", session.id);
    store.log(auditKind + '.fuse', { session_id: session.id, subject_id: session.subject_id, user_id: session.user_id, spent, extra, threshold });
    return { ok: false, broken: true, spent, extra, threshold };
  }
  return { ok: true, broken: false };
}

// ———— 五、会话与记忆（通用表 chat_sessions / chat_messages；记忆只记执行结果摘要）————
function createSession(user, subject, opts) {
  opts = opts || {};
  const id = U.uid('as_');
  store.run('INSERT INTO chat_sessions(id,scope,subject_type,subject_id,user_id,status,ctx_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, String(subject.scope), String(subject.type), String(subject.id), user.id, 'open', U.jstr({}), U.nowIso());
  return store.get('SELECT * FROM chat_sessions WHERE id=?', id);
}
function getSession(id) { return store.get('SELECT * FROM chat_sessions WHERE id=?', String(id || '')); }
// 只记已执行结果摘要（≤150 字，过净化）——原始指令全文不落库
function recordResult(session, summary, meta, opts) {
  opts = opts || {};
  const sanitize = opts.sanitize || ((x) => String(x));
  const s = sanitize(String(summary || '')).slice(0, 150);
  if (!s) return null;
  const id = U.uid('asm_');
  store.run('INSERT INTO chat_messages(id,session_id,role,content,meta_json,created_at) VALUES(?,?,?,?,?,?)',
    id, session.id, 'result', s, U.jstr(meta || null), U.nowIso());
  return id;
}
function recentResults(sessionId, n) {
  return store.all("SELECT content FROM chat_messages WHERE session_id=? AND role='result' ORDER BY rowid DESC LIMIT ?",
    String(sessionId || ''), Math.min(10, Number(n) || 5)).reverse();
}

module.exports = {
  INJECTION_PATTERNS, TICKET_TTL_MS, FUSE_RATIO,
  isInjection, gateTool,
  issueTicket, fetchPendingTickets, verifyAndConsumeTicket, denyTicket, sweepExpiredTickets, ticketShape, ticketHash, canonicalArgs,
  fuseCheck, createSession, getSession, recordResult, recentResults,
};
