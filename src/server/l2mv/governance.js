// MV 助手治理层（契约 v2.13–v2.15 / 架构 §3 l2mv、§7 S9、§10-2、ADR-MV-7/ADR-MV-12，2026-11-24 wave-3）
// 职责：工具白名单（恰 7 项）+ 参数域校验｜注入红线（≥11 条正则）｜确认票生命周期（hash12+ver 五连、TTL 60s、一票一次）｜
//       助手侧预算双熔断（session broken）｜会话记忆（只记执行结果摘要）。
// 纪律：白名单外工具 gateTool 期即拒；args 白名单键、实体一律服务端按 chips 注入（不信 LLM id）；boot 永不可票据执行。
'use strict';
const config = require('../config');
const store = require('../core/store');
const bus = require('../core/bus');
const U = require('../core/util');
const lex = require('../rules/mv_lexicon');
const budget = require('../rules/mv_budget');
const AC = require('../core/appconfig');

const MV = config.mv;
const TICKET_TTL_MS = 60000; // 确认票 TTL 60s（契约 v2.14）
const FUSE_RATIO = 1.2;      // 助手侧熔断比例（与 v2.11 同源）

// ———— 一、工具白名单（恰 7 项）+ 参数域（契约 v2.13.2）————
// 参数域 kind：string{min,max,optional} / enum{values} / shotId（须属 ctx.ownedShotIds）/ shotIds（同上，全列去重）
const TOOLS = {
  'mv.set_title': {
    expensive: false,
    params: { title: { kind: 'string', min: 1, max: 60 } },
    est: () => ({ credits: 0, minutes: 0 }),
  },
  'mv.set_brief': {
    expensive: false,
    params: { brief: { kind: 'string', min: 1, max: 300 } },
    est: () => ({ credits: 0, minutes: 0 }),
  },
  'mv.set_queue_mode': {
    expensive: false,
    params: { queue_mode: { kind: 'enum', values: ['normal', 'night'] } },
    est: () => ({ credits: 0, minutes: 0 }),
  },
  'mv.script_suggest_edit': { // 昂贵：只挂 suggest 草稿（不 ver++，v2.8.2 suggest 纪律）
    expensive: true,
    params: { instruction: { kind: 'string', min: 1, max: 200 } },
    est: () => ({ credits: 0, minutes: 2 }),
  },
  'mv.shot_reorder': {
    expensive: true,
    params: { order: { kind: 'shotIds', min: 1, max: 64 } },
    est: (args) => { const c = AC.credits().mv || MV.credits; return { credits: (args.order || []).length * (c.storyboard || 0) + (c.compose || 0), minutes: 2 + Math.max(1, Math.round(MV.est.compose / 60)) }; },
  },
  'mv.shot_delete': { // 仅未成片镜可删（执行层再校验成片保护）
    expensive: true,
    params: { shot_id: { kind: 'shotId' } },
    est: () => { const c = AC.credits().mv || MV.credits; return { credits: c.compose || 0, minutes: Math.max(1, Math.round(MV.est.compose / 60)) }; },
  },
  'mv.shot_reshoot': { // 票面注明 40⚡ 估价（契约 v2.14）
    expensive: true,
    params: {
      shot_id: { kind: 'shotId' },
      reason: { kind: 'string', min: 1, max: 120, optional: true },
    },
    est: () => { const c = AC.credits().mv || MV.credits; return { credits: c.shot || 0, minutes: Math.max(1, Math.round((MV.est.video || 290) / 60)) }; },
  },
};

// ———— 二、注入红线（≥11 条正则，契约 v2.13.2；命中→拒答+审计 injection_suspect，不给任何执行意图）————
// 第 10 条为聊天模板角色控制标记（成对尖括号包裹小写下划线标记），按模式匹配、不粘贴标记原文本身。
const INJECTION_PATTERNS = [
  { id: 'override_instructions', re: /(忽略|无视|忘记)(以上|之前|所有)(的)?(全部)?(指令|规则|设定)/ },
  { id: 'role_takeover', re: /(你现在是|从现在起你是|你不再是)/ },
  { id: 'system_prompt', re: /system\s*prompt/i },
  { id: 'bypass_approval', re: /(绕过|跳过|免去)(审批|确认|批准)/ },
  { id: 'mass_delete', re: /(删除所有|删光所有|清空)(镜头|项目|作品|数据|记录|全部)?/ },
  { id: 'shell_rm', re: /rm\s+-rf/i },
  { id: 'js_exec', re: /exec\s*\(/ },
  { id: 'js_spawn', re: /spawn\s*\(/ },
  { id: 'node_child_process', re: /child_process/i },
  { id: 'chat_template_marker', re: /<\|[a-z_]+\|>/i },
  { id: 'prompt_leak', re: /(reveal|输出|打印|告诉我|显示|复述)[^。！？\n]{0,8}(系统提示|系统指令|system prompt|system 提示)/i },
  { id: 'privilege_mode', re: /以\s*(管理员|root|开发者|超级用户)\s*模式/ },
  { id: 'js_eval', re: /eval\s*\(/ },
];

// 红线扫描：命中即拒（审计 action:'injection_suspect'，ctx 可带 user_id/project_id 便于取证）
function isInjection(text, ctx) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(s)) {
      store.log('mv.assistant.audit', {
        action: 'injection_suspect', pattern: p.id,
        user_id: ctx && ctx.user_id || null, project_id: ctx && ctx.project_id || null,
        snippet: s.slice(0, 40), // 取证只留片段，不外漏全文
      });
      return { rejected: true, pattern: p.id };
    }
  }
  return null;
}

// ———— 三、gateTool：白名单外即拒 + 参数域校验 + 域外键静默剥除（架构 §10-2）————
// ctx = { user, project, ownedShotIds:Set }；返回 {ok:true,args} 或 {ok:false,code,message}
function gateTool(tool, args, ctx) {
  const def = TOOLS[tool];
  if (!def) {
    store.log('mv.assistant.audit', {
      action: 'tool_not_whitelisted', tool: String(tool).slice(0, 60),
      user_id: ctx && ctx.user && ctx.user.id || null, project_id: ctx && ctx.project && ctx.project.id || null,
    });
    return { ok: false, code: 'BAD_REQUEST', message: '这个操作不在制片助手的职责范围内' };
  }
  const src = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  const clean = {};
  for (const [key, spec] of Object.entries(def.params)) {
    const v = src[key];
    if (v === undefined || v === null || v === '') {
      if (spec.optional) continue;
      return { ok: false, code: 'BAD_REQUEST', message: '缺少参数：' + key };
    }
    if (spec.kind === 'string') {
      const s = lex.sanitize(String(v)).trim().slice(0, spec.max);
      if (s.length < spec.min) return { ok: false, code: 'BAD_REQUEST', message: '参数不合规格：' + key };
      clean[key] = s;
    } else if (spec.kind === 'enum') {
      const s = String(v);
      if (!spec.values.includes(s)) return { ok: false, code: 'BAD_REQUEST', message: key + ' 仅支持：' + spec.values.join('/' ) };
      clean[key] = s;
    } else if (spec.kind === 'shotId') {
      const id = String(v);
      if (!(ctx && ctx.ownedShotIds && ctx.ownedShotIds.has(id))) {
        store.log('mv.assistant.audit', {
          action: 'entity_rejected', tool, key, id: id.slice(0, 40),
          user_id: ctx && ctx.user && ctx.user.id || null, project_id: ctx && ctx.project && ctx.project.id || null,
        });
        return { ok: false, code: 'FORBIDDEN', message: '该镜头不属于当前项目，已拒绝' };
      }
      clean[key] = id;
    } else if (spec.kind === 'shotIds') {
      if (!Array.isArray(v)) return { ok: false, code: 'BAD_REQUEST', message: key + ' 需为镜头 id 数组' };
      if (v.length > spec.max || v.length < spec.min || new Set(v.map(String)).size !== v.length) {
        return { ok: false, code: 'BAD_REQUEST', message: key + ' 需为不重复的完整镜头 id 数组' };
      }
      const ids = v.map(String);
      const owned = Array.from(ctx && ctx.ownedShotIds || []);
      const foreign = ids.filter((id) => !(ctx && ctx.ownedShotIds && ctx.ownedShotIds.has(id)));
      if (foreign.length || owned.length !== ids.length || owned.some((id) => !ids.includes(id))) {
        store.log('mv.assistant.audit', {
          action: 'entity_rejected', tool, key, foreign: foreign.slice(0, 3),
          user_id: ctx && ctx.user && ctx.user.id || null, project_id: ctx && ctx.project && ctx.project.id || null,
        });
        return { ok: false, code: 'FORBIDDEN', message: '镜头清单含非本项目镜头，已拒绝' };
      }
      clean[key] = ids;
    } else {
      return { ok: false, code: 'INTERNAL', message: '工具参数域配置异常' };
    }
    // 域外键（src 中不在 def.params 的键）到此自然被丢弃——args 白名单键（契约 v2.13.2）
  }
  return { ok: true, args: clean };
}

// ———— 四、确认票（mv_tickets 表已在 MIGRATIONS v3；五连校验/一票一次/TTL 60s）————
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
    id: r.id, project_id: r.project_id, session_id: r.session_id || null, job_id: r.job_id || null, action: r.action, args: U.jparse(r.args_json, {}) || {},
    est_credits: r.est_credits || 0, est_minutes: r.est_minutes || 0,
    hash: r.hash, ver: r.ver, status: r.status,
    ttl_expire_at: r.ttl_expire_at, created_at: r.created_at, consumed_at: r.consumed_at || null,
  };
}
// 过期票清扫（任意访问时顺带；幂等）
function sweepExpiredTickets() {
  const now = U.nowIso();
  const due = store.all("SELECT id,session_id,est_credits FROM mv_tickets WHERE status='pending' AND (ttl_expire_at IS NULL OR ttl_expire_at<=? OR created_at<=?)",
    now, U.isoAfterMs(-TICKET_TTL_MS));
  if (!due.length) return 0;
  store.run("UPDATE mv_tickets SET status='expired' WHERE status='pending' AND (ttl_expire_at IS NULL OR ttl_expire_at<=? OR created_at<=?)", now, U.isoAfterMs(-TICKET_TTL_MS));
  for (const row of due) releaseTicketReservation(row.id);
  store.log('mv.ticket.expire', { count: due.length });
  return due.length;
}
// 签发：hash12(action+规范化args+est) + ver 随机短串 CAS + TTL 60s + pending + WSS mv.ticket（契约 v2.14/§14.2）
function issueTicket(user, project, action, args, est, sessionId) {
  sweepExpiredTickets();
  if (!TOOLS[action]) throw new U.ApiError('BAD_REQUEST', '该操作不在助手职责范围内，不能发票');
  if (est === undefined || est === null) est = TOOLS[action].est(args);
  const estCredits = Math.max(0, Math.trunc(Number(est.credits) || 0));
  const estMinutes = Math.max(0, Math.trunc(Number(est.minutes) || 0));
  const id = U.uid('mvtick_');
  const ver = U.hash12(U.uid('tv_')); // CAS 用随机短串，客户端确认时原样回传
  const hash = ticketHash(action, args, { credits: estCredits, minutes: estMinutes });
  const now = U.nowIso();
  store.run(
    'INSERT INTO mv_tickets(id,project_id,user_id,session_id,action,args_json,est_credits,est_minutes,hash,ver,status,ttl_expire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, project.id, user.id, sessionId || null, action, canonicalArgs(args), estCredits, estMinutes, hash, ver, 'pending',
    U.isoAfterMs(TICKET_TTL_MS), now);
  store.log('mv.ticket.issue', { ticket_id: id, project_id: project.id, user_id: user.id, action, est_credits: estCredits });
  try { bus.push(user.id, { type: 'mv.ticket', ticket_id: id, project_id: project.id, action, est: { credits: estCredits, minutes: estMinutes } }); } catch (e) { /* 广播失败不阻断 */ }
  return ticketShape(store.get('SELECT * FROM mv_tickets WHERE id=?', id));
}
// 五连校验后一次性消费：同用户 && hash && ver CAS && 未过期 && pending（全过才执行；票面防伪造见 v2.8.6）
function verifyAndConsumeTicket(id, body, user) {
  sweepExpiredTickets();
  const row = store.get('SELECT * FROM mv_tickets WHERE id=?', String(id || ''));
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效'); // 不泄露他人票据存在性
  const ver = body && body.ver != null ? String(body.ver) : '';
  const hash = body && body.hash != null ? String(body.hash) : '';
  if (!ver || !hash) throw new U.ApiError('BAD_REQUEST', '确认需携带 ver 与 hash（来自票面）');
  const expired = row.status !== 'pending'
    || Date.parse(String(row.created_at)) + TICKET_TTL_MS <= Date.now()
    || (row.ttl_expire_at && Date.parse(row.ttl_expire_at) <= Date.now());
  if (row.status === 'pending' && expired) store.run("UPDATE mv_tickets SET status='expired' WHERE id=?", row.id); // 顺带落状态
  if (expired) throw new U.ApiError('TICKET_UNUSABLE', '确认票已过期或已被使用，请让助手重新发起', 409);
  if (ver !== row.ver) throw new U.ApiError('STALE', '确认票版本已过期，请刷新确认面板', 409);
  if (!U.timingSafeEq(hash, row.hash)) throw new U.ApiError('FORBIDDEN', '确认票校验失败');
  // 一次性消费（并发同票竞态：后到者 changes=0 → 拒绝）
  const r = store.run("UPDATE mv_tickets SET status='consumed', consumed_at=? WHERE id=? AND status='pending'", U.nowIso(), row.id);
  if (r.changes !== 1) throw new U.ApiError('TICKET_UNUSABLE', '确认票已被使用', 409);
  commitTicketReservation(row.id);
  store.log('mv.ticket.confirm', { ticket_id: row.id, project_id: row.project_id, user_id: user.id, action: row.action });
  return { id: row.id, project_id: row.project_id, action: row.action, args: U.jparse(row.args_json, {}) || {}, est_credits: row.est_credits || 0, est_minutes: row.est_minutes || 0 };
}
// 拒绝（仅票主；pending→denied，其余状态幂等 200）
function denyTicket(id, user) {
  sweepExpiredTickets();
  const row = store.get('SELECT * FROM mv_tickets WHERE id=?', String(id || ''));
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效');
  if (row.status === 'pending') {
    const changed = store.run("UPDATE mv_tickets SET status='denied' WHERE id=? AND status='pending'", row.id);
    if (changed.changes === 1) releaseTicketReservation(row.id);
    store.log('mv.ticket.deny', { ticket_id: row.id, project_id: row.project_id, user_id: user.id, action: row.action });
  }
  return { ok: true };
}
// GET detail 用：pending 票清单（面板数据源，契约 v2.13.3）
function cancelProjectTickets(projectId) {
  const rows = store.all("SELECT id FROM mv_tickets WHERE project_id=? AND status='pending'", String(projectId || ''));
  if (!rows.length) return 0;
  store.run("UPDATE mv_tickets SET status='denied' WHERE project_id=? AND status='pending'", String(projectId || ''));
  for (const row of rows) releaseTicketReservation(row.id);
  store.log('mv.ticket.cancel', { project_id: projectId, count: rows.length });
  return rows.length;
}
function fetchPendingTickets(projectId) {
  sweepExpiredTickets();
  return store.all("SELECT id,action,est_credits,est_minutes,hash,ver,status,ttl_expire_at,created_at FROM mv_tickets WHERE project_id=? AND status='pending' ORDER BY created_at DESC", projectId);
}

// ———— 五、助手侧预算双熔断（v2.14.1；与 v2.11 项目 paused 互相独立）————
function updateTicketReservation(id, to, credits) {
  const ticket = store.get('SELECT session_id,est_credits FROM mv_tickets WHERE id=?', String(id || ''));
  if (!ticket || !ticket.session_id) return;
  const session = getSession(ticket.session_id);
  if (!session) return;
  const ctx = U.jparse(session.ctx_json, {}) || {};
  const pending = ctx.assistant_ticket_reserved || {};
  const committed = ctx.assistant_ticket_committed || {};
  const amount = Math.max(0, Math.trunc(Number(credits == null ? ticket.est_credits : credits) || 0));
  delete pending[id]; delete committed[id];
  if (to && amount > 0) {
    const target = to === 'assistant_ticket_reserved' ? pending : committed;
    target[id] = amount;
  }
  if (Object.keys(pending).length) ctx.assistant_ticket_reserved = pending; else delete ctx.assistant_ticket_reserved;
  if (Object.keys(committed).length) ctx.assistant_ticket_committed = committed; else delete ctx.assistant_ticket_committed;
  store.run('UPDATE mv_chat_sessions SET ctx_json=? WHERE id=?', U.jstr(ctx), session.id);
}
function releaseTicketReservation(id) { updateTicketReservation(id, null, 0); }
function commitTicketReservation(id) { updateTicketReservation(id, 'assistant_ticket_committed'); }
function settleTicketReservation(id, credits) { updateTicketReservation(id, Number(credits) > 0 ? 'assistant_ticket_committed' : null, credits); }
function releaseTicketReservationByJob(jobId) {
  const rows = store.all('SELECT id FROM mv_tickets WHERE job_id=?', String(jobId || ''));
  for (const row of rows) releaseTicketReservation(row.id);
}
function reservationTotal(map) { return Object.values(map || {}).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0); }

// 代发付费动作签票前核验：已扣+待确认估价+已执行估价 > 报价×1.2（无报价则 budget×1.2）→ session broken + 审计，后续该会话一切请求直接拒
function fuseCheck(session, project, cost) {
  const extra = Math.max(0, Math.trunc(Number(cost) || 0));
  if (!session || extra <= 0) return { ok: true, broken: false };
  const est = U.jparse(project.est_json, null);
  const base = est && Number.isFinite(Number(est.credits)) && Number(est.credits) > 0 ? Number(est.credits) : budget.budgetOf(project);
  const threshold = base * FUSE_RATIO;
  const ctx = U.jparse(session.ctx_json, {}) || {};
  const reserved = reservationTotal(ctx.assistant_ticket_reserved);
  const committed = reservationTotal(ctx.assistant_ticket_committed);
  const spent = Math.max(Number(project.credits_cost) || 0, Math.max(0, Number(ctx.assistant_est_spent) || 0) + reserved + committed);
  if (spent + extra > threshold) {
    store.run("UPDATE mv_chat_sessions SET status='broken' WHERE id=?", session.id);
    store.log('mv.assistant.fuse', { session_id: session.id, project_id: project.id, user_id: session.user_id, spent, extra, threshold });
    return { ok: false, broken: true, spent, extra, threshold };
  }
  return { ok: true, broken: false };
}

// ———— 六、会话与记忆（mv_chat_sessions / mv_chat_messages 表已在 v3；记忆只记执行结果摘要）————
function createSession(user, project) {
  const id = U.uid('mvas_');
  store.run('INSERT INTO mv_chat_sessions(id,project_id,user_id,status,ctx_json,created_at) VALUES(?,?,?,?,?,?)',
    id, project.id, user.id, 'open', U.jstr({}), U.nowIso());
  return store.get('SELECT * FROM mv_chat_sessions WHERE id=?', id);
}
function getSession(id) { return store.get('SELECT * FROM mv_chat_sessions WHERE id=?', String(id || '')); }
function touchSession(id) {
  const row = getSession(id);
  if (!row) return;
  const ctx = U.jparse(row.ctx_json, {}) || {};
  ctx.last_active_at = U.nowIso();
  store.run('UPDATE mv_chat_sessions SET ctx_json=? WHERE id=?', U.jstr(ctx), id);
}
function reserveSessionCost(session, cost, ticketId) {
  const extra = Math.max(0, Math.trunc(Number(cost) || 0));
  if (!session || !ticketId || extra <= 0) return;
  updateTicketReservation(ticketId, 'assistant_ticket_reserved', extra);
}
// 只记已执行结果摘要（≤150 字，过禁词净化）——原始指令全文不落库
function recordResult(session, summary, meta) {
  const s = lex.sanitize(String(summary || '')).slice(0, 150);
  if (!s) return null;
  const id = U.uid('mvam_');
  store.run('INSERT INTO mv_chat_messages(id,session_id,role,content,meta_json,created_at) VALUES(?,?,?,?,?,?)',
    id, session.id, 'result', s, U.jstr(meta || null), U.nowIso());
  touchSession(session.id);
  return id;
}
function recentResults(sessionId, n) {
  return store.all('SELECT content FROM mv_chat_messages WHERE session_id=? AND role=\'result\' ORDER BY rowid DESC LIMIT ?',
    String(sessionId || ''), Math.min(10, Number(n) || 5)).reverse();
}

module.exports = {
  TOOLS, INJECTION_PATTERNS, TICKET_TTL_MS,
  isInjection, gateTool,
  issueTicket, fetchPendingTickets, verifyAndConsumeTicket, denyTicket, cancelProjectTickets, sweepExpiredTickets, ticketShape, ticketHash,
  releaseTicketReservation, commitTicketReservation, settleTicketReservation, releaseTicketReservationByJob,
  fuseCheck, createSession, getSession, touchSession, reserveSessionCost, recordResult, recentResults,
};
