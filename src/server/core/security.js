// 启动期安全审计 + 口令散列（2026-11-26 抢救 P0-3：默认值 fail-closed）。
// 纪律：① 明文凭据绝不进日志/响应；② MB_ENV=prod 下存在不安全默认值即拒绝启动；③ 零 npm 依赖（只用 node:crypto）。
'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const U = require('./util');

// —— 口令散列：scrypt 加盐（替代历史无盐 sha256；旧行登录成功后自动升级）——
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt}$${hash}`;
}

function isLegacyHash(stored) { return !String(stored || '').startsWith('scrypt$'); }

function verifyPassword(pw, stored) {
  const s = String(stored || '');
  if (!s) return false;
  if (isLegacyHash(s)) return U.timingSafeEq(U.sha256hex(pw), s); // 迁移期兼容旧行
  const parts = s.split('$');
  if (parts.length !== 6) return false;
  const [, N, r, p, salt, hash] = parts;
  const keylen = Buffer.from(hash, 'hex').length;
  let got;
  try {
    got = crypto.scryptSync(String(pw), salt, keylen, { N: Number(N), r: Number(r), p: Number(p) });
  } catch (e) { return false; }
  const a = got, b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// —— 不安全默认值清单（只报键名与语义，绝不回显任何凭据值）——
function audit() {
  const issues = [];
  const has = (n) => process.env[n] !== undefined && process.env[n] !== '';
  if (config.DEV_OTP) issues.push({ key: 'MB_DEV_OTP', detail: '固定验证码启用，任意手机号可直接拿到正式用户令牌' });
  if (!has('MB_EXECUTOR_TOKEN')) issues.push({ key: 'MB_EXECUTOR_TOKEN', detail: '执行器令牌仍是仓库内公开默认值，可领单/伪造 complete-fail' });
  if (!has('MB_ADMIN_USERNAME') || !has('MB_ADMIN_PASSWORD')) issues.push({ key: 'MB_ADMIN_PASSWORD', detail: '运营后台仍用内置默认账号口令（可改积分/定价/模型 endpoint）' });
  if (!has('MB_PUBLIC_BASE_URL')) issues.push({ key: 'MB_PUBLIC_BASE_URL', detail: '产物绝对 URL 用默认 127.0.0.1，真机播放会全挂' });
  if (config.mv && config.mv.enabled && !has('MB_WORKER_TOKEN')) issues.push({ key: 'MB_WORKER_TOKEN', detail: 'worker（ASR/口型/换脸/对齐）无内部令牌，仅靠回环监听兜底' });
  return issues;
}

// —— 启动闸门：prod 拒绝启动，dev 打脱敏警告 ——
function assertBootable(out) {
  const log = out || console;
  const issues = audit();
  if (!issues.length) return { ok: true, issues: [] };
  const keys = issues.map(i => i.key).join('、');
  if (config.env === 'prod') {
    log.error(`[security] 拒绝启动：MB_ENV=prod 下存在 ${issues.length} 项不安全默认值 → ${keys}。`
      + `逐项显式配置后重试（明细见 docs/runbook-dev.md「上线前必做」）。`);
    for (const i of issues) log.error(`[security]   - ${i.key}: ${i.detail}`);
    return { ok: false, issues };
  }
  log.warn(`[security] 开发模式放行 ${issues.length} 项不安全默认值：${keys}`
    + `（生产请设 MB_ENV=prod 并显式配置；这些默认值在 prod 下会直接拒绝启动）`);
  return { ok: true, issues };
}

module.exports = { hashPassword, verifyPassword, isLegacyHash, audit, assertBootable, SCRYPT };
