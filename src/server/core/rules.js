// 审核软门：启动时从 var/config/moderation_words.txt 加载词库（零内置敏感词），文本机检（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const U = require('./util');

// 代码中不内置任何敏感词；占位词完全无害，生产词库由运营填入
const PLACEHOLDER = [
  '# MusicBox 审核词库（一行一词；"re:" 前缀表示正则行）',
  '# 生产词库由运营填入',
  '测试违禁词A',
  '',
].join('\n');

let plainWords = [];  // 普通子串词
let regexRules = [];  // [{source, re}]
let loadedAt = null;

function ensureWordFile() {
  const f = config.moderationWordFile;
  try {
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, PLACEHOLDER, 'utf8');
    }
    return fs.readFileSync(f, 'utf8');
  } catch (e) {
    return PLACEHOLDER;
  }
}

function reload() {
  const text = ensureWordFile();
  const plain = [];
  const re = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^re:/i.test(line)) {
      const src = line.slice(3).trim();
      if (!src) continue;
      try { re.push({ source: src, re: new RegExp(src, 'i') }); } catch (e) { /* 跳过坏正则 */ }
    } else {
      plain.push(line);
    }
  }
  plainWords = plain;
  regexRules = re;
  loadedAt = U.nowIso();
  return { plain: plainWords.length, regex: regexRules.length };
}

// 审核入口：返回 {ok:true} 或 {ok:false, code:'MODERATION_BLOCK', message:中文}
function moderate(text) {
  // 运营总开关（后台可热关闭）：关闭时直放
  try {
    const AC = require('./appconfig');
    if (!AC.moderationEnabled()) return { ok: true };
  } catch (e) { /* 配置中心异常不影响审核 */ }
  if (!plainWords.length && !regexRules.length) reload();
  const s = String(text == null ? '' : text);
  if (!s.trim()) return { ok: true };
  const compact = s.replace(/\s+/g, ''); // 去空白防简单拆分绕过
  for (const w of plainWords) {
    if (!w) continue;
    if (s.toLowerCase().includes(w.toLowerCase()) || compact.includes(w.replace(/\s+/g, '').toLowerCase())) {
      return { ok: false, code: 'MODERATION_BLOCK', message: '内容包含不适宜的信息，请调整后重试' };
    }
  }
  for (const r of regexRules) {
    if (r.re.test(s) || r.re.test(compact)) {
      return { ok: false, code: 'MODERATION_BLOCK', message: '内容包含不适宜的信息，请调整后重试' };
    }
  }
  return { ok: true };
}

// 多字段合并审核；命中抛 ApiError
function moderateFields(fields) {
  const joined = [].concat(fields || []).filter(Boolean).join('\n');
  const r = moderate(joined);
  if (!r.ok) throw new U.ApiError('MODERATION_BLOCK', r.message);
  return true;
}

reload();

module.exports = { reload, moderate, moderateFields, stats: () => ({ plain: plainWords.length, regex: regexRules.length, loadedAt }) };
