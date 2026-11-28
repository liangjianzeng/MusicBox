// 复刻风格画像归纳（契约 v5.7，2026-11-27 追加）。
//
// 职责边界（v5.7.1/5/6）：把参考曲的**可观察特征**（元数据 / ASR 情绪事件 / 检索摘要）归纳进
// dict.catalog() 四域词表。产出永远不包含声纹、旋律描述与歌词原文 —— LLM 只是被关进词表笼子的
// 提词器，真正的闸门是 closeToCatalog 的机械校验：LLM 输出的词不在 catalog = 丢弃，映射不上如
// 实 dropped（与 core/websearch.js mapDomains 同一口径，v5.5.6）。
'use strict';
const P = require('./intent');        // chatCompletion / extractJson：全仓唯一 LLM 客户端入口
const dict = require('./dictionary');

const SYSTEM = '你是"风格画像归纳器"。输入是参考曲的可观察特征（元数据、语音识别的情绪/事件、网页摘要），' +
  '输出严格 JSON（不解释、不用 Markdown 围栏）：\n' +
  '{"moods":["中文氛围词"],"genres":["曲风词"],"style_words":["质感词"],"voice":["人声词"],' +
  '"bpm_est":40到200的整数估计,"summary":"不超过120字的中文风格摘要","confidence":0到1}\n' +
  '规则：\n' +
  '1. 四个词数组**只能逐字取自给定词表**；词表里没有的特质宁可不写，绝不许造词。\n' +
  '2. summary 只描述风格与听感（节奏/配器/情绪/人声质感），**绝不出现**歌手名/艺人名/歌词片段/' +
  '旋律描述，不评论演唱者本人。\n' +
  '3. bpm_est 是估计值；没有把握就按曲风常识给区间中值。\n' +
  '4. 输入不足时 confidence 如实给低分，不许凑。';

function catalogText() {
  const cat = dict.catalog() || {};
  const line = (arr) => (Array.isArray(arr) ? arr.map((x) => (x && x.zh) || '').filter(Boolean).join('、') : '');
  return '词表（四个数组只能从中逐字选词）：\n' +
    '- 氛围：' + line(cat.moods) + '\n' +
    '- 曲风：' + line(cat.genres) + '\n' +
    '- 质感：' + line(cat.style_words) + '\n' +
    '- 人声：' + line(cat.voice);
}

// 机械闸门（v5.7.6）：LLM 输出的每个词必须逐字命中 catalog 对应域，否则丢弃并如实报告。
// 这个函数是词表封闭的**唯一实现位** —— 不信任任何提示词工程。
function closeToCatalog(raw) {
  const cat = dict.catalog() || {};
  const out = { moods: [], genres: [], style_words: [], voice: [] };
  const dropped = [];
  const take = (arr, list, bucket, cap) => {
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const w = String(it || '').trim().slice(0, 20);
      if (!w) continue;
      if (list.some((x) => x && x.zh === w)) {
        if (!out[bucket].includes(w) && out[bucket].length < cap) out[bucket].push(w);
      } else dropped.push(w);
    }
  };
  take(raw && raw.moods, cat.moods || [], 'moods', 3);
  take(raw && raw.genres, cat.genres || [], 'genres', 3);
  take(raw && raw.style_words, cat.style_words || [], 'style_words', 3);
  take(raw && raw.voice, cat.voice || [], 'voice', 3);
  const bpm = Math.round(Number(raw && raw.bpm_est));
  const conf = Number(raw && raw.confidence);
  const summary = String((raw && raw.summary) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    features: out,
    bpm_est: Number.isFinite(bpm) && bpm >= 40 && bpm <= 200 ? bpm : null,
    summary,
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.4,
    dropped: Array.from(new Set(dropped)).slice(0, 12),
  };
}

// LLM 归纳：端点挂=一次就退（完成链不干等两轮）；解析失败重试一次；均失败返回 null 交规则兜底。
// 注意 chatCompletion 的签名是 (messages, timeoutMs)——节点解析在它内部做，这里不传 cfg。
async function synthProfile(facts) {
  const user = '参考曲特征：\n' + String(facts || '').slice(0, 4000) + '\n\n' + catalogText();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await P.chatCompletion([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user + (attempt === 1 ? '\n\n注意：只输出一个 JSON 对象，词必须逐字来自词表。' : '') },
      ], 90000); // 思考模型对大词表 prompt 实测 ~58s：60s 贴脸超时会让真归纳白跑一次掉进规则兜底（实测教训）
      const raw = P.extractJson(content);
      if (raw) return closeToCatalog(raw);
    } catch (e) {
      return null; // 端点不可达：立即走规则兜底（LLM 是增强不是依赖，ADR-MV-9 同款纪律）
    }
  }
  return null;
}

// 规则兜底画像（LLM 不可达时，v5.7.10）：只用机械可证的来源 ——
// work 源=元数据直映射（校验后原样进域）；ASR/检索文本=mapDomains 命中词典。
// 恒 degraded=true，summary 明说没走理解服务 —— 诚实化纪律，不许装忙。
function ruleProfile(facts) {
  const websearch = require('../core/websearch'); // 延迟 require：websearch 也引 dictionary，避免加载环
  const cat = dict.catalog() || {};
  const inList = (w, list) => list.some((x) => x && x.zh === String(w || '').trim());
  const features = {
    moods: (Array.isArray(facts.moods) ? facts.moods : []).filter((w) => inList(w, cat.moods || [])).slice(0, 3),
    genres: (Array.isArray(facts.genres) ? facts.genres : []).filter((w) => inList(w, cat.genres || [])).slice(0, 3),
    style_words: [],
    voice: [],
  };
  const mapped = websearch.mapDomains(String((facts && facts.text) || ''));
  for (const d of ['moods', 'genres', 'style_words', 'voice']) {
    for (const it of mapped.hit[d] || []) {
      const zh = String(it && it.zh || '').slice(0, 20);
      if (zh && features[d].length < 3 && !features[d].includes(zh)) features[d].push(zh);
    }
  }
  const bpm = Math.round(Number(facts && facts.bpm));
  return {
    features,
    bpm_est: Number.isFinite(bpm) && bpm >= 40 && bpm <= 200 ? bpm : null,
    summary: '基于可用元数据与词典直接映射的风格画像（理解服务不可用，已如实降级）',
    confidence: 0.4,
    dropped: mapped.dropped,
  };
}

module.exports = { SYSTEM, catalogText, closeToCatalog, synthProfile, ruleProfile };
