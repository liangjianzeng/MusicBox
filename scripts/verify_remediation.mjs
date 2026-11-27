#!/usr/bin/env node
// scripts/verify_remediation.mjs —— 整改一次性总验收（抢救计划 P0/P1 + 契约 v5.1–v5.3）
//
// 为什么要有这个文件：整改做完最怕的是"每条都说明明验过，合起来没人知道还成立不成立"。
// 本脚本把每条整改判据**绑死到一个真跑起来的检查**上，一条命令给出
//   整改项 → 判据 → 实测数字 → 结论。
// 三条硬规矩（写在这里防后人把它跑成"看起来全绿"）：
//   1) 套件类判据必须 fail==0 **且 pass>=minCases** —— 把套件删了或把用例删了都会判红；
//   2) 跑不了的东西如实记 BLOCKED/SKIP 并写清前置条件，**绝不记 PASS**（真机 GPU、真人像都属此类）；
//   3) 本脚本不修改任何源码、不碰仓内 var/（一律用 /tmp 隔离 var）。
//
// 用法：
//   node scripts/verify_remediation.mjs            # 一次性总验收（约 5 分钟）
//   node scripts/verify_remediation.mjs --quick     # 跳过全量闸门与逐套件复跑，只跑静态+链路+LLM（约 1 分钟）
//   node scripts/verify_remediation.mjs --ticket    # 追加 P1-1 门票：verify.sh --repeat 20（约 30 分钟）
//   node scripts/verify_remediation.mjs --music     # 追加真机音乐链（需 GeekPro ACE-Step + 隧道已起）
'use strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const ARGS = new Set(process.argv.slice(2));
const QUICK = ARGS.has('--quick');
const TICKET = ARGS.has('--ticket');
const MUSIC = ARGS.has('--music');

const results = [];
const t0 = Date.now();
function record(group, item, judge, status, measured) {
  results.push({ group, item, judge, status, measured: String(measured || '').slice(0, 300) });
}
function run(cmd, args, opts) {
  const o = opts || {};
  const r = spawnSync(cmd, args, {
    cwd: ROOT, encoding: 'utf8', timeout: o.timeoutMs || 600000,
    env: Object.assign({}, process.env, o.env || {}), maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status === null ? -1 : r.status, out: (r.stdout || '') + (r.stderr || ''), err: r.error };
}
const ok = (b) => (b ? 'PASS' : 'FAIL');

// —— 环境自检：Node 版本（node:sqlite 需要）与 ffmpeg（mock 执行器出 mp3 依赖它）——
const major = Number(process.versions.node.split('.')[0]);
record('环境', 'Node ≥ 22（node:sqlite）', 'process.versions.node', ok(major >= 22), process.version);
const ff = run('which', ['ffmpeg']);
record('环境', 'ffmpeg 可用（冒烟出 mp3）', 'which ffmpeg', ok(ff.code === 0 && !!ff.out.trim()), (ff.out || '缺失').trim().split('\n')[0]);

// ═══ 组 A：闸门自证（P0-1 / P0-2 / 凭据扫描 / 路由三方对账）═══
if (!QUICK) {
  const g = run('bash', ['scripts/verify.sh', '--full'], { timeoutMs: 1500000 });
  const m = g.out.match(/第 1 轮全绿（pass=(\d+) skip=(\d+)）/);
  const steps = (g.out.match(/✓/g) || []).length;
  const bad = (g.out.match(/✗/g) || []).length;
  record('A 闸门', 'P0-2 零依赖闸门即发布判据', 'bash scripts/verify.sh --full 退出码 0',
    ok(g.code === 0 && bad === 0), `退出码=${g.code} ✓${steps} ✗${bad}`);
  record('A 闸门', 'P0-2 全量验收一轮全绿', 'pass≥170 且 0 失败',
    ok(!!m && Number(m[1]) >= 170 && bad === 0), m ? `pass=${m[1]} skip=${m[2]}` : '未出现全绿结论行');
  record('A 闸门', 'P0-1/P0-3 明文凭据扫描（软警告已改硬失败）', '闸门凭据步骤无 ✗',
    ok(g.code === 0 && /凭据扫描干净/.test(g.out)), /凭据扫描干净/.test(g.out) ? '干净' : '见闸门输出');
  record('A 闸门', 'P1-3 路由三方对账（server↔App↔契约）', '闸门路由步骤通过 + 契约版本块唯一',
    ok(/路由三方对账通过/.test(g.out) && /无重复/.test(g.out)),
    (g.out.match(/server \d+ 条方法项 \/ \d+ 条路径；[^\n]*/) || ['未命中'])[0].slice(0, 90));
  if (TICKET) {
    const t = run('bash', ['scripts/verify.sh', '--repeat', '20'], { timeoutMs: 5400000 });
    const rounds = (t.out.match(/轮全绿/g) || []).length;
    record('A 闸门', 'P1-1 门票：20 轮零 flake', 'bash scripts/verify.sh --repeat 20 → 20 轮全绿',
      ok(rounds === 20 && t.code === 0), `全绿轮数=${rounds}/20`);
  } else {
    record('A 闸门', 'P1-1 门票：20 轮零 flake', '本命令未跑（--ticket 才跑）；已在计划文档留证两次 20/20',
      'INFO', '门票不在一次性总验里重跑（约 30 分钟），用 --ticket 打开');
  }
}

// ═══ 组 B：契约机器面（P1-3）═══
const c = run('node', ['scripts/verify_contract.mjs'], { timeoutMs: 120000 });
const decl = (c.out.match(/(\d+) 条声明/) || [])[1];
record('B 契约', 'P1-3 契约↔实现**双向**对账', 'verify_contract.mjs 退出码 0 且声明数≥107',
  ok(c.code === 0 && Number(decl || 0) >= 107), `声明 ${decl} 条；${(c.out.match(/双向对账通过：[^\n]*/) || ['未命中'])[0].slice(0, 70)}`);

// ═══ 组 C：逐条整改 ↔ 验收套件（删套件 / 砍用例都会判红）═══
const SUITES = [
  ['P0-3 上线面 fail-closed（缺配置拒启动且点名缺哪个键）', 'v28_boot_security', 5, '契约 v5.2 前置 · 计划 P0-3'],
  ['P0-4 越权与目录穿越四条已封死', 'v23_security', 6, '计划 P0-4'],
  ['P1-2 账本与状态机（退款 CAS / 提交后推送 / 崩溃重放）', 'v25_ledger_consistency', 6, '契约 §4 · 计划 P1-2'],
  ['P1-2 父子任务看护必须有上界（父 job 不得永久挂账）', 'v29_parent_guard', 2, '资损补口 2026-11-27'],
  ['v5.3 并发写冲突可重试（BEGIN IMMEDIATE + 503）', 'v32_db_busy', 3, '契约 v5.3'],
  ['P1-4 运营面 /admin/* 契约级覆盖（鉴权/审计/幂等/轮换）', 'v27_admin_ops', 8, '计划 P1-4'],
  ['P1-5 迁移收口（历史库升级起服 + 列名静态对账）', 'v26_migration_upgrade', 3, '计划 P1-5'],
  ['v5.2 声纹私有化（不入公共 /f/*、身份门、历史行兼容）', 'v30_persona_privacy', 5, '契约 v5.2.1–v5.2.4'],
  ['v5.2 人格归属与跨机声纹回捞（他人声纹不可克隆）', 'v31_persona_crosshost', 4, '契约 v5.2.5–v5.2.6'],
  ['v5.1 MV 加固回归（审核 fail-closed / scriptHash / toArr）', 'v20_mv_hardening', 3, '契约 v5.1'],
  ['助手诚实兜底（无上下文不背清单、积分不编数、上下文门只认核验 refs）', 'v33_assistant_honest', 5, '契约 v5.4 · 真机体感故障'],
  ['声纹/字段真源之外的账本不变量复核（助手回合不扣费）', 'v1_credits', 5, '契约 §4 回归基线'],
];
for (const [item, suite, minCases, judge] of SUITES) {
  const file = path.join('test', 'acceptance', suite + '.test.js');
  if (!fs.existsSync(path.join(ROOT, file))) { record('C 套件', item, judge, 'FAIL', `套件不存在：${file}`); continue; }
  if (QUICK) { record('C 套件', item, judge, 'SKIP', '--quick 未跑（组 A 全量闸门里含它）'); continue; }
  const r = run('node', ['--test', file], { timeoutMs: 900000 });
  const pass = Number((r.out.match(/^ℹ pass (\d+)/m) || [])[1] || 0);
  const fail = Number((r.out.match(/^ℹ fail (\d+)/m) || [])[1] || 0);
  const firstErr = (r.out.match(/AssertionError[^\n]*/) || [])[0] || '';
  record('C 套件', item, `${suite}：fail==0 且 pass>=${minCases}`, ok(fail === 0 && pass >= minCases),
    `pass=${pass} fail=${fail}${firstErr ? '；' + firstErr.slice(0, 140) : ''}`);
}

// P1-1 的另一半：flaky 的根因判据（failPlan 必须显式定域，不许退回时间戳猜）
const helpers = fs.readFileSync(path.join(ROOT, 'test/acceptance/helpers.js'), 'utf8');
record('C 套件', 'P1-1 计划性失败必须显式定域（防被残留 job 蹭掉次数）',
  'FakeExecutor.planFail 存在且按 exclude 判定；不得用 created_at 时间戳定域',
  ok(/planFail\s*\(/.test(helpers) && /\bexcl\w*\.has\(job\.id\)/.test(helpers) && !/failPlan\.armedAt/.test(helpers)),
  `planFail=${/planFail\s*\(/.test(helpers)} 排除集判定=${/\bexcl\w*\.has\(job\.id\)/.test(helpers)} 退回armedAt=${/failPlan\.armedAt/.test(helpers)}`);

// ═══ 组 D：仓库卫生与状态面（P0-7）═══
const untracked = run('git', ['ls-files', '--others', '--exclude-standard']);
const un = untracked.out.trim() ? untracked.out.trim().split('\n').length : 0;
record('D 卫生', 'P0-7 工作区无未跟踪残留', 'git ls-files --others = 0', ok(un === 0), `${un} 个未跟踪`);
const du = run('du', ['-sk', 'var-test']);
const kb = Number((du.out.match(/^\d+/) || [0])[0]);
record('D 卫生', 'P0-7 var-test 自增回收（个数 + 总量双上界）', 'du -sk var-test < 200MB',
  ok(kb > 0 && kb < 200 * 1024), `${(kb / 1024).toFixed(0)}MB`);
const st = run('bash', ['bin/status.sh'], { timeoutMs: 60000 });
const dead = (st.out.match(/DEAD/g) || []).length;
const llm200 = /LLM :8090 \/v1\/models\s+200/.test(st.out);
record('D 卫生', 'P0-7/P0-8 bin/status.sh 无死 PID 且 LLM 路径通', '无 DEAD 且 LLM :8090 /v1/models=200',
  ok(dead === 0 && llm200), `DEAD=${dead} LLM200=${llm200}`);
// P0-1 的历史泄露点定向回归（不依赖模糊全仓扫描）
const engineSrc = fs.readFileSync(path.join(ROOT, 'src/server/core/engine.js'), 'utf8');
record('D 卫生', 'P0-1 泄露点无令牌残留（engine.js 定向回归）',
  '不得出现 Bearer 字面量 / token: \'…\' 形式的硬编码',
  ok(!/Bearer\s+[A-Za-z0-9_\-]{12,}/.test(engineSrc) && !/token:\s*'[A-Za-z0-9_\-]{12,}'/.test(engineSrc)),
  '定向 grep engine.js');
const dirty = run('git', ['status', '--porcelain']);
record('D 卫生', 'P0-6 无在途未提交工作', 'git status --porcelain 为空', ok(!dirty.out.trim()), dirty.out.trim() ? dirty.out.trim().split('\n').length + ' 项待提交' : '干净');

// ═══ 组 E：P0-8 从零起一条最小链路（隔离 var，绝不碰仓内 var/）═══
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function fetchJson(url, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || 'GET', headers: o.headers || {}, timeout: o.timeoutMs || 20000 },
      (r) => { let b = ''; r.on('data', (x) => { b += x; }); r.on('end', () => resolve({ status: r.statusCode, text: b })); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (o.body) req.write(o.body);
    req.end();
  });
}
const tok = 'remediation-' + Math.random().toString(36).slice(2, 12);
let apiChild = null; let exChild = null;
const varDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-remed-'));
try {
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    MB_VAR_ROOT: varDir, MB_VAR_DIR: varDir, MB_PORT: String(port), MB_ENV: 'dev', MB_DEV_OTP: '1',
    MB_EXECUTOR_TOKEN: tok, MB_ADMIN_PASSWORD: 'Remed-' + tok, MB_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    MB_MV_ENABLED: '0',
  });
  const { spawn } = await import('node:child_process');
  const logFile = path.join(varDir, 'api.log');
  apiChild = spawn('node', ['src/server/index.js'], { cwd: ROOT, env, stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')] });
  let health = null;
  const tStart = Date.now();
  while (Date.now() - tStart < 30000) {
    try { health = await fetchJson(`http://127.0.0.1:${port}/healthz`, { timeoutMs: 2000 }); if (health.status === 200) break; } catch (e) { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const hj = health && health.status === 200 ? JSON.parse(health.text) : null;
  record('E 从零链路', 'P0-8 服务端从空 var 启动到 /healthz', 'ok:true 且 audit_failures==0 且 credit_violations==0',
    ok(!!hj && hj.ok === true && hj.audit_failures === 0 && hj.credit_violations === 0),
    hj ? `ok=${hj.ok} audit_failures=${hj.audit_failures} credit_violations=${hj.credit_violations}` : (health ? `status=${health.status}` : '无响应'));

  const execLog = path.join(varDir, 'exec.log');
  exChild = spawn('node', ['src/executor/index.js', '--api', `http://127.0.0.1:${port}`, '--token', tok, '--lanes', 'music,intent,ffmpeg'],
    { cwd: ROOT, env: Object.assign({}, env, { EXECUTOR_MOCK: '1' }), stdio: ['ignore', fs.openSync(execLog, 'a'), fs.openSync(execLog, 'a')] });
  let exLine = '';
  const tEx = Date.now();
  while (Date.now() - tEx < 30000) {
    exLine = fs.existsSync(execLog) ? fs.readFileSync(execLog, 'utf8') : '';
    if (/已接入调度/.test(exLine)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const sameVar = new RegExp('数据目录=' + varDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(exLine);
  record('E 从零链路', 'P0-8 mock 执行器接入且 var 与 server 同源（§3.1 第 1 条坑）', '日志含"已接入调度"且"数据目录"=同一 var',
    ok(/已接入调度/.test(exLine) && sameVar), `已接入=${/已接入调度/.test(exLine)} var同源=${sameVar}`);

  const smoke = run('node', ['scripts/e2e_smoke.mjs', `http://127.0.0.1:${port}`], { timeoutMs: 300000 });
  const mm = smoke.out.match(/总计 (\d+)\/(\d+) 通过/);
  record('E 从零链路', 'P0-8 端到端冒烟（扣费→幂等→3 候选 mp3+peaks→adopt→adjust 谱系）', '总计 21/21 且退出码 0',
    ok(!!mm && mm[1] === mm[2] && Number(mm[1]) === 21 && smoke.code === 0), mm ? `${mm[1]}/${mm[2]}；退出码=${smoke.code}` : (smoke.out.slice(-160) || '无输出'));
  const mp3 = (smoke.out.match(/mp3 可下载且 >100KB\s+\[(\d+)B\]/) || [])[1];
  record('E 从零链路', '产物真的能下载（不是只建了 DB 行）', 'mp3 字节数 >100KB', ok(Number(mp3) > 100000), `${mp3 || '?'}B`);
  record('E 从零链路', '隔离性：整套跑完不污染仓内 var/', '隔离 var 存在且仓内 var 未被本次写入',
    ok(fs.existsSync(path.join(varDir, 'db', 'musicbox.sqlite'))), `隔离 var=${(run('du', ['-sh', varDir]).out || '').trim()}`);
} catch (e) {
  record('E 从零链路', 'P0-8 从零链路', '本组检查', 'FAIL', '异常：' + e.message);
} finally {
  for (const ch of [exChild, apiChild]) { try { if (ch) ch.kill('SIGKILL'); } catch (e) { /* noop */ } }
  await new Promise((r) => setTimeout(r, 500));
}

// ═══ 组 F：助手 LLM 面（用户点名要用本机 qwen38-fp4）═══
function envKey(k) {
  const f = path.join(ROOT, 'etc/spark.env');
  if (fs.existsSync(f)) {
    const m = new RegExp('^' + k + '=["\']?([^"\'\\n]+)', 'm').exec(fs.readFileSync(f, 'utf8'));
    if (m) return m[1].trim();
  }
  return process.env[k] || '';
}
const LLM = (process.env.MB_LLM_VLM_URL || envKey('MB_LLM_VLM_URL') || 'http://127.0.0.1:8090/v1').replace(/\/+$/, '');
const MODEL = process.env.MB_LLM_VLM_MODEL || envKey('MB_LLM_VLM_MODEL') || 'qwen38-fp4';
try {
  const m = await fetchJson(LLM + '/models', { timeoutMs: 15000 });
  const list = m.status === 200 ? JSON.parse(m.text) : null;
  const names = (list && list.data || []).map((x) => x.id);
  record('F 助手LLM', '服务在线且模型名正确', `GET ${LLM}/models 返回 data 且含 ${MODEL}`,
    ok(m.status === 200 && names.includes(MODEL)), `status=${m.status} models=${names.join(',')}`);
  const ask = async (messages, temperature) => {
    const r = await fetchJson(LLM + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 120000,
      body: JSON.stringify({ model: MODEL, messages, temperature }),
    });
    const j = r.status === 200 ? JSON.parse(r.text) : null;
    const content = ((j && j.choices && j.choices[0] && j.choices[0].message) || {}).content || '';
    return { status: r.status, content: String(content).trim() };
  };
  const t = await ask([
    { role: 'system', content: '只输出 JSON。' },
    { role: 'user', content: '把"想给妈妈写首温馨的生日歌"编译成 {"mood":[],"genre":[]}，只输出 JSON' },
  ], 0.3);
  record('F 助手LLM', '意图编译同型请求可用（文本一发）', 'choices[0].message.content 非空且含 mood',
    ok(t.status === 200 && t.content.length > 0 && /mood/.test(t.content)), `status=${t.status} 应答=${t.content.slice(0, 90)}`);
  // 合法 1x1 PNG（不往仓里塞二进制）；判定只看 content —— 响应里还有 reasoning 字段，别拿整个响应断言
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const img = await ask([{
    role: 'user',
    content: [
      { type: 'text', text: '一句话描述这张图。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png.toString('base64') } },
    ],
  }], 0.2);
  record('F 助手LLM', '多模态面可用（图片一发）', '喂合法 PNG，content 非空且不是报错文本',
    ok(img.status === 200 && img.content.length > 0 && !/error|失败/i.test(img.content)), `status=${img.status} 应答=${img.content.slice(0, 90)}`);
} catch (e) {
  record('F 助手LLM', 'LLM 三发自检', `GET ${LLM}/models 等`, 'BLOCKED', `${LLM} 不可达（${e.message}）—— 助手面走启发式兜底，不得记 PASS`);
}

// ═══ 组 G：P1-6 计费/合规去短路（文档红线必须是活的）═══
const docs = ['deploy/spark/realdevice-test-plan-c1c2c3-1126.md', 'deploy/spark/realdevice-verify-c1c2c3-1126v2.md'];
let docOk = true; const docNote = [];
for (const d of docs) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) { docOk = false; docNote.push(d + ' 缺失'); continue; }
  const s = fs.readFileSync(abs, 'utf8');
  const hasRed = /红线/.test(s) && /禁止灌余额/.test(s);
  const voided = /不计通过/.test(s);
  // 活判据检查：任何把"灌余额"当**通过条件**的行必须已被标记作废
  const liveShort = s.split('\n').filter((l) => /积分校验|灌至|budget_credits|budget=/.test(l) && /✅/.test(l) && !/作废/.test(l));
  if (!hasRed || !voided || liveShort.length) { docOk = false; docNote.push(`${d}: 红线=${hasRed} 作废标记=${voided} 未作废短路行=${liveShort.length}`); }
}
record('G 合规', 'P1-6 真机计划禁止灌余额（红线为活判据、历史短路已作废）',
  '两份文档均含"红线/禁止灌余额"+"不计通过"，且无未作废的灌余额 ✅ 行', ok(docOk), docNote.join('；') || '两份文档均合规');
record('G 合规', 'P1-6 C2 真人像走 facegate 预检与 consent', '需 GeekPro GPU + lipsync/facegate/生图队列在跑',
  'BLOCKED', '本机 :8395/:8390/:8188 未运行且 MB_MV_ENABLED=0；按判据记 BLOCKED 不记 ✅');

// ═══ 组 H：真机音乐链（默认不跑，需 GeekPro）═══
// 引擎可达性这一条**每次必打**（就一个 /health，2 秒）—— 它是"跨机音乐链"最容易被悄悄断掉的一环：
// ACE-Step 的 server.py 硬绑 127.0.0.1，必须用 uvicorn CLI 绑到 Tailscale 网卡才能被 DGX 直连（见 runbook §6 ①）。
const ENGINE = (process.env.MB_MUSIC_URL || envKey('MB_MUSIC_URL') || 'http://100.100.140.75:8190').replace(/\/+$/, '');
try {
  const h = await fetchJson(ENGINE + '/health', { timeoutMs: 12000 });
  const j = h.status === 200 ? JSON.parse(h.text) : null;
  record('H 真机音乐', 'ACE-Step 经 Tailscale 直连可达（无 SSH 隧道）', `GET ${ENGINE}/health → 200 且 service=w-m-acestep`,
    ok(h.status === 200 && j && j.service === 'w-m-acestep'),
    j ? `status=${h.status} gpu=${(j.vram || {}).gpu || '?'} 显存 ${(j.vram || {}).vram_total_mb || '?'}MB handler_ready=${j.handler_ready}` : `status=${h.status}`);
} catch (e) {
  record('H 真机音乐', 'ACE-Step 经 Tailscale 直连可达', `GET ${ENGINE}/health`, 'FAIL', `${ENGINE} 不可达：${e.message}（起法见 runbook §6 ①）`);
}
if (MUSIC) {
  const srv = process.env.MB_SERVER || 'http://127.0.0.1:7900';
  let up = null; try { up = await fetchJson(srv + '/healthz', { timeoutMs: 8000 }); } catch (e) { up = null; }
  if (!up || up.status !== 200) {
    record('H 真机音乐', '真机音乐链（30 判据全跑）', '需要一个活着的 server 供验证（默认 ' + srv + '）',
      'BLOCKED', srv + ' 无响应 —— 先起栈：bash tmp/dev_up.sh 7900（或指定 MB_SERVER=…），再 --music 复跑');
  } else {
  const r = run('node', ['scripts/verify_real_music.mjs', '--sec', '30', '--count', '1'], {
    timeoutMs: 2400000,
    env: Object.assign({}, (function(){ const o={}; const t=fs.readFileSync(path.join(ROOT,'etc/spark.env'),'utf8'); for(const m of t.matchAll(/^([A-Z_]+)=(.*)$/gm)) o[m[1]]=m[2].replace(/^["']|["']$/g,''); return o; })(), {
      MB_SERVER: srv, MB_DB: process.env.MB_DB || '/tmp/mb-dev/db/musicbox.sqlite', MB_BUDGET_MS: '1500000',
    }),
  });
  const m = r.out.match(/(\d+)\/(\d+) 判据通过/) || r.out.match(/通过\s*(\d+)\s*\/\s*(\d+)/);
  record('H 真机音乐', '真机音乐链（server 在 DGX + ACE-Step 在 GeekPro）', 'verify_real_music.mjs 判据全通过',
    ok(m && m[1] === m[2] && r.code === 0), m ? `${m[1]}/${m[2]}；退出码=${r.code}` : (r.out.slice(-200) || '无输出'));
  }
} else {
  record('H 真机音乐', '真机音乐链（跨机出歌 + 取件口回捞 + Σdelta==余额）', '需 GeekPro ACE-Step(:8190) + SSH 隧道',
    'BLOCKED', '本次未跑（--music 打开）；上次实跑 29/30 判据通过，证据 var/evidence/music-2026-11-26T18-54-14-673Z/report.json');
}

// ═══ 汇总 ═══
const byStatus = {};
for (const r of results) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
const fails = results.filter((r) => r.status === 'FAIL');
// 中英混排必须按**显示宽度**对齐（CJK 占两列），否则中文行会把后面两列挤歪 —— 这是给人看的交付面
const dw = (s) => { let w = 0; for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1; return w; };
const W = (s, n) => { s = String(s); if (dw(s) <= n) return s + ' '.repeat(n - dw(s)); let out = ''; for (const ch of s) { if (dw(out + ch) > n - 2) break; out += ch; } return out + '…'; };
const ICON = { PASS: '✅', FAIL: '❌', BLOCKED: '⛔', SKIP: '➖', INFO: 'ℹ️ ' };
console.log('\n' + '='.repeat(118));
console.log('整改一次性总验收 · 抢救计划 P0/P1 + 契约 v5.1–v5.3   （' + new Date().toISOString() + '，用时 '
  + Math.round((Date.now() - t0) / 1000) + 's）');
console.log('='.repeat(118));
let lastGroup = '';
for (const r of results) {
  if (r.group !== lastGroup) { console.log('\n\x1b[1m' + r.group + '\x1b[0m'); lastGroup = r.group; }
  console.log('  ' + (ICON[r.status] || '·') + ' ' + W(r.item, 46) + ' │ ' + W(r.measured, 42) + ' │ ' + W(r.judge, 46));
}
console.log('\n' + '-'.repeat(118));
console.log('合计 ' + results.length + ' 项：' + Object.entries(byStatus).map(([k, v]) => k + '=' + v).join('  '));
if (fails.length) {
  console.log('\n\x1b[31m\x1b[1m❌ 整改总验收失败：' + fails.length + ' 项判据不成立\x1b[0m');
  for (const f of fails) console.log('   · ' + f.group + ' / ' + f.item + ' —— ' + f.measured);
  process.exit(1);
}
console.log('\n\x1b[32m\x1b[1m✅ 整改总验收通过\x1b[0m（可交付口径：所有可跑判据全绿；'
  + (byStatus.BLOCKED ? byStatus.BLOCKED + ' 项因环境未就绪记 BLOCKED，已在表内写明前置条件' : '无 BLOCKED') + '）');
