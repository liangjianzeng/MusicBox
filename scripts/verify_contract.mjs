// 契约机器可读清单对账（抢救计划 P1-3「contract/routes.json + 闸门 --with-contract 双向对账」）
// 用法：node scripts/verify_contract.mjs
// 退出码 0 = 通过；1 = 存在阻断性不一致（闸门据此判红）。
//
// 三件事：
//   ① 结构自检：每条声明必须有 id/method/path/module/auth/contract，id 唯一，方法合法；
//   ② **双向**对账：实现的 routes[]（src/server/api/*.js）与声明的 routes[] 必须互相覆盖，
//      漏声明与声明了却没实现都要红 —— 单向对账（只查实现有没有进契约）是过去契约腐化而闸门全绿的主因之一；
//   ③ 计费额抽检：声明里引用的价格数字若既不在运营配置默认值里、也不是默认值的整数倍组合，列为待人工复核（不判红，
//      因为定价是热配置，硬绑数字会把运营正常调价变成 CI 红灯）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTRACT = path.join(ROOT, 'contract', 'routes.json');
const API_DIR = path.join(ROOT, 'src', 'server', 'api');
const APPCFG = path.join(ROOT, 'src', 'server', 'core', 'appconfig.js');

const fail = [];
const warn = [];
const ok = [];

if (!fs.existsSync(CONTRACT)) {
  console.error('✗ 缺少 contract/routes.json（P1-3 要求机器可读接口清单为结构化真源）');
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
const declared = Array.isArray(j.routes) ? j.routes : [];

// ── ① 结构自检 ───────────────────────────────────────────────────────────
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const seenIds = new Set();
for (const [i, r] of declared.entries()) {
  const at = `routes[${i}] ${r && r.id ? r.id : '(无 id)'}`;
  if (!r || typeof r !== 'object') { fail.push(`${at} 不是对象`); continue; }
  if (!r.id) fail.push(`${at} 缺 id`);
  else if (seenIds.has(r.id)) fail.push(`${at} id 重复`);
  else seenIds.add(r.id);
  if (!METHODS.has(String(r.method))) fail.push(`${at} method 非法：${r.method}`);
  if (typeof r.path !== 'string' || r.path[0] !== '/') fail.push(`${at} path 非法：${r.path}`);
  for (const k of ['module', 'auth', 'contract']) if (!r[k]) fail.push(`${at} 缺 ${k}`);
  if (!r.response && !r.responseShape) warn.push(`${at} 未声明响应形状`);
}
if (declared.length < 100) fail.push(`声明条目仅 ${declared.length} 条（实现约 100+ 条路由项，疑似清单被删空）`);
else ok.push(`结构自检通过：${declared.length} 条声明，id 全唯一`);

// ── ② 双向对账 ───────────────────────────────────────────────────────────
function norm(p) { // 统一参数写法与结尾斜杠，避免 :id / {id} 造成假缺失
  return String(p).replace(/\{[^}/]+\}/g, ':p').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p').replace(/\/+$/, '') || '/';
}
const impl = new Set();
for (const f of fs.readdirSync(API_DIR).filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(API_DIR, f), 'utf8');
  const re = /\{\s*m:\s*'([A-Z]+)'\s*,\s*p:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) impl.add(`${m[1]} ${norm(m[2])}`);
}
// 框架内置端点（不在 api/*.js 的 routes[] 里，但确实对外提供，见 src/server/index.js）
for (const b of ['/healthz', '/healthz.online', '/f/*', '/admin', '/admin/', '/ws', '/ws?token=<access_token>']) {
  const mm = b.split('|')[0];
  impl.add(`GET ${norm(mm)}`);
}
impl.add('GET /healthz.online');
impl.add('GET /ws');
impl.add('GET /f/*');

const decl = new Map();
for (const r of declared) decl.set(`${r.method} ${norm(r.path)}`, r.id);

const undeclared = [...impl].filter((k) => !decl.has(k));
const unimplemented = [...decl.keys()].filter((k) => !impl.has(k));
if (undeclared.length) fail.push('已实现但未进契约（契约不再是真源就是这样开始的）：\n   ' + undeclared.join('\n   '));
if (unimplemented.length) fail.push('契约声明了但实现里没有（App 会按契约调用然后 404）：\n   ' + unimplemented.join('\n   '));
if (!undeclared.length && !unimplemented.length) ok.push(`双向对账通过：实现 ${impl.size} 条方法项 ↔ 契约 ${decl.size} 条，互相覆盖`);

// ── ③ 计费额抽检（不判红）───────────────────────────────────────────────
const CFG2 = path.join(ROOT, 'src', 'server', 'config.js'); // 定价默认值实际住在 config.js 的 envInt 默认位，appconfig 只是转发
const cfgSrc = fs.readFileSync(APPCFG, 'utf8') + '\n' + fs.readFileSync(CFG2, 'utf8');
const seeds = new Set([...cfgSrc.matchAll(/([a-z_]+):\s*(\d{1,4})\b/g)].map((m) => Number(m[2])));
const quoted = new Set();
for (const r of declared) {
  const c = r.credits;
  if (!c) continue;
  const txt = typeof c === 'string' ? c : JSON.stringify(c);
  for (const m of txt.matchAll(/\b(\d{2,5})\b/g)) {
    const n = Number(m[1]);
    if (n <= 1) continue;
    const derivable = [...seeds].some((s) => s === n || (s > 0 && n % s === 0 && n / s <= 12));
    if (!derivable) quoted.add(`${r.id}: ${n}`);
  }
}
if (quoted.size) warn.push('计费声明里的数字在运营默认值里找不到直接来源（可能来自乘法组合或历史价，需人工确认）：\n   ' + [...quoted].join('\n   '));
else ok.push('计费抽检：声明中的价格都能在运营默认值里对上');

// ── 输出 ────────────────────────────────────────────────────────────────
for (const s of ok) console.log('  ✓ ' + s);
for (const s of warn) console.log('  ! ' + s);
if (fail.length) {
  console.error('✗ 契约对账未通过（' + fail.length + ' 项）：');
  for (const s of fail) console.error('   ✗ ' + s);
  process.exit(1);
}
console.log('  ✓ 契约机器可读清单对账通过（contract/routes.json）');
