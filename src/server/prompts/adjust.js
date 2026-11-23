// 自然语言微调：LLM 解析参数 delta（可选），不可达/超时走 20+ 条启发式规则兜底（2026-11-23）
'use strict';
const config = require('../config');
const U = require('../core/util');
const intentPrompt = require('./intent');

const SYSTEM_PROMPT = [
  '你是音乐参数微调解析器。把用户的中文调整诉求解析为 JSON 参数增量。',
  '只输出严格 JSON：{"understood":true|false,"mood":"情绪","tags":["英文标签"],"bpm":整数,"sec":整数,"instrumental":true|false,"seed":整数,"clarify":"understood=false 时给一句中文追问"}',
  '规则：只输出用户明确要求改动的字段；无法理解时 understood=false 并在 clarify 用一句中文追问，禁止瞎猜。',
].join('\n');

// —— 启发式规则（顺序匹配、可叠加），合计 20+ 条 ——
// 每条：re 命中 → apply(delta, ctx)，ctx={text, bpm, sec}
const RULES = [
  { re: /欢快|开心|高兴|嗨|活泼|愉悦|快乐|雀跃/, apply: d => { d.mood = '欢快'; d.bpmDelta = (d.bpmDelta || 0) + 20; addTag(d, 'upbeat'); } },
  { re: /悲伤|难过|伤心|忧郁|致郁|emo/i, apply: d => { d.mood = '悲伤'; d.bpmDelta = (d.bpmDelta || 0) - 20; addTag(d, 'sad'); } },
  { re: /安静|平静|放松|舒缓|治愈|轻柔|温柔/, apply: d => { d.mood = '平静'; d.bpmDelta = (d.bpmDelta || 0) - 10; addTag(d, 'soft'); } },
  { re: /燃|热血|劲爆|嗨翻|炸/, apply: d => { d.mood = '热血'; d.bpmDelta = (d.bpmDelta || 0) + 20; addTag(d, 'power'); } },
  { re: /浪漫/, apply: d => { d.mood = '浪漫'; addTag(d, 'romantic'); } },
  { re: /甜蜜|甜一点|甜甜的/, apply: d => { d.mood = '甜蜜'; addTag(d, 'sweet'); } },
  { re: /孤独|寂寞/, apply: d => { d.mood = '孤独'; addTag(d, 'lonely'); } },
  { re: /梦幻|空灵|飘渺/, apply: d => { d.mood = '梦幻'; addTag(d, 'dreamy'); } },
  { re: /慢(一点|些|下来)?|降速|速度.*低/, apply: d => { d.bpmDelta = (d.bpmDelta || 0) - 20; } },
  { re: /快(一点|些)?|加速|节奏.*强|提速/, apply: d => { d.bpmDelta = (d.bpmDelta || 0) + 20; } },
  { re: /纯音乐|无人声|不要人声|伴奏|instrumental/i, apply: d => { d.instrumental = true; } },
  { re: /加人声|要人声|有人声|人声.*多/, apply: d => { d.instrumental = false; } },
  { re: /男声|男生|男歌手/, apply: d => addTag(d, 'male-vocal') },
  { re: /女声|女生|女歌手/, apply: d => addTag(d, 'female-vocal') },
  { re: /长一点|长一些|更长|延长/, apply: d => { d.secDelta = (d.secDelta || 0) + 15; } },
  { re: /短一点|短一些|更短|剪短/, apply: d => { d.secDelta = (d.secDelta || 0) - 15; } },
  { re: /电子|电音|edm|electronic/i, apply: d => addTag(d, 'electronic') },
  { re: /摇滚|rock/i, apply: d => addTag(d, 'rock') },
  { re: /民谣|folk/i, apply: d => addTag(d, 'folk') },
  { re: /古风|中国风|国风|古筝|琵琶/, apply: d => addTag(d, 'guofeng') },
  { re: /爵士|jazz/i, apply: d => addTag(d, 'jazz') },
  { re: /嘻哈|说唱|rap|hip-?hop/i, apply: d => addTag(d, 'hiphop') },
  { re: /钢琴|piano/i, apply: d => addTag(d, 'piano') },
  { re: /吉他|guitar/i, apply: d => addTag(d, 'guitar') },
  { re: /小提琴|violin/i, apply: d => addTag(d, 'violin') },
  { re: /lo-?fi|低保真|慵懒/i, apply: d => addTag(d, 'lofi') },
  { re: /大气|史诗|宏大/, apply: d => { d.mood = d.mood || '史诗'; addTag(d, 'epic'); } },
  { re: /换个种子|换一批|换种子|随机一点/, apply: d => { d.seed = U.randInt(1e9); } },
];

function addTag(d, t) { d.tags = d.tags || []; if (!d.tags.includes(t)) d.tags.push(t); return d; }

// 启发式解析：text + base{bpm,sec} → {understood, delta?|clarify?}
function heuristicParse(text, base) {
  const d = {};
  for (const r of RULES) if (r.re.test(text)) r.apply(d);
  const understood = d.mood || d.tags || d.instrumental !== undefined || d.bpmDelta || d.secDelta || d.seed !== undefined;
  if (!understood) return { understood: false, clarify: '我还没完全理解你的意思，可以告诉我想要的情绪（如欢快、治愈）、节奏快慢、风格（如电子、民谣）或时长增减吗？' };
  const delta = {};
  if (d.mood) delta.mood = d.mood;
  if (d.tags) delta.tags = d.tags;
  if (d.instrumental !== undefined) delta.instrumental = d.instrumental;
  if (d.seed !== undefined) delta.seed = d.seed;
  const baseBpm = (base && Number(base.bpm)) || 100;
  if (d.bpmDelta) delta.bpm = U.clamp(Math.round(baseBpm + d.bpmDelta), 40, 200);
  const baseSec = (base && Number(base.sec)) || config.gen.sec_default;
  if (d.secDelta) delta.sec = U.clamp(Math.round(baseSec + d.secDelta), config.gen.sec_min, config.gen.sec_max);
  return { understood: true, delta };
}

// LLM 输出 → 校验成合法 delta
function llmToDelta(json, base) {
  if (!json || typeof json !== 'object' || json.understood !== true) return null;
  const delta = {};
  if (json.mood) delta.mood = String(json.mood).slice(0, 20);
  if (Array.isArray(json.tags) && json.tags.length) delta.tags = U.toArr(json.tags).slice(0, 6);
  if (Number.isFinite(Number(json.bpm))) delta.bpm = U.clamp(Math.round(Number(json.bpm)), 40, 200);
  if (Number.isFinite(Number(json.sec))) delta.sec = U.clamp(Math.round(Number(json.sec)), config.gen.sec_min, config.gen.sec_max);
  if (typeof json.instrumental === 'boolean') delta.instrumental = json.instrumental;
  if (Number.isFinite(Number(json.seed))) delta.seed = Math.round(Number(json.seed));
  if (!Object.keys(delta).length) return null;
  return { understood: true, delta };
}

// 解析入口：LLM 优先（不可达→规则兜底），永不中断
async function parseAdjust(text, base) {
  const t = String(text || '').trim();
  if (!t) return { understood: false, clarify: '请告诉我你想怎么调整，比如"再欢快一点"或"改成纯音乐"。' };
  try {
    const raw = await intentPrompt.chatCompletionWithRetry([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `当前参数：bpm=${(base && base.bpm) || '未设'}，sec=${(base && base.sec) || '未设'}。调整诉求：${t}` },
    ]);
    const json = intentPrompt.extractJson(raw);
    const viaLlm = llmToDelta(json, base);
    if (viaLlm) return viaLlm;
    if (json && json.understood === false && json.clarify) return { understood: false, clarify: String(json.clarify).slice(0, 120) };
  } catch (e) { /* LLM 不可达 → 兜底 */ }
  return heuristicParse(t, base);
}

// delta 合并到 base 参数（供 works.js 派单）
function mergeDelta(base, delta) {
  const out = { ...base };
  if (delta.mood) out.mood = delta.mood;
  if (delta.tags) out.tags = U.unionArr(base.tags, delta.tags);
  if (delta.bpm) out.bpm = delta.bpm;
  if (delta.sec) out.sec = delta.sec;
  if (delta.instrumental !== undefined) out.instrumental = delta.instrumental;
  if (delta.seed !== undefined) out.seed_base = delta.seed;
  return out;
}

module.exports = { SYSTEM_PROMPT, RULES, heuristicParse, parseAdjust, mergeDelta };
