'use strict';
// V43 · 定妆候选的「身份门控」状态必须一路活到端上（2026-11-28 加）
//
// 起因（现场，不是假想敌）：`facegateScore()` 在 facegate 不可达时返回 `{score:null,pass:false}`
//   并只写一行日志（代码原话「评分缺省，不致命」），`mv_cast_image` 照样 done；而
//   `completeMvCastImage` 落库时**只存 URL 数组**，分数与门控状态整个丢在 job result 里。
//   净效果：App 摆出三张候选让用户挑主演、扣积分，而这三个候选可能**一张都没和主角脸对照过**，
//   界面上没有任何地方说这件事。属于"不许静默降级"那条红线（施工计划 §1）。
//
// 判词纪律（§6.3 / §1-4）：
//   ① 走真实数据路径：用 `/executor/poll` 领单、`/executor/jobs/:id/complete` 收单（multipart），
//      再 `GET /v1/mv/projects/:id` 读回来断言 —— 不做白盒改库，也不测"代码里引用了 meta"；
//   ② 必须带破坏验证：把 engine 的落库退回 URL 数组 → ①②③ 全红（见 docs/runbook 里的控制记录）；
//   ③ 缺前置显式 skip 并点名缺失项，绝不用假绿凑数。
//
// 主角像：定妆真机判词用 test/acceptance/fixtures/mv_lead_portrait.jpg（sha256 见施工计划 §6.3.1）。
// 本套是服务端落库腿，产物由判词自带的 PNG 桩充当；真脸对照发生在 V14-①（真机，需 ComfyUI+facegate）。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const H = require('./helpers.js');

const EX_ID = 'v43-executor';
const EX_LANES = ['music', 'intent', 'ffmpeg', 'imgspark', 'vidspark', 'lipsync', 'align'];

function exHeaders() { return { 'X-Executor-Id': EX_ID }; }

async function newProject(R, g) {
  const workId = R.seedWork(g.user.id, { lyrics: '' });
  const r = await R.api('POST', '/v1/mv/projects', {
    token: g.token,
    json: { work_id: workId, brief: 'V43 定妆门控落库', character: { gender: 'f', source: 'ai' } },
  });
  assert.strictEqual(r.status, 201, 'V43 前置 建项目应 201，实际 ' + r.status + ' ' + String(r.text).slice(0, 200));
  return r.json.project.id;
}

async function dispatchCast(R, g, pid) {
  const r = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'cast_image' } });
  assert.strictEqual(r.status, 202, 'V43 前置 cast_image 派单应 202，实际 ' + r.status + ' ' + String(r.text).slice(0, 200));
  return r.json.job_id;
}

// 以执行侧身份领单并按**给定 result** 收单：真 HTTP、真 multipart，不白盒写库
async function takeAndComplete(R, jobId, result) {
  const p = await R.api('POST', '/executor/poll', {
    executorToken: H.EXECUTOR_TOKEN, headers: exHeaders(),
    json: { lanes: EX_LANES, executor_id: EX_ID }, timeoutMs: 30000,
  });
  assert.strictEqual(p.status, 200, 'V43 领单应 200，实际 ' + p.status + ' ' + String(p.text).slice(0, 200));
  const job = p.json && p.json.job;
  assert.ok(job, 'V43 没领到 job（内置 fake 是否在跑？本套 boot 传了 noFakeExecutor）');
  assert.strictEqual(job.id, jobId, 'V43 领到的必须是本用例派出的 cast_image job，实际 ' + job.type + '/' + job.id);
  const files = [];
  const logical = {};
  for (let i = 1; i <= 3; i++) {
    const field = 'cast_image_' + i;
    files.push({ field, filename: field + '.png', data: H.makePng(), contentType: 'image/png' });
    logical[field] = field;
  }
  const c = await R.api('POST', '/executor/jobs/' + job.id + '/complete', {
    executorToken: H.EXECUTOR_TOKEN, headers: exHeaders(),
    multipart: { fields: { result: JSON.stringify(Object.assign({ files: logical }, result)), executor_id: EX_ID }, files },
  });
  assert.ok(c.ok, 'V43 执行侧收单应 2xx，实际 ' + c.status + ' ' + String(c.text).slice(0, 240));
}

async function castImagesOf(R, g, pid) {
  const got = await R.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
  assert.strictEqual(got.status, 200, 'V43 读项目应 200，实际 ' + got.status);
  const ch = (got.json.characters || [])[0] || {};
  return ch.cast_images || [];
}

describe('V43 · 定妆身份门控状态落库与下发（契约 v5.6.16）', () => {
  let R;
  before(async () => { R = await H.boot('V43', { noFakeExecutor: true }); });
  after(async () => { if (R) await R.close(); });

  it('V43-① facegate 真跑成：3 候选的 url+score+gate.ran 必须原样落到角色上', async () => {
    const g = await R.newGuest();
    await R.credits(g.token);
    const pid = await newProject(R, g);
    const jid = await dispatchCast(R, g, pid);
    await takeAndComplete(R, jid, {
      seed_base: 7, face_scores: [0.81, 0.42, 0.55],
      meta: { comfy: true, facegate: { attempted: 3, scored: 3, ran: true, reason: null } },
    });
    const row = (R.db.mvJobsOf(g.user.id).rows || []).find((x) => x.id === jid) || {};
    assert.strictEqual(row.status, 'done', 'V43-① 门控跑成时 job 应 done，实际 ' + row.status);
    const cands = await castImagesOf(R, g, pid);
    assert.strictEqual(cands.length, 3, 'V43-① 角色应挂 3 个候选，实际 ' + cands.length + '（形状 ' + JSON.stringify(cands).slice(0, 160) + '）');
    assert.ok(cands.every((c) => c && typeof c === 'object' && String(c.url || '').includes('/f/')),
      'V43-① 每个候选必须带可下载 url，实际 ' + JSON.stringify(cands).slice(0, 200));
    assert.deepStrictEqual(cands.map((c) => c.score), [0.81, 0.42, 0.55],
      'V43-① 分数必须逐张落库（丢了就没法告诉用户哪张最像主角），实际 ' + JSON.stringify(cands.map((c) => c.score)));
    assert.ok(cands.every((c) => c.gate && c.gate.ran === true),
      'V43-① gate.ran=true 必须下发，否则端上只能显示"未标注"，实际 ' + JSON.stringify(cands.map((c) => c.gate)));
  });

  it('V43-② facegate 没跑成：候选照常交付，但必须带 ran=false + 原因（不许抹平）', async () => {
    const g = await R.newGuest();
    await R.credits(g.token);
    const pid = await newProject(R, g);
    const jid = await dispatchCast(R, g, pid);
    await takeAndComplete(R, jid, {
      seed_base: 11, face_scores: [null, null, null],
      meta: { comfy: true, facegate: { attempted: 3, scored: 0, ran: false, reason: 'unreachable' } },
    });
    const row = (R.db.mvJobsOf(g.user.id).rows || []).find((x) => x.id === jid) || {};
    assert.strictEqual(row.status, 'done',
      'V43-② 门控没跑成时图是真出的，job 仍应 done（失败要标注，不许靠 fail 把交付一起拖没），实际 ' + row.status);
    const cands = await castImagesOf(R, g, pid);
    assert.strictEqual(cands.length, 3, 'V43-② 未验脸也要能挑，候选不许消失，实际 ' + cands.length);
    assert.ok(cands.every((c) => c.score === null),
      'V43-② 没打分就是 null，不许脑补成 0（0 会被读成"验过且完全不像"），实际 ' + JSON.stringify(cands.map((c) => c.score)));
    assert.ok(cands.every((c) => c.gate && c.gate.ran === false && c.gate.reason === 'unreachable'),
      'V43-② 必须把"没跑成 + 原因"下发给端上，实际 ' + JSON.stringify(cands.map((c) => c.gate)));
  });

  it('V43-③ 老执行侧不带 meta：服务端不许脑补成"验过了"', async () => {
    const g = await R.newGuest();
    await R.credits(g.token);
    const pid = await newProject(R, g);
    const jid = await dispatchCast(R, g, pid);
    await takeAndComplete(R, jid, { seed_base: 3, face_scores: [null, null, null] }); // 无 meta
    const cands = await castImagesOf(R, g, pid);
    assert.strictEqual(cands.length, 3, 'V43-③ 兼容老执行侧：候选仍要能挑，实际 ' + cands.length);
    assert.ok(cands.every((c) => !c.gate || c.gate.ran !== true),
      'V43-③ 没有 meta 时 gate 只许缺省/未标注，脑补 ran=true 就是替一次没发生的验脸作担保，实际 '
        + JSON.stringify(cands.map((c) => c.gate)));
  });
});

// 脚手架自身也算一条腿：内置 mock 执行侧过去凭空发 0.90/0.83/0.76，等于自己造"验过脸"的证据。
describe('V43-④ 内置 mock 执行侧不许假装验过脸', () => {
  let F;
  before(async () => { F = await H.boot('V43M'); }); // 默认带 FakeExecutor
  after(async () => { if (F) await F.close(); });

  it('V43-④ mock 定妆必须自带 ran=false + reason=mock_executor，且分数为 null', async () => {
    const g = await F.newGuest();
    await F.credits(g.token);
    const pid = await newProject(F, g);
    await dispatchCast(F, g, pid);
    const t0 = Date.now();
    let cands = [];
    while (Date.now() - t0 < 30000) {
      cands = await castImagesOf(F, g, pid);
      if (cands.length === 3) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.strictEqual(cands.length, 3, 'V43-④ mock 应交付 3 候选，实际 ' + cands.length);
    assert.ok(cands.every((c) => c.score === null),
      'V43-④ mock 没有 facegate 在跑，分数只许 null；发 0.90 这种漂亮数字就是脚手架替假数据作保，实际 '
        + JSON.stringify(cands.map((c) => c.score)));
    assert.ok(cands.every((c) => c.gate && c.gate.ran === false && c.gate.reason === 'mock_executor'),
      'V43-④ mock 必须自报 mock_executor，实际 ' + JSON.stringify(cands.map((c) => c.gate)));
  });
});

// ---------- 真机腿：选角（真人照片）→ 定妆真跑（ComfyUI + 我们自己的 facegate） ----------
// 为什么单独装门而不复用 V14 的 realGate：realGate 只看 PRE.ok，而 PRE 探针把 lipsync
// （/healthz + weights_loaded）捆成**整条链**的前置（v14:30-54/55）。定妆压根不碰口型，
// lipsync 挂起期间让定妆陪着 skip，就是"门铃装错了门"——那是无证据的绿的另一种形态。
// 本腿的前置按用例装：ComfyUI + facegate 权重 + ffmpeg。**断言一条没减**：3 候选可下载可解码、
// face_scores 全数值、至少一张 ≥0.6、meta.facegate.ran 必须 true（真跑，不是 mock 报的）。
const FIXTURE = path.join(H.ROOT, 'test', 'acceptance', 'fixtures', 'mv_lead_portrait.jpg');
const FIXTURE_SHA = 'e8bf45a872773e66c4c26fdd15c9895b3bd71111d09e6789f5b294562f1b7c2d'; // 施工计划 §6.3.1
const VENV_FG = '/opt/musicbox/var/venv-facegate/bin/uvicorn';
const FG_APP = path.join(H.ROOT, 'src', 'workers', 'mv_facegate');
const FG_MODELS = process.env.MB_FACEGATE_MODELS
  || path.join(process.env.HOME || '/home/jianzengliang', 'musicbox-models', 'facegate');
const CAST_GATE_LINE = 0.6; // SP-MV-3 通过线：与端上 kMvCastGateLine、V14-① 同源，改一处须同改
const FG_TOKEN = 'mb-v43-facegate-token';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function weightsReady() {
  const dir = path.join(FG_MODELS, 'models', 'buffalo_l'); // insightface: {root}/models/{name}
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.onnx') && fs.statSync(path.join(dir, f)).size > 1048576);
  } catch (e) { return false; }
}
function castPrereq() {
  const miss = [];
  if (!fs.existsSync(FIXTURE)) miss.push('主角像缺失：' + FIXTURE);
  else {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE)).digest('hex');
    if (sha !== FIXTURE_SHA) {
      miss.push('主角像 sha256 与施工计划 §6.3.1 登记不符（' + sha.slice(0, 12) + '… ≠ e8bf45a8…）—— 换脸须同时改登记');
    }
  }
  if (!fs.existsSync(VENV_FG)) miss.push(VENV_FG + ' 不存在（Spark 机 venv-facegate 未建，§2.1 S6）');
  if (!fs.existsSync(FG_APP)) miss.push('facegate worker 目录缺失：' + FG_APP);
  if (!weightsReady()) miss.push('buffalo_l 权重缺失：' + path.join(FG_MODELS, 'models/buffalo_l/*.onnx') + '（MB_FACEGATE_MODELS 可指路）');
  if (!H.findFfmpeg()) miss.push('ffmpeg 未找到（cast_video 抽帧需要，§2.1 S2）');
  return miss;
}
async function probeComfy() {
  const url = process.env.MB_SPARK_COMFY;
  if (!url) return 'MB_SPARK_COMFY 未设置（真实 ComfyUI :8188 实连，§6.3 探针）';
  try {
    const r = await H.httpReq('GET', String(url).replace(/\/+$/, '') + '/system_stats', { timeoutMs: 6000 });
    if (r.status < 200 || r.status >= 300) return 'MB_SPARK_COMFY=' + url + ' /system_stats HTTP ' + r.status;
    return null;
  } catch (e) { return 'MB_SPARK_COMFY=' + url + ' 不可达：' + e.message; }
}

describe('V43-⑤⑥ 选角/定妆真机（ComfyUI + facegate，不捆 lipsync）', () => {
  const kids = [];
  let R = null;
  // runId 必须**每轮全新**：执行侧启动时向服务端注册自己的 worker 地址，那份注册落在
  // var-test/<runId>/db 里；复用固定 runId 就会让"上一轮那次注册的 facegate 端口"永远盖住
  // 本轮的 MB_FACEGATE_URL（2026-11-28 排查两小时的真凶：env 传对了却被库里旧注册顶掉，
  // 表现成 facegate 活着却 unreachable）。判词要复现的是本轮环境，不是历史。
  const RUN_ID = 'V43-REAL-' + new Date().toISOString().replace(/[:.]/g, '-');
  const varDir = path.join(H.ROOT, 'var-test', RUN_ID);
  const LOG_DIR = path.join(H.ROOT, 'var-test', 'v43-logs');
  const KIDS_FILE = path.join(LOG_DIR, 'kids.pid');
  const RUN_TAG = new Date().toISOString().replace(/[:.]/g, '-');
  // 子进程必须按**进程组**回收。node:test 的 after 在被 timeout 打断或异常退出时不执行，
  // 于是上一轮的执行侧还活着、继续往同一个日志文件里写：2026-11-28 就因此把"上一轮的
  // ECONNREFUSED 42955"混进新日志，把人往"facegate 起不来"的方向带偏了整整两轮。
  function sweepKids(why) {
    if (!fs.existsSync(KIDS_FILE)) return;
    const pids = fs.readFileSync(KIDS_FILE, 'utf8').split('\n').map((s) => parseInt(s, 10)).filter(Boolean);
    for (const pgid of pids) { try { process.kill(-pgid, 'SIGKILL'); } catch (e) { /* 已退 */ } }
    try { fs.unlinkSync(KIDS_FILE); } catch (e) { /* 已无 */ }
    if (why && pids.length) console.log('  [V43 清扫] ' + why + '：回收 ' + pids.length + ' 个子进程组');
  }
  function track(child) {
    kids.push(child);
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(KIDS_FILE, child.pid + '\n'); // detached 后 pid==pgid ⇒ 可按组杀干净
  }
  sweepKids('起跑前清残留');
  process.on('exit', () => sweepKids('进程退出'));

  async function startFacegate(tag) {
    const port = await freePort();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // stdio 必须落到文件：用 pipe 而不消费，子进程写满 64KB 管道缓冲就会**卡死**，
    // 表现成"连不上"（unreachable），排查时会被误导成服务没起来。
    const out = fs.openSync(path.join(LOG_DIR, 'facegate-' + tag + '-' + RUN_TAG + '.log'), 'w');
    const child = spawn(VENV_FG, ['app:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: FG_APP,
      detached: true, // 自成进程组，配合 kids.pid 按组回收
      env: Object.assign({}, process.env, {
        MB_WORKER_TOKEN: FG_TOKEN,
        MB_FACEGATE_MODELS: FG_MODELS,
        MB_FACEGATE_ROOTS: [varDir, H.ROOT].join(','), // ref_file 在 facegate 自己这侧 resolve（app.py:87-91）
      }),
      stdio: ['ignore', out, out],
    });
    track(child);
    const base = 'http://127.0.0.1:' + port;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      try {
        const r = await H.httpReq('GET', base + '/health', { timeoutMs: 2000 });
        if (r.status === 200) return { base, child };
      } catch (e) { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('facegate 60s 内没起来（' + VENV_FG + '，权重目录 ' + FG_MODELS + '）');
  }
  function startExecutor(baseUrl, fgBase) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // 日志名带本轮时间戳：固定名会被上一轮仍存活的执行侧继续写，混出的日志能把人骗惨
    const out = fs.openSync(path.join(LOG_DIR, 'executor-' + RUN_TAG + '.log'), 'w');
    const child = spawn(process.execPath, [
      path.join(H.ROOT, 'src', 'executor', 'index.js'),
      '--api', baseUrl, '--token', H.EXECUTOR_TOKEN, '--lanes', 'imgspark,vidspark',
    ], {
      cwd: H.ROOT,
      detached: true,
      env: Object.assign({}, process.env, {
        EXECUTOR_MOCK: '0', // 真机：mock 语义必须关，否则又成"绿得没有证据"
        MB_VAR_DIR: varDir, MB_VAR_ROOT: varDir, // 同义双名是既有坑（index.js:50-52，P0-4）
        MB_COMFY_URL: String(process.env.MB_SPARK_COMFY).replace(/\/+$/, ''),
        MB_FACEGATE_URL: fgBase,
        MB_WORKER_TOKEN: FG_TOKEN,
      }),
      stdio: ['ignore', out, out],
    });
    track(child);
    return child;
  }
  async function uploadPortrait(token, { consent = true } = {}) {
    const buf = fs.readFileSync(FIXTURE);
    const fields = consent ? { consent: 'true' } : {}; // PIPL 前置：「仅用于本次角色生成、不用于训练」勾选
    const r = await R.api('POST', '/v1/mv/image', {
      token,
      multipart: { fields, files: [{ field: 'file', filename: 'mv_lead_portrait.jpg', data: buf, contentType: 'image/jpeg' }] },
    });
    assert.strictEqual(r.status, 200, 'V43 真人通道上传人像应 200，实际 ' + r.status + ' ' + String(r.text).slice(0, 200));
    assert.ok(r.json && r.json.image_id, 'V43 上传必须回 image_id，实际 ' + String(r.text).slice(0, 200));
    return r.json.image_id;
  }

  after(async () => {
    for (const k of kids) { try { k.kill('SIGTERM'); } catch (e) { /* 已退 */ } }
    sweepKids('after');
    if (R) await R.close();
  });

  it('V43-⑤ 真人照片选角 → 定妆 3 候选必须真过 facegate（分数数值 + ran=true）', { timeout: 30 * 60000 }, async (t) => {
    const miss = castPrereq();
    const cf = await probeComfy();
    if (cf) miss.push(cf);
    if (miss.length) {
      t.skip('【V43 真机】缺前置：' + miss.join('；') + ' —— §6.3 skip 纪律（断言在此登记，不是跳过不判）');
      return;
    }
    const fg = await startFacegate('cast');
    R = await H.boot(RUN_ID, {
      runId: RUN_ID, noFakeExecutor: true,
      env: {
        EXECUTOR_MOCK: '0',
        MB_COMFY_URL: String(process.env.MB_SPARK_COMFY).replace(/\/+$/, ''),
        MB_FACEGATE_URL: fg.base,
        MB_WORKER_TOKEN: FG_TOKEN, // 两侧必须一致：server→facegate 也要带（api/mv.js facegateHeaders）
      },
    });
    startExecutor(R.baseUrl, fg.base);

    const g = await R.newGuest();
    await R.credits(g.token);
    // PIPL consent 前置必须真在：没勾「仅用于本次角色生成、不用于训练」就不许收下真人照片
    const noConsent = await R.api('POST', '/v1/mv/image', {
      token: g.token,
      multipart: { fields: {}, files: [{ field: 'file', filename: 'mv_lead_portrait.jpg', data: fs.readFileSync(FIXTURE), contentType: 'image/jpeg' }] },
    });
    assert.strictEqual(noConsent.status, 400,
      'V43-⑤ 未勾选授权时上传真人照片必须 400（PIPL consent 前置），实际 ' + noConsent.status + ' ' + String(noConsent.text).slice(0, 160));
    const imageId = await uploadPortrait(g.token);
    const workId = R.seedWork(g.user.id, { lyrics: '' });
    const pr = await R.api('POST', '/v1/mv/projects', {
      token: g.token,
      json: { work_id: workId, brief: 'V43-⑤ 真人选角定妆真机', character: { gender: 'f', source: 'upload', image_id: imageId } },
    });
    assert.strictEqual(pr.status, 201, 'V43-⑤ 真人通道建项目应 201，实际 ' + pr.status + ' ' + String(pr.text).slice(0, 240));
    const pid = pr.json.project.id;

    const dj = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'cast_image' } });
    assert.strictEqual(dj.status, 202, 'V43-⑤ cast_image 派单应 202，实际 ' + dj.status + ' ' + String(dj.text).slice(0, 240));
    const job = await R.waitForJob(g.token, dj.json.job_id, { timeoutMs: 24 * 60000 });
    assert.strictEqual(job.status, 'done',
      'V43-⑤ 真机定妆应 done（ComfyUI h3-image-cast ×3），实际 ' + job.status + ' ' + JSON.stringify(job.error || {}).slice(0, 240));

    const row = (R.db.mvJobsOf(g.user.id).rows || []).find((x) => x.id === dj.json.job_id) || {};
    const res = JSON.parse(row.result || '{}');
    const raw = res.face_scores || [];
    const gate = (res.meta && res.meta.facegate) || null;
    // 顺序即真相：先判"门控到底跑没跑"，再判分数。2026-11-28 这条先判分数，被
    // `(face_scores||[]).map(Number)` 把 [null,null,null] 洗成 [0,0,0] —— 于是报出的失败是
    // "照片不像（0 分）"，而真实原因是 facegate unreachable：**类型强制把 null 洗成合法值**，
    // 判词自己成了说谎的那一环。
    assert.ok(gate && gate.ran === true,
      'V43-⑤ 身份门控必须真跑成（ran=true），实际 ' + JSON.stringify(gate)
        + '；facegate 侧日志：var-test/v43-logs/facegate-cast.log');
    assert.strictEqual(raw.length, 3, 'V43-⑤ 应有 3 个 face_scores，实际 ' + JSON.stringify(raw));
    assert.ok(raw.every((s) => s !== null && s !== undefined && Number.isFinite(Number(s))),
      'V43-⑤ 每个候选都要有 facegate 数值分；**null=没打分，不许被 Number(null)=0 冒充**，实际 ' + JSON.stringify(raw));
    const scores = raw.map(Number);
    assert.ok(scores.some((s) => s >= CAST_GATE_LINE),
      'V43-⑤ 至少一张 ≥' + CAST_GATE_LINE + '（SP-MV-3 通过线），实际 ' + JSON.stringify(scores));
    assert.strictEqual(gate.scored, 3, 'V43-⑤ 三张都应被打分，实际 ' + JSON.stringify(gate));
    // 真人通道禁走造脸模板（回归锁）：2026-11-28 实测 h3-image-cast/edit 的身份余弦只有
    // -0.00~0.24 / 0.05~0.11（同人为 0.94 作标尺），用它=交出一个不是主角的人还当候选给用户挑。
    assert.strictEqual(res.meta.cast_mode, 'photo_master',
      'V43-⑤ 真人通道定妆必须以原片为母版（cast_mode=photo_master），实际 ' + JSON.stringify(res.meta.cast_mode));
    assert.deepStrictEqual(res.meta.denoise, [0.1, 0.2, 0.3],
      'V43-⑤ 三档轻度处理必须如实交付（端上要显示处理力度），实际 ' + JSON.stringify(res.meta.denoise));
    assert.ok(scores[0] >= scores[2] - 0.05,
      'V43-⑤ denoise 越大越不像（0.1 档应不低于 0.3 档，容差 0.05）：' + JSON.stringify(scores));
    assert.notStrictEqual(new Set(scores).size, 1,
      'V43-⑤ 三张分数完全相同=可疑（多半是常量或同图重复），实际 ' + JSON.stringify(scores));

    const got = await R.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    const ch = (got.json.characters || [])[0] || {};
    const cands = ch.cast_images || [];
    assert.strictEqual(cands.length, 3, 'V43-⑤ 角色应挂 3 候选，实际 ' + cands.length + ' ' + JSON.stringify(cands).slice(0, 200));
    for (const c of cands) {
      assert.ok(String(c.url || '').includes('/f/'), 'V43-⑤ 候选 url 必须可下载，实际 ' + JSON.stringify(c));
      const rel = String(c.url).split('/f/').pop();
      const dl = await H.httpReq('GET', R.baseUrl + '/f/' + rel, { timeoutMs: 60000 });
      assert.strictEqual(dl.status, 200, 'V43-⑤ 候选下载应 200，实际 ' + dl.status);
      const b = dl.buffer;
      const okPng = b.length > 1000 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
      const okJpg = b.length > 1000 && b[0] === 0xff && b[1] === 0xd8;
      assert.ok(okPng || okJpg, 'V43-⑤ 候选必须是真图（魔数实测），实际 ' + b.length + ' 字节 头 ' + b.subarray(0, 4).toString('hex'));
    }
  });

  it('V43-⑥ 人像预检：facegate 不可达要说"没检成"，不许说成"照片不合格"', { timeout: 8 * 60000 }, async (t) => {
    const miss = castPrereq().filter((m) => !/ffmpeg/.test(m));
    if (miss.length) {
      t.skip('【V43 真机】缺前置：' + miss.join('；') + ' —— §6.3 skip 纪律');
      return;
    }
    const fg = await startFacegate('precheck');
    R = await H.boot(RUN_ID + '-PRE', { runId: RUN_ID + '-PRE', env: { MB_FACEGATE_URL: fg.base, MB_WORKER_TOKEN: FG_TOKEN } });
    const g = await R.newGuest();
    const buf = fs.readFileSync(FIXTURE);
    const call = async () => R.api('POST', '/v1/mv/image/precheck', {
      token: g.token,
      multipart: { fields: {}, files: [{ field: 'file', filename: 'mv_lead_portrait.jpg', data: buf, contentType: 'image/jpeg' }] },
    });

    const up = await call();
    assert.strictEqual(up.status, 200, 'V43-⑥ 预检（facegate 在位）应 200，实际 ' + up.status + ' ' + String(up.text).slice(0, 200));
    const keys = (up.json.checks || []).map((c) => c.key);
    assert.ok(keys.includes('resolution'), 'V43-⑥ 分辨率项恒在，实际 keys=' + JSON.stringify(keys));
    assert.strictEqual(up.json.available, true, 'V43-⑥ facegate 在位时 available 必须 true，实际 ' + JSON.stringify(up.json).slice(0, 240));

    // 抽掉 facegate：不许把"我检不了"说成"你照片不合格"（也不许 500，契约 v2.22 明写）
    try { fg.child.kill('SIGKILL'); } catch (e) { /* 已退 */ }
    await new Promise((r) => setTimeout(r, 800));
    const down = await call();
    assert.strictEqual(down.status, 200, 'V43-⑥ facegate 不可达时预检不许 500（契约 v2.22 诚实降级），实际 ' + down.status + ' ' + String(down.text).slice(0, 200));
    assert.strictEqual(down.json.available, false,
      'V43-⑥ 不可达必须如实 available:false；把它报成"检过了"就是把失败藏进用户的损失里，实际 ' + JSON.stringify(down.json).slice(0, 240));
    const claimed = (down.json.checks || []).filter((c) => c.key !== 'resolution' && c.pass === true);
    assert.strictEqual(claimed.length, 0,
      'V43-⑥ 没检成的项不许报 pass=true（正脸/光照/遮挡），实际 ' + JSON.stringify(down.json.checks));
  });
});
