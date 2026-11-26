// 通用工具：随机ID/哈希/时间/JSON/ApiError/游标/multipart解析/限流（2026-11-23）
'use strict';
const crypto = require('node:crypto');

const CODE_STATUS = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, RATE_LIMITED: 429,
  INTERNAL: 500, BAD_REQUEST: 400, CREDITS_NOT_ENOUGH: 400, MODERATION_BLOCK: 400,
  SERVICE_BUSY: 503,   // 数据库并发写冲突（可重试）：不能混进 INTERNAL 500，客户端据此决定重试与否
};

// 业务错误：code 对应契约错误码，message 面向用户（全中文）
class ApiError extends Error {
  constructor(code, message, httpStatus) {
    super(message || '请求无效');
    this.name = 'ApiError';
    this.code = code || 'BAD_REQUEST';
    this.httpStatus = httpStatus || CODE_STATUS[this.code] || 400;
  }
}

function uid(prefix) { return (prefix || '') + crypto.randomBytes(10).toString('hex'); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hash12(s) { return sha256hex(s).slice(0, 12); }
function randInt(max) { return crypto.randomInt(0, max); } // [0, max)
function hmacSign(secret, body) { return crypto.createHmac('sha256', secret).update(body).digest('base64url'); }
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function nowIso() { return new Date().toISOString(); }
function isoAfterMs(ms) { return new Date(Date.now() + ms).toISOString(); }
function isPast(iso) { return !iso || Date.parse(iso) <= Date.now(); }
function todayLocal() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function outMonthDir() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1); }

function clamp(n, min, max) { n = Number(n); if (!Number.isFinite(n)) return min; return Math.min(max, Math.max(min, n)); }
function jstr(v) { try { return JSON.stringify(v === undefined ? null : v); } catch (e) { return 'null'; } }
function jparse(s, dflt) {
  const d = dflt === undefined ? null : dflt;
  if (s === null || s === undefined || s === '') return d;
  try { return JSON.parse(s); } catch (e) { return d; }
}
function maskPhone(p) { p = String(p || ''); return p.length === 11 ? p.slice(0, 3) + '****' + p.slice(7) : p.replace(/.(?=.{2})/g, '*'); }

// 字符串/数组 → 去重前数组（支持 "a,b" 与 ["a","b"] 两种入参）
function toArr(v) {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  const text = String(v).trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(x => String(x).trim()).filter(Boolean);
    } catch (e) { /* 非 JSON 数组时继续按分隔字符串解析 */ }
  }
  return text.split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean);
}
function unionArr(a, b, cap) {
  const out = [];
  for (const x of [].concat(a || [], b || [])) {
    const s = String(x).trim();
    if (s && out.indexOf(s) === -1) out.push(s);
    if (out.length >= (cap || 12)) break;
  }
  return out;
}

function encodeCursor(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function decodeCursor(s) { if (!s) return null; try { return JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); } catch (e) { return null; } }

// 用户面纪律：错误信息里不得出现引擎型号名，统一替换为"后台服务"
function sanitizeEngineNames(msg) {
  return String(msg || '').replace(/ace-?step|qwen[\w.\-]*|sense-?voice|vllm|deepseek|whisper|ffmpeg|cuda|gpu/gi, '后台服务');
}

// multipart/form-data 解析（零依赖，返回文本字段与文件部件）
function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) throw new ApiError('BAD_REQUEST', '请求缺少 multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}; const files = [];
  let pos = body.indexOf(boundary);
  if (pos === -1) throw new ApiError('BAD_REQUEST', 'multipart 数据无法解析');
  pos += boundary.length;
  for (;;) {
    if (body.slice(pos, pos + 2).toString('latin1') === '--') break; // 结束边界
    if (body[pos] === 13 && body[pos + 1] === 10) pos += 2;
    const next = body.indexOf(boundary, pos);
    if (next === -1) break;
    const part = body.slice(pos, next);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = part.slice(0, headEnd).toString('utf8');
      let data = part.slice(headEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 13 && data[data.length - 1] === 10) data = data.slice(0, data.length - 2);
      const nameM = /name="([^"]*)"/i.exec(head);
      const fileM = /filename="([^"]*)"/i.exec(head);
      const name = nameM ? nameM[1] : '';
      if (fileM) files.push({ field: name, filename: (fileM[1] || 'file').replace(/[\\/\x00-\x1f]/g, '_'), data });
      else fields[name] = data.toString('utf8');
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

// 落盘到 var/out/<yyyy-mm>/，返回相对路径（DB 存 rel，对外拼 publicBaseUrl）
function saveToOut(outRoot, data, origName) {
  const fs = require('node:fs');
  const path = require('node:path');
  const month = outMonthDir();
  const dir = path.join(outRoot, month);
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(String(origName || '')).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin').slice(0, 10);
  const name = uid('f_') + ext;
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, data);
  return { rel: month + '/' + name, abs, bytes: data.length, sha256: sha256hex(data) };
}

// 简易内存限流（滑动窗口），进程级即可
const rateBuckets = new Map();
function allowRate(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { rateBuckets.set(key, arr); return false; }
  arr.push(now); rateBuckets.set(key, arr);
  return true;
}

module.exports = {
  ApiError, uid, sha256hex, hash12, randInt, hmacSign, timingSafeEq,
  nowIso, isoAfterMs, isPast, todayLocal, outMonthDir, clamp, jstr, jparse, maskPhone,
  toArr, unionArr, encodeCursor, decodeCursor, sanitizeEngineNames,
  parseMultipart, saveToOut, allowRate,
};
