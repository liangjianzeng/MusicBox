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
  // 抢救 P0-4：绝对路径不得越出可信目录。旧实现 tries=[s] 首选按绝对路径直取，
  // 配合服务端 dsp 的 srcs 校验缺陷 → 登录用户可让执行器读任意文件（并把产物写回源目录）。
  // 可信目录：执行器 var 根（与同机 server 的 MB_VAR_ROOT 对齐）+ 本次任务工作目录 + MB_SRC_ROOTS 显式追加。
  const roots = [cfg.varDir, cfg.execTmp, ctx && ctx.workDir,
    String(process.env.MB_SRC_ROOTS || '').split(path.delimiter)]
    .flatMap(x => Array.isArray(x) ? x : [x])
    .filter(Boolean).map(p => path.resolve(p));
  const insideRoots = (p) => {
    const r = path.resolve(p);
    return roots.some(a => r === a || r.startsWith(a + path.sep));
  };
  const tries = [];
  if (path.isAbsolute(s)) {
    if (!insideRoots(s)) {
      if (ctx && ctx.log) ctx.log('素材路径越出可信目录，已拒绝：' + s.replace(/[/\\]/g, '/').slice(-80));
      return null;
    }
    tries.push(s);
  } else {
    tries.push(s);
    if (cfg.varDir) tries.push(path.join(cfg.varDir, 'out', s), path.join(cfg.varDir, s));
  }
  for (const t of tries) {
    if (!insideRoots(t)) continue;
    try { if (fs.existsSync(t) && fs.statSync(t).isFile()) return t; } catch (e) { /* ignore */ }
  }
  return null;
}

// 公共 /f/<rel> URL（或裸 rel）→ var/out/<rel> 真实文件路径（供 facegate ROOTS 白名单校验）
// facegate 只认 ROOTS（本机 var）下的参考图；传 URL 会被 Path().resolve() 成野路径 → 403。
function resolvePublic(relOrUrl, cfg) {
  const s = String(relOrUrl || '').trim();
  if (!s) return null;
  const m = s.match(/\/f\/(.+)$/); // http(s)://host/f/<rel> 或 /<rel>
  const rel = m ? m[1] : s.replace(/^\/+/, '');
  const varDir = (cfg && (cfg.varDir || cfg.VAR)) || process.env.MB_VAR_ROOT;
  if (varDir) {
    const root = path.resolve(varDir, 'out');
    const p = path.resolve(root, rel);
    if (p === root || p.startsWith(root + path.sep)) { // 拒绝 ../ 逃逸（rel 来自服务端下发的 URL）
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (e) { /* ignore */ }
    }
  }
  return null;
}

module.exports = { resolveSrc, resolvePublic };
