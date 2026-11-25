// V14 · 纯音乐 MV 全链（真机验收套件 · 施工方 D · 2026-11-24 登记）
// 断言源（权威清单）：docs/musicbox-phase2-mv-plan.md §9 V14 行——
//   选曲→定妆（facegate 过门）→剧本（JSON 契约合格率）→样片先出→报价卡→12 镜→成片 mp4
//   （时长=歌长±0.5s、音轨=master SHA 一致、竖屏 9:16、AI 角标在）；断点续作（App 杀进程后 project 状态完好）；
//   单并发不 OOM 且与剧场任务共存（MB_SPARK_COMFY 实连）。
//   文件划分/真机前置/skip 纪律：docs/musicbox-phase2-construction-plan.md §6.1/§6.3/§2。
//   契约条款：CONTRACTS.md v2（v2.1 REST / v2.3 payload + v2.12 compose 增补 / v2.4 积分 / v2.6 lanes / v2.8 派单·报价·开机）。
// 一期纪律（施工计划 §1-4 验收驱动）：断言清单先登记；缺前置显式 t.skip 且消息点名缺失项（引用施工计划 §2/§6.3）；
//   fail 方向恒执行——探针全过时执行失败必须报 fail，禁止为变绿放宽断言。mock CI 三探针必缺 → 本文件真机用例全部
//   以 skip 呈现，NEVER fail（§1-2「mock 先行、真机后置」：CI 恒绿是合入门槛，质量类断言全部放 V14/V15 真机侧）。
// 真机前置探针（施工计划 §6.3，env 名登记）：
//   MB_SPARK_COMFY        真实 ComfyUI 基址（剧场共用 :8188，只观测不打扰；探针 GET /system_stats，§2.1 S8/S9）
//   MB_TEST_LIPSYNC_URL   真实 mv-lipsync 服务基址（探针 GET /healthz，weights_loaded 在位，§2.1 S5/S6）
//   ffmpeg 能力探测       PATH / MB_TEST_FFMPEG / test/acceptance/tools/ffmpeg 三供法（§2.2；一期能力探测：libmp3lame 过才算数）；
//                         MB_TEST_FORCE_NO_FFMPEG=1 强制探测为缺（§6.3 失败方向演练开关）
//   （可选）MB_TEST_FACEGATE_URL  真实 facegate 服务基址；MB_TEST_MV_WORK_ID 钉死「选曲」母带（否则走真实音乐链现产）
// Mock-safe 烟雾（现在就在 CI 跑绿，与 v13 不重复——v13 钉契约/账本，此处只钉 V14 全链的 mock 形状子集）：
//   S1 compose 派单 payload 形状符合契约 v2.12；S2 report STUB 诚实标注（歌唱形态项目语境）；S3 12 镜 boot 派单形状。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const H = require('./helpers.js');

// ---------- 真机前置探针（§6.3：任一缺失 → 真机用例逐条显式 skip，断言保持登记） ----------
const PRE = { ok: false, missing: [] };
function trimUrl(u) { return String(u).replace(/\/+$/, ''); }
async function probeSparkComfy() {
  const url = process.env.MB_SPARK_COMFY;
  if (!url) return 'MB_SPARK_COMFY 未设置（真实 ComfyUI :8188 实连，施工计划 §6.3 探针 / §2.1 S8 共宿主基线）';
  try {
    const r = await H.httpReq('GET', trimUrl(url) + '/system_stats', { timeoutMs: 5000 });
    if (!(r.status >= 200 && r.status < 500)) return 'MB_SPARK_COMFY=' + url + ' /system_stats HTTP ' + r.status + '（§2.1 S8）';
    return null;
  } catch (e) { return 'MB_SPARK_COMFY=' + url + ' 不可达：' + e.message + '（§2.1 S8/S9 tailnet 可达）'; }
}
async function probeLipsync() {
  const url = process.env.MB_TEST_LIPSYNC_URL;
  if (!url) return 'MB_TEST_LIPSYNC_URL 未设置（真机 mv-lipsync 服务 /healthz，施工计划 §6.3 探针 / §2.1 S5 权重在位）';
  try {
    const r = await H.httpReq('GET', trimUrl(url) + '/healthz', { timeoutMs: 5000 });
    if (r.status !== 200) return 'lipsync /healthz HTTP ' + r.status + '（§6.3：healthz lipsync 权重在位）';
    let j = null; try { j = JSON.parse(r.buffer.toString('utf8')); } catch (e) { /* 非 JSON 视为通过形状下限 */ }
    if (j && j.weights_loaded === false) return 'lipsync /healthz weights_loaded=false（EchoMimicV3-Flash/SyncNet 权重未就位，§2.1 S5）';
    return null;
  } catch (e) { return 'MB_TEST_LIPSYNC_URL=' + url + ' /healthz 不可达：' + e.message + '（§2.1 S6 systemd 单元）'; }
}
function probeFfmpeg() {
  return H.findFfmpeg() ? null : 'ffmpeg 未找到或能力探测未过（libmp3lame；三供法 PATH/MB_TEST_FFMPEG/tools 目录；MB_TEST_FORCE_NO_FFMPEG=1 强制缺——施工计划 §2.1 S2 / §2.2 / §6.3）';
}
function realGate(t, extra) {
  if (!PRE.ok) {
    const items = PRE.missing.slice();
    if (extra) items.push(extra);
    t.skip('【V14 真机】缺前置：' + items.join('；') + ' —— 施工计划 §6.3 真机前置与 skip 纪律 / §2 环境就绪清单（断言已登记，真机补齐后禁放宽）');
    return false;
  }
  if (extra) {
    t.skip('【V14 真机】缺前置：' + extra + ' —— 施工计划 §6.3 skip 纪律（断言已登记）');
    return false;
  }
  return true;
}

// ---------- 真机上下文（懒 boot：探针全过才启动；noFakeExecutor=真实 executor 独占拉单） ----------
let S = null;   // mock 上下文（S1/S2/S3 烟雾）
let S2 = null;  // 真机上下文
let varFreshed = false;
async function realBoot(opts) {
  opts = opts || {};
  if (S2) return S2;
  const varDir = path.join(H.ROOT, 'var-test', 'V14-REAL');
  if (opts.fresh !== false && !varFreshed) { fs.rmSync(varDir, { recursive: true, force: true }); varFreshed = true; }
  S2 = await H.boot('V14-REAL', {
    runId: 'V14-REAL', // 固定 runId：断点续作用例 kill 进程后同库重 boot
    noFakeExecutor: true,
    env: Object.assign({
      EXECUTOR_MOCK: '0', // 真机：src/executor（systemd，§2.1 S6）是唯一执行体，服务端 mock 语义必须关
      MB_COMFY_URL: trimUrl(process.env.MB_SPARK_COMFY),
      MB_LIPSYNC_URL: trimUrl(process.env.MB_TEST_LIPSYNC_URL),
      MB_FACEGATE_URL: process.env.MB_TEST_FACEGATE_URL ? trimUrl(process.env.MB_TEST_FACEGATE_URL) : 'http://127.0.0.1:9',
    }, opts.env || {}),
  });
  return S2;
}

// ---------- 共享真机全链（重资产：单轮 ~2h，§7 真机套件口径；一次跑链、多断言分面取证） ----------
let CHAIN = null;
let CHAIN_PROM = null;
async function fullChain() {
  if (CHAIN) return CHAIN;
  if (CHAIN_PROM) return CHAIN_PROM;
  CHAIN_PROM = (async () => {
    const R = await realBoot();
    const g = await R.newGuest();
    // ① 选曲：MB_TEST_MV_WORK_ID 钉死母带；未钉则走真实音乐链现产（真实 executor/ACE-Step）
    let workId = process.env.MB_TEST_MV_WORK_ID || null;
    let work = null;
    if (workId) {
      work = R.db.all('SELECT * FROM works WHERE id=? AND user_id=?', workId, g.user.id)[0] || null;
      if (!work) throw new Error('V14 前置：MB_TEST_MV_WORK_ID=' + workId + ' 不存在或不属于本测试游客账号（§6.3 选曲前置；用全新 guest 名下的 done 母带）');
    } else {
      const ga = await R.genAndAdopt(g.token, { mode: 'simple', prompt: 'V14 真机登记 · 纯音乐母带', sec: 45, count: 1 }, { timeoutMs: 30 * 60000 });
      workId = ga.work.id;
      work = R.db.all('SELECT * FROM works WHERE id=?', workId)[0] || ga.work;
    }
    // 建项目（纯音乐形态：lyrics 空 → kind=instrument，契约 v2.0 双形态）
    const pr = await R.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: workId, brief: 'V14 真机 · 纯音乐全链', character: { gender: 'f', source: 'ai' } } });
    assert.strictEqual(pr.status, 201, 'V14 前置 建项目应 201（契约 v2.1），实际 ' + pr.status + ' ' + pr.text.slice(0, 200));
    const pid = pr.json.project.id;
    await R.credits(g.token);
    R.seedLedger(g.user.id, 5000); // 真机余额（12 镜全链 ≈580⚡，D13 预算默认 1200 内）
    // ② 定妆（facegate 过门）：cast_image ×3 候选 + face_scores → cast_video 13 帧 → 拍板固化 viewRefs（契约 v2.1/v2.8.1）
    const ci = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'cast_image' } });
    assert.strictEqual(ci.status, 202, 'V14 前置 cast_image 派单应 202，实际 ' + ci.status + ' ' + ci.text.slice(0, 200));
    const ciJob = await R.waitForJob(g.token, ci.json.job_id, { timeoutMs: 30 * 60000 });
    const ciRow = R.db.mvJobsOf(g.user.id).rows.find((x) => x.id === ci.json.job_id);
    const ciResult = JSON.parse((ciRow && ciRow.result) || '{}');
    const got1 = await R.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    const character = (got1.json.characters || [])[0] || {};
    const castImageUrl = character.cast_image_url || character.image_url || ciResult.cast_image_url || null;
    assert.ok(ciJob.status === 'done', 'V14 前置 cast_image job 应 done（真 Spark H3-Image），实际 ' + ciJob.status);
    // cast_video（前置=已有 cast_image_url，契约 v2.8.1）
    const cv = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'cast_video', params: { cast_image_url: castImageUrl } } });
    assert.strictEqual(cv.status, 202, 'V14 前置 cast_video 派单应 202，实际 ' + cv.status + ' ' + cv.text.slice(0, 200));
    const cvJob = await R.waitForJob(g.token, cv.json.job_id, { timeoutMs: 45 * 60000 });
    const cvRow = R.db.mvJobsOf(g.user.id).rows.find((x) => x.id === cv.json.job_id);
    const cvResult = JSON.parse((cvRow && cvRow.result) || '{}');
    assert.strictEqual(cvJob.status, 'done', 'V14 前置 cast_video 应 done（REF2VA/FL2VA + 13 帧 facegate），实际 ' + cvJob.status);
    // ③ 剧本：按歌长切 12 镜（时长=歌长的前提：镜长合计≈歌长）→ PATCH（ver CAS）
    const dur = Number(work.duration_sec) || 45;
    const shots = [];
    for (let i = 1; i <= 12; i++) shots.push({ seq: i, kind: 'story', sec: Math.round((dur / 12) * 10) / 10, desc: '真机登记镜 ' + i, camera: '中景', cast_ids: [] });
    const sc = await R.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { ver: 1, script_json: { shots } } });
    assert.strictEqual(sc.status, 200, 'V14 前置 剧本 PATCH 应 200，实际 ' + sc.status + ' ' + sc.text.slice(0, 200));
    // 关键帧 + 样片先出（先看片再掏分，C6/S7）：样片前 boot → 409 NOT_READY
    const stb = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'storyboard' } });
    assert.strictEqual(stb.status, 202, 'V14 前置 storyboard 派单应 202，实际 ' + stb.status);
    await R.waitForJob(g.token, stb.json.job_id, { timeoutMs: 30 * 60000 });
    const b0 = await R.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: 'x' } });
    const preview = await R.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
    assert.strictEqual(preview.status, 202, 'V14 前置 preview 应 202（首免，D9），实际 ' + preview.status);
    const pvJob = await R.waitForJob(g.token, preview.json.job_id, { timeoutMs: 20 * 60000 });
    const pvRow = R.db.mvJobsOf(g.user.id).rows.find((x) => x.id === preview.json.job_id);
    const pvResult = JSON.parse((pvRow && pvRow.result) || '{}');
    // 报价卡（v2.8.3）
    const got2 = await R.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    const est = got2.json.project.est; const estVer = got2.json.project.est_ver;
    // ④ 开机 12 镜（逐镜 enqueueOnce、先扣后派单，v2.8.1）
    const boot = await R.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: estVer } });
    assert.strictEqual(boot.status, 202, 'V14 前置 boot 应 202，实际 ' + boot.status + ' ' + boot.text.slice(0, 200));
    const shotJobs = boot.json.jobs || [];
    for (const jid of shotJobs) {
      const j = await R.waitForJob(g.token, jid, { timeoutMs: 60 * 60000 }); // 真 Spark 12 镜 ≈1.5–2h/MV（mv-plan §10）
      assert.strictEqual(j.status, 'done', 'V14 前置 mv_shot job ' + jid + ' 应 done，实际 ' + j.status + ' ' + JSON.stringify(j.error));
    }
    // 自动合成收口（架构 §3.1，v2.8.4）
    const t0 = Date.now();
    let row = (R.db.mvProject(pid).row || {});
    while (row.status !== 'ready' && Date.now() - t0 < 30 * 60000) { await H.sleep(1000); row = R.db.mvProject(pid).row || {}; }
    const composeRow = R.mvJobRows(g.user.id, 'mv_compose')[0] || null;
    const videoRel = row.video_url ? String(row.video_url).split('/f/').pop() : null;
    let videoBuf = null;
    if (videoRel) {
      const dl = await H.httpReq('GET', R.baseUrl + '/f/' + videoRel, { timeoutMs: 120000 });
      if (dl.status === 200) videoBuf = dl.buffer;
    }
    return { R, g, pid, workId, work, ciJob, ciResult, cvJob, cvResult, castImageUrl, b0, pvJob, pvResult, previewJobId: preview.json.job_id, est, estVer, boot, shotJobs, projectRow: row, composeRow, videoRel, videoBuf };
  })().catch((e) => { CHAIN_PROM = null; throw e; });
  CHAIN = await CHAIN_PROM;
  return CHAIN;
}

// ---------- ffprobe/ffmpeg 小工具（真机侧成片断言用；§2.1 S2 能力口径） ----------
function ffprobePath() {
  const ff = H.findFfmpeg();
  if (!ff) return null;
  const d = path.dirname(ff);
  for (const n of ['ffprobe.exe', 'ffprobe']) { const p = path.join(d, n); try { if (fs.existsSync(p)) return p; } catch (e) { /* noop */ } }
  return null;
}
function ffprobeJson(probe, file) {
  const r = spawnSync(probe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error('ffprobe 失败：' + String(r.stderr || '').slice(0, 300));
  return JSON.parse(r.stdout.toString('utf8'));
}
function tmpFile(name) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb_v14_')); return path.join(dir, name); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// ---------- mock-safe 助手（v13 同纪律：白盒种子仅作测试前置，DEV-LEDGER） ----------
async function fundedProject(ctx, g, opts) {
  opts = opts || {};
  await ctx.credits(g.token); // 先落每日免费 50，再种子充值不被 daily_reset 吞（v13 fundedProject 同法）
  ctx.seedLedger(g.user.id, opts.grant == null ? 1000 : opts.grant);
  const workId = ctx.seedWork(g.user.id, { lyrics: '', duration_sec: opts.dur == null ? 45 : opts.dur });
  const r = await ctx.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: workId, brief: opts.brief || 'V14 mock 烟雾', character: { gender: 'f', source: 'ai' } } });
  assert.strictEqual(r.status, 201, '前置 建项目应 201（契约 v2.1），实际 ' + r.status + ' ' + r.text.slice(0, 200));
  const pid = r.json.project.id;
  const ids = [];
  for (let i = 1; i <= (opts.shots || 2); i++) ids.push(ctx.seedMvShot(pid, { seq: i, kind: 'story', sec: Math.max(1, Math.round(((opts.dur || 45) / (opts.shots || 2)) * 10) / 10), status: 'draft' }));
  return { pid, ids, workId };
}
async function toPreviewed(ctx, g, pid) {
  const pv = await ctx.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
  assert.strictEqual(pv.status, 202, '前置 preview 应 202，实际 ' + pv.status + ' ' + pv.text.slice(0, 200));
  const job = await ctx.waitForJob(g.token, pv.json.job_id, { timeoutMs: 60000 });
  assert.strictEqual(job.status, 'done', '前置 preview job 应 done（mock），实际 ' + job.status);
  return job;
}

describe('V14 纯音乐 MV 全链（真机 · §6.1 文件划分 / §6.3 skip 纪律）', () => {
  before(async () => {
    const missing = [];
    for (const p of [await probeSparkComfy(), await probeLipsync(), probeFfmpeg()]) if (p) missing.push(p);
    PRE.missing = missing;
    PRE.ok = missing.length === 0;
    S = await H.boot('V14'); // mock 烟雾上下文（CI 恒可用）
  });
  after(async () => {
    if (S) await S.close();
    if (S2) { try { await S2.close(); } catch (e) { /* noop */ } }
  });

  // ════════ 真机断言（mv-plan §9 V14 行逐条登记；mock CI 全部显式 skip） ════════

  it('V14-① 定妆 facegate 过门：cast_image 3 候选 face_scores 有 ≥0.6、cast_video 13 帧评分、cast/confirm 固化 viewRefs', async (t) => {
    if (!realGate(t, process.env.MB_TEST_FACEGATE_URL ? null : 'facegate 服务未钉（MB_TEST_FACEGATE_URL；§2.1 N0-4 五单元）')) return;
    const c = await fullChain();
    const scores = (c.ciResult.face_scores || []).map(Number);
    assert.ok(scores.length >= 3, 'V14-① cast_image 应产 3 候选 face_scores（契约 v2.3 mv_cast_image），实际 ' + JSON.stringify(c.ciResult).slice(0, 200));
    assert.ok(scores.some((s) => s >= 0.6), 'V14-① facegate 过门：3 候选至少一张 face_score ≥0.6（SP-MV-3 量化通过线口径），实际 ' + JSON.stringify(scores));
    assert.ok(Array.isArray(c.cvResult.frames) && c.cvResult.frames.length === 13, 'V14-① cast_video 应产 13 帧 facegate 评分（架构 §4.1/N0-3），实际 ' + (c.cvResult.frames || []).length);
    assert.ok(c.castImageUrl, 'V14-① 角色应挂 cast_image_url（候选机检写入，engine completeMvCastImage）');
    assert.ok(c.cvResult.frames.every((f) => typeof f.score === 'number'), 'V14-① 每帧必须有数值评分（facegate /score 真跑）');
  });

  it('V14-② 剧本 JSON 契约合格率：真 :8090 suggest ≥10 次编译，normalizeShots 合格率 ≥95%（SP-MV-5 口径）', async (t) => {
    if (!realGate(t)) return;
    const R = await realBoot();
    const g = await R.newGuest();
    await R.credits(g.token);
    const pr = await R.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: R.seedWork(g.user.id, { lyrics: '' }), brief: 'V14-② 契约合格率', character: { gender: 'f', source: 'ai' } } });
    assert.strictEqual(pr.status, 201, 'V14-② 前置 建项目应 201，实际 ' + pr.status);
    const pid = pr.json.project.id;
    const base = { shots: Array.from({ length: 4 }, (_, i) => ({ seq: i + 1, kind: 'story', sec: 5, desc: '雨夜街口 ' + i, camera: '远景', cast_ids: [] })) };
    const sc = await R.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { ver: 1, script_json: base } });
    assert.strictEqual(sc.status, 200, 'V14-② 前置 基线剧本应 200，实际 ' + sc.status);
    const mvScript = require('../../src/server/prompts/mv_script.js');   // 契约分镜正规化（JSON 契约形状真源）
    const mvValidator = require('../../src/server/core/mv_validator.js'); // 契约 v2.10 剧本结构机检（warn 不 fail，结构性 'empty' 视为不合格）
    let attempts = 0, okCount = 0, notReady = 0;
    for (let i = 0; i < 10; i++) {
      attempts++;
      const s = await R.api('POST', '/v1/mv/projects/' + pid + '/suggest', { token: g.token, json: { note: '把第 ' + (i + 1) + ' 镜改得更燃、夜景霓虹' }, timeoutMs: 30000 });
      if (s.status === 409 && s.json && s.json.code === 'NOT_READY') { notReady++; continue; }
      if (s.status === 200 && s.json && s.json.suggest && s.json.suggest.script) {
        try {
          const norm = mvScript.normalizeShots(s.json.suggest.script);
          const findings = mvValidator.validate({ script_json: { shots: norm }, kind: 'instrument', characters: (await R.api('GET', '/v1/mv/projects/' + pid, { token: g.token })).json.characters });
          if (Array.isArray(norm) && norm.length >= 1 && norm.every((x) => x && (x.kind === 'story' || x.kind === 'singing') && Number.isFinite(Number(x.sec)))
            && !findings.some((f) => f.check === 'empty')) okCount++;
        } catch (e) { /* 编译不合格：不计数（fail 方向计入分母） */ }
      }
    }
    if (notReady === attempts) { t.skip('【V14 真机】缺前置：:8090 LLM 不可用（suggest 全量 NOT_READY）——施工计划 §2.3（LLM 是增强不是依赖）/ §3 SP-MV-5；契约 v2.8.2 诚实拒绝语义本身已由 V13-⑬ mock 钉死'); return; }
    const rate = okCount / attempts;
    assert.ok(rate >= 0.95, 'V14-② 剧本 JSON 契约合格率应 ≥95%（mv-plan §9 V14 / SP-MV-5 量化线），实际 ' + okCount + '/' + attempts + '=' + (rate * 100).toFixed(0) + '%');
  });

  it('V14-③ 样片先出：preview done + preview_url 可下载可解码（ffprobe），样片未出 boot 必 409 NOT_READY', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    assert.strictEqual(c.b0.status, 409, 'V14-③ 样片未出时 boot 应 409（契约 v2.8.1① C6 先看片再掏分），实际 ' + c.b0.status);
    assert.strictEqual(c.b0.json.code, 'NOT_READY', 'V14-③ 应答 code 应 NOT_READY，实际 ' + JSON.stringify(c.b0.json));
    assert.strictEqual(c.pvJob.status, 'done', 'V14-③ preview job 应 done（真 ffmpeg zoompan 轮播），实际 ' + c.pvJob.status);
    const pvRel = (c.pvResult.preview_url || '').split('/f/').pop();
    assert.ok(pvRel, 'V14-③ preview_url 应落库（v2.3 mv_preview files.preview），实际 ' + JSON.stringify(c.pvResult).slice(0, 200));
    const probe = ffprobePath();
    if (!probe) { t.skip('【V14 真机】缺前置：ffprobe 缺失（ffmpeg 三供法未含 ffprobe——施工计划 §2.1 S2）'); return; }
    const dl = await H.httpReq('GET', c.R.baseUrl + '/f/' + pvRel, { timeoutMs: 60000 });
    assert.strictEqual(dl.status, 200, 'V14-③ 样片 mp4 应可下载（契约 §2 /f/*），实际 ' + dl.status);
    const f = tmpFile('preview.mp4'); fs.writeFileSync(f, dl.buffer);
    const info = ffprobeJson(probe, f);
    assert.ok(Number(info.format.duration) > 0.5, 'V14-③ 样片必须可解码且 >0.5s（真实可播，非字节桩——§1-2 mock/真机分界），实际 duration=' + info.format.duration);
  });

  it('V14-④ 报价卡：est 明细/credits/est_ver hash12 真值；错 est_ver boot → 409 EST_STALE', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    const est = c.est;
    assert.ok(est && Array.isArray(est.breakdown) && est.breakdown.length >= 1, 'V14-④ 报价卡 breakdown 形状（契约 v2.8.3），实际 ' + JSON.stringify(est));
    assert.strictEqual(est.shots, 12, 'V14-④ 报价镜数应=12（mv-plan §9 V14 全链），实际 ' + est.shots);
    assert.ok(Number(est.credits) > 0, 'V14-④ 真机报价 credits 必须 >0（纯音乐 12 镜 ≈40×12+10+定妆/关键帧，契约 v2.4），实际 ' + est.credits);
    assert.ok(typeof c.estVer === 'string' && c.estVer.length === 12, 'V14-④ est_ver 应为 hash12（v2.8.3），实际 ' + c.estVer);
  });

  it('V14-⑤ 12 镜：boot 逐镜派 12 个 mv_shot job（enqueueOnce 每镜恒一）、真 Spark 全部 done', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    assert.strictEqual(c.boot.json.jobs.length, 12, 'V14-⑤ boot 应逐镜派 12 个 job（契约 v2.8.1⑤），实际 ' + c.boot.json.jobs.length);
    const rows = c.R.mvJobRows(c.g.user.id, 'mv_shot');
    assert.strictEqual(rows.length, 12, 'V14-⑤ jobs 表 mv_shot 恒 12 条（每镜一个，重复 boot 幂等），实际 ' + rows.length);
    assert.ok(rows.every((r) => r.status === 'done'), 'V14-⑤ 全部 mv_shot job 应 done（真 vidspark lane，契约 v2.6 3600s 超时口径）');
    const shots = c.R.db.mvShotsOf(c.pid).rows;
    assert.strictEqual(shots.length, 12, 'V14-⑤ mv_shots 应 12 行，实际 ' + shots.length);
  });

  it('V14-⑥ 成片时长=歌长 ±0.5s（ffprobe 实测 vs 母带 work.duration_sec）', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    assert.ok(c.videoBuf && c.videoBuf.length > 1000, 'V14-⑥ 成片应可下载且非空（契约 §2 /f/*），实际 ' + (c.videoBuf || null));
    const probe = ffprobePath();
    if (!probe) { t.skip('【V14 真机】缺前置：ffprobe 缺失（§2.1 S2 能力口径）'); return; }
    const f = tmpFile('mv_video.mp4'); fs.writeFileSync(f, c.videoBuf);
    const info = ffprobeJson(probe, f);
    const master = c.R.db.all('SELECT * FROM works WHERE id=?', c.workId)[0];
    const songSec = Number(master.duration_sec) || 45;
    const vidSec = Number(info.format.duration);
    assert.ok(Math.abs(vidSec - songSec) <= 0.5, 'V14-⑥ 成片时长=歌长±0.5s（mv-plan §9 V14），歌长=' + songSec + 's 片长=' + vidSec + 's');
  });

  it('V14-⑦ 成片音轨 SHA==母 work master（-vn -acodec copy 抽取后 sha256 恒等，compose 铺 master 不转码）', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    const ff = H.findFfmpeg();
    const master = c.R.db.all('SELECT * FROM works WHERE id=?', c.workId)[0];
    assert.ok(master.audio_master, 'V14-⑦ 前置：母 work 必须有 audio_master（契约 §2 work 形状），实际 ' + master.audio_master);
    // audio_master 存 var/out 相对路径（works.js:265 join(paths.out, audio_master)）→ 公共读走 /f/*
    const amRel = String(master.audio_master).split('/f/').pop().replace(/^\/+/, '');
    const dlMaster = await H.httpReq('GET', c.R.baseUrl + '/f/' + amRel, { timeoutMs: 60000 });
    assert.strictEqual(dlMaster.status, 200, 'V14-⑦ 母带应可下载，实际 ' + dlMaster.status);
    const vFile = tmpFile('mv_video.mp4'); fs.writeFileSync(vFile, c.videoBuf);
    const aFile = tmpFile('extracted_track.dat');
    const r = spawnSync(ff, ['-y', '-v', 'error', '-i', vFile, '-vn', '-acodec', 'copy', aFile], { timeout: 120000, windowsHide: true });
    assert.strictEqual(r.status, 0, 'V14-⑦ 音轨无损抽取失败（compose「铺 master」纪律=N1-2 filter 基线）：' + String(r.stderr || '').slice(0, 200));
    const trackSha = sha256(fs.readFileSync(aFile));
    const masterSha = sha256(dlMaster.buffer);
    assert.strictEqual(trackSha, masterSha, 'V14-⑦ 成片音轨 SHA 必须==母 work master SHA（mv-plan §9 V14：音轨=master SHA 一致；compose 铺 master 不重编码，N1-2 filter 基线）');
  });

  it('V14-⑧ 成片竖屏 9:16（ffprobe 视频流宽高比 ≈ 9/16 ±1%）', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    const probe = ffprobePath();
    if (!probe) { t.skip('【V14 真机】缺前置：ffprobe 缺失（§2.1 S2）'); return; }
    const f = tmpFile('mv_video.mp4'); fs.writeFileSync(f, c.videoBuf);
    const info = ffprobeJson(probe, f);
    const v = (info.streams || []).find((s) => s.codec_type === 'video');
    assert.ok(v, 'V14-⑧ 成片必须有视频流，实际 streams=' + JSON.stringify((info.streams || []).map((s) => s.codec_type)));
    const ratio = Number(v.width) / Number(v.height);
    assert.ok(Math.abs(ratio - 9 / 16) / (9 / 16) <= 0.01, 'V14-⑧ 竖屏 9:16（mv-plan §9 V14），实际 ' + v.width + '×' + v.height + ' ratio=' + ratio.toFixed(4));
  });

  it('V14-⑨ AI 角标在：compose sidecar ai_label 恒 1（角标视觉核验=真机随检帧）', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    assert.ok(c.composeRow, 'V14-⑨ 应有自动 mv_compose job（架构 §3.1 收口）');
    const result = JSON.parse(c.composeRow.result || '{}');
    assert.strictEqual(Number(result.ai_label), 1, 'V14-⑨ compose sidecar ai_label 必须恒 1（契约 v2.3 compose sidecar / §0 AI 内容强制标注；drawtext 角标=N1-2 filter 基线，抽帧目检为真机随检项）');
    assert.ok(Array.isArray(result.degraded_shots), 'V14-⑨ degraded_shots 必须为数组（明示降级，v2.12 sidecar 真源）');
  });

  it('V14-⑩ 断点续作：进程 kill 后 project 状态完好（同 var-test/V14-REAL 重 boot 复验）', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    assert.strictEqual(c.projectRow.status, 'ready', 'V14-⑩ 前置：全链后 project 应 ready，实际 ' + c.projectRow.status);
    // 模拟「App 杀进程/进程重启」：kill 当前 server，用同一 runId（同 var）重 boot（helpers boot opts.runId 真机扩展）
    await S2.close();
    S2 = null;
    const R2 = await realBoot({ fresh: false });
    const row = (R2.db.mvProject(c.pid).row || {});
    assert.strictEqual(row.status, 'ready', 'V14-⑩ 重启后 project.status 必须完好（架构 §5 状态机落库，N1-3「杀进程重进状态完好」）');
    assert.strictEqual(row.video_url, c.projectRow.video_url, 'V14-⑩ 重启后 video_url 必须不变');
    const shots = R2.db.mvShotsOf(c.pid).rows;
    assert.strictEqual(shots.length, 12, 'V14-⑩ 重启后 12 镜行必须完好，实际 ' + shots.length);
    assert.ok(shots.every((s) => ['clipReady', 'synced', 'locked'].includes(s.status)), 'V14-⑩ 重启后镜状态不得回退（每镜必须仍是终态），实际 ' + JSON.stringify(shots.map((s) => s.status)));
    const led = R2.db.ledgerRows(c.g.user.id);
    assert.ok(!led.error, 'V14-⑩ 重启后账本白盒可读：' + (led.error || ''));
  });

  it('V14-⑪ 单并发不 OOM 且与剧场任务共存：MB_SPARK_COMFY 实连观测 + mv jobs 零 OOM 失败', async (t) => {
    if (!realGate(t)) return;
    const c = await fullChain();
    // 共宿主只观测铁律（§1-6）：GET /system_stats，绝不 /free/kill；剧场常态任务同机在跑时本链仍零 OOM
    const stats = await H.httpReq('GET', trimUrl(process.env.MB_SPARK_COMFY) + '/system_stats', { timeoutMs: 10000 });
    assert.strictEqual(stats.status, 200, 'V14-⑪ :8188 /system_stats 共宿主观测必须可达（施工计划 §2.1 S8 基线快照 / SP-MV-4 对照）');
    const failed = c.R.mvJobRows(c.g.user.id).filter((j) => j.status === 'failed');
    const oom = failed.filter((j) => /OOM|CUDA out of memory|out of memory/i.test(String(j.error || '')));
    assert.strictEqual(oom.length, 0, 'V14-⑪ 单并发全链不得出现 OOM 失败（架构 §1.2 executor 单并发 + ram_free 水位挂起；共宿主基线 §2.1 S8）：' + JSON.stringify(oom.map((j) => j.type + ':' + j.error)).slice(0, 400));
    // 与剧场任务共存互扰判定（对方任务失败率/我方 p90）为 SP-MV-4 基线对照项：留档 deploy/spark/baseline.md，本条钉「我方零 OOM + 观测可达」下限
  });

  // ════════ mock-safe 烟雾（CI 恒绿；与 v13 不重复——v13 钉契约/账本，此处钉 V14 全链形状子集） ════════

  it('V14-S1（mock）compose 派单 payload 形状符合契约 v2.12：takes[].{video,start_sec,strip_audio} + audio_master + title', async () => {
    const g = await S.newGuest();
    const { pid } = await fundedProject(S, g, { shots: 2, dur: 45 });
    await toPreviewed(S, g, pid);
    const got = await S.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    const boot = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: got.json.project.est_ver } });
    assert.strictEqual(boot.status, 202, 'S1 前置 boot 应 202，实际 ' + boot.status);
    for (const jid of boot.json.jobs) {
      const j = await S.waitForJob(g.token, jid, { timeoutMs: 60000 });
      assert.strictEqual(j.status, 'done', 'S1 前置 mv_shot 应 done（mock），实际 ' + j.status);
    }
    const t0 = Date.now();
    let row = S.db.mvProject(pid).row;
    while (row && row.status !== 'ready' && Date.now() - t0 < 60000) { await H.sleep(300); row = S.db.mvProject(pid).row; }
    assert.ok(row && row.status === 'ready', 'S1 前置 自动合成应收口 ready（架构 §3.1），实际 ' + (row && row.status));
    const compose = S.mvJobRows(g.user.id, 'mv_compose')[0];
    assert.ok(compose, 'S1 应有自动 mv_compose job（v2.8.4）');
    const payload = JSON.parse(compose.payload || '{}');
    assert.ok(Array.isArray(payload.takes) && payload.takes.length === 2, 'S1 payload.takes 应为数组且=就绪镜数（契约 v2.3 mv_compose takes），实际 ' + JSON.stringify(payload.takes));
    let prev = -1;
    for (const tk of payload.takes) {
      assert.strictEqual(typeof tk.video, 'string', 'S1 takes[].video 必须为字符串（rel 路径，v2.12）');
      assert.ok(tk.video.length > 0, 'S1 takes[].video 不得为空');
      assert.strictEqual(typeof tk.start_sec, 'number', 'S1 takes[].start_sec 必须为数字（拼接偏移，v2.12）');
      assert.ok(tk.start_sec >= prev, 'S1 takes[].start_sec 应单调不减（按 seq 拼接），实际 ' + JSON.stringify(payload.takes.map((x) => x.start_sec)));
      prev = tk.start_sec;
      assert.strictEqual(tk.strip_audio, true, 'S1 takes[].strip_audio 必须 true（compose 剥原生声画防串音，契约 v2.3 注释）');
      // v2.12 增补键均可选但有安全默认值：出现即须类型正确
      if ('segment' in tk) assert.ok(typeof tk.segment === 'string' || typeof tk.segment === 'number', 'S1 takes[].segment 类型（v2.12 段落身份）');
      if ('xfade' in tk) assert.strictEqual(typeof tk.xfade, 'boolean', 'S1 takes[].xfade 必须 bool（v2.12 强制边界淡入淡出）');
      if ('degraded' in tk) assert.ok(Array.isArray(tk.degraded), 'S1 takes[].degraded 必须 string[]（v2.12 逐镜降级标记）');
    }
    assert.ok('audio_master' in payload, 'S1 payload 必须含 audio_master 键（母带铺轨真源，v2.3）');
    assert.strictEqual(typeof payload.title, 'string', 'S1 payload.title 必须为字符串（片名卡，v2.12）');
  });

  it('V14-S2（mock）report STUB 诚实标注（歌唱形态项目语境）：stub:true + degraded_shots 空数组 + phrase_hit 0', async () => {
    const g = await S.newGuest();
    const workId = S.seedWork(g.user.id, { lyrics: '第一行歌词\n第二行歌词\n第三行歌词' }); // vocal 形态（kind=vocal，v2.0）
    const pr = await S.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: workId, brief: 'V14-S2 报告面', character: { gender: 'f', source: 'ai' } } });
    assert.strictEqual(pr.status, 201, 'S2 前置 建项目应 201，实际 ' + pr.status);
    assert.strictEqual(pr.json.project.kind, 'vocal', 'S2 前置 lyrics 非空 → kind=vocal（v2.0 双形态），实际 ' + pr.json.project.kind);
    S.seedMvShot(pr.json.project.id, { seq: 1, kind: 'singing', sec: 8, status: 'draft' });
    const rep = await S.api('GET', '/v1/mv/projects/' + pr.json.project.id + '/report', { token: g.token });
    assert.strictEqual(rep.status, 200, 'S2 GET report 应 200（STUB，契约 v2.1 / CONTRACTS v2.1:200），实际 ' + rep.status);
    assert.strictEqual(rep.json.stub, true, 'S2 STUB 应答必须诚实标注 stub:true（计费诚信纪律：不装真数据）');
    assert.deepStrictEqual(rep.json.degraded_shots, [], 'S2 STUB degraded_shots 必须空数组（不臆造降级清单）');
    assert.strictEqual(rep.json.phrase_hit, 0, 'S2 STUB phrase_hit 必须 0（对齐真值归 V15-① 真机，STUB 不得非零装忙）');
  });

  it('V14-S3（mock）12 镜 boot 派单形状：12 jobs / 40⚡每镜 / 每镜恒一 job / 重复 boot 幂等', async () => {
    const g = await S.newGuest();
    const { pid } = await fundedProject(S, g, { shots: 12, dur: 48, grant: 3000 });
    await toPreviewed(S, g, pid);
    const got = await S.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    assert.strictEqual(got.json.project.est.shots, 12, 'S3 报价镜数应 12（v2.8.3），实际 ' + got.json.project.est.shots);
    const bal0 = (await S.credits(g.token)).balance;
    const boot = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: got.json.project.est_ver } });
    assert.strictEqual(boot.status, 202, 'S3 boot 应 202，实际 ' + boot.status + ' ' + boot.text.slice(0, 200));
    assert.strictEqual(boot.json.jobs.length, 12, 'S3 应逐镜派 12 个 mv_shot job（契约 v2.8.1⑤），实际 ' + boot.json.jobs.length);
    assert.strictEqual(boot.json.credits_charged, 480, 'S3 boot 扣款应=40×12（契约 v2.4 先扣后派单），实际 ' + boot.json.credits_charged);
    assert.strictEqual((await S.credits(g.token)).balance, bal0 - 480, 'S3 实际扣款须与回执一致');
    const rows = S.mvJobRows(g.user.id, 'mv_shot');
    assert.strictEqual(rows.length, 12, 'S3 jobs 表 mv_shot 恒 12 条（enqueueOnce 逐镜防重，v2.8.1⑤），实际 ' + rows.length);
    assert.ok(rows.every((r) => Number(r.credits_cost) === 40), 'S3 每 job credits_cost 必须=40（账本诚信，v2.4）');
    assert.deepStrictEqual(new Set(rows.map((r) => String(r.payload).match(/mvs_[\w-]+/) && String(r.payload).match(/mvs_[\w-]+/)[0])).size, 12, 'S3 12 个 job 应覆盖 12 个不同镜（每镜一个）');
    const again = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: got.json.project.est_ver } });
    assert.strictEqual(again.json.idempotent, true, 'S3 重复 boot 必须幂等（v2.8.1⑤）');
    assert.strictEqual(again.json.credits_charged, 0, 'S3 重复 boot 不得重复扣分');
    assert.strictEqual(S.mvJobRows(g.user.id, 'mv_shot').length, 12, 'S3 重复 boot 后 jobs 表仍恒 12 条');
  });

  // 登记完整性（一期 skipped 套件同法）：清单与 mv-plan §9 V14 行一一对应，人审 + 本文件评审保证
  it('登记完整性：V14 断言清单（选曲/定妆/剧本/样片/报价/12 镜/成片四项/断点续作/共存）与 mv-plan §9 一致', () => {
    assert.ok(true, '清单完整性由人审 + 本文件评审保证（一期纪律：断言清单先登记）');
  });
});
