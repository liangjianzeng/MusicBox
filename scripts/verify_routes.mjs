// MusicBox 零依赖闸门之一：路由三方对账（server 路由表 ↔ Flutter 调用 ↔ 契约清单）
// 用法：node scripts/verify_routes.mjs [--with-contract]
// 退出码 0=通过；1=发现漂移。设计原则：先拦"路径级"漂移（最便宜、最致命），字段级留给契约清单阶段。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'src/server/api');
const APP_LIB = path.join(ROOT, 'src/app/lib');
const CONTRACT = path.join(ROOT, 'CONTRACTS.md');
const MANIFEST = path.join(ROOT, 'contract/routes.json');

function readRoutes() {
  const routes = [];
  for (const f of fs.readdirSync(API_DIR).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(API_DIR, f), 'utf8');
    const re = /\{\s*m:\s*'([A-Z]+)'\s*,\s*p:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) routes.push({ method: m[1], path: m[2], file: `src/server/api/${f}` });
  }
  return routes;
}

function walkDart(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'build' && e.name !== '.dart_tool') walkDart(p, out); }
    else if (e.name.endsWith('.dart')) out.push(p);
  }
  return out;
}

function readAppCalls() {
  const calls = new Set();
  for (const f of walkDart(APP_LIB)) {
    const src = fs.readFileSync(f, 'utf8');
    const re = /['"`](\/v1\/[A-Za-z0-9_/${}:.\-]+)['"`]/g;
    let m;
    while ((m = re.exec(src))) calls.add(m[1]);
  }
  return [...calls];
}

// 归一化：:id / ${var} / ${foo.bar} 全部压成 :ID，便于比对
const norm = (p) => p.replace(/:[A-Za-z0-9_]+/g, ':ID').replace(/\$\{[^}]*\}/g, ':ID').replace(/\$\{?[A-Za-z0-9_]+\}?/g, ':ID').replace(/\/+$/, '') || '/';

const errors = [];
const warn = [];

const routes = readRoutes();
const srvPaths = new Set(routes.map((r) => norm(r.path)));

// 1) App 调了但 server 没有的路由（最危险：真机 404）
for (const c of readAppCalls()) {
  if (!srvPaths.has(norm(c))) errors.push(`App 调用 server 不存在的路由：${c}`);
}

// 2) server 有但 App 从不调用（信息性：executor/admin 面本就由别方调用）
const NEVER_CALLED_OK = /^\/(executor|admin)\//;
const appCalls = readAppCalls();
const appNorm = new Set(appCalls.map(norm));
const orphan = [];
for (const r of routes) {
  const n = norm(r.path);
  if (NEVER_CALLED_OK.test(r.path)) continue;
  if (!appNorm.has(n)) orphan.push(`${r.method} ${r.path}  (${r.file})`);
}
if (orphan.length) warn.push(`server 有 ${orphan.length} 条用户面路由 App 未调用：\n    ` + orphan.join('\n    '));

// 3) 代码里的「契约 vX.Y」注释必须在 CONTRACTS.md 里存在
const contractText = fs.readFileSync(CONTRACT, 'utf8');
const declaredIds = new Set([...contractText.matchAll(/^#{2,3} (v[0-9]+(?:\.[0-9]+)*)/gm)].map((m) => m[1]));
const dupCheck = [...contractText.matchAll(/^#{2,3} (v[0-9]+(?:\.[0-9]+)*)/gm)].map((m) => m[1]);
const seenDup = new Map();
for (const id of dupCheck) seenDup.set(id, (seenDup.get(id) || 0) + 1);
for (const [id, n] of seenDup) if (n > 1) errors.push(`CONTRACTS.md 契约版本块重复定义：${id}（出现 ${n} 次）—— 唯一真源出现 ID 冲突`);

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['build', '.dart_tool', 'third_party', 'node_modules'].includes(e.name)) walkJs(p, out); }
    else if (/\.(js|mjs|dart)$/.test(e.name)) out.push(p);
  }
  return out;
}
const refs = new Map();
for (const f of [...walkJs(path.join(ROOT, 'src')), ...walkJs(path.join(ROOT, 'test'))]) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/契约 (v[0-9]+\.[0-9]+)/g)) {
    if (!refs.has(m[1])) refs.set(m[1], []);
    refs.get(m[1]).push(path.relative(ROOT, f));
  }
}
for (const [id, files] of refs) {
  if (!declaredIds.has(id)) errors.push(`代码引用了不存在的契约条目「契约 ${id}」（${files.length} 处，如 ${files[0]}）`);
}

// 4) 可选：与机器可读清单 contract/routes.json 双向对账（P1 阶段引入后打开）
if (process.argv.includes('--with-contract')) {
  if (!fs.existsSync(MANIFEST)) { warn.push('contract/routes.json 尚不存在，跳过清单对账（P1 待办）'); }
  else {
    const list = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    // index.js 内置路由（/healthz、/f/*、/admin、/ws）不走 api/*/routes 数组，注册在 handle() 里 —— 对账需计入
    for (const b of ['/healthz', '/f/*', '/admin', '/admin/', '/ws', '/ws?token=<access_token>']) srvPaths.add(norm(b));
    const mPaths = new Set(list.routes.map((r) => norm(r.path)));
    for (const r of routes) if (!mPaths.has(norm(r.path))) errors.push(`server 路由未登记进契约清单：${r.method} ${r.path}`);
    for (const r of list.routes) if (!String(r.path).split('|').some((seg) => srvPaths.has(norm(seg.trim())))) errors.push(`契约清单声明了 server 不存在的路由：${r.method} ${r.path}`);
  }
}

for (const w of warn) console.log('⚠ ' + w);
if (!errors.length) {
  console.log(`✓ 路由三方对账通过：server ${routes.length} 条方法项 / ${srvPaths.size} 条路径；App 调用已核对；契约版本块 ${declaredIds.size} 个无重复`);
  process.exit(0);
}
console.error(`\n✗ 路由/契约对账发现 ${errors.length} 个问题：`);
for (const e of errors) console.error('  ✗ ' + e);
process.exit(1);
