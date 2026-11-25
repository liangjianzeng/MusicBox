// MV 语言纪律单一禁词表 + sanitize()（ADR-MV-8 / mv-plan §5.4：剧场 langlint 移植，三层净化之首）（2026-11-24）
// 纪律：一切 MV 用户面字符串（project title/brief、script desc、WSS note、错误文案）出话前过 sanitize()；
//       App 端二次幂等过滤；引擎/模型型号名绝不上用户面。ASCII 词带词边界（防 "mistake 含 take" 假阳），CJK 子串直替。
'use strict';

// —— 技术黑话 → 人话（mv-plan §5.4 对照表）——
const TERMS = [
  { re: /\bseed\b/gi, to: '复刻编号' },
  { re: /\bprompt\b/gi, to: '导演阐述' },
  { re: /\bi2v\b/gi, to: '开机拍摄' },
  { re: /\bt2i\b/gi, to: '画面生成' },
  { re: /\blipsync\b/gi, to: '口型校准' },
  { re: /\bfacegate\b/gi, to: '人像校验' },
  { re: /\breroll\b/gi, to: '重出' },
  { re: /\bbroll\b/gi, to: '空镜' },
  { re: /\bstoryboard\b/gi, to: '分镜图' },
  { re: /\bzoompan\b/gi, to: '运镜预览' },
  { re: /抽帧/g, to: '选镜' },
  { re: /\blora\b/gi, to: '签名档' },
  // take 仅作独立英文单词时替换（重拍历史语境），中文串不受影响
  { re: /\btake(s)?\b/gi, to: (m) => (m.toLowerCase().endsWith('s') ? '重拍历史' : '重拍记录') },
];

// —— 模型/引擎型号名正则 → 「自部署·高品质档」（契约 §0：任何引擎型号名不得出现在面向用户的字符串）——
const MODEL_RE = /minimax[-\s]?h3(?:[-\s]?(?:image|fl2va|ref2va))?(?:\s*community)?|echo-?mimic(?:v3)?(?:-flash)?|musetalk|sense-?voice|ace-?step(?:\s*1\.5)?|comfyui|vllm|insightface|inswapper|arcface|syncnet|gguf|nvfp4|int8_?convrot|int8|mxfp8|turbo\s*4(?:\s*step)?|qwen[\w.\-]*|\bh3[-_]?(?:image|fl2va|ref2va)\b|\bh3\b/gi;
const MODEL_TO = '自部署·高品质档';

// —— 政策/暴恐词表（core/mv_aireview 机检用；类别词，非用户面文案）——
const POLICY_WORDS = [
  '血腥暴力', '枪支弹药', '恐怖袭击', '制毒贩毒', '自残自杀教程',
  '赌博网站', '诈骗教程', '儿童色情', '极端主义', '人肉搜索教程',
];

// 净化入口：任何 MV 用户面字符串过此（幂等：已替换文本再进不出变化）
function sanitize(text) {
  let s = String(text == null ? '' : text);
  if (!s) return s;
  s = s.replace(MODEL_RE, MODEL_TO);
  for (const t of TERMS) {
    s = s.replace(t.re, typeof t.to === 'function' ? t.to : t.to);
  }
  return s;
}

// 批量净化对象里的全部字符串值（深拷贝语义，用于 WSS payload / script_json）
function sanitizeDeep(obj, depth) {
  depth = depth || 0;
  if (depth > 6) return obj;
  if (typeof obj === 'string') return sanitize(obj);
  if (Array.isArray(obj)) return obj.map((x) => sanitizeDeep(x, depth + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeDeep(v, depth + 1);
    return out;
  }
  return obj;
}

// 命中政策词检测：返回命中词数组（aireview 用；只报有无与词类，不外漏原文片段）
function policyHit(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return [];
  const compact = s.replace(/\s+/g, '');
  return POLICY_WORDS.filter((w) => s.includes(w) || compact.includes(w.replace(/\s+/g, '')));
}

module.exports = { TERMS, MODEL_RE, POLICY_WORDS, sanitize, sanitizeDeep, policyHit };
