// V24 · 执行器身份回归（抢救 P0：真机全链实测暴露的「任务全租给 ex_anon」）
// 断言源：src/server/api/executor.js（领单必须带身份）、src/executor/index.js（每个请求带身份 + 身份落盘复用）。
//
// 为什么必须单独有这套：验收套件的 FakeExecutor 一直自带 executor_id，所以「真执行器从不回传身份」
// 这个致命缺陷在 172 例里从未暴露 —— 真机上表现为：任务 progress 永远 0、complete 被归属校验 403、
// attempts 耗尽 → failed + 退款。这套用**真执行器进程**打一个记录型假调度端，专验协议姿态。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const H = require('./helpers.js');

const ROOT = H.ROOT;
const EXECUTOR_TOKEN = 'v24-exec-token';
const ID = 'ex_v24_persistent';
let PORT = 0;   // 由 mock 监听后取实际端口，避免与其它套件的端口段撞车

const seen = [];   // 每个到达假调度端的请求：{p, id, bodyId, headerId, token}
let srv = null;

function startMock() {
  return new Promise((resolve, reject) => {
    srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { /* multipart 等非 JSON 体 */ }
        seen.push({
          p: req.url,
          token: req.headers['x-executor-token'] || null,
          headerId: req.headers['x-executor-id'] || null,
          bodyId: body.executor_id || null,
        });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/executor/register') {
          res.end(JSON.stringify({ executor_id: ID, poll_interval_ms: 400, nodes: null }));
        } else if (req.url === '/executor/poll') {
          res.end(JSON.stringify({ job: null }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { PORT = srv.address().port; resolve(); });
  });
}

function spawnExecutor(varDir) {
  return spawn(process.execPath, [path.join(ROOT, 'src', 'executor', 'index.js'), '--lanes', 'music'], {
    cwd: path.join(ROOT, 'src'),
    env: Object.assign({}, process.env, {
      MB_API_URL: 'http://127.0.0.1:' + PORT,
      MB_EXECUTOR_TOKEN: EXECUTOR_TOKEN,
      MB_VAR_DIR: varDir,
      MB_VAR_ROOT: varDir,
      MB_EXECUTOR_ID: '',          // 不许靠环境变量作弊：身份必须来自 register 响应 + 落盘
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (r) => r.bodyId || r.headerId;

let tmpVar = '';
let child = null;

describe('V24 执行器身份（真进程 · 假调度端）', () => {
  before(async () => {
    tmpVar = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v24-'));
    await startMock();
  });
  after(() => {
    try { if (child) child.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
    try { if (srv) srv.close(); } catch (e) { /* 已关 */ }
    try { fs.rmSync(tmpVar, { recursive: true, force: true }); } catch (e) { /* 临时目录回收失败不影响结论 */ }
  });

  it('V24-① 首次接入后，poll / heartbeat 等一切后续请求都必须带服务端下发的身份', async () => {
    child = spawnExecutor(tmpVar);
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      await wait(500);
      const polls = seen.filter((r) => r.p === '/executor/poll');
      if (polls.length >= 2) break;
    }
    const regs = seen.filter((r) => r.p === '/executor/register');
    const polls = seen.filter((r) => r.p === '/executor/poll');
    assert.ok(regs.length >= 1, '执行器必须先 POST /executor/register（实际收到 ' + regs.length + ' 次）');
    assert.ok(polls.length >= 2, '执行器应持续轮询（实际 ' + polls.length + ' 次 poll）');
    for (const r of polls) {
      assert.strictEqual(r.token, EXECUTOR_TOKEN, 'poll 必须带 x-executor-token');
      assert.strictEqual(idOf(r), ID,
        'poll 必须带 register 下发的身份（否则服务端会把任务租给 ex_anon，真执行器再也完不成任务）。实际 header=' + r.headerId + ' body=' + r.bodyId);
    }
    const hbs = seen.filter((r) => r.p === '/executor/heartbeat');
    for (const r of hbs) assert.ok(idOf(r), 'heartbeat 也必须带身份，实际 header=' + r.headerId + ' body=' + r.bodyId);
    child.kill('SIGKILL'); await wait(300); child = null;
  });

  it('V24-② 身份必须落盘并在重启后复用（否则 executors 表每 30s 长一行幽灵执行器）', () => {
    const f = path.join(tmpVar, 'executor.id');
    assert.ok(fs.existsSync(f), 'register 下发的身份必须落盘到 <varDir>/executor.id');
    assert.strictEqual(fs.readFileSync(f, 'utf8').trim(), ID, '落盘身份必须就是服务端下发的 id');
  });

  it('V24-③ 重启后的 register 必须自带身份，让服务端走 UPDATE 而不是每次新建执行器行', async () => {
    const before = seen.length;
    child = spawnExecutor(tmpVar);
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await wait(400);
      if (seen.slice(before).some((r) => r.p === '/executor/register')) break;
    }
    const regs = seen.slice(before).filter((r) => r.p === '/executor/register');
    assert.ok(regs.length >= 1, '重启后应重新 register');
    assert.strictEqual(idOf(regs[0]), ID, '重启后 register 必须带上持久化身份，实际 header=' + regs[0].headerId + ' body=' + regs[0].bodyId);
    child.kill('SIGKILL'); await wait(300); child = null;
  });

  it('V24-④ 调度端侧：缺身份的领单必须被拒（不再把任务租给 ex_anon）', async () => {
    const S = await H.boot('V24srv', { noFakeExecutor: true });
    try {
      const bad = await S.api('POST', '/executor/poll', { executorToken: H.EXECUTOR_TOKEN, json: { lanes: ['music'] } });
      assert.strictEqual(bad.status, 400, '不带身份的领单必须 400，实际 ' + bad.status + ' ' + bad.text);
      assert.match(String((bad.json || {}).message || ''), /身份|x-executor-id/, '报错要说清怎么补救');
      // 关键：库里绝不能出现 ex_anon 的租约
      const rows = S.db.all("SELECT id, executor_id, status FROM jobs WHERE executor_id='ex_anon' OR executor_id=''");
      assert.strictEqual(rows.length, 0, '绝不能把任务租给 ex_anon/空身份，实际 ' + JSON.stringify(rows));
      const ok = await S.api('POST', '/executor/poll', { executorToken: H.EXECUTOR_TOKEN, json: { lanes: ['music'], executor_id: 'ex_v24_ok' } });
      assert.strictEqual(ok.status, 200, '带身份的领单应正常 200（空队列返回 job:null），实际 ' + ok.status + ' ' + ok.text);
    } finally { S.close(); }
  });
});
