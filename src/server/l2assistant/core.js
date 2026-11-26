// 统一创作助手领域核心（契约 v4.0）：全局 user 会话、refs 属主门、工具白名单、确认票与用户事件游标。
// 不复制扣费/派单实现：付费动作只适配 l2music.executeMusicTicketAction / mv.executeTicketAction。
'use strict';
const config = require('../config');
const store = require('../core/store');
const bus = require('../core/bus');
const U = require('../core/util');
const AC = require('../core/appconfig');
const lex = require('../rules/mv_lexicon');
const gov = require('../l2/governance_core');

const AUDIT = 'assistant';
const REF_TYPES = ['work', 'intent', 'job', 'project', 'shot', 'persona', 'image'];
// 付费动作（expensive 且扣费）：统一助手下由 assistant_actions 闸门控制；免费写（set_title/set_card 等）仍走确认票但不受该闸门限制。
const PAID_ACTIONS = ['music.adjust_params', 'music.regenerate', 'music.cover', 'music.extend', 'mv.shot_reorder', 'mv.shot_delete', 'mv.shot_reshoot'];
// 所有写操作（免费写 + 付费写）：统一助手中一律先确认票、再执行。
const WRITE_ACTIONS = ['music.set_title', 'music.set_card', 'mv.set_title', 'mv.set_brief', 'mv.set_queue_mode', 'mv.script_suggest_edit', ...PAID_ACTIONS];
// 统一工具白名单（19 项，契约 v5.0）：音乐 7 + MV 7 + 只读/解释 5。复用 l2music/execute 与 api/mv 既有执行内核。
const TOOLS = {
  'assistant.context': { params: {}, readOnly: true },
  'assistant.task_query': { params: {}, readOnly: true },
  'assistant.ticket_query': { params: {}, readOnly: true },
  'library.search': { params: { q: { kind: 'string', min: 1, max: 50 } }, readOnly: true },
  'music.query_status': { params: {}, readOnly: true },
  'music.set_title': { params: { title: { kind: 'string', min: 1, max: 60 } } },
  'music.set_card': {
    params: {
      mood: { kind: 'string', min: 1, max: gov.FIELD_LIMITS.mood, optional: true }, // 单一真源，防与 l2music 漂移
      vocal: { kind: 'enum', values: ['song', 'instrumental', 'unknown'], optional: true },
      sec: { kind: 'integer', min: config.gen.sec_min, max: config.gen.sec_max, optional: true },
      bpm: { kind: 'integer', min: 40, max: 200, optional: true },
      count: { kind: 'integer', min: config.gen.count_min, max: config.gen.count_max, optional: true },
      scene_desc: { kind: 'string', min: 1, max: 300, optional: true },
    },
  },
  'work.explain': { params: {}, readOnly: true },
  'music.adjust_params': { params: { text: { kind: 'string', min: 1, max: 200 } }, expensive: true },
  'music.regenerate': {
    params: { count: { kind: 'integer', min: config.gen.count_min, max: config.gen.count_max, optional: true } },
    expensive: true,
    est: (args) => ({ credits: (AC.credits().per_candidate || 15) * (Number(args && args.count) || config.gen.count_default), minutes: 2 }),
  },
  'music.cover': {
    params: { persona_id: { kind: 'entity', of: 'persona' }, cover_strength: { kind: 'integer', min: 0, max: 100, optional: true } },
    expensive: true,
    est: () => ({ credits: AC.credits().cover || 20, minutes: 3 }),
  },
  'music.extend': {
    params: { sec: { kind: 'integer', min: config.gen.sec_min, max: config.gen.sec_max, optional: true } },
    expensive: true,
    est: () => ({ credits: AC.credits().extend || 20, minutes: 2 }),
  },
  'mv.set_title': { params: { title: { kind: 'string', min: 1, max: 60 } }, expensive: false, est: () => ({ credits: 0, minutes: 0 }) },
  'mv.set_brief': { params: { brief: { kind: 'string', min: 1, max: 300 } }, expensive: false, est: () => ({ credits: 0, minutes: 0 }) },
  'mv.set_queue_mode': { params: { queue_mode: { kind: 'enum', values: ['normal', 'night'] } }, expensive: false, est: () => ({ credits: 0, minutes: 0 }) },
  'mv.script_suggest_edit': { params: { instruction: { kind: 'string', min: 1, max: 200 } }, expensive: false, est: () => ({ credits: 0, minutes: 2 }) },
  'mv.shot_reorder': {
    params: { order: { kind: 'shotIds', min: 1, max: 64 } },
    expensive: true,
    est: (args) => { const c = AC.credits().mv || config.mv.credits; return { credits: (args.order || []).length * (c.storyboard || 0) + (c.compose || 0), minutes: 2 + Math.max(1, Math.round(config.mv.est.compose / 60)) }; },
  },
  'mv.shot_delete': {
    params: { shot_id: { kind: 'shotId' } },
    expensive: true,
    est: () => { const c = AC.credits().mv || config.mv.credits; return { credits: c.compose || 0, minutes: Math.max(1, Math.round(config.mv.est.compose / 60)) }; },
  },
  'mv.shot_reshoot': {
    params: { shot_id: { kind: 'entity', of: 'shot' }, reason: { kind: 'string', min: 1, max: 120, optional: true } },
    expensive: true,
  },
};

function clampInt(v, dflt, min, max) { return U.clamp(Math.trunc(Number(v) || dflt), min, max); }
function now() { return U.nowIso(); }
function audit(kind, obj) { store.log('assistant.' + kind, Object.assign({ user_id: null }, obj || {})); }
function cleanText(s, max) { return lex.sanitize(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().slice(0, max || 300); }
function cleanMeta(meta) {
  const src = meta && typeof meta === 'object' ? meta : {};
  const allowed = ['mode', 'intent', 'tool', 'status', 'ticket_id', 'rejected', 'via', 'kind', 'credits', 'failure_code', 'session_id', 'subject_type', 'subject_id'];
  const out = {};
  for (const k of allowed) if (src[k] !== undefined && src[k] !== null) {
    out[k] = typeof src[k] === 'string' ? cleanText(src[k], 160) : src[k];
  }
  return out;
}

// 事件与业务写同一事务落库，提交后再推送；WSS 永不替代 REST 真相。
function eventRow(userId, type, payload) {
  const r = store.get('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM assistant_events WHERE user_id=?', userId);
  const seq = Number(r && r.seq) || 1;
  const id = U.uid('ase_');
  store.run('INSERT INTO assistant_events(id,user_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)',
    id, userId, seq, String(type), U.jstr(payload || {}), now());
  return { id, seq, type: String(type), payload: payload || {}, created_at: now() };
}
function publish(userId, row) {
  try { bus.push(userId, { type: 'assistant.event', seq: row.seq, event: row }); } catch (e) { /* 离线仍可补发 */ }
}
function withEvents(userId, fn) {
  const rows = [];
  const result = store.tx(() => fn(rows));
  for (const row of rows) publish(userId, row);
  return result;
}
function addEvent(rows, userId, type, payload) {
  const row = eventRow(userId, type, payload);
  rows.push(row);
  return row;
}

function sessionShape(row) {
  if (!row) return null;
  const ctx = U.jparse(row.ctx_json, {}) || {};
  return {
    id: row.id, title: cleanText(row.title || '新对话', 80), surface: row.surface || ctx.surface || 'global',
    refs: Array.isArray(ctx.refs) ? ctx.refs : [], created_at: row.created_at, updated_at: row.updated_at || row.created_at,
  };
}
function ownSession(user, id) {
  const row = store.get("SELECT * FROM chat_sessions WHERE id=? AND scope='global' AND subject_type='user' AND subject_id=? AND user_id=?", String(id || ''), user.id, user.id);
  if (!row) throw new U.ApiError('NOT_FOUND', '会话不存在或不属于你');
  return row;
}
function createSession(user, opts) {
  opts = opts || {};
  const id = U.uid('asu_');
  const ts = now();
  const ctx = { surface: validSurface(opts.surface), refs: Array.isArray(opts.refs) ? opts.refs : [] };
  store.run("INSERT INTO chat_sessions(id,scope,subject_type,subject_id,user_id,status,ctx_json,title,surface,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id, 'global', 'user', user.id, user.id, 'open', U.jstr(ctx), cleanText(opts.title || '新对话', 80), ctx.surface, ts, ts);
  audit('session.create', { user_id: user.id, session_id: id, surface: ctx.surface });
  return ownSession(user, id);
}
function validSurface(v) {
  const s = String(v || 'global').trim();
  return ['global', 'create', 'music', 'mv', 'library', 'settings', 'tasks'].includes(s) ? s : 'global';
}
function recentSession(user) {
  return store.get("SELECT * FROM chat_sessions WHERE user_id=? AND scope='global' AND subject_type='user' AND status='open' ORDER BY updated_at DESC,rowid DESC LIMIT 1", user.id);
}
function touchSession(id) { store.run("UPDATE chat_sessions SET updated_at=? WHERE id=?", now(), id); }

// refs 两遍解析：先固化项目，再验证 shot；文本/LLM 中出现的 id 从不进入此函数。
function resolveRefs(user, refsIn, session) {
  if (refsIn !== undefined && !Array.isArray(refsIn)) throw new U.ApiError('BAD_REQUEST', 'context.refs 必须是数组');
  if (Array.isArray(refsIn) && refsIn.length > 12) throw new U.ApiError('BAD_REQUEST', 'context.refs 最多 12 个');
  const oldCtx = session ? (U.jparse(session.ctx_json, {}) || {}) : {};
  const oldRefs = Array.isArray(oldCtx.refs) ? oldCtx.refs : [];
  // 缺省 context 沿用会话；显式 [] 表示脱离上下文。仅 shot 可补同会话项目。
  const incoming = Array.isArray(refsIn) ? refsIn : oldRefs;
  const candidates = incoming.some((r) => r && r.type === 'shot') &&
    !incoming.some((r) => r && r.type === 'project') ? incoming.concat(oldRefs.filter((r) => r && r.type === 'project')) : incoming;
  const normalized = [];
  const seen = new Set();
  for (const raw of candidates.slice(0, 24)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = String(raw.type || '');
    const id = String(raw.id || '').trim().slice(0, 100);
    if (!REF_TYPES.includes(type) || !id || seen.has(type + ':' + id)) continue;
    seen.add(type + ':' + id); normalized.push({ type, id });
  }
  const refs = [], entities = new Map(), rejected = [];
  const put = (ref, row) => { refs.push(ref); entities.set(ref.type + ':' + ref.id, row); };
  for (const ref of normalized.filter((r) => r.type === 'project')) {
    const p = store.get('SELECT * FROM mv_projects WHERE id=? AND user_id=?', ref.id, user.id);
    if (p) put(ref, p); else rejected.push(ref.type);
  }
  const project = refs.find((r) => r.type === 'project');
  for (const ref of normalized) {
    if (ref.type === 'project') continue;
    let row = null;
    if (ref.type === 'work') row = store.get('SELECT * FROM works WHERE id=? AND user_id=?', ref.id, user.id);
    else if (ref.type === 'intent') row = store.get('SELECT * FROM intent_cards WHERE id=? AND user_id=?', ref.id, user.id);
    else if (ref.type === 'job') row = store.get('SELECT * FROM jobs WHERE id=? AND user_id=?', ref.id, user.id);
    else if (ref.type === 'persona') row = store.get('SELECT * FROM personas WHERE id=? AND (user_id=? OR is_public=1)', ref.id, user.id);
    else if (ref.type === 'shot') {
      const sh = store.get('SELECT * FROM mv_shots WHERE id=?', ref.id);
      const p = project && sh && project.id === sh.project_id ? entities.get('project:' + project.id) : null;
      if (sh && p) row = sh;
    }
    else if (ref.type === 'image') {
      // 图片 = 上传对象：仅认本用户且未过 72h TTL 的 uploads 行
      const up = store.get('SELECT * FROM uploads WHERE id=? AND user_id=? AND expire_at> ?', ref.id, user.id, U.nowIso());
      if (up) row = up;
    }
    if (row) put(ref, row); else rejected.push(ref.type);
  }
  if (rejected.length) audit('refs.rejected', { user_id: user.id, session_id: session && session.id, count: rejected.length });
  return { refs: refs.slice(0, 12), entities, project: project ? entities.get('project:' + project.id) : null };
}
function refOf(type, entities) {
  for (const [key, row] of entities) if (key.startsWith(type + ':') && row) return { type, id: row.id };
  return null;
}
function imageRow(resolved) {
  if (!resolved || !resolved.entities) return null;
  for (const [key, row] of resolved.entities) if (key.startsWith('image:') && row && row.path) return row;
  return null;
}
function contextSummary(resolved, surface) {
  const names = { work: '作品', intent: '意图卡', job: '任务', project: 'MV 项目', shot: '镜头', persona: '声音人格', image: '图片' };
  if (!resolved.refs.length) return '当前没有已核验的创作对象；你可以先描述需求，或从作品、任务、MV 中选择上下文。';
  return '已核验上下文（' + (surface || 'global') + '）：' + resolved.refs.map((r) => names[r.type] + ' ' + r.id.slice(0, 12)).join('、') + '。跨用户对象已自动忽略。';
}

function messageShape(r) {
  return {
    id: r.id, seq: r.seq, session_id: r.session_id, role: r.role,
    content: String(r.content || ''), meta: cleanMeta(U.jparse(r.meta_json, {})),
    client_msg_id: r.client_msg_id || undefined, created_at: r.created_at,
  };
}
function appendMessage(rows, session, role, content, meta, clientMsgId) {
  const cur = store.get('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM chat_messages WHERE session_id=?', session.id);
  const id = U.uid('asm_');
  const ts = now();
  store.run('INSERT INTO chat_messages(id,session_id,role,content,meta_json,created_at,seq,client_msg_id) VALUES(?,?,?,?,?,?,?,?)',
    id, session.id, role, cleanText(content, 1500), U.jstr(cleanMeta(meta)), ts, Number(cur.seq), clientMsgId || null);
  const message = messageShape(store.get('SELECT * FROM chat_messages WHERE id=?', id));
  addEvent(rows, session.user_id, 'assistant.message', { session_id: session.id, message });
  return message;
}
function getMessages(user, sessionId, afterSeq) {
  const session = ownSession(user, sessionId);
  const after = clampInt(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
  const rows = store.all('SELECT * FROM chat_messages WHERE session_id=? AND seq>? ORDER BY seq ASC LIMIT 500', session.id, after);
  const cur = store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM chat_messages WHERE session_id=?', session.id);
  return { session_id: session.id, messages: rows.map(messageShape), next_seq: Number(cur.seq) || 0 };
}
function storedResponse(row) {
  if (!row) return null;
  const meta = U.jparse(row.meta_json, {}) || {};
  if (meta.client_error) throw new U.ApiError(meta.client_error.code, meta.client_error.message, meta.client_error.httpStatus);
  return meta.client_response || null;
}

function effectiveTicket(r) {
  if (!r) return null;
  if (r.status === 'pending' && U.isPast(r.expires_at || r.ttl_expire_at)) return Object.assign({}, r, { status: 'expired' });
  if (r.status === 'consumed') return Object.assign({}, r, { status: 'succeeded' });
  return r;
}
function ticketShape(r, owner) {
  r = effectiveTicket(r);
  if (!r) return null;
  const meta = U.jparse(r.meta_json, {}) || {};
  const out = {
    ticket_id: r.id, scope: r.scope, session_id: r.session_id || null,
    subject_type: r.subject_type, subject_id: r.subject_id, action: r.action,
    est: { credits: r.est_credits || 0, minutes: r.est_minutes || 0 }, status: r.status,
    job_id: r.job_id || null, reply: r.reply || null, created_at: r.created_at,
    expires_at: r.expires_at || r.ttl_expire_at, consumed_at: r.consumed_at || null,
  };
  if (meta.diff) out.diff = meta.diff;
  if (owner) { out.ver = r.ver; out.hash = r.hash; }
  return out;
}
function ownTicket(user, id) {
  const row = store.get("SELECT * FROM chat_tickets WHERE id=? AND scope='assistant' AND user_id=?", String(id || ''), user.id);
  if (!row) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效');
  if (row.session_id) ownSession(user, row.session_id);
  return row;
}
function sweepTickets() {
  const ts = now();
  store.run("UPDATE chat_tickets SET status='expired',finished_at=COALESCE(finished_at,?) WHERE scope='assistant' AND status='pending' AND (expires_at IS NULL OR expires_at<=? OR ttl_expire_at<=?)", ts, ts, ts);
}
function listTickets(user, limit) {
  sweepTickets();
  const rows = store.all("SELECT * FROM chat_tickets WHERE scope='assistant' AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?", user.id, clampInt(limit, 50, 1, 50));
  return rows.map((r) => ticketShape(r, true));
}
function issueTicket(user, session, action, args, est, meta) {
  if (!TOOLS[action] || !WRITE_ACTIONS.includes(action)) throw new U.ApiError('FORBIDDEN', '该操作不在统一助手白名单内');
  if (PAID_ACTIONS.includes(action) && !AC.featureOn('assistant_actions', user.id)) throw new U.ApiError('FORBIDDEN', '付费助手动作尚未开放');
  sweepTickets();
  const issued = gov.issueTicket(TOOLS, user, { scope: 'assistant', type: 'user', id: user.id }, action, args, est, { auditKind: AUDIT });
  store.run('UPDATE chat_tickets SET session_id=?,meta_json=?,expires_at=? WHERE id=?', session.id, U.jstr(meta || {}), issued.ttl_expire_at, issued.id);
  audit('ticket.issue', { user_id: user.id, session_id: session.id, ticket_id: issued.id, action });
  return ownTicket(user, issued.id);
}
function ticketEvent(rows, user, type, ticket, extra) {
  addEvent(rows, user.id, type, Object.assign({ session_id: ticket.session_id, ticket: ticketShape(ticket, true) }, extra || {}));
}

// CAS 与执行分离：同一进程/多进程都只有 pending→executing 的赢家能调用执行器。
function claimTicket(user, id, body, rows) {
  const row = ownTicket(user, id);
  const current = effectiveTicket(row);
  if (!['pending', 'executing', 'succeeded', 'failed', 'reconciling', 'compensated', 'consumed'].includes(current.status)) {
    throw new U.ApiError('TICKET_UNUSABLE', '确认票已失效，请让助手重新发起', 409);
  }
  const ver = String(body && body.ver || ''), hash = String(body && body.hash || '');
  if (!ver || !hash) throw new U.ApiError('BAD_REQUEST', '确认需携带 ver 与 hash');
  if (ver !== row.ver) throw new U.ApiError('STALE', '确认票版本已过期', 409);
  if (!U.timingSafeEq(hash, row.hash)) throw new U.ApiError('FORBIDDEN', '确认票校验失败');
  // 已领取/终态票仅回放，不重新验 TTL、不调用执行器；但 ver/hash/owner 仍逐次硬验。
  if (current.status !== 'pending') return { replay: true, ticket: ownTicket(user, id), row: current };
  if (U.isPast(row.expires_at || row.ttl_expire_at) || Date.parse(row.created_at) + gov.TICKET_TTL_MS <= Date.now()) {
    store.run("UPDATE chat_tickets SET status='expired',finished_at=? WHERE id=? AND status='pending'", now(), row.id);
    throw new U.ApiError('TICKET_UNUSABLE', '确认票已过期', 409);
  }
  const ts = now();
  const changed = store.run("UPDATE chat_tickets SET status='executing',started_at=?,finished_at=NULL WHERE id=? AND status='pending' AND ver=? AND hash=? AND (expires_at IS NULL OR expires_at>?)", ts, row.id, row.ver, row.hash, ts);
  if (changed.changes !== 1) return { replay: true, ticket: ownTicket(user, id), row: ownTicket(user, id) };
  audit('ticket.confirm', { user_id: user.id, session_id: row.session_id, ticket_id: row.id, action: row.action });
  metric(user, ownSession(user, row.session_id), row.action, null, 'executing', 'ticket', 0, 0);
  const ticket = ownTicket(user, row.id);
  ticketEvent(rows, user, 'assistant.ticket', ticket, { status: 'executing' });
  return { replay: false, ticket, row: ticket };
}
function denyTicket(user, id, rows) {
  const row = ownTicket(user, id);
  const changed = store.run("UPDATE chat_tickets SET status='denied',finished_at=? WHERE id=? AND status='pending'", now(), row.id);
  if (changed.changes) {
    audit('ticket.deny', { user_id: user.id, session_id: row.session_id, ticket_id: row.id });
    metric(user, ownSession(user, row.session_id), row.action, null, 'denied', 'ticket', 0, 0);
  }
  const ticket = ownTicket(user, row.id);
  ticketEvent(rows, user, 'assistant.ticket', ticket, { status: ticket.status });
  return ticket;
}
function finishTicket(user, ticket, status, result, failureCode) {
  const ts = now(), events = [];
  const row = store.tx(() => {
    store.run('UPDATE chat_tickets SET status=?,job_id=?,reply=?,finished_at=?,failure_code=? WHERE id=? AND status=\'executing\'',
      status, result && result.job_id || ticket.job_id, result && result.reply || ticket.reply, ts, failureCode || null, ticket.id);
    const changed = ownTicket(user, ticket.id);
    ticketEvent(events, user, 'assistant.ticket', changed, { status });
    if (result && result.job_id) {
      const job = store.get('SELECT * FROM jobs WHERE id=? AND user_id=?', result.job_id, user.id);
      if (job) addEvent(events, user.id, 'assistant.task', { session_id: changed.session_id, ticket_id: changed.id, job_id: job.id, task: taskShape(job) });
    }
    return changed;
  });
  for (const event of events) publish(user.id, event);
  audit('ticket.' + status, { user_id: user.id, session_id: row.session_id, ticket_id: row.id, action: row.action, failure_code: failureCode || null });
  return row;
}
function replayAction(ticket) {
  return { action: ticket.action, reply: ticket.reply || '这张票已处理，不重复执行。', job_id: ticket.job_id || null, credits_charged: 0 };
}

function taskShape(job) {
  let result = U.jparse(job.result, {}) || {};
  let title = cleanText(job.note || result.title || ({ music: '音乐生成', intent: '灵感整理', mv_shot: 'MV 镜头制作' }[job.type] || '创作任务'), 80);
  return { kind: 'job', id: job.id, title, status: job.status, progress: job.progress || 0, updated_at: job.updated_at, result_work_id: result.work_id || null, credits_cost: job.credits_cost || 0 };
}
function listTasks(user, limit) {
  const rows = store.all('SELECT * FROM jobs WHERE user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT ?', user.id, clampInt(limit, 50, 1, 50));
  return rows.map(taskShape);
}
function getEvents(user, afterSeq, limit) {
  const after = clampInt(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
  const rows = store.all('SELECT * FROM assistant_events WHERE user_id=? AND seq>? ORDER BY seq ASC LIMIT ?', user.id, after, clampInt(limit, 100, 1, 200));
  const cur = store.get('SELECT COALESCE(MAX(seq),0) AS seq FROM assistant_events WHERE user_id=?', user.id);
  return { items: rows.map((r) => ({ id: r.id, seq: r.seq, type: r.type, payload: U.jparse(r.payload, {}) || {}, created_at: r.created_at })), next_seq: Number(cur.seq) || 0 };
}

function metric(user, session, tool, mode, status, kind, latencyMs, credits) {
  store.run('INSERT INTO assistant_metrics(id,user_id,session_id,surface,tool,mode,status,kind,latency_ms,credits,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    U.uid('am_'), user.id, session && session.id || null, session && (session.surface || 'global') || 'global', tool || null,
    mode || null, String(status || ''), String(kind || 'request'), clampInt(latencyMs, 0, 0, 86400000), Math.trunc(Number(credits) || 0), now());
}
function recordFeedback(user, messageId, result, session) {
  if (!['accepted', 'dismissed', 'completed'].includes(String(result || ''))) throw new U.ApiError('BAD_REQUEST', 'result 仅支持 accepted|dismissed|completed');
  const m = store.get('SELECT * FROM chat_messages WHERE id=?', String(messageId || ''));
  if (!m || !['assistant', 'tool', 'result'].includes(m.role)) throw new U.ApiError('NOT_FOUND', '消息不存在');
  const s = ownSession(user, m.session_id);
  metric(user, s, null, null, String(result), 'feedback', 0, 0);
  audit('feedback', { user_id: user.id, session_id: s.id, message_id: m.id, result: String(result) });
  return { ok: true };
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function assistantMetrics(days) {
  days = clampInt(days, 7, 1, 90);
  const since = U.isoAfterMs(-days * 86400000);
  const rows = store.all('SELECT tool,mode,status,kind,latency_ms,credits,created_at FROM assistant_metrics WHERE created_at>=?', since);
  const totals = { requests: 0, tool_calls: 0, tool_succeeded: 0, tool_failed: 0, p50_ms: null, p90_ms: null, accepted: 0, dismissed: 0, completed: 0, ticket_issued: 0, ticket_confirmed: 0, ticket_denied: 0, ticket_execute_failed: 0, credits: 0 };
  const tools = new Map(), modes = new Map(), daily = new Map();
  const latencies = [];
  for (const r of rows) {
    if (r.kind === 'request') totals.requests++;
    if (r.kind === 'tool') {
      totals.tool_calls++;
      if (r.status === 'succeeded') totals.tool_succeeded++;
      if (r.status === 'failed') totals.tool_failed++;
      const key = r.tool || 'unknown';
      const t = tools.get(key) || { tool: key, calls: 0, succeeded: 0, failed: 0, p50_ms: null, p90_ms: null };
      t.calls++; if (r.status === 'succeeded') t.succeeded++; if (r.status === 'failed') t.failed++; tools.set(key, t);
      if (Number.isFinite(Number(r.latency_ms))) latencies.push(Number(r.latency_ms));
    }
    if (r.kind === 'feedback' && ['accepted', 'dismissed', 'completed'].includes(r.status)) totals[r.status]++;
    if (r.kind === 'ticket') {
      if (r.status === 'issued') totals.ticket_issued++;
      if (r.status === 'executing') totals.ticket_confirmed++;
      if (r.status === 'denied') totals.ticket_denied++;
      if (r.status === 'failed' || r.status === 'reconciling') totals.ticket_execute_failed++;
    }
    if (Number(r.credits)) totals.credits += Number(r.credits);
    if (r.kind === 'request') {
      const mk = r.mode || 'unknown';
      modes.set(mk, (modes.get(mk) || 0) + 1);
    }
    const day = String(r.created_at || '').slice(0, 10);
    const d = daily.get(day) || { day, requests: 0, tool_calls: 0, tool_succeeded: 0, tool_failed: 0, credits: 0 };
    if (r.kind === 'request') d.requests++;
    if (r.kind === 'tool') { d.tool_calls++; if (r.status === 'succeeded') d.tool_succeeded++; if (r.status === 'failed') d.tool_failed++; }
    d.credits += Number(r.credits) || 0; daily.set(day, d);
  }
  totals.p50_ms = pct(latencies, 0.5); totals.p90_ms = pct(latencies, 0.9);
  for (const t of tools.values()) {
    const ls = rows.filter((r) => r.kind === 'tool' && (r.tool || 'unknown') === t.tool && Number.isFinite(Number(r.latency_ms))).map((r) => Number(r.latency_ms));
    t.p50_ms = pct(ls, 0.5); t.p90_ms = pct(ls, 0.9);
  }
  return { range_days: days, totals, tools: [...tools.values()], modes: [...modes].map(([mode, count]) => ({ mode, count })), daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

// 引擎进度钩子：只追加通知，任务真相仍查 jobs REST。终态失败已由引擎按原账本退款，票仅标记补偿不重复退款。
function notifyJob(job, status) {
  if (!job || !job.user_id) return;
  try {
    const events = [];
    const tickets = store.tx(() => {
      if (String(job.type || '').startsWith('mv_') && status === 'failed') {
        require('../l2mv/governance').releaseTicketReservationByJob(job.id);
      }
      const rows = store.all("SELECT * FROM chat_tickets WHERE scope='assistant' AND user_id=? AND job_id=? ORDER BY rowid DESC LIMIT 10", job.user_id, job.id);
      for (const t of rows) {
        addEvent(events, job.user_id, 'assistant.task', { session_id: t.session_id, ticket_id: t.id, job_id: job.id, status, progress: job.progress || 0, task: taskShape(job) });
        if (status === 'failed' && ['executing', 'succeeded'].includes(t.status)) {
          const changed = store.run("UPDATE chat_tickets SET status='compensated',reply=?,finished_at=?,failure_code=? WHERE id=? AND status IN ('executing','succeeded')",
            '任务失败，已按原账本退回积分。', now(), String(job.error_code || 'JOB_FAILED'), t.id);
          if (changed.changes === 1) {
            const done = ownTicket({ id: job.user_id }, t.id);
            ticketEvent(events, { id: job.user_id }, 'assistant.ticket', done, { status: 'compensated' });
            metric({ id: job.user_id }, ownSession({ id: job.user_id }, t.session_id), t.action, null, 'compensated', 'ticket', 0, -(Number(job.credits_cost) || 0));
            audit('ticket.compensated', { user_id: job.user_id, session_id: t.session_id, ticket_id: t.id, job_id: job.id });
          }
        }
      }
      return rows;
    });
    for (const event of events) publish(job.user_id, event);
  } catch (e) { /* 观测不阻断任务 */ }
}

module.exports = {
  AUDIT, TOOLS, PAID_ACTIONS, WRITE_ACTIONS,
  audit, cleanText, cleanMeta, validSurface, resolveRefs, refOf, imageRow, contextSummary, withEvents, ticketEvent,
  createSession, ownSession, recentSession, sessionShape, touchSession,
  appendMessage, getMessages, storedResponse,
  ticketShape, ownTicket, listTickets, issueTicket, claimTicket, denyTicket, finishTicket, replayAction, sweepTickets,
  listTasks, taskShape, getEvents, metric, recordFeedback, assistantMetrics, notifyJob,
};
