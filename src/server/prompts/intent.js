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
  '"questions":[{"q_idx":0,"q":"澄清问题","options":[{"idx":0,"label":"选项"}],"recommended_idx":0}]}',
  '规则：questions 至多 2 题，每题 options 为 2-4 个且必须给出 recommended_idx；',
  '信息足够（confidence>=0.75）时 questions 必须为空数组；信息不足时 questions 给 1-2 题并把 confidence 降到 0.75 以下。',
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
function normalizeCard(raw) {
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
  card.questions = qs.slice(0, 2).map((q, i) => ({
    q_idx: i,
    q: String((q && q.q) || '').slice(0, 120),
    options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 4).map((o, idx) => ({ idx, label: String(typeof o === 'string' ? o : (o && o.label) || '').slice(0, 60) })).filter(o => o.label),
    recommended_idx: Math.max(0, Math.min(Number((q && q.recommended_idx) || 0), 1)),
  })).filter(q => q.q && q.options.length >= 2);
  // 重编号 q_idx 连续
  card.questions.forEach((q, i) => { q.q_idx = i; q.options.forEach((o, j) => { o.idx = j; }); q.recommended_idx = U.clamp(q.recommended_idx, 0, Math.max(0, q.options.length - 1)); });
  return card;
}

// 服务端强制澄清纪律：轮次≤2、每题必带 recommended_idx、options 2-4、confidence≥0.75 直接 ready
function enforce(card) {
  const c = normalizeCard(card);
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
  try {
    const text = await chatCompletionWithRetry(messages);
    const json = extractJson(text);
    if (!json) throw new U.ApiError('INTERNAL', '返回格式异常');
    const card = enforce({ ...json, confidence: U.clamp(json.confidence, 0.3, 1) });
    if (card.confidence < 0.75 && !card.questions.length) card.questions = dict.defaultQuestions(card);
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

module.exports = { SYSTEM_PROMPT, chatCompletion, chatCompletionWithRetry, extractJson, normalizeCard, enforce, fallbackCompile, compileIntent, genParamsFromCard };
