// 载荷路径解析：绝对路径 / var 相对路径 / http(s) URL（下载到工作目录）（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('./net.js');

// 返回本机绝对路径；无法解析返回 null。URL 情形下载到 ctx.workDir。
async function resolveSrc(src, ctx) {
  const s = String(src || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    const name = (s.split('/').pop() || 'file').split('?')[0].replace(/[^\w.\-]/g, '_').slice(0, 64) || 'file';
    const dest = path.join(ctx.workDir, 'dl_' + name);
    try {
      const res = await net.request('GET', s, { timeoutMs: 60000 });
      if (res.status !== 200 || res.body.length === 0) return null;
      fs.writeFileSync(dest, res.body);
      return dest;
    } catch (e) {
      if (ctx && ctx.log) ctx.log('下载素材失败: ' + e.message);
      return null;
    }
  }
  const cfg = (ctx && ctx.cfg) || {};
  const tries = [s];
  if (cfg.varDir && !path.isAbsolute(s)) {
    tries.push(path.join(cfg.varDir, 'out', s), path.join(cfg.varDir, s));
  }
  for (const t of tries) {
    try { if (fs.existsSync(t) && fs.statSync(t).isFile()) return t; } catch (e) { /* ignore */ }
  }
  return null;
}

module.exports = { resolveSrc };
