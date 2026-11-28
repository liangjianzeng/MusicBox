// IntentCard 编译：system prompt + OpenAI 兼容客户端（20s 超时重试 1 次）+ 词典确定性兜底（2026-11-23）
'use strict';
const config = require('../config');
const U = require('../core/util');
const M = require('../core/modelnodes');
const dict = require('./dictionary');

const SYSTEM_PROMPT = [
  '你是音乐创作意图编译器。根据用户的语音转写或图像场景描述，产出一张 IntentCard。',
  '只输出一个严格 JSON 对象，不要任何解释、不要 markdown 代码块。字段：',
  '{"mood":["情绪词1","情绪词2"],"scene_desc":"一句话场景描述","genre_hypotheses":["风格1","风格2"],',
  '"vocal":"song|instrumental|unknown","duration_hint":"如 45s/1分钟/未知",',
  '"confidence":0到1的小数,"bpm":整数或null,"tags":["英文标签"],',
  '"questions":[{"q_idx":0,"q":"澄清问题","options":[{"idx":0,"label":"选项","set":{"tags_add":["英文标签"],"genre_add":["风格"],"mood_add":["情绪"],"vocal":"song|instrumental","bpm":整数,"sec":整数,"dim":"维度名"}}],"recommended_idx":0}]}',
  // v5.5.9：选项必须自带 set。不教它带 set，回填就只能回头猜标签字面，那是「勾女声出男声」的起点。
  '规则：每个选项尽量带 set（它决定用户选完后**具体改哪些参数**）；标签用英文，vocal 只能是 song 或 instrumental；拿不准就不带 set，不要瞎填。',
  '规则：每题 options 为 2-4 个且必须给出 recommended_idx（推荐项可为任意下标，不限前两项）；',
  '信息足够（confidence>=0.75）时 questions 必须为空数组；信息不足时把 confidence 降到 0.75 以下并给澄清题。',
  'mood 用中文常用情绪词；不确定填 unknown，禁止编造。',
].join('\n');

// —— OpenAI 兼容单端点调用（DGX 托管多模态，文本+图像同一 /chat/completions）——
// 端点/模型名走运行时节点解析（后台可配，不写死）；空表或节点失效时回退 config 默认值。
async function chatCompletion(messages, timeoutMs) {
  const node = M.resolveNode('llm') || { endpoint: config.llmVlmUrl, engine: config.llmVlmModel };
  const url = String(node.endpoint).replace(/\/$/, '') + '/chat/completions';
  const tmo = timeoutMs || config.llmTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tmo);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 思考模型（qwen38-fp4）：答案可能整体落在 reasoning，content 为 null；max_tokens 须给推理留量
      body: JSON.stringify({ model: node.engine || config.llmVlmModel, messages, temperature: 0.3, max_tokens: 3000, stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new U.ApiError('INTERNAL', '后台理解服务不可用(' + res.status + ')');
    const data = await res.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const text = msg && (msg.content || msg.reasoning); // 2026-11-23 实测：thinking 输出在 reasoning 字段
    if (!text) throw new U.ApiError('INTERNAL', '后台理解服务返回为空');
    return String(text);
  } finally {
    clearTimeout(timer);
  }
}
async function chatCompletionWithRetry(messages, timeoutMs) {
  try {
    return await chatCompletion(messages, timeoutMs);
  } catch (e) {
    try { return await chatCompletion(messages, timeoutMs); } // 重试 1 次
    catch (e2) { throw e; }
  }
}

// —— 原生 function calling（契约 v5.5；探针实测 qwen38-fp4 原生支持 tools/tool_calls）——
// 与 chatCompletion 的关键差异，也是本次要替掉手搓 JSON 协议的原因：
//   思考模型决定调用工具时 **content 为 null、推理整体落在 reasoning**（附录 A 实测）。
//   所以这里**绝不**复用 `msg.content || msg.reasoning` 那套兜底 —— 那会把"它正在琢磨调哪个工具"
//   的推理过程当成回复吐给用户。事实照实返回，取舍策略留给调用方。
// 返回 null = 该端点不认 tools（老版本 vLLM 会 4xx 拒绝带 tools 的请求）。这是能力缺失不是故障，
// 如实报 null 让上层回落文本协议，不能把整条助手链路打成 500。
async function chatToolCall(messages, tools, opts) {
  opts = opts || {};
  const node = M.resolveNode('llm') || { endpoint: config.llmVlmUrl, engine: config.llmVlmModel };
  const url = String(node.endpoint).replace(/\/$/, '') + '/chat/completions';
  const tmo = opts.timeoutMs || config.llmTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), tmo);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: node.engine || config.llmVlmModel, messages, temperature: 0.2,
        // max_tokens 要给推理留量：thinking 模型的 reasoning 与 content 共享这个预算，
        // 给小了会在推理中途被截，表现为"永远不出 tool_calls"而非报错，极难归因。
        max_tokens: opts.maxTokens || 1500, stream: false,
        // **没有工具就不要带 tools/tool_choice**。vLLM 对 `tools: []` + `tool_choice:"auto"`
        // 直接 400，而我方把这种 400 翻译成「当前模型不支持工具调用」并回 503 —— 于是
        // "这一轮本来就不需要工具"的纯聊天回合被整轮误杀（真机 K90 2026-11-28 实测：
        // 同一模型带 tools 时 tool_calls 正常返回，模型没问题，是我们的请求形状有问题）。
        // 思考开关（2026-11-28 实测）：vLLM 上只有 chat_template_kwargs.enable_thinking 真能关掉思考
        // （reasoning 归零）；thinking_enabled、thinking_budget=0 两种写法都压不住，实测照出 reasoning。
        // 【只在客户端显式表态时下发】：老客户端不传 thinking 就维持今天的默认行为，不擅自改变。
        ...(opts.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        ...(Array.isArray(tools) && tools.length
          ? { tools, tool_choice: 'auto', parallel_tool_calls: false }
          : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if ((res.status === 400 || res.status === 422) && /\btools?\b|tool_choice|function/i.test(body)) return null;
      throw new U.ApiError('INTERNAL', '后台理解服务不可用(' + res.status + ')');
    }
    const data = await res.json();
    const ch = (data && data.choices && data.choices[0]) || null;
    const msg = (ch && ch.message) || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    return {
      content: msg.content == null ? null : String(msg.content),
      reasoning: msg.reasoning == null ? null : String(msg.reasoning),
      // arguments 是**未校验的模型输出**，保持原始字符串交给调用方 parse + 收敛，这里不做任何信任
      toolCalls: calls.map((c) => ({
        id: (c && c.id) || null,
        name: String((c && c.function && c.function.name) || ''),
        arguments: String((c && c.function && c.function.arguments) || ''),
      })).filter((c) => c.name),
      finishReason: (ch && ch.finish_reason) || null,
      usage: (data && data.usage) || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 宽松 JSON 提取（模型可能包 ```json 或前后带话）
function extractJson(text) {
  const s = String(text || '');
  const fenced = /```(?:json)?\s*([\s\S]+?)```/i.exec(s);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return U.jparse(body.slice(start, end + 1), null);
}

// 归一化 LLM 输出为契约 intent 字段
// v5.5.9：`set` 是**模型产出的不可信输入**，在投递层就收干：只认白名单键、数组限长、数值限域。
// 写入侧 api/intent.js:applyOptionToCard 还有一道同样口径的校验 —— 纵深防御，两处都得有，
// 少一处就意味着模型能用一个越界 bpm 或一万个 tag 直接落进 gen_params。
function sanitizeOptionSet(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  const arr = (k, max, len) => {
    if (!Array.isArray(v[k])) return;
    const a = v[k].map((t) => String(t == null ? '' : t).trim().slice(0, len)).filter(Boolean).slice(0, max);
    if (a.length) out[k] = a;
  };
  arr('tags_add', 5, 24);
  arr('genre_add', 3, 24);
  arr('mood_add', 3, 20);
  if (typeof v.vocal === 'string' && ['song', 'instrumental', 'unknown'].includes(v.vocal)) out.vocal = v.vocal;
  if (Number.isFinite(Number(v.bpm))) { const b = Math.round(Number(v.bpm)); if (b >= 40 && b <= 200) out.bpm = b; }
  if (Number.isFinite(Number(v.sec))) { const s = Math.round(Number(v.sec)); if (s >= 15 && s <= 240) out.sec = s; }
  if (typeof v.dim === 'string' && v.dim.trim()) out.dim = v.dim.trim().slice(0, 24);
  return Object.keys(out).length ? out : null;
}

function normalizeCard(raw, opts) {
  opts = opts || {};
  const card = {
    mood: U.toArr(raw && raw.mood).slice(0, 3),
    scene_desc: String((raw && raw.scene_desc) || '').slice(0, 300),
    genre_hypotheses: U.toArr(raw && raw.genre_hypotheses).slice(0, 3),
    vocal: ['song', 'instrumental'].includes(raw && raw.vocal) ? raw.vocal : 'unknown',
    duration_hint: String((raw && raw.duration_hint) || '').slice(0, 40),
    confidence: U.clamp(raw && raw.confidence, 0, 1),
    bpm: raw && Number.isFinite(Number(raw.bpm)) && Number(raw.bpm) > 0 ? Math.round(Number(raw.bpm)) : null,
    tags: U.toArr(raw && raw.tags).slice(0, 6),
    questions: [],
  };
  const qs = Array.isArray(raw && raw.questions) ? raw.questions : [];
  // v5.5.8：题量按卡分档（伴创 3，其余默认 2），不再全局钳 2。
  const cap = Number.isFinite(opts.askBudget) && opts.askBudget >= 1 && opts.askBudget <= 3 ? Math.trunc(opts.askBudget) : 2;
  card.questions = qs.slice(0, cap).map((q, i) => ({
    q_idx: i,
    q: String((q && q.q) || '').slice(0, 120),
    // v5.5.9：options 必须**带着 set 过这一关**。此前只留 {idx,label}，把 set 剥得一干二净，
    // 于是回填只能回头猜标签字面 —— 那正是「勾女声出男声」的起点。
    options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 4).map((o, idx) => {
      const src = o && typeof o === 'object' ? o : {};
      const out = { idx, label: String(typeof o === 'string' ? o : (src.label) || '').slice(0, 60) };
      const st = sanitizeOptionSet(src.set);
      if (st) out.set = st;
      return out;
    }).filter(o => o.label),
    // 原实现 Math.min(recommended_idx, 1) 把推荐位**永久钳死在 0/1**：4 选项题里正确项排在 2/3
    // 时永远拿不到高亮。这里按实际选项数钳（下面重编号处再钳一次，两处一致）。
    recommended_idx: Math.max(0, Math.trunc(Number((q && q.recommended_idx) || 0))),
  })).filter(q => q.q && q.options.length >= 2);
  // 重编号 q_idx 连续
  card.questions.forEach((q, i) => { q.q_idx = i; q.options.forEach((o, j) => { o.idx = j; }); q.recommended_idx = U.clamp(q.recommended_idx, 0, Math.max(0, q.options.length - 1)); });
  return card;
}

// 服务端强制澄清纪律：轮次≤2、每题必带 recommended_idx、options 2-4、confidence≥0.75 直接 ready
function enforce(card, opts) {
  const c = normalizeCard(card, opts);
  if (c.confidence >= 0.75) c.questions = [];
  for (const q of c.questions) {
    if (q.options.length < 2) q.options.push({ idx: q.options.length, label: '都可以' });
    q.recommended_idx = U.clamp(q.recommended_idx, 0, q.options.length - 1);
  }
  if (!c.tags.length) c.tags = c.genre_hypotheses.length ? c.genre_hypotheses : ['pop'];
  if (!c.mood.length) c.mood = ['中性'];
  return c;
}

// 词典兜底编译（确定性，confidence<0.5，流程不中断）
function fallbackCompile({ kind, input, payload }) {
  const parts = [];
  if (input && input.text) parts.push(input.text);
  if (input && input.scene_desc) parts.push(input.scene_desc);
  if (payload && payload.hint) parts.push(payload.hint);
  if (input && input.emotion) {
    const m = dict.EMOTION_MAP[String(input.emotion).toLowerCase()];
    if (m) parts.push(m);
  }
  const h = dict.heuristicIntent(parts.join('\n'));
  if (input && input.emotion) {
    const m = dict.EMOTION_MAP[String(input.emotion).toLowerCase()];
    if (m && !h.mood.includes(m)) h.mood.unshift(m);
  }
  const card = enforce({ ...h, questions: [], confidence: Math.min(h.confidence, 0.49) });
  card.questions = dict.defaultQuestions(card);
  if (card.confidence >= 0.75 || !card.questions.length) card.questions = [];
  return card;
}

// 编译入口：LLM 优先，失败→词典兜底（永不抛错中断流程）
async function compileIntent({ kind, input, payload }) {
  const userParts = [`来源：${kind === 'voice' ? '语音转写' : (kind === 'text' ? '用户原话' : '图像场景')}`];
  if (input && input.text) userParts.push('转写文本：' + input.text);
  if (input && input.emotion) userParts.push('情绪标签：' + input.emotion);
  if (input && Array.isArray(input.events) && input.events.length) userParts.push('音频事件：' + input.events.join(','));
  if (input && input.scene_desc) userParts.push('场景描述：' + input.scene_desc);
  if (input && input.duration) userParts.push('时长：' + input.duration + ' 秒');
  if (payload && payload.hint) userParts.push('补充：' + payload.hint);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userParts.join('\n') },
  ];
  // 图像：qwen38-fp4 单端点兼顾多模态，content 带 image_url base64 data URL
  if (kind === 'image' && payload && payload.image_data_url) {
    messages[1] = { role: 'user', content: [
      { type: 'text', text: userParts.join('\n') },
      { type: 'image_url', image_url: { url: payload.image_data_url } },
    ] };
  }
  // v5.5.8：题量按卡分档。这条指令必须**在这里追加**而不是写死进 SYSTEM_PROMPT ——
  // 后者是三档共用的，写进常量就等于把存量三档一起放宽到三题。
  const cap = Number.isFinite(Number(payload && payload.ask_budget)) ? Math.trunc(Number(payload.ask_budget)) : 2;
  if (messages[0] && messages[0].role === 'system') {
    messages[0] = { role: 'system', content: messages[0].content + `\n本轮最多问 ${cap} 个澄清题；不足时宁可少问，不要凑数。` };
  }
  try {
    const text = await chatCompletionWithRetry(messages);
    const json = extractJson(text);
    if (!json) throw new U.ApiError('INTERNAL', '返回格式异常');
    const card = enforce({ ...json, confidence: U.clamp(json.confidence, 0.3, 1) }, { askBudget: cap });
    if (card.confidence < 0.75 && !card.questions.length) card.questions = dict.defaultQuestions(card, cap);
    card.gen_params = genParamsFromCard(card);
    return card;
  } catch (e) {
    const card = fallbackCompile({ kind, input, payload });
    card.gen_params = genParamsFromCard(card);
    return card;
  }
}

// 意图卡 → 生乐参数（intent generate 用）
function genParamsFromCard(card) {
  const sec = (() => {
    const m = /(\d+(?:\.\d+)?)\s*(s|秒|分钟|min|m)/i.exec(String(card.duration_hint || ''));
    if (m) {
      let v = Number(m[1]);
      if (/分钟|min|^m$/i.test(m[2])) v *= 60;
      return U.clamp(Math.round(v), config.gen.sec_min, config.gen.sec_max);
    }
    return config.gen.sec_default;
  })();
  return {
    mood: card.mood[0] || '',
    tags: (card.tags && card.tags.length ? card.tags : card.genre_hypotheses).slice(0, 5),
    bpm: card.bpm || null,
    sec,
    instrumental: card.vocal === 'instrumental',
    prompt: card.scene_desc || '',
  };
}

module.exports = { SYSTEM_PROMPT, chatCompletion, chatCompletionWithRetry, chatToolCall, extractJson, normalizeCard, enforce, fallbackCompile, compileIntent, genParamsFromCard };
