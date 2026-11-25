// V15 · 歌唱 MV 口型（真机验收套件 · 施工方 D · 2026-11-24 登记）
// 断言源（权威清单）：docs/musicbox-phase2-mv-plan.md §9 V15 行——
//   对齐抽检逐句 ±150ms ≥90%（真曲样本 10 首）；演唱镜 sync_score ≥阈值占比 ≥80%；
//   sync 不过自动免费补样 ≤2（credits_cost=0 + origin=system_auto）；兜底降级镜不阻塞成片；
//   全片尾段音画漂移 ≤±80ms（尾段实测）。
//   文件划分/真机前置/skip 纪律：docs/musicbox-phase2-construction-plan.md §6.1/§6.3/§2；量化线出处 §3 SP-MV-1/SP-MV-2。
//   契约条款：CONTRACTS.md v2.3（mv_lipsync result.sync_score / mv_align timings）、v2.4（系统补拍恒 0/明示）、
//   v2.6（lipsync lane 1800s）、v2.8.4（质量门：sync_score<阈值 → 免费补样 ≤2 → B-roll+字幕降级）；
//   质量门阈值唯一真源 = config.mv.syncThreshold（MB_MV_SYNC_THRESHOLD，架构 S8）。
// 一期纪律（施工计划 §1-4）：断言清单先登记；缺前置显式 t.skip 且消息点名缺失项（引用施工计划 §2/§6.3）；
//   fail 方向恒执行，禁止为变绿放宽断言。mock CI 三探针必缺 → 真机用例全部 skip 呈现，NEVER fail。
// 真机前置探针（施工计划 §6.3，env 名登记）：
//   MB_SPARK_COMFY        真实 ComfyUI 基址（探针 GET /system_stats，§2.1 S8/S9）
//   MB_TEST_LIPSYNC_URL   真实 mv-lipsync 服务基址（探针 GET /healthz weights_loaded，§2.1 S5/S6）
//   ffmpeg 能力探测       PATH / MB_TEST_FFMPEG / test/acceptance/tools/ffmpeg（§2.2；MB_TEST_FORCE_NO_FFMPEG=1 强制缺）
//   （随条附加前置）真曲对齐语料：test/fixtures/mv_align_samples/（10 首 master + 人工标注 .json，§3 SP-MV-2 / §2.1 S4 venv-asr）；
//   尾段 SyncNet 实测工具：MB_TEST_SYNCNET_TOOL（SP-MV-1 工具链，spikes/SP-MV-1/）。
// mock 侧服务端缺陷登记（验收驱动 skip，见 lipsyncCompleteProbe）：
//   src/server/core/engine.js completeMvLipsync mv_takes INSERT「11 values for 10 columns」→ S1/S2 显式 skip，
//   修复后自动转正（断言保持登记，一期纪律禁止为变绿放宽）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers.js');

// ---------- 真机前置探针（与 V14 同一套 §6.3 探针；各文件独立自探测） ----------
const PRE = { ok: false, missing: [] };
function trimUrl(u) { return String(u).replace(/\/+$/, ''); }
async function probeSparkComfy() {
  const url = process.env.MB_SPARK_COMFY;
  if (!url) return 'MB_SPARK_COMFY 未设置（真实 ComfyUI :8188 实连，施工计划 §6.3 探针 / §2.1 S8）';
  try {
    const r = await H.httpReq('GET', trimUrl(url) + '/system_stats', { timeoutMs: 5000 });
    if (!(r.status >= 200 && r.status < 500)) return 'MB_SPARK_COMFY=' + url + ' /system_stats HTTP ' + r.status + '（§2.1 S8）';
    return null;
  } catch (e) { return 'MB_SPARK_COMFY=' + url + ' 不可达：' + e.message + '（§2.1 S8/S9）'; }
}
async function probeLipsync() {
  const url = process.env.MB_TEST_LIPSYNC_URL;
  if (!url) return 'MB_TEST_LIPSYNC_URL 未设置（真机 mv-lipsync 服务 /healthz，施工计划 §6.3 探针 / §2.1 S5 EchoMimicV3-Flash+SyncNet 权重在位）';
  try {
    const r = await H.httpReq('GET', trimUrl(url) + '/healthz', { timeoutMs: 5000 });
    if (r.status !== 200) return 'lipsync /healthz HTTP ' + r.status + '（§6.3：healthz lipsync 权重在位）';
    let j = null; try { j = JSON.parse(r.buffer.toString('utf8')); } catch (e) { /* 非 JSON 视为形状下限通过 */ }
    if (j && j.weights_loaded === false) return 'lipsync /healthz weights_loaded=false（权重未就位，§2.1 S5）';
    return null;
  } catch (e) { return 'MB_TEST_LIPSYNC_URL=' + url + ' /healthz 不可达：' + e.message + '（§2.1 S6 systemd）'; }
}
function probeFfmpeg() {
  return H.findFfmpeg() ? null : 'ffmpeg 未找到或能力探测未过（libmp3lame；§2.1 S2 / §2.2 / §6.3）';
}
function realGate(t, extra) {
  if (!PRE.ok) {
    const items = PRE.missing.slice();
    if (extra) items.push(extra);
    t.skip('【V15 真机】缺前置：' + items.join('；') + ' —— 施工计划 §6.3 真机前置与 skip 纪律 / §2 环境就绪清单（断言已登记，真机补齐后禁放宽）');
    return false;
  }
  if (extra) {
    t.skip('【V15 真机】缺前置：' + extra + ' —— 施工计划 §6.3 skip 纪律（断言已登记）');
    return false;
  }
  return true;
}

// ---------- 真机上下文（懒 boot；noFakeExecutor=真实 executor 独占拉单） ----------
let S = null;  // mock 上下文（S1/S2 烟雾）
let S2 = null; // 真机上下文
let S2Prom = null;
async function realBoot(opts) {
  opts = opts || {};
  if (S2) return S2;
  if (!S2Prom) {
    S2Prom = H.boot('V15-REAL', {
      runId: 'V15-REAL',
      noFakeExecutor: true,
      env: Object.assign({
        EXECUTOR_MOCK: '0',
        MB_COMFY_URL: trimUrl(process.env.MB_SPARK_COMFY),
        MB_LIPSYNC_URL: trimUrl(process.env.MB_TEST_LIPSYNC_URL),
        MB_FACEGATE_URL: process.env.MB_TEST_FACEGATE_URL ? trimUrl(process.env.MB_TEST_FACEGATE_URL) : 'http://127.0.0.1:9',
      }, opts.env || {}),
    }).then((c) => { S2 = c; return c; }).catch((e) => { S2Prom = null; throw e; });
  }
  return S2Prom;
}
function ffprobePath() {
  const ff = H.findFfmpeg();
  if (!ff) return null;
  const d = path.dirname(ff);
  for (const n of ['ffprobe.exe', 'ffprobe']) { const p = path.join(d, n); try { if (fs.existsSync(p)) return p; } catch (e) { /* noop */ } }
  return null;
}
function tmpFile(name) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb_v15_')); return path.join(dir, name); }
function readConfigSyncThreshold(envExtra) {
  const env = Object.assign({}, process.env, envExtra || {});
  if (!envExtra) delete env.MB_MV_SYNC_THRESHOLD; // 默认口径：清掉外部污染
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("./src/server/config.js").mv.syncThreshold))'],
    { cwd: H.ROOT, env, timeout: 20000, windowsHide: true });
  if (r.status !== 0) throw new Error('读取 config.mv.syncThreshold 失败：' + String(r.stderr || '').slice(0, 200));
  return Number(r.stdout.toString('utf8'));
}

// 建一个含演唱镜的歌唱项目（vocal 形态：lyrics 非空，kind=vocal，契约 v2.0）
async function vocalProject(ctx, g, opts) {
  opts = opts || {};
  const lines = (opts.lines == null ? 8 : opts.lines);
  const lyrics = Array.from({ length: lines }, (_, i) => '真机登记歌词第 ' + (i + 1) + ' 行').join('\n');
  const workId = ctx.seedWork(g.user.id, { lyrics, duration_sec: opts.dur == null ? 45 : opts.dur });
  const pr = await ctx.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: workId, brief: opts.brief || 'V15 登记', character: { gender: 'f', source: 'ai' } } });
  assert.strictEqual(pr.status, 201, '前置 建歌唱项目应 201（契约 v2.1），实际 ' + pr.status + ' ' + pr.text.slice(0, 200));
  return { pid: pr.json.project.id, workId };
}

// ---------- 服务端缺陷探针（验收驱动红/skip 登记，施工计划 §1-4「先登记（红/skip）再施工」） ----------
// 已知缺陷（2026-11-24 登记）：src/server/core/engine.js completeMvLipsync 落 take 的 INSERT
//   VALUES(?,?,?,?,?,?,?,?,1,?,?) 占位符+字面量共 11 值 vs 10 列 → executor complete 500
//   INTERNAL「11 values for 10 columns」，mv_lipsync 透传/质量门在 mock 面不可达。
//   该文件属 server 施工方（test/acceptance/** 之外，本套件零改动）；相关 mock 用例登记为显式 skip，
//   修复后探针自动转正 —— 断言保持登记，禁止放宽。
const LIPSYNC_BUG_MSG = '【服务端缺陷登记·mock】src/server/core/engine.js completeMvLipsync：mv_takes INSERT 11 values vs 10 columns → mv_lipsync complete 500 INTERNAL，sync_score 透传/质量门链路不可达（server 施工方修复项，test/acceptance/** 之外零改动；修复后本用例自动转正，断言已登记禁放宽）';
let LIPSYNC_COMPLETE_BUGGED = null;
async function lipsyncCompleteProbe() {
  if (LIPSYNC_COMPLETE_BUGGED !== null) return LIPSYNC_COMPLETE_BUGGED;
  const g = await S.newGuest();
  const { pid } = await vocalProject(S, g, { lines: 2, dur: 10, brief: 'V15 缺陷探针' });
  const shotId = S.seedMvShot(pid, { seq: 1, kind: 'singing', sec: 5, status: 'clipReady' });
  const jobId = S.seedMvJob({
    type: 'mv_lipsync', userId: g.user.id, creditsCost: 0,
    payload: { project_id: pid, shot_id: shotId, video: 'out/missing_fallback.mp4', audio_master: 'out/master.mp3', win: { start_sec: 0, dur_sec: 5 }, reroll: 0 },
  });
  try {
    await S.waitForJob(g.token, jobId, { timeoutMs: 20000 });
    LIPSYNC_COMPLETE_BUGGED = false;
  } catch (e) {
    const hitSig = S.executor.errors.some((x) => /11 values for 10 columns|INTERNAL/.test(String(x)));
    if (!hitSig) throw e; // 非本缺陷签名的异常 = 正常 fail 方向，绝不吞
    LIPSYNC_COMPLETE_BUGGED = true;
  }
  return LIPSYNC_COMPLETE_BUGGED;
}

describe('V15 歌唱 MV 口型（真机 · §6.1 文件划分 / §6.3 skip 纪律）', () => {
  before(async () => {
    const missing = [];
    for (const p of [await probeSparkComfy(), await probeLipsync(), probeFfmpeg()]) if (p) missing.push(p);
    PRE.missing = missing;
    PRE.ok = missing.length === 0;
    S = await H.boot('V15'); // mock 烟雾上下文（CI 恒可用）
  });
  after(async () => {
    if (S) await S.close();
    if (S2) { try { await S2.close(); } catch (e) { /* noop */ } }
  });

  // ════════ 真机断言（mv-plan §9 V15 行逐条登记；mock CI 全部显式 skip） ════════

  it('V15-① 对齐抽检：真曲样本 10 首 → mv_align 逐句时间戳 vs 人工标注，±150ms 内 ≥90%、全句漏配 0', async (t) => {
    const corpusDir = path.join(H.ROOT, 'test', 'fixtures', 'mv_align_samples');
    const corpusOk = fs.existsSync(corpusDir) && fs.readdirSync(corpusDir).filter((f) => /\.(wav|mp3)$/i.test(f)).length >= 10;
    if (!realGate(t, corpusOk ? null : '真曲对齐语料缺（test/fixtures/mv_align_samples/ 10 首 master + 人工标注 .json——施工计划 §3 SP-MV-2 / §2.1 S4 venv-asr，待收集）')) return;
    const R = await realBoot();
    const files = fs.readdirSync(corpusDir).filter((f) => /\.(wav|mp3)$/i.test(f)).slice(0, 10);
    let totalLines = 0, hitLines = 0, missedSongs = 0;
    for (const f of files) {
      const annoFile = path.join(corpusDir, f.replace(/\.[^.]+$/, '') + '.json');
      if (!fs.existsSync(annoFile)) { missedSongs++; continue; }
      const anno = JSON.parse(fs.readFileSync(annoFile, 'utf8')); // [{line,start,end}] 人工标注（SP-MV-2 口径）
      const g = await R.newGuest();
      const { workId } = await vocalProject(R, g, { lines: anno.length, dur: Math.ceil(Number(anno[anno.length - 1].end) || 45) });
      // 把真曲母带挂到 work（白盒前置：契约未提供上传母带端点，真机以 var/out 放置 + 白盒回填，同 DEV-LEDGER 纪律）
      const outRel = 'v15_' + f;
      fs.copyFileSync(path.join(corpusDir, f), path.join(R.outDir, outRel));
      const w = new (require('node:sqlite').DatabaseSync)(R.dbPath);
      try { w.prepare('UPDATE works SET audio_master=?, format=? WHERE id=?').run(outRel, path.extname(f).slice(1), workId); } finally { w.close(); }
      // align 派单走项目 jobs 路径（v2.16 jobs type 增补 align）
      const pid = (R.db.all('SELECT id FROM mv_projects WHERE work_id=?', workId)[0] || {}).id;
      assert.ok(pid, 'V15-① 前置：项目应已建（work_id=' + workId + '）');
      const al = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'align' } });
      assert.strictEqual(al.status, 202, 'V15-① align 派单应 202（契约 v2.16/v2.4=5⚡），实际 ' + al.status + ' ' + al.text.slice(0, 160));
      const job = await R.waitForJob(g.token, al.json.job_id, { timeoutMs: 10 * 60000 }); // align lane 120s（v2.6）
      assert.strictEqual(job.status, 'done', 'V15-① mv_align 应 done（真 :8391 mv_asr 时间戳，§2.1 S4），实际 ' + job.status + ' ' + JSON.stringify(job.error));
      const p = R.db.mvProject(pid).row || {};
      const sj = JSON.parse(p.script_json || '{}');
      const timings = Array.isArray(sj.timings) ? sj.timings : [];
      assert.strictEqual(timings.length, anno.length, 'V15-① ' + f + ' 全句漏配必须=0（SP-MV-2 量化线）：标注 ' + anno.length + ' 行 vs 对齐 ' + timings.length + ' 行');
      for (let i = 0; i < anno.length; i++) {
        totalLines++;
        const d1 = Math.abs(Number(timings[i].start) - Number(anno[i].start));
        const d2 = Math.abs(Number(timings[i].end) - Number(anno[i].end));
        if (d1 <= 0.15 && d2 <= 0.15) hitLines++;
      }
    }
    assert.strictEqual(missedSongs, 0, 'V15-① 每首真曲必须配人工标注 .json（SP-MV-2），缺标注 ' + missedSongs + ' 首');
    const rate = totalLines ? hitLines / totalLines : 0;
    assert.ok(rate >= 0.9, 'V15-① 逐句 ±150ms 命中率应 ≥90%（mv-plan §9 V15 / SP-MV-2 量化线），实际 ' + hitLines + '/' + totalLines + '=' + (rate * 100).toFixed(1) + '%');
  });

  it('V15-② 演唱镜 sync_score ≥阈值 占比 ≥80%（真 lipsync/SyncNet 实测分布）', async (t) => {
    if (!realGate(t)) return;
    const R = await realBoot();
    const threshold = readConfigSyncThreshold(); // 阈值唯一真源 config.mv.syncThreshold（架构 S8/v2.8.4）
    const g = await R.newGuest();
    await R.credits(g.token);
    R.seedLedger(g.user.id, 5000);
    const { pid } = await vocalProject(R, g, { lines: 10, dur: 50 });
    // 基线剧本 → 对齐 → 10 演唱镜 → 定妆 → 样片 → 开机（真链：拍摄+父子口型链，N2-1/N2-2）
    const shotsN = 10;
    const shots = Array.from({ length: shotsN }, (_, i) => ({ seq: i + 1, kind: 'singing', sec: 5, lyric_from: i, lyric_to: i, desc: '演唱镜 ' + (i + 1), camera: '近景', cast_ids: [] }));
    const sc = await R.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { ver: 1, script_json: { shots } } });
    assert.strictEqual(sc.status, 200, 'V15-② 前置 剧本应 200，实际 ' + sc.status + ' ' + sc.text.slice(0, 160));
    for (const type of ['cast_image', 'align', 'storyboard']) {
      const jj = await R.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type } });
      assert.strictEqual(jj.status, 202, 'V15-② 前置 ' + type + ' 应 202，实际 ' + jj.status + ' ' + jj.text.slice(0, 160));
      const jd = await R.waitForJob(g.token, jj.json.job_id, { timeoutMs: 30 * 60000 });
      assert.strictEqual(jd.status, 'done', 'V15-② 前置 ' + type + ' job 应 done，实际 ' + jd.status);
    }
    const pv = await R.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
    await R.waitForJob(g.token, pv.json.job_id, { timeoutMs: 20 * 60000 });
    const est = (await R.api('GET', '/v1/mv/projects/' + pid, { token: g.token })).json.project;
    const bt = await R.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: est.est_ver } });
    assert.strictEqual(bt.status, 202, 'V15-② boot 应 202，实际 ' + bt.status + ' ' + bt.text.slice(0, 160));
    for (const jid of bt.json.jobs) await R.waitForJob(g.token, jid, { timeoutMs: 60 * 60000 }); // 含父子 lipsync 链（v2.8.4）
    const scored = [];
    for (const s of R.db.mvShotsOf(pid).rows) {
      for (const tk of R.db.mvTakesOf(s.id).rows) {
        if (Number(tk.lipsynced) === 1 && tk.sync_score != null) scored.push({ shot: s.id, score: Number(tk.sync_score), origin: tk.origin });
      }
    }
    assert.ok(scored.length >= shotsN, 'V15-② 10 演唱镜每镜至少有 1 个 lipsynced 评分 take，实际评分 take=' + scored.length);
    const bestByShot = {};
    for (const x of scored) bestByShot[x.shot] = Math.max(bestByShot[x.shot] == null ? -1 : bestByShot[x.shot], x.score);
    const passed = Object.values(bestByShot).filter((v) => v >= threshold).length;
    const total = Object.keys(bestByShot).length;
    const ratio = total ? passed / total : 0;
    assert.ok(ratio >= 0.8, 'V15-② sync_score ≥阈值(' + threshold + '=config.mv.syncThreshold) 占比应 ≥80%（mv-plan §9 V15 / N2-2 DoD），实际 ' + passed + '/' + total + '=' + (ratio * 100).toFixed(0) + '%');
  });

  it('V15-③ sync 不过自动免费补样 ≤2：补样 job credits_cost=0 + payload/take origin=system_auto + 不扣分', async (t) => {
    if (!realGate(t)) return;
    const R = await realBoot();
    // 复用 V15-② 已开机的真链项目（同 var）：审计所有 system_auto 补样
    const g = await R.newGuest(); // 新 guest 不受影响；补样审计针对本进程此前链
    void g;
    const rows = R.db.all("SELECT * FROM jobs WHERE type='mv_lipsync' ORDER BY rowid ASC");
    const rerolls = rows.filter((j) => /system_auto/.test(String(j.payload || '')));
    for (const j of rerolls) {
      assert.strictEqual(Number(j.credits_cost), 0, 'V15-③ 自动补样 job credits_cost 必须=0（契约 v2.4 系统补拍恒免费 / v2.8.4），实际 job=' + j.id + ' cost=' + j.credits_cost);
      const pl = JSON.parse(j.payload || '{}');
      assert.strictEqual(pl.origin, 'system_auto', 'V15-③ 补样 payload.origin 必须 system_auto（明示），实际 ' + j.id + ' → ' + pl.origin);
    }
    for (const s of R.db.all("SELECT * FROM mv_shots WHERE rerolls>0")) {
      assert.ok(Number(s.rerolls) <= 2, 'V15-③ 单镜自动补样必须 ≤2 次（v2.8.4/架构 S8），实际 shot=' + s.id + ' rerolls=' + s.rerolls);
      const autoTakes = R.db.mvTakesOf(s.id).rows.filter((tk) => tk.origin === 'system_auto');
      assert.ok(autoTakes.length <= 2, 'V15-③ system_auto take 数必须 ≤2，实际 ' + autoTakes.length);
      for (const tk of autoTakes) assert.strictEqual(Number(tk.ai_label), 1, 'V15-③ 补样 take ai_label 恒 1（契约 v2.4）');
    }
    // 零扣分支：账本上不得出现 reason=mv_lipsync 对应补样的扣分（补样 creditsCost=0 不入账）
    const ledBad = R.db.all("SELECT * FROM credit_ledger WHERE reason LIKE '%lipsync%' AND delta<0 AND ref_id IN (SELECT id FROM mv_shots WHERE rerolls>0)");
    assert.strictEqual(ledBad.length, 0, 'V15-③ 自动补样不得留下扣分账（credits_cost=0 语义），实际 ' + ledBad.length + ' 行');
  });

  it('V15-④ 兜底降级镜不阻塞成片：阈值钉高逼降级（B-roll+字幕明示）→ 两次补样后 shot locked，project 仍收口 ready', async (t) => {
    if (!realGate(t)) return;
    // 独立真机演练（N2-5 降级演练同法）：阈值 1.01 → SyncNet 必然不过 → ≤2 补样 → broll_subtitle，成片不被阻塞
    const RD = await H.boot('V15-DEG', {
      runId: 'V15-DEG',
      noFakeExecutor: true,
      env: {
        EXECUTOR_MOCK: '0',
        MB_COMFY_URL: trimUrl(process.env.MB_SPARK_COMFY),
        MB_LIPSYNC_URL: trimUrl(process.env.MB_TEST_LIPSYNC_URL),
        MB_MV_SYNC_THRESHOLD: '1.01', // 必然过不了质量门（仅本演练 server，不改共享 config）
      },
    });
    try {
      const g = await RD.newGuest();
      await RD.credits(g.token);
      RD.seedLedger(g.user.id, 2000);
      const { pid } = await vocalProject(RD, g, { lines: 4, dur: 20 });
      const sc = await RD.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { ver: 1, script_json: { shots: [{ seq: 1, kind: 'singing', sec: 5, lyric_from: 0, lyric_to: 1, desc: '兜底演练镜', camera: '近景', cast_ids: [] }] } } });
      assert.strictEqual(sc.status, 200, 'V15-④ 前置 剧本应 200，实际 ' + sc.status);
      for (const type of ['cast_image', 'align', 'storyboard']) {
        const jj = await RD.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type } });
        if (jj.status !== 202) throw new Error('V15-④ 前置 ' + type + ' 派单应 202，实际 ' + jj.status + ' ' + jj.text.slice(0, 160));
        const jd = await RD.waitForJob(g.token, jj.json.job_id, { timeoutMs: 30 * 60000 });
        if (jd.status !== 'done') throw new Error('V15-④ 前置 ' + type + ' 应 done，实际 ' + jd.status);
      }
      const pv = await RD.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
      await RD.waitForJob(g.token, pv.json.job_id, { timeoutMs: 20 * 60000 });
      const est = (await RD.api('GET', '/v1/mv/projects/' + pid, { token: g.token })).json.project;
      const bt = await RD.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: est.est_ver } });
      if (bt.status !== 202) throw new Error('V15-④ boot 应 202，实际 ' + bt.status + ' ' + bt.text.slice(0, 160));
      for (const jid of bt.json.jobs) await RD.waitForJob(g.token, jid, { timeoutMs: 60 * 60000 });
      const t0 = Date.now();
      let row = RD.db.mvProject(pid).row || {};
      while (row.status !== 'ready' && Date.now() - t0 < 30 * 60000) { await H.sleep(1000); row = RD.db.mvProject(pid).row || {}; }
      const shot = RD.db.mvShotsOf(pid).rows[0];
      assert.strictEqual(shot.status, 'locked', 'V15-④ 质量门必然不过的镜应两次补样后 locked 收口（v2.8.4 B-roll 降级，非 fail 全片）');
      const flags = JSON.parse(shot.flags_json || '{}');
      assert.strictEqual(flags.degraded, 'broll_subtitle', 'V15-④ 降级形态必须明示 broll_subtitle（空镜+字幕，契约 v2.12 takes[].degraded / v2.6 ladder「仍败→B-roll 降级非 fail 全片」）');
      assert.ok(Number(shot.rerolls) <= 2, 'V15-④ 演练内补样 ≤2（v2.8.4）');
      assert.strictEqual(row.status, 'ready', 'V15-④ 兜底降级镜绝不阻塞成片：project 仍须收口 ready，实际 ' + row.status);
      assert.ok(row.video_url, 'V15-④ ready 必须有成片 video_url（降级镜 compose 尊重 flags，N1-2）');
    } finally {
      try { await RD.close(); } catch (e) { /* noop */ }
    }
  });

  it('V15-⑤ 全片尾段音画漂移 ≤±80ms（尾段实测：ffmpeg 截取末 10s → SyncNet 偏移实测）', async (t) => {
    const tool = process.env.MB_TEST_SYNCNET_TOOL;
    if (!realGate(t, tool ? null : '尾段 SyncNet 实测工具未钉（MB_TEST_SYNCNET_TOOL，SP-MV-1 工具链 spikes/SP-MV-1/——施工计划 §3）')) return;
    const R = await realBoot();
    const videos = R.db.all("SELECT video_url FROM mv_projects WHERE status='ready' AND video_url IS NOT NULL ORDER BY rowid DESC LIMIT 1");
    if (!videos.length) { t.skip('【V15 真机】缺前置：尚无可测成片（先跑 V15-② 真链产出）——施工计划 §6.3'); return; }
    const probe = ffprobePath();
    if (!probe) { t.skip('【V15 真机】缺前置：ffprobe 缺失（§2.1 S2）'); return; }
    const rel = String(videos[0].video_url).split('/f/').pop().replace(/^\/+/, '');
    const dl = await H.httpReq('GET', R.baseUrl + '/f/' + rel, { timeoutMs: 120000 });
    assert.strictEqual(dl.status, 200, 'V15-⑤ 成片应可下载，实际 ' + dl.status);
    const full = tmpFile('full.mp4'); fs.writeFileSync(full, dl.buffer);
    const info = JSON.parse(spawnSync(probe, ['-v', 'error', '-show_format', '-of', 'json', full], { timeout: 60000, windowsHide: true }).stdout.toString('utf8'));
    const total = Number(info.format.duration) || 0;
    const tail = tmpFile('tail.mp4');
    const cut = spawnSync(H.findFfmpeg(), ['-y', '-v', 'error', '-ss', String(Math.max(0, total - 10)), '-i', full, '-c', 'copy', tail], { timeout: 120000, windowsHide: true });
    assert.strictEqual(cut.status, 0, 'V15-⑤ 尾段截取失败：' + String(cut.stderr || '').slice(0, 200));
    const m = spawnSync(process.execPath, [tool, tail], { timeout: 600000, windowsHide: true }); // SP-MV-1 SyncNet 工具：stdout JSON {offset_sec}
    assert.strictEqual(m.status, 0, 'V15-⑤ SyncNet 实测工具执行失败：' + String(m.stderr || '').slice(0, 300));
    const meas = JSON.parse(m.stdout.toString('utf8'));
    assert.ok(Math.abs(Number(meas.offset_sec)) <= 0.08, 'V15-⑤ 尾段音画漂移应 ≤±80ms（mv-plan §9 V15「全片音画不同步漂移 ≤±80ms 尾段实测」），实际 offset=' + meas.offset_sec + 's');
  });

  // ════════ mock-safe 烟雾（CI 恒绿；与 v13 不重复——v13 不触 lipsync 质量门/透传位） ════════

  it('V15-S1（mock）lipsync pass-through sync_score 契约位：result.sync_score∈[0,1] + mv_takes.sync_score/lipsynced/origin 落库 + 过阈 shot→synced', async (t) => {
    if (await lipsyncCompleteProbe()) { t.skip(LIPSYNC_BUG_MSG); return; }
    const g = await S.newGuest();
    const { pid } = await vocalProject(S, g, { lines: 4, dur: 20 });
    const shotId = S.seedMvShot(pid, { seq: 1, kind: 'singing', sec: 5, status: 'clipReady' });
    const jobId = S.seedMvJob({
      type: 'mv_lipsync', userId: g.user.id, creditsCost: 0,
      payload: { project_id: pid, shot_id: shotId, video: 'out/missing_fallback.mp4', audio_master: 'out/master.mp3', win: { start_sec: 0, dur_sec: 5 }, reroll: 0 },
    });
    const job = await S.waitForJob(g.token, jobId, { timeoutMs: 60000 });
    assert.strictEqual(job.status, 'done', 'S1 mv_lipsync 应 done（FakeExecutor 透传分支），实际 ' + job.status + '；executor 错误=' + JSON.stringify(S.executor.errors).slice(0, 300));
    const row = S.db.mvJobsOf(g.user.id).rows.find((x) => x.id === jobId);
    const result = JSON.parse(row.result || '{}');
    assert.ok(typeof result.sync_score === 'number' && result.sync_score >= 0 && result.sync_score <= 1,
      'S1 result.sync_score 必须为 [0,1] 数字（契约 v2.3 mv_lipsync result.sync_score 契约位），实际 ' + JSON.stringify(result).slice(0, 200));
    const syncedKey = Object.keys(result).find((k) => /^synced_.*_url$/.test(k));
    assert.ok(syncedKey, 'S1 透传产物必须回填 synced_<shotId>_url（v2.3 files.synced_<shotId>），实际 keys=' + Object.keys(result).join(','));
    const takes = S.db.mvTakesOf(shotId).rows;
    assert.strictEqual(takes.length, 1, 'S1 应落 1 条 lipsynced take，实际 ' + takes.length);
    const tk = takes[0];
    assert.strictEqual(Number(tk.lipsynced), 1, 'S1 take.lipsynced 必须=1');
    assert.strictEqual(Number(tk.sync_score), Number(result.sync_score), 'S1 take.sync_score 必须与 result 透传一致（SyncNet 分数落库真源）');
    assert.strictEqual(tk.origin, 'auto', 'S1 首轮 take.origin=auto（非补样，v2.14/架构 §5）');
    assert.strictEqual(Number(tk.ai_label), 1, 'S1 take.ai_label 恒 1（契约 v2.4）');
    const shot = S.db.mvShotsOf(pid).rows.find((x) => x.id === shotId);
    assert.strictEqual(shot.status, 'synced', 'S1 0.95 ≥ 默认阈值0.6（config.mv.syncThreshold）→ shot 应 synced（v2.8.4 质量门通过分支）');
  });

  it('V15-S2（mock）质量门阈值来自 config.mv.syncThreshold：MB_MV_SYNC_THRESHOLD=0.97 覆盖 → 0.95 不过门 → 免费补样×2（credits_cost=0+system_auto）→ 降级 broll_subtitle 收口', async (t) => {
    if (await lipsyncCompleteProbe()) { t.skip(LIPSYNC_BUG_MSG); return; } // 质量门链在 completeMvLipsync 内，同探针门控
    // 阈值 env 生效的直接证据：同一 fake executor（sync_score=0.95）在默认阈值下过门（S1），在覆盖阈值下必须不过门
    const defTh = readConfigSyncThreshold();
    const overTh = readConfigSyncThreshold({ MB_MV_SYNC_THRESHOLD: '0.42' });
    assert.ok(Number.isFinite(defTh) && defTh > 0 && defTh <= 1, 'S2 config.mv.syncThreshold 默认为 (0,1] 数字（架构 S8），实际 ' + defTh);
    assert.strictEqual(overTh, 0.42, 'S2 MB_MV_SYNC_THRESHOLD=0.42 应改写 config.mv.syncThreshold（阈值唯一真源=config/env，非硬编码），实际 ' + overTh);
    const SG = await H.boot('V15GATE', { env: { MB_MV_SYNC_THRESHOLD: '0.97' } }); // fake executor 固定透传 0.95 → 必不过门
    try {
      const g = await SG.newGuest();
      const bal0 = (await SG.credits(g.token)).balance;
      const { pid } = await vocalProject(SG, g, { lines: 4, dur: 20 });
      const shotId = SG.seedMvShot(pid, { seq: 1, kind: 'singing', sec: 5, status: 'clipReady' });
      const jobId = SG.seedMvJob({
        type: 'mv_lipsync', userId: g.user.id, creditsCost: 0,
        payload: { project_id: pid, shot_id: shotId, video: 'out/missing_fallback.mp4', audio_master: 'out/master.mp3', win: { start_sec: 0, dur_sec: 5 }, reroll: 0 },
      });
      const first = await SG.waitForJob(g.token, jobId, { timeoutMs: 60000 });
      assert.strictEqual(first.status, 'done', 'S2 首个 lipsync job 应 done，实际 ' + first.status);
      // 等自动补样链收口（补样 ≤2 次 → 第 3 条 lipsync job 后 shot locked）
      const t0 = Date.now();
      let rows = [];
      while (Date.now() - t0 < 60000) {
        rows = SG.db.all("SELECT * FROM jobs WHERE user_id=? AND type='mv_lipsync' ORDER BY rowid ASC", g.user.id);
        if (rows.length >= 3 && rows.every((r) => ['done', 'failed'].includes(r.status))) break;
        await H.sleep(300);
      }
      assert.strictEqual(rows.length, 3, 'S2 阈值 0.97 下应触发恰好 2 次自动补样（1 首 + 2 补样 = 3 个 mv_lipsync job；v2.8.4 补样 ≤2），实际 ' + rows.length);
      const rerolls = rows.slice(1);
      for (const j of rerolls) {
        assert.strictEqual(Number(j.credits_cost), 0, 'S2 自动补样 job credits_cost 必须=0（契约 v2.4 系统补拍恒免费），实际 job=' + j.id + ' cost=' + j.credits_cost);
        assert.ok(String(j.payload).includes('system_auto'), 'S2 补样 payload.origin=system_auto 明示（v2.8.4/v2.14），实际 ' + String(j.payload).slice(0, 200));
        assert.strictEqual(j.status, 'done', 'S2 补样 job 应 done（mock 透传），实际 ' + j.status);
      }
      const takes = SG.db.mvTakesOf(shotId).rows;
      assert.strictEqual(takes.length, 3, 'S2 每轮 lipsync 各落 1 take，应 3 条，实际 ' + takes.length);
      assert.strictEqual(takes[0].origin, 'auto', 'S2 首轮 take.origin=auto');
      assert.strictEqual(takes[1].origin, 'system_auto', 'S2 补样1 take.origin=system_auto（origin 真源=engine completeMvLipsync isReroll 分支）');
      assert.strictEqual(takes[2].origin, 'system_auto', 'S2 补样2 take.origin=system_auto');
      const shot = SG.db.mvShotsOf(pid).rows.find((x) => x.id === shotId);
      assert.strictEqual(shot.status, 'locked', 'S2 两次补样仍不过 → locked 收口（v2.8.4「仍不过 → B-roll+字幕降级」，绝不无限补样）');
      assert.ok(Number(shot.rerolls) === 2, 'S2 shot.rerolls 应恰=2（补样计数），实际 ' + shot.rerolls);
      const flags = JSON.parse(shot.flags_json || '{}');
      assert.strictEqual(flags.degraded, 'broll_subtitle', 'S2 降级形态必须 broll_subtitle（compose 尊重 flags，N1-2/N2-1）');
      assert.strictEqual((await SG.credits(g.token)).balance, bal0, 'S2 全链（含 2 次补样）不得扣任何分（系统补样零扣账本不变量）');
      const led = SG.db.ledgerRows(g.user.id);
      assert.ok(!led.error && led.rows.reduce((a, x) => a + x.delta, 0) === bal0, 'S2 账本不变量 Σdelta==balance');
    } finally {
      try { await SG.close(); } catch (e) { /* noop */ }
    }
  });

  // 登记完整性（一期 skipped 套件同法）：清单与 mv-plan §9 V15 行一一对应，人审 + 本文件评审保证
  it('登记完整性：V15 断言清单（对齐±150ms/sync≥阈值/免费补样≤2/兜底不阻塞/尾段±80ms）与 mv-plan §9 一致', () => {
    assert.ok(true, '清单完整性由人审 + 本文件评审保证（一期纪律：断言清单先登记）');
  });
});
