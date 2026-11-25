// 审核软门：从 var/config/moderation_words.txt 加载并按文件签名热更新（零内置敏感词）
'use strict';
const fs = require('node:fs');
const config = require('../config');
const U = require('./util');

let plainWords = [];
let regexRules = [];
let loadedAt = null;
let signature = null;
let lastError = null;

function parseWords(text) {
  const plain = [];
  const re = [];
  for (let line of String(text || '').split(/\r?\n/)) {
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
  return { plain, re };
}

function refresh() {
  let st = null;
  let text = '';
  try { st = fs.statSync(config.moderationWordFile); text = fs.readFileSync(config.moderationWordFile, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT' && !loadedAt) return { ok: true, not_configured: true };
    lastError = String((e && e.message) || e).slice(0, 160);
    return { ok: false, stale: !!loadedAt, error: lastError };
  }
  const next = st ? st.size + ':' + st.mtimeMs : null;
  if (next === signature) { lastError = null; return { ok: true }; }
  const parsed = parseWords(text);
  plainWords = parsed.plain;
  regexRules = parsed.re;
  signature = next;
  loadedAt = U.nowIso();
  lastError = null;
  return { ok: true };
}

function reload() {
  signature = null;
  refresh();
  return stats();
}

// 审核入口：返回 {ok:true} 或 {ok:false, code:'MODERATION_BLOCK', message:中文}
function moderate(text) {
  try {
    const AC = require('./appconfig');
    if (!AC.moderationEnabled()) return { ok: true };
  } catch (e) { /* 配置中心异常不影响审核 */ }
  const state = refresh();
  if (!state.ok) throw new U.ApiError('MODERATION_UNAVAILABLE', '审核词库暂时不可读，为安全起见已暂停内容处理', 503);
  const s = String(text == null ? '' : text);
  if (!s.trim()) return { ok: true };
  const compact = s.replace(/\s+/g, '');
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

function moderateFields(fields) {
  const joined = [].concat(fields || []).filter(Boolean).join('\n');
  const r = moderate(joined);
  if (!r.ok) throw new U.ApiError('MODERATION_BLOCK', r.message);
  return true;
}

function stats() {
  const state = refresh();
  return { plain: plainWords.length, regex: regexRules.length, loadedAt, configured: signature !== null, not_configured: signature === null,
    available: state.ok, stale: !!state.stale, error: state.error || lastError || null };
}

refresh();
module.exports = { reload, moderate, moderateFields, stats };
