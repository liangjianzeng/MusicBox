// V42 · MV worker 健康口与真机探针的契约对账（2026-11-28 加）
// 起因（现场，不是假想敌）：`src/workers/mv_lipsync/app.py` 只挂了 `/health`，还把 `loaded`
//   **硬编码成 False**；而真机判词 V14/V15 的探针探的是 `/healthz` + `weights_loaded`
//   （`mv_asr`/`sensevoice` 两个 worker 本来就是 `/healthz`）。路由名与字段名两头对不上 →
//   探针恒缺 → V14 那 15 条真机用例**无论权重装没装都以 skip 呈现**：闸门全绿，MV 真机侧
//   一次都没跑过。这是"无证据的绿"的又一个形态——不是断言太松，是**门铃装在隔壁门**。
// 判词纪律（施工计划 §1-4 / §6.3）：
//   ① 走真实数据路径：用 Spark 机的 venv 真把 uvicorn 起起来，HTTP 打它，不做"代码里提到了 X"式空断言；
//   ② 必须带破坏验证：注入不同 env（有权重/无权重、配了可执行命令/没配）必须让字段翻转，
//      谁把字段写死成常量，①②立刻红；
//   ③ 缺前置（venv 不在）显式 t.skip 并点名缺失项，与 V14/V15 同一套 skip 纪律，NEVER 伪绿。
'use strict';
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const H = require('./helpers.js');

const WORKER = path.join(H.ROOT, 'src', 'workers', 'mv_lipsync');
const PY_UVICORN = '/opt/musicbox/var/venv-asr/bin/uvicorn'; // Spark 机已建好的 venv（含 fastapi/uvicorn）

function missingPrereq() {
  if (!fs.existsSync(WORKER)) return 'worker 目录缺失：' + WORKER;
  if (!fs.existsSync(PY_UVICORN)) return PY_UVICORN + ' 不存在（Spark 机 venv 未建，施工计划 §2.1 S6）';
  return null;
}

// 临时权重目录：var-test 由判词自己兜底建出来（别的判词 boot 时才建，本判词不 boot 服务端）
function tmpCase(name) {
  const base = path.join(H.ROOT, 'var-test');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, name + '-'));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// 起一个真服务；返回 { port, stop() }
async function bootWorker(env) {
  const port = await freePort();
  const child = spawn(PY_UVICORN, ['app:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: WORKER,
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tail = [];
  child.stdout.on('data', (b) => tail.push(b.toString()));
  child.stderr.on('data', (b) => tail.push(b.toString()));
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('worker 启动即退出 code=' + child.exitCode + '：' + tail.join('').slice(-400));
    try {
      const r = await H.httpReq('GET', 'http://127.0.0.1:' + port + '/healthz', { timeoutMs: 1500 });
      if (r.status === 200) return { port, child, stop: () => { try { child.kill('SIGTERM'); } catch (e) { /* 已退出 */ } } };
    } catch (e) { /* 还没起来 */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('worker 30s 未就绪：' + tail.join('').slice(-400)); }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function getJson(port, route) {
  const r = await H.httpReq('GET', 'http://127.0.0.1:' + port + route, { timeoutMs: 5000 });
  return { status: r.status, json: JSON.parse(r.buffer.toString('utf8')) };
}

describe('V42 · MV worker 健康口 ↔ 真机探针契约', () => {
  const pre = missingPrereq();
  const spawned = [];
  const boot = async (env) => { const w = await bootWorker(env); spawned.push(w); return w; };
  after(() => { for (const w of spawned) { try { w.stop(); } catch (e) { /* noop */ } } });

  it('V42-① 权重在位 + 外部命令可执行时，/healthz 必须如实报 true（不许写死）', async (t) => {
    if (pre) { t.skip('【V42】缺前置：' + pre + ' —— 施工计划 §6.3 skip 纪律'); return; }
    const wDir = tmpCase('v42-weights');
    fs.writeFileSync(path.join(wDir, 'echomimic_v3-flash.safetensors'), Buffer.alloc(4096, 7)); // 非空权重文件
    const w = await boot({ MODELSCOPE_CACHE: wDir, MB_LIPSYNC_COMMAND: JSON.stringify(['/bin/true', '{video}', '{audio}', '{output}']), MB_LIPSYNC_SYNC_COMMAND: JSON.stringify(['/bin/true']) });
    const h = await getJson(w.port, '/healthz');
    assert.strictEqual(h.status, 200, '/healthz 必须 200（V14/V15 探针就是探它）');
    assert.strictEqual(h.json.ok, true, 'ok 必须为 true：' + JSON.stringify(h.json));
    assert.strictEqual(h.json.weights_loaded, true, '权重目录里有非空权重文件却报 false = 谎报缺失：' + JSON.stringify(h.json));
    assert.strictEqual(h.json.command_ready, true, 'MB_LIPSYNC_COMMAND 首项 /bin/true 可执行却报 false = 谎报：' + JSON.stringify(h.json));
    assert.strictEqual(h.json.score_configured, true, '评分命令已配却报 false：' + JSON.stringify(h.json));
    assert.strictEqual(typeof h.json.weights_dir, 'string', '必须说出权重目录在哪，便于运维定位');
  });

  it('V42-② 空权重 + 未配命令时必须如实报 false，且 /lipsync 显式 503 不静默降级', async (t) => {
    if (pre) { t.skip('【V42】缺前置：' + pre); return; }
    const empty = tmpCase('v42-empty');
    const env = { MODELSCOPE_CACHE: empty };
    delete env.MB_LIPSYNC_COMMAND; delete env.MB_LIPSYNC_SYNC_COMMAND;
    const w = await boot(env);
    const h = await getJson(w.port, '/healthz');
    assert.strictEqual(h.json.weights_loaded, false, '空目录报 true 就是"权重在位"的谎言（§2.1 S5）：' + JSON.stringify(h.json));
    assert.strictEqual(h.json.command_ready, false, '没配外部推理命令却报就绪 = 派单后必然 500 的假放行');
    const p = await H.httpReq('POST', 'http://127.0.0.1:' + w.port + '/lipsync', {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ video: '/tmp/none.mp4', audio: '/tmp/none.wav' }), timeoutMs: 8000,
    });
    assert.strictEqual(p.status, 503, '引擎没接线必须 503 明说，绝不返回"看起来成功"的产物：' + p.buffer.toString().slice(0, 160));
    assert.match(p.buffer.toString(), /ENGINE_NOT_READY/, '必须点名"未配置口型推理命令"，让闸门和人都看得懂缺什么');
  });

  it('V42-③ 真机探针读的路由与字段，worker 必须真的提供（对账 V14/V15 ↔ workers）', (t) => {
    if (pre) { t.skip('【V42】缺前置：' + pre); return; }
    const read = (p) => fs.readFileSync(path.join(H.ROOT, p), 'utf8');
    const v14 = read('test/acceptance/v14_mv_instrumental.test.js');
    const v15 = read('test/acceptance/v15_mv_lipsync.test.js');
    // 探针侧：真机判词到底探哪个路由、读哪个字段（改这里=改契约，必须同步 worker）
    assert.match(v14, /\/healthz/, 'V14 的 lipsync 探针约定探 /healthz');
    assert.match(v14, /weights_loaded/, 'V14 靠 weights_loaded 判权重在位');
    assert.match(v15, /\/healthz/, 'V15 同上');
    // worker 侧：路由必须挂上、字段必须真的由能力计算出来（不是常量）
    const lip = read('src/workers/mv_lipsync/app.py');
    assert.match(lip, /@app\.get\("\/healthz"\)/, 'mv_lipsync 必须挂 /healthz：判词探的是它，挂成 /health 就是门铃装错门');
    assert.match(lip, /"weights_loaded":\s*weights_present\(\)/, 'weights_loaded 必须由 weights_present() 算出来，写死常量=谎报');
    assert.match(lip, /"command_ready":\s*command_ready\(\)/, 'command_ready 必须真探测可执行性');
    // 另两个 worker 与探针的路由约定（mv_asr 真机侧探 /healthz + model_loaded）
    const asr = read('src/workers/mv_asr/app.py');
    assert.match(asr, /@app\.get\("\/healthz"\)/, 'mv_asr 必须挂 /healthz（deploy/spark/realdevice-test-plan A3 就探它）');
    assert.match(asr, /"model_loaded":\s*_model is not None/, 'model_loaded 必须由模型对象真算');
  });
});
