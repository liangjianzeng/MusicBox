// intent lane —— 语音/图片 → 意图卡：ASR(:8191) + 托管多模态端点编译；端点挂→本地词典启发式（2026-11-23）
'use strict';
const fs = require('node:fs');
const net = require('../lib/net.js');
const { resolveSrc } = require('../lib/paths.js');

// 内置意图编译指令（job.payload.system_prompt 非空时优先）
const DEFAULT_INTENT_SYSTEM =
  '你是"一句话点歌"的意图编译器。输入是用户语音转写或图片场景描述，输出严格 JSON（不解释、不用 Markdown 围栏）：\n' +
  '{"mood":["中文氛围词1-3个"],"scene_desc":"一句话中文场景概括","genre_hypotheses":["曲风1-4个"],' +
  '"vocal":"song|instrumental|unknown","duration_hint":"偏短|适中|偏长","confidence":0到1,' +
  '"questions":[{"q_idx":0,"q":"中文问题","options":[{"idx":0,"label":"选项"}],"recommended_idx":0}]}\n' +
  '规则：confidence≥0.75 时 questions 必须为空数组；否则给 1-2 题，每题 2-4 个选项且必带 recommended_idx；' +
  '明确提到纯音乐/伴奏时 vocal=instrumental，可唱为 song，否则 unknown；mood 与 questions 全部用中文。';

const DEFAULT_DESCRIBE_SYSTEM = '请用不超过 60 字中文描述这张图片的场景、氛围与适合的曲风，只输出描述文本本身。';

// ---------- 多模态端点（OpenAI 兼容） ----------
async function chat(cfg, messages, opts) {
  opts = opts || {};
  const base = String(cfg.llmVlmUrl || '').replace(/\/+$/, '');
  const body = JSON.stringify({
    model: cfg.llmVlmModel,
    messages,
    temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
  });
  const res = await net.request('POST', base + '/chat/completions', {
    headers: { 'content-type': 'application/json' },
    body,
    timeoutMs: opts.timeoutMs || 90000,
  });
  if (res.status !== 200) {
    const e = new Error('理解服务响应异常(' + res.status + ')');
    e.endpointDown = true;
    throw e;
  }
  const j = res.json();
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  // 2026-11-23 实测：qwen38-fp4 为思考型输出，答案可能整体落在 reasoning、content 为 null —— 取其一兜底
  const content = msg && (msg.content || msg.reasoning);
  if (!content) {
    const e = new Error('理解服务返回为空');
    e.endpointDown = true;
    throw e;
  }
  return String(content);
}

// 从自由文本中抽取 JSON 对象（容忍围栏/前后废话）
function extractJson(text) {
  const s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = (fence ? fence[1] : s).trim();
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const o = JSON.parse(body.slice(a, b + 1));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch (e) { return null; }
}

// 编译意图卡：JSON 解析失败重试 1 次；端点不可达 → 返回 null 交启发式兜底
async function tryCompile(ctx, system, user) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await chat(ctx.cfg, [
        { role: 'system', content: system },
        { role: 'user', content: user + (attempt === 1 ? '\n\n注意：只输出一个 JSON 对象。' : '') },
      ]);
      const card = extractJson(content);
      if (card) return card;
      ctx.log('意图卡解析失败，重试 ' + (attempt + 1) + '/2');
    } catch (e) {
      ctx.log('理解服务不可用，改用本地兜底：' + e.message);
      return null;
    }
  }
  return null;
}

// ---------- 本地词典启发式（端点挂时兜底，confidence<0.5） ----------
const MOOD_DICT = [
  { kw: ['快乐', '开心', '欢快', '高兴', '庆祝', '庆生', '生日', '派对', '聚会'], mood: ['温暖'], genre: ['pop', 'folk'], vocal: 'song' },
  { kw: ['难过', '伤心', '悲伤', '离别', '思念', '想念', '失恋'], mood: ['忧伤'], genre: ['ballad', 'folk'], vocal: 'song' },
  { kw: ['爱情', '表白', '恋爱', '心动', '喜欢', '告白'], mood: ['浪漫'], genre: ['pop', 'r&b'], vocal: 'song' },
  { kw: ['燃', '热血', '运动', '跑步', '健身', '冲刺', '加油', '战斗'], mood: ['热血'], genre: ['rock', 'electronic'], vocal: 'song' },
  { kw: ['睡觉', '晚安', '安静', '放松', '疗愈', '冥想', '休息', '助眠'], mood: ['宁静'], genre: ['ambient', 'new age'], vocal: 'unknown' },
  { kw: ['古风', '国风', '山水', '侠', '江湖', '汉服'], mood: ['悠远'], genre: ['chinese traditional', 'folk'], vocal: 'song' },
  { kw: ['儿歌', '孩子', '宝宝', '童年', '幼儿园'], mood: ['活泼'], genre: ['children', 'pop'], vocal: 'song' },
  { kw: ['纯音乐', '伴奏', '无人声', '钢琴', '吉他', '乐器'], mood: ['温暖'], genre: ['instrumental', 'ambient'], vocal: 'instrumental' },
];

function heuristicCard(text, asr, sourceKind) {
  const t = String(text || '');
  let hit = null;
  for (const d of MOOD_DICT) {
    if (d.kw.some((k) => t.indexOf(k) !== -1)) { hit = d; break; }
  }
  const hasText = t.length > 0;
  const card = {
    mood: hit ? hit.mood.slice() : ['温暖'],
    scene_desc: hasText ? ('基于转写内容提炼的创作意图：「' + t.slice(0, 24) + '」') : (sourceKind === 'image' ? '来自图片的创作意图' : '来自语音的创作意图'),
    genre_hypotheses: hit ? hit.genre.slice() : ['pop', 'folk'],
    vocal: hit ? hit.vocal : (asr && (asr.events || []).indexOf('bgm') !== -1 ? 'instrumental' : 'unknown'),
    duration_hint: asr && asr.duration ? (asr.duration <= 20 ? '偏短' : asr.duration <= 40 ? '适中' : '偏长') : '适中',
    confidence: hasText && hit ? 0.45 : 0.4,
    questions: [],
    answers: [],
    fallback: true,
  };
  card.questions.push({
    q_idx: 0,
    q: '希望这首歌更偏向哪种氛围？',
    options: [{ idx: 0, label: '轻快活泼' }, { idx: 1, label: '温柔舒缓' }, { idx: 2, label: '热血燃向' }],
    recommended_idx: hit ? (hit.mood[0] === '热血' ? 2 : hit.mood[0] === '宁静' || hit.mood[0] === '忧伤' ? 1 : 0) : 0,
  });
  if (!hasText || (asr && asr.duration && asr.duration > 15)) {
    card.questions.push({
      q_idx: 1,
      q: '想要人声演唱还是纯音乐？',
      options: [{ idx: 0, label: '人声演唱' }, { idx: 1, label: '纯音乐' }, { idx: 2, label: '都可以' }],
      recommended_idx: card.vocal === 'instrumental' ? 1 : 0,
    });
  }
  return card;
}

// ---------- 意图卡整形（用户面纪律 + 澄清纪律的执行器侧预检） ----------
const VOCAL_SET = { song: 1, instrumental: 1, unknown: 1 };
function sanitizeCard(card) {
  const out = { mood: [], scene_desc: '', genre_hypotheses: [], vocal: 'unknown', duration_hint: '适中', confidence: 0.4, questions: [], answers: [] };
  if (!card || typeof card !== 'object') return out;
  const arr = (v, cap) => (Array.isArray(v) ? v : String(v || '').split(/[,，]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, cap);
  out.mood = arr(card.mood, 3);
  out.genre_hypotheses = arr(card.genre_hypotheses, 4);
  out.scene_desc = String(card.scene_desc || '').trim().slice(0, 200);
  if (VOCAL_SET[card.vocal]) out.vocal = card.vocal;
  const hints = { '偏短': 1, '适中': 1, '偏长': 1 };
  if (hints[card.duration_hint]) out.duration_hint = card.duration_hint;
  const c = Number(card.confidence);
  out.confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.4;
  if (card.fallback) out.fallback = true;

  const qs = Array.isArray(card.questions) ? card.questions : [];
  let idx = 0;
  for (const q of qs) {
    if (!q || idx >= 2) continue;
    const text = String(q.q || '').trim();
    let options = Array.isArray(q.options) ? q.options : [];
    options = options.map((o, i) => ({ idx: Number.isFinite(Number(o.idx)) ? Number(o.idx) : i, label: String(o.label || '').trim() })).filter((o) => o.label).slice(0, 4);
    if (!text || options.length < 2) continue; // 每题选项 2-4 个
    let rec = Number(q.recommended_idx);
    if (!Number.isInteger(rec) || rec < 0 || rec >= options.length) rec = 0; // 必带 recommended_idx
    out.questions.push({ q_idx: idx, q: text, options, recommended_idx: rec });
    idx++;
  }
  if (out.confidence >= 0.75) out.questions = []; // ≥0.75 直接 ready
  if (out.mood.length === 0) out.mood = ['温暖'];
  if (out.genre_hypotheses.length === 0) out.genre_hypotheses = ['pop'];
  return out;
}

// ---------- 语音线：ASR → 编译 ----------
async function runVoice(job, ctx) {
  const p = job.payload || {};
  await ctx.progress(10, '正在识别语音');
  const srcAbs = await resolveSrc(p.upload_path, ctx);
  let asr = null;
  if (srcAbs) {
    try {
      const res = await net.request('POST', String(ctx.cfg.asrUrl).replace(/\/+$/, '') + '/asr', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: srcAbs }),
        timeoutMs: 60000,
      });
      if (res.status === 200) asr = res.json();
      else ctx.log('语音识别服务返回 ' + res.status);
    } catch (e) {
      ctx.log('语音识别服务不可用：' + e.message);
    }
  } else {
    ctx.log('语音素材缺失，走本地兜底');
  }
  if (asr && asr.text) await ctx.progress(50, '正在理解意图');
  else ctx.log('无转写结果，走本地词典兜底');

  let card = null;
  const userText = asr && asr.text
    ? ('语音转写：' + asr.text + (asr.emotion && asr.emotion !== 'neutral' ? '；情绪：' + asr.emotion : '') + ((asr.events || []).length ? '；事件：' + asr.events.join(',') : ''))
    : '';
  if (userText) card = await tryCompile(ctx, p.system_prompt || DEFAULT_INTENT_SYSTEM, userText);
  // 兜底要留痕：没转写或 LLM 没编出来 = 词典兜底，服务端据此标 degraded（诚实化 v11）
  const heuristic = !card;
  if (!card) card = heuristicCard(userText || (asr && asr.text) || '', asr, 'voice');

  card = sanitizeCard(card);
  if (!card.scene_desc) card.scene_desc = '来自语音的创作意图';
  // result 为超集：IntentCard 字段（契约 §4）+ ASR 观测字段（服务端 compileIntent 消费 text/emotion/events）
  const result = Object.assign({}, card);
  if (asr && asr.text) {
    result.text = String(asr.text).slice(0, 500);
    if (asr.emotion) result.emotion = asr.emotion;
    if (Array.isArray(asr.events)) result.events = asr.events;
    if (Number.isFinite(Number(asr.duration))) result.duration = Number(asr.duration);
  }
  if (heuristic || !asr || !asr.text) result.fallback = true;
  await ctx.progress(90, '意图卡已生成');
  return { result, files: [] };
}

// ---------- 文本线：端侧已识别/用户手写 → 直接编译（不再过 ASR） ----------
// 用途：① 端侧转写喂进意图链；② 用户在「你说的话」确认页改字后重新理解。
async function runText(job, ctx) {
  const p = job.payload || {};
  const own = String(p.text || '').trim().slice(0, 500);
  if (!own) throw new Error('缺少文本内容');
  await ctx.progress(30, '正在理解意图');
  let card = await tryCompile(ctx, p.system_prompt || DEFAULT_INTENT_SYSTEM, '用户原话：' + own);
  const heuristic = !card;
  if (!card) card = heuristicCard(own, null, 'voice');
  card = sanitizeCard(card);
  if (!card.scene_desc) card.scene_desc = '基于你说的内容提炼的创作意图';
  const result = Object.assign({}, card, { text: own });
  if (heuristic) result.fallback = true;
  await ctx.progress(90, '意图卡已生成');
  return { result, files: [] };
}

// ---------- 图片线：多模态描述 → 编译 ----------
function imageMime(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  } finally { fs.closeSync(fd); }
  return /\.png$/i.test(abs) ? 'image/png' : 'image/jpeg';
}

async function runImage(job, ctx) {
  const p = job.payload || {};
  await ctx.progress(15, '正在观察图片');
  const srcAbs = await resolveSrc(p.upload_path, ctx);
  let desc = null;
  if (srcAbs && fs.statSync(srcAbs).size <= 8 * 1024 * 1024) {
    const dataUrl = 'data:' + imageMime(srcAbs) + ';base64,' + fs.readFileSync(srcAbs).toString('base64');
    try {
      desc = await chat(ctx.cfg, [
        { role: 'system', content: p.describe_prompt || DEFAULT_DESCRIBE_SYSTEM },
        { role: 'user', content: [{ type: 'text', text: '描述这张图片。' }, { type: 'image_url', image_url: { url: dataUrl } }] },
      ]);
      desc = String(desc || '').trim().slice(0, 200);
    } catch (e) {
      ctx.log('图片理解服务不可用：' + e.message);
    }
  } else {
    ctx.log('图片素材缺失或超限，走本地兜底');
  }
  await ctx.progress(55, '正在理解意图');
  let card = null;
  if (desc) card = await tryCompile(ctx, p.system_prompt || DEFAULT_INTENT_SYSTEM, '图片场景描述：' + desc);
  if (!card) card = heuristicCard(desc || '', null, 'image');
  card = sanitizeCard(card);
  if (!card.scene_desc && desc) card.scene_desc = desc;
  if (!card.scene_desc) card.scene_desc = '来自图片的创作意图';
  await ctx.progress(90, '意图卡已生成');
  return { result: card, files: [] };
}

// ---------- 复刻分析线（契约 v5.7.4）：取件 → :8191 ASR → raw 特征回传 ----------
// 执行器只做特征采集（ASR 情绪/事件/时长 + 转写文本），LLM 归纳在服务端 completeReplicaAnalyze。
// 转写文本经 complete 上报属**瞬态**：服务端落库的 job.result 是净化版（v5.7.5），执行器侧不留档。
async function runReplicaAnalyze(job, ctx) {
  const p = job.payload || {};
  await ctx.progress(10, '正在读取参考音频');
  const srcAbs = await resolveSrc(p.src_path, ctx);
  if (!srcAbs) throw Object.assign(new Error('参考音频不可达'), { failCode: 'SRC_MISSING', failMessage: '参考音频文件不存在或已过期，请重新上传' });
  await ctx.progress(35, '正在识别参考曲');
  let asr = null;
  try {
    // 整首歌远超 intent 语音 60s 的设计目标（SenseVoice 未实测长音频）：放宽超时 + 失败诚实回落，
    // 由服务端按可用元数据走规则画像（v5.7.10），绝不伪造观测
    const res = await net.request('POST', String(ctx.cfg.asrUrl).replace(/\/+$/, '') + '/asr', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcAbs }),
      timeoutMs: 150000,
    });
    if (res.status === 200) asr = res.json();
    else ctx.log('参考曲识别返回 ' + res.status);
  } catch (e) {
    ctx.log('识别服务不可用：' + e.message);
  }
  await ctx.progress(80, asr && asr.text ? '识别完成，交由服务端归纳' : '识别不可用，交由服务端按可用信息归纳');
  const result = {
    asr: asr ? {
      emotion: asr.emotion || null,
      events: Array.isArray(asr.events) ? asr.events : [],
      duration: Number.isFinite(Number(asr.duration)) ? Number(asr.duration) : null,
      text: String(asr.text || '').slice(0, 2000),
    } : null,
    fallback: !asr,
  };
  return { result, files: [] };
}

module.exports = { runVoice, runImage, runText, runReplicaAnalyze, DEFAULT_INTENT_SYSTEM, extractJson, heuristicCard, sanitizeCard };
