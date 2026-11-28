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
