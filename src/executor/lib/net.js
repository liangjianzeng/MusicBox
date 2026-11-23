// 执行器 HTTP 工具：零依赖请求(node:http/https)、multipart 组包、错误分类（2026-11-23）
'use strict';
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const MAX_RESP = 256 * 1024 * 1024; // 响应体上限 256MB（产物 wav 足够）

// err.netCode：'TIMEOUT'（超时）| 'NET'（连不上/连接错误）| 'BAD_URL' | 'NET_TOO_LARGE'
function mkErr(netCode, msg) { const e = new Error(msg); e.netCode = netCode; return e; }

// 通用请求：返回 {status, headers, body(Buffer), json()}；网络层错误 reject（带 netCode）
function request(method, urlStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(mkErr('BAD_URL', 'URL 无效: ' + urlStr)); }
    const lib = u.protocol === 'https:' ? https : http;
    const timeoutMs = opts.timeoutMs || 30000;
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined && headers['content-length'] === undefined) {
      headers['content-length'] = Buffer.byteLength(opts.body);
    }
    const req = lib.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        chunks.push(c); size += c.length;
        if (size > (opts.maxBytes || MAX_RESP)) { req.destroy(); reject(mkErr('NET_TOO_LARGE', '响应体过大: ' + urlStr)); }
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body,
          json() { try { return JSON.parse(body.toString('utf8')); } catch (e) { return null; } },
        });
      });
      res.on('error', (e) => reject(mkErr('NET', e.message)));
    });
    req.on('timeout', () => { req.destroy(); reject(mkErr('TIMEOUT', '请求超时(' + timeoutMs + 'ms): ' + method + ' ' + urlStr)); });
    req.on('error', (e) => { if (!e.netCode) reject(mkErr('NET', e.message)); });
    // 外部中止钩子：opts.abortRef.current() 可提前断开挂起中的 long-poll
    if (opts.abortRef) opts.abortRef.current = () => { try { req.destroy(); } catch (e) { /* ignore */ } };
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

// multipart/form-data 组包：fields={name:str}, files=[{field, filename, data, type}]
function buildMultipart(fields, files) {
  const boundary = '----MusicBoxExec' + crypto.randomBytes(10).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(v) + '\r\n', 'utf8'));
  }
  for (const f of files || []) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + f.field + '"; filename="' + (f.filename || f.field) + '"\r\nContent-Type: ' + (f.type || 'application/octet-stream') + '\r\n\r\n', 'utf8'));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
  return { boundary, body: Buffer.concat(parts) };
}

function isNetErr(e) { return !!(e && e.netCode); }

module.exports = { request, buildMultipart, isNetErr, mkErr };
