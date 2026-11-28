// 智能体共创（伴创）服务端接口（契约 v5.5，2026-11-27 追加）。
//
// 四条红线决定了这个文件的存在形式：
//  ① App 从不直连引擎：LLM 只经 /v1/agent/llm 代理，端点与模型名**永不出服务端**（v5.5.3）。
//  ② 花钱的动作只在这里计量：token 用量落 agent_usage，成本闸门才有可聚合的账本。
//  ③ 检索只有一份实现：端侧只调 /v1/agent/tools/web_search，围栏与禁则在服务端（v5.5.4/5/6）。
//  ④ 灰度关 = 404：不给客户端"接口存在但被拒"的探测面，也不让未开放的能力出现在 capabilities 里。
'use strict';
const store = require('../core/store');
const U = require('../core/util');
const bus = require('../core/bus');
const auth = require('./auth');
const AC = require('../core/appconfig');
const M = require('../core/modelnodes');
const gov = require('../l2/governance_core');
const P = require('../prompts/intent');
const skills = require('../core/agentskills');
const websearch = require('../core/websearch');
const lex = require('../rules/mv_lexicon');
const config = require('../config');
const intentApi = require('./intent');

const AUDIT = 'agent';
const AGENT_TOKEN_BASE = 200000; // 单账号累计 token 软预算基准（× FUSE_RATIO 1.2 = 240k 熔断）
const TOKEN_SCOPE = 500000;      // 无基准时的 scope 级兜底
const TURN_TOKEN_CAP = 24000;    // 单回合硬上限：先按入参预估拦一道，省得把请求发出去再算
const MAX_MESSAGES = 64;
const MAX_MSG_CHARS = 8000;
const MAX_TOOLS = 32;
const ROLES = ['system', 'user', 'assistant', 'tool'];

function requireAgent(ctx) {
  const user = auth.userFromRequest(ctx);
  // 灰度未命中一律 404（与统一助手同一口径）：能力没开放就不该让人探到它存在
  if (!AC.featureOn('createAgentMode', user && user.id)) throw new U.ApiError('NOT_FOUND', '接口不存在');
  if (!user) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  return user;
}

function agentSpent(user) {
  const r = store.get(
    "SELECT COALESCE(SUM(prompt_tokens + completion_tokens),0) AS s FROM agent_usage WHERE user_id=?", user.id);
  return (r && r.s) || 0;
}

function recordUsage(user, sessionId, turnIndex, usage) {
  store.run(
    'INSERT INTO agent_usage(user_id,session_id,turn_index,prompt_tokens,completion_tokens,reasoning_tokens,created_at) VALUES(?,?,?,?,?,?,?)',
    user.id, sessionId || null, Number.isFinite(Number(turnIndex)) ? Math.trunc(Number(turnIndex)) : null,
    Math.max(0, Math.trunc((usage && usage.prompt_tokens) || 0)),
    Math.max(0, Math.trunc((usage && usage.completion_tokens) || 0)),
    Math.max(0, Math.trunc(((usage && usage.completion_tokens_details) || {}).reasoning_tokens || 0)),
    U.nowIso());
}

function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new U.ApiError('BAD_REQUEST', 'messages 不能为空');
  if (messages.length > MAX_MESSAGES) throw new U.ApiError('BAD_REQUEST', `messages 不超过 ${MAX_MESSAGES} 条`);
  let chars = 0;
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw new U.ApiError('BAD_REQUEST', 'messages 元素格式无效');
    const role = String(m.role || '');
    if (!ROLES.includes(role)) throw new U.ApiError('BAD_REQUEST', 'role 仅支持 ' + ROLES.join('/'));
    const isArr = Array.isArray(m.content);
    const text = isArr ? JSON.stringify(m.content) : String(m.content == null ? '' : m.content);
    if (text.length > MAX_MSG_CHARS) throw new U.ApiError('BAD_REQUEST', `单条消息不超过 ${MAX_MSG_CHARS} 字`);
    chars += text.length;
    out.push({ role, content: isArr ? m.content : text });
  }
  if (chars > 200000) throw new U.ApiError('BAD_REQUEST', '上下文过长，请清理历史后重试');
  return { out, chars };
}

function validTools(tools) {
  if (tools === undefined || tools === null) return undefined;
  if (!Array.isArray(tools)) throw new U.ApiError('BAD_REQUEST', 'tools 必须是数组');
  if (tools.length > MAX_TOOLS) throw new U.ApiError('BAD_REQUEST', `tools 不超过 ${MAX_TOOLS} 个`);
  const seen = new Set();
  const out = [];
  for (const t of tools) {
    const fn = t && t.function;
    const name = String((fn && fn.name) || '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(name)) throw new U.ApiError('BAD_REQUEST', '工具名不合法');
    if (seen.has(name)) throw new U.ApiError('BAD_REQUEST', '工具名重复：' + name);
    seen.add(name);
    // 只转发 name/description/parameters：执行体在端侧，服务端不解释也不执行这些工具
    out.push({
      type: 'function',
      function: {
        name,
        description: String((fn && fn.description) || '').slice(0, 500),
        parameters: (fn && fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

// POST /v1/agent/llm —— 唯一的端侧模型入口（契约 v5.5.3）
async function llmProxy(ctx) {
  const user = requireAgent(ctx);
  const b = ctx.body || {};
  const { out: messages, chars } = validMessages(b.messages);
  const tools = validTools(b.tools);
  const maxTokens = Math.min(2000, Math.max(64, Math.trunc(Number(b.max_tokens) || 1024)));

  const subject = { scope: 'agent', type: 'user', id: user.id };
  let session = b.session_id ? gov.getSession(b.session_id) : null;
  if (session && session.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '会话不存在');
  if (session && session.status === 'broken') {
    throw new U.ApiError('SESSION_BROKEN', '这个智能体会话已因用量护栏暂停。这是护栏不是故障，新开一对话也不会绕过去；请稍后再试，或让运营放宽智能体的用量上限。', 409);
  }
  if (!session) session = gov.createSession(user, subject, {});

  const node = M.resolveNode('llm');
  if (!node || !node.endpoint || node.status === 'unreachable') {
    // 如实说"理解服务没就绪"，不返回空答案：空答案会让端侧智能体以为模型真的没话说
    throw new U.ApiError('SERVICE_UNAVAILABLE', '理解服务暂未就绪，稍后再试。你的输入已保留，可以直接重发。', 503);
  }

  // 先按入参预估拦一道：字符数/4 粗估 prompt，加请求上限作 completion 上界。
  // 拦在这里而不是等模型回完再记 —— 回完再拦，token 已经花了。
  const est = Math.ceil(chars / 4) + maxTokens;
  if (est > TURN_TOKEN_CAP) {
    throw new U.ApiError('BAD_REQUEST', `单回合请求过大（约 ${est} tokens，上限 ${TURN_TOKEN_CAP}）。请精简历史消息或减少工具数量后重试。`, 413);
  }
  const f = gov.fuseCheck(session, subject, est, {
    auditKind: AUDIT, scopeBudget: TOKEN_SCOPE,
    baseResolver: () => AGENT_TOKEN_BASE, spentResolver: () => agentSpent(user),
  });
  if (f.broken) {
    throw new U.ApiError('SESSION_BROKEN', '本次智能体的累计 token 已超过软预算上限，为守住用量我已暂停这个会话。这是护栏不是故障，新开一对话也不会绕过去；请稍后再试，或让运营放宽智能体的用量上限。', 409);
  }

  // 思考开关（2026-11-28）：这是聊天，一发思考实测 47–48 秒，用户等不起。而这里原来把超时
  // 【写死成 30s】—— 于是「会思考的模型 + 30s 超时」必然被掐（日志里那一串 ERROR INTERNAL
  // This operation was aborted 就是这么来的：一整轮什么也没说）。客户端显式说不要思考才给 30s；
  // 要思考就不传，让它回落到 config.llmTimeoutMs（60s），别拿写死的 30s 判它死刑。
  const thinking = b.thinking === undefined ? undefined : !!b.thinking;
  const got = await P.chatToolCall(messages, tools || [], {
    maxTokens,
    thinking,
    timeoutMs: thinking === false ? 30000 : undefined,
  });
  if (!got) {
    throw new U.ApiError('SERVICE_UNAVAILABLE', '当前模型不支持工具调用，智能体模式暂时不可用；可切回标准创作流程继续。', 503);
  }
  recordUsage(user, session.id, b.turn_index, got.usage);
  store.log('agent.llm', {
    user_id: user.id, session_id: session.id, turn_index: b.turn_index == null ? null : b.turn_index,
    messages: messages.length, tools: tools ? tools.length : 0,
    prompt_tokens: (got.usage || {}).prompt_tokens || 0, completion_tokens: (got.usage || {}).completion_tokens || 0,
  });
  const msg = { content: got.content, reasoning: got.reasoning, tool_calls: got.toolCalls.length ? got.toolCalls : undefined };
  // 刻意不回传 model/endpoint/engine（v5.5.3）：客户端不该知道也不需要知道用的是哪个引擎
  return { status: 200, body: { session_id: session.id, choices: [{ message: msg, finish_reason: got.finishReason }], usage: got.usage || null } };
}

// POST /v1/agent/tools/web_search —— 端侧唯一检索通道（契约 v5.5.4）
async function webSearchTool(ctx) {
  const user = requireAgent(ctx);
  if (!AC.featureOn('agentWebSearch', user.id)) throw new U.ApiError('NOT_FOUND', '接口不存在');
  const b = ctx.body || {};
  const r = await websearch.searchWeb(b.query, { userId: user.id, timeoutMs: 8000 });
  store.log('agent.web_search', {
    user_id: user.id, query_hash: r.query_hash, ok: !!r.ok,
    results: (r.results || []).length, artist_blocked: !!r.artist_blocked, domains: r.domains ? Object.keys(r.domains).filter((k) => (r.domains[k] || []).length) : [],
  });
  return { status: 200, body: r };
}

// GET /v1/agent/skills —— rank 150 投递层：只给目录（name/description），正文按需 load
function skillsCatalog(ctx) {
  const user = requireAgent(ctx);
  skills.ensureSeeds();
  return { status: 200, body: { rank: skills.SERVER_RANK, skills: skills.catalog(), user_id: user.id } };
}

// GET /v1/agent/skills/:name —— 正文按次取用；端侧必须按会话去重，同一会话只装一次
function skillLoad(ctx) {
  const user = requireAgent(ctx);
  skills.ensureSeeds();
  const s = skills.load(ctx.params.name);
  if (!s) throw new U.ApiError('NOT_FOUND', '没有这个技能');
  store.log('agent.skill_load', { user_id: user.id, name: s.name, rank: s.rank });
  return { status: 200, body: s };
}

// GET/PUT /v1/agent/memory —— 只存"这个用户的口味"，不存数据也不存方法（三层分工）
function memoryGet(ctx) {
  const user = requireAgent(ctx);
  const rows = store.all('SELECT key,value,source,updated_at FROM agent_memory WHERE user_id=? ORDER BY updated_at DESC LIMIT 100', user.id);
  return { status: 200, body: { memories: rows } };
}
function memoryPut(ctx) {
  const user = requireAgent(ctx);
  const b = ctx.body || {};
  const key = String(b.key || '').trim().toLowerCase().slice(0, 48);
  const value = String(b.value == null ? '' : b.value).trim().slice(0, 300);
  if (!/^[a-z0-9_.:-]{1,48}$/.test(key)) throw new U.ApiError('BAD_REQUEST', 'key 仅允许小写字母、数字与 _ . : -');
  if (!value) throw new U.ApiError('BAD_REQUEST', 'value 不能为空');
  // (user_id,key) 唯一：同一偏好只有一份。允许无限堆积的话，半年后 prompt 里全是自相矛盾的历史残骸。
  store.run(
    'INSERT INTO agent_memory(user_id,key,value,source,updated_at) VALUES(?,?,?,?,?) ' +
    'ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, source=excluded.source, updated_at=excluded.updated_at',
    user.id, key, value, String(b.source || 'agent').slice(0, 24), U.nowIso());
  store.log('agent.memory_put', { user_id: user.id, key });
  return { status: 200, body: { ok: true, key, value } };
}
function memoryDelete(ctx) {
  const user = requireAgent(ctx);
  const key = String(ctx.params.key || '').trim().toLowerCase();
  const r = store.run('DELETE FROM agent_memory WHERE user_id=? AND key=?', user.id, key);
  return { status: 200, body: { ok: true, removed: !!(r && r.changes) } };
}

// ——————————————————————————————————————————————————————————————————————————
// 五、建议票：端侧 `music.propose_*` 工具的宿主出口（v5.9.9.5，2026-11-28 真机断头路的正解）
//
// 真机上那条链断在这里：模型调了 `music.propose_generate`，端侧工具回了一句「已整理成待确认
// 草稿，等服务端出确认票之后才真正执行」，而**服务端从来没有被问过**，于是界面上既没有票、
// 也没有任务 —— 用户点完了所有能点的，活没开始。这里把"服务端出票"这半边补上。
//
// 三条规矩：
//  ① **草稿不落地**：端侧工具只把结构化建议送进来，写操作一律不在端侧（方案 §3.3/§3.5）。
//  ② **派单永远走票**（方案 §6.5）：确认走 `gov.verifyAndConsumeTicket` 的五连校验
//     （属主 + hash + ver CAS + 未过期 + pending）；重复 confirm 只回放同一张票与同一个任务，
//     不重派、不重复付。
//  ③ **模型给的编号不作数**（契约 v5.4.3「文本里的 ID 一律不信」）：intent_id 查不到或不是
//     本人的，一律当"还没有任务单"就地建一张属主本人的卡，真编号由票回带给模型。
//     让模型拿一个幻觉编号去派单，等于让它替别人决定"给谁的歌"。
//
// 「用户已经拍过板」这件事只有端侧知道（主 CTA 是人按的），所以 auto_confirm 由客户端带 ——
// 这不是新开的后门：能带这个标记的请求本来就拿着同一张票的 ver/hash，它自己就能调 confirm。
// 真正拦住"模型自己开工"的是端侧那颗一次性授权（AgentBriefApproval），不是这个布尔值。
// ——————————————————————————————————————————————————————————————————————————

const AGENT_SCOPE = 'agent';
const G = config.gen;
// 白名单只有这两项：MV 镜头重拍的再审批边界方案 §10-U5 还挂着「需产品确认」，
// 不在智能体这边代拍（硬接会把"越出计划步骤要重新发票"这条边界悄悄放掉）。
const PROPOSAL_TOOLS = {
  'music.propose_card_patch': { est: () => ({ credits: 0, minutes: 0 }) },
  'music.propose_generate': {
    est: (a) => ({ credits: (AC.credits().per_candidate || 15) * (Number(a && a.count) || G.count_default), minutes: 2 }),
  },
};
const MV_REWORK_HINT = '镜头重拍不在智能体这边做：请到 MV 制片页点「重拍这镜」，那里能看到这一镜和它前后的样子。';
// 能写进任务单的字段 = patchIntentInternal 真正认的字段。工具描述里出现这里没有的旋钮，
// 就是给用户一个拧不动的把手（真机上那个「歌名」旋钮拧了什么都不改）。
const CARD_FIELDS = ['mood', 'genre_hypotheses', 'vocal', 'voice', 'scene_desc', 'sec', 'bpm', 'count'];

function one(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
function words(v, max) {
  const arr = (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,，、]/))
    .map((e) => lex.sanitize(String(e).trim()).slice(0, max)).filter(Boolean);
  return Array.from(new Set(arr)).slice(0, 3);
}

// 票的形状（给端侧的那份）。刻意把 params 一起回带：界面上念的数、模型嘴里念的数、
// 服务端真正派单的数**必须来自同一个地方**，否则就是"简报说 3 首、模型说 1 条"那种自相矛盾。
function agentTicketShape(row) {
  if (!row) return null;
  const meta = U.jparse(row.meta_json, {}) || {};
  return {
    ticket_id: row.id, action: row.action, status: row.status,
    ver: row.ver, hash: row.hash, session_id: row.session_id || null,
    intent_id: meta.intent_id || null,
    minutes: row.est_minutes || 0,
    diff: meta.diff || '', reason: meta.reason || '',
    params: meta.params || {},
    job_id: row.job_id || null,
    created_at: row.created_at, expires_at: row.expires_at || row.ttl_expire_at,
  };
}

// 权威参数：卡上用户显式点改过的 > 这次建议里的 > 平台默认。条数与时长都从这里出。
function authoritativeParams(row, args) {
  const gp = row ? (U.jparse(row.gen_params, {}) || {}) : {};
  const pick = (k, dflt) => {
    const v = gp[k] != null ? gp[k] : (args && args[k] != null ? args[k] : dflt);
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : dflt;
  };
  return {
    count: U.clamp(pick('count', G.count_default), G.count_min, G.count_max),
    sec: U.clamp(pick('sec', G.sec_default), G.sec_min, G.sec_max),
  };
}

function ticketDiff(action, args, params) {
  const bits = [];
  if (args.mood && args.mood.length) bits.push('情绪：' + args.mood.join('、'));
  if (args.genre_hypotheses && args.genre_hypotheses.length) bits.push('曲风：' + args.genre_hypotheses.join('、'));
  if (args.vocal === 'instrumental') bits.push('不唱，纯音乐');
  else if (args.vocal === 'song') bits.push('有人唱');
  if (args.voice) bits.push('谁来唱：' + args.voice);
  if (args.scene_desc) bits.push('灵感：' + String(args.scene_desc).slice(0, 40));
  if (action === 'music.propose_generate') bits.push('出 ' + params.count + ' 条候选', '大约 ' + params.sec + ' 秒');
  const d = bits.join(' · ');
  return lex.sanitize(d).slice(0, 180);
}

// 建议里的参数逐个夹死边界。这一步刻意**不在**端侧做：端侧夹的是"看起来对不对"，
// 这里夹的是"服务端能不能真交付"，而且它同时是派单参数的唯一来源。
function normalizeProposal(action, payload) {
  const out = {};
  const id = one(payload.intent_id, 48);
  if (id) out.intent_id = id;
  const reason = one(payload.reason, 120);
  if (reason) out.reason = lex.sanitize(reason);
  const sd = one(payload.scene_desc, 300);
  if (sd) out.scene_desc = lex.sanitize(sd);
  const secRaw = payload.sec != null ? payload.sec : payload.duration_sec;
  const sec = Number(secRaw);
  if (Number.isFinite(sec) && sec > 0) {
    if (sec < G.sec_min || sec > G.sec_max) throw new U.ApiError('BAD_REQUEST', `时长要在 ${G.sec_min}-${G.sec_max} 秒之间，我按这个范围才能真交付`);
    out.sec = Math.round(sec);
  }
  const cnt = Number(payload.count);
  if (Number.isFinite(cnt) && cnt > 0) {
    if (cnt < G.count_min || cnt > G.count_max) throw new U.ApiError('BAD_REQUEST', `候选条数要在 ${G.count_min}-${G.count_max} 之间`);
    out.count = Math.trunc(cnt);
  }
  if (action === 'music.propose_card_patch') {
    const mood = words(payload.mood, 20); if (mood.length) out.mood = mood;
    const gh = words(payload.genre_hypotheses, 24); if (gh.length) out.genre_hypotheses = gh;
    const v = one(payload.vocal, 12);
    if (v) {
      if (!['song', 'instrumental', 'unknown'].includes(v)) throw new U.ApiError('BAD_REQUEST', '要不要人声只支持 song / instrumental / unknown');
      out.vocal = v;
    }
    const voice = one(payload.voice, 24); if (voice) out.voice = lex.sanitize(voice);
    const bpm = Number(payload.bpm);
    if (Number.isFinite(bpm) && bpm > 0) {
      if (bpm < 40 || bpm > 200) throw new U.ApiError('BAD_REQUEST', '快慢要在 40 到 200 之间');
      out.bpm = Math.round(bpm);
    }
    if (!CARD_FIELDS.some((k) => out[k] !== undefined)) throw new U.ApiError('BAD_REQUEST', '这张任务单没有要改的地方');
  }
  return out;
}

// 属主本人的任务单；查不到就**新建一张**（不拿幻觉编号去派单）。
function resolveAgentCard(user, args, sessionId, create) {
  const id = String(args.intent_id || '').trim();
  if (id) {
    const row = store.get('SELECT * FROM intent_cards WHERE id=?', id);
    if (row && row.user_id === user.id) {
      if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '这张任务单已经用来出过歌了，重新起一版灵感再来一次');
      return row;
    }
    // 留痕而不是报错：模型编编号是常态，判它红只会让它换个编号再编一次。
    store.log('agent.proposal.foreign_intent', { user_id: user.id, intent_id: id, session_id: sessionId || null });
  }
  if (!create) return null;
  const idea = String(args.scene_desc || '').trim();
  if (!idea) throw new U.ApiError('NOT_READY', '还不知道要做一首什么样的歌 —— 点上面任意一句灵感就行，或告我一句（比如「深夜加班听的安静纯音乐」），我再往下做。', 409);
  const newId = intentApi.newDraftIntent(user, 'agent', null, 3); // 伴创卡 ask_budget=3（v5.5.8）
  store.run('UPDATE intent_cards SET scene_desc=?,source_text=?,gen_params=?,updated_at=? WHERE id=?',
    idea, idea, U.jstr({ prompt: idea }), U.nowIso(), newId);
  store.log('intent.create', { user_id: user.id, intent_id: newId, initiated_by: 'agent', session_id: sessionId || null });
  bus.intentCard(user.id, newId, 'clarifying');
  return store.get('SELECT * FROM intent_cards WHERE id=?', newId);
}

// 字段名不许念给用户（§11.5 黑话纪律）：这句 reply 会被端侧原样贴进气泡。
const FIELD_HUMAN = {
  mood: '情绪', genre_hypotheses: '曲风', vocal: '要不要人声', voice: '谁来唱',
  scene_desc: '灵感', sec: '时长', bpm: '快慢', count: '候选条数',
};

// 票消费后的唯一执行器。派单只发生在 generate 这一支，且一律经 generateIntentInternal
// → worksApi.dispatchMusic（扣分与入队同事务的唯一落点，本文件不自己碰账）。
async function executeAgentTicket(user, ticket) {
  const args = ticket.args || {};
  const row = resolveAgentCard(user, args, ticket.session_id, true);
  const body = {};
  for (const k of CARD_FIELDS) if (args[k] !== undefined) body[k] = args[k];
  if (Object.keys(body).length) intentApi.patchIntentInternal(user, row, body);
  let fresh = store.get('SELECT * FROM intent_cards WHERE id=?', row.id);
  const params = authoritativeParams(fresh, args);

  if (ticket.action === 'music.propose_card_patch') {
    const changed = Object.keys(body).map((k) => FIELD_HUMAN[k] || k).join('、');
    store.log('agent.ticket.applied', { user_id: user.id, ticket_id: ticket.id, intent_id: fresh.id, fields: Object.keys(body) });
    return {
      intent_id: fresh.id, params,
      reply: changed ? '任务单已经按你确认的这份改好了：' + changed + '。' : '任务单没有需要改的地方。',
    };
  }

  const gp = U.jparse(fresh.gen_params, {}) || {};
  if (!String(gp.prompt || fresh.scene_desc || '').trim()) {
    throw new U.ApiError('NOT_READY', '还不知道要做一首什么样的歌 —— 点上面任意一句灵感就行，或告我一句（比如「深夜加班听的安静纯音乐」），我再往下做。', 409);
  }
  if (fresh.status !== 'ready') {
    // 用户在简报卡上已经对着这份参数点过一次头，这里替他跨过"澄清分不够"这道门；
    // 没这句灵感的那条在上面就被拦下了，不会派出一单谁也不知道在做什么的活。
    store.run("UPDATE intent_cards SET status='ready', updated_at=? WHERE id=? AND status IN ('clarifying','processing')", U.nowIso(), fresh.id);
    bus.intentCard(user.id, fresh.id, 'ready');
    fresh = store.get('SELECT * FROM intent_cards WHERE id=?', fresh.id);
  }
  const r = intentApi.generateIntentInternal(user, fresh);
  const jobId = r && r.body && r.body.job_id;
  store.log('agent.ticket.applied', { user_id: user.id, ticket_id: ticket.id, intent_id: fresh.id, job_id: jobId || null, count: params.count });
  return {
    intent_id: fresh.id, job_id: jobId || null, params,
    idempotent: !!(r && r.body && r.body.idempotent),
    reply: r && r.body && r.body.idempotent
      ? '这一批刚才已经在排队了，不重复开工。'
      : '好，这版已经开始排队，出 ' + params.count + ' 条候选，好了我放在这里等你听。',
  };
}

// POST /v1/agent/proposals —— 端侧建议草稿 → 服务端确认票（可选同一次里替已拍板的人消费掉）
async function proposalIssue(ctx) {
  const user = requireAgent(ctx);
  const b = ctx.body || {};
  const action = String(b.action || '').trim();
  if (action === 'mv.propose_shot_rework') throw new U.ApiError('FORBIDDEN', MV_REWORK_HINT);
  if (!PROPOSAL_TOOLS[action]) throw new U.ApiError('BAD_REQUEST', '这个建议不在智能体职责范围内，不能发票');
  const payload = (b.payload && typeof b.payload === 'object' && !Array.isArray(b.payload)) ? b.payload : {};
  const args = normalizeProposal(action, payload);
  // reason 端侧放在 body 顶层（它就是给工具回单用的一句话），旧调用也塞在 payload 里 ——
  // 两边都认，取先出现的那个，别让它因为摆错位置就变成空字符串（票面上那句"为什么"就没了）。
  const topReason = one(b.reason, 120);
  if (topReason) args.reason = lex.sanitize(topReason);
  const sessionId = b.session_id ? String(b.session_id) : null;
  if (sessionId) {
    const s = gov.getSession(sessionId);
    if (!s || s.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '会话不存在');
  }
  const preview = authoritativeParams(resolveAgentCard(user, args, sessionId, false), args);
  const issued = gov.issueTicket(PROPOSAL_TOOLS, user, { scope: AGENT_SCOPE, type: 'user', id: user.id },
    action, args, undefined, { auditKind: AUDIT });
  const row0 = store.get('SELECT * FROM chat_tickets WHERE id=?', issued.id);
  store.run('UPDATE chat_tickets SET session_id=?,meta_json=?,expires_at=? WHERE id=?',
    sessionId, U.jstr({ reason: args.reason || '', diff: ticketDiff(action, args, preview), params: preview }),
    row0.ttl_expire_at || U.isoAfterMs(gov.TICKET_TTL_MS), issued.id);
  const ticket = agentTicketShape(store.get('SELECT * FROM chat_tickets WHERE id=?', issued.id));
  store.log('agent.proposal', { user_id: user.id, session_id: sessionId, ticket_id: issued.id, action });

  // 人已经按过主 CTA 才带这个标记；带上了就不必再让用户点第二遍（D-2：出曲前一次总确认）。
  if (b.auto_confirm === true) {
    const t = gov.verifyAndConsumeTicket(issued.id, { ver: ticket.ver, hash: ticket.hash }, user, { auditKind: AUDIT });
    try {
      const out = await executeAgentTicket(user, t);
      const cur = store.get('SELECT meta_json FROM chat_tickets WHERE id=?', t.id);
      store.run("UPDATE chat_tickets SET status='succeeded',job_id=?,reply=?,finished_at=?,meta_json=? WHERE id=?",
        out.job_id || null, out.reply || null, U.nowIso(),
        U.jstr(Object.assign({}, U.jparse(cur && cur.meta_json, {}) || {},
          { intent_id: out.intent_id || null, params: out.params || {} })), t.id);
      return { status: 202, body: Object.assign({ executed: true, ticket: agentTicketShape(store.get('SELECT * FROM chat_tickets WHERE id=?', t.id)) }, out) };
    } catch (e) {
      const code = e && e.code ? String(e.code) : 'INTERNAL';
      store.run("UPDATE chat_tickets SET status='failed',reply=?,finished_at=?,failure_code=? WHERE id=?",
        one(e && e.message, 200), U.nowIso(), code, t.id);
      store.log('agent.ticket.failed', { user_id: user.id, ticket_id: t.id, action, code, via: 'auto' });
      if (e instanceof U.ApiError) throw e;
      throw new U.ApiError('INTERNAL', '这一步没办成，再让我提一次就行。', 500);
    }
  }
  return { status: 200, body: { executed: false, ticket, params: preview } };
}

// POST /v1/agent/tickets/:id/confirm {ver,hash} —— 五连校验后一次性消费并执行
async function agentTicketConfirm(ctx) {
  const user = requireAgent(ctx);
  const id = String(ctx.params.id || '');
  const row = store.get("SELECT * FROM chat_tickets WHERE id=? AND scope=? AND user_id=?", id, AGENT_SCOPE, user.id);
  if (!row) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效');
  // 终态票只回放：重复点同一颗钮不重新派单、也不重复向服务端要一次活（验收 ⑦）。
  if (row.status === 'succeeded' || row.status === 'consumed') {
    const meta = U.jparse(row.meta_json, {}) || {};
    return { status: 200, body: { executed: true, replay: true, ticket_id: row.id, action: row.action, job_id: row.job_id || null, intent_id: meta.intent_id || null, params: meta.params || {}, reply: row.reply || '这张票已经处理过了，不重复开工。' } };
  }
  if (row.status === 'failed') throw new U.ApiError('TICKET_UNUSABLE', row.reply || '这张票没办成，请再让我提一次', 409);
  if (row.status !== 'pending') throw new U.ApiError('TICKET_UNUSABLE', '这张票已经不能用了，再让我提一次', 409);
  const t = gov.verifyAndConsumeTicket(id, ctx.body, user, { auditKind: AUDIT });
  try {
    const out = await executeAgentTicket(user, t);
    store.run("UPDATE chat_tickets SET status='succeeded',job_id=?,reply=?,finished_at=?,meta_json=? WHERE id=?",
      out.job_id || null, out.reply || null, U.nowIso(),
      U.jstr(Object.assign({}, U.jparse(row.meta_json, {}) || {}, { intent_id: out.intent_id || null, params: out.params || {} })), t.id);
    store.log('agent.ticket.succeeded', { user_id: user.id, ticket_id: t.id, action: t.action, job_id: out.job_id || null });
    return { status: 202, body: Object.assign({ executed: true, ticket_id: t.id, action: t.action }, out) };
  } catch (e) {
    const code = e && e.code ? String(e.code) : 'INTERNAL';
    store.run("UPDATE chat_tickets SET status='failed',reply=?,finished_at=?,failure_code=? WHERE id=?",
      one(e && e.message, 200), U.nowIso(), code, t.id);
    store.log('agent.ticket.failed', { user_id: user.id, ticket_id: t.id, action: t.action, code });
    if (e instanceof U.ApiError) throw e;
    throw new U.ApiError('INTERNAL', '这一步没办成，再让我提一次就行。', 500);
  }
}

// POST /v1/agent/tickets/:id/deny —— 用户不要这一步（pending→denied，只按票主）
function agentTicketDeny(ctx) {
  const user = requireAgent(ctx);
  const row = store.get("SELECT id,status FROM chat_tickets WHERE id=? AND scope=? AND user_id=?",
    String(ctx.params.id || ''), AGENT_SCOPE, user.id);
  if (!row) throw new U.ApiError('NOT_FOUND', '确认票不存在或已失效');
  gov.denyTicket(ctx.params.id, user, { auditKind: AUDIT });
  return { status: 200, body: { ok: true } };
}

// GET /v1/agent/tickets —— 挂在界面上的待确认票（重启 App 之后还得看得见，不然"待确认"会凭空消失）
function agentTicketsGet(ctx) {
  const user = requireAgent(ctx);
  const now = U.nowIso();
  store.run("UPDATE chat_tickets SET status='expired' WHERE scope=? AND status='pending' AND (expires_at IS NULL OR expires_at<=?)", AGENT_SCOPE, now);
  const rows = store.all("SELECT * FROM chat_tickets WHERE scope=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
    AGENT_SCOPE, user.id, U.clamp(Number(ctx.query && ctx.query.limit) || 10, 1, 20));
  return { status: 200, body: { tickets: rows.map(agentTicketShape) } };
}

module.exports = {
  requireAgent, agentSpent, AGENT_TOKEN_BASE, TOKEN_SCOPE, TURN_TOKEN_CAP,
  PROPOSAL_TOOLS, normalizeProposal, authoritativeParams, executeAgentTicket,
  routes: [
    { m: 'POST', p: '/v1/agent/llm', h: llmProxy },
    { m: 'POST', p: '/v1/agent/tools/web_search', h: webSearchTool },
    { m: 'GET', p: '/v1/agent/skills', h: skillsCatalog },
    { m: 'GET', p: '/v1/agent/skills/:name', h: skillLoad },
    { m: 'GET', p: '/v1/agent/memory', h: memoryGet },
    { m: 'PUT', p: '/v1/agent/memory', h: memoryPut },
    { m: 'DELETE', p: '/v1/agent/memory/:key', h: memoryDelete },
    { m: 'POST', p: '/v1/agent/proposals', h: proposalIssue },
    { m: 'GET', p: '/v1/agent/tickets', h: agentTicketsGet },
    { m: 'POST', p: '/v1/agent/tickets/:id/confirm', h: agentTicketConfirm },
    { m: 'POST', p: '/v1/agent/tickets/:id/deny', h: agentTicketDeny },
  ],
};

