// V13 · MV 契约与账本（施工方 D · 2026-11-24，wave-2 升级）
// 断言源：CONTRACTS.md v2（v2.1 REST / v2.3 job payload / v2.4 积分 / v2.5 uploads / v2.6 lanes）
//         + v2.8-v2.11（派单·报价·开机·建议 / 剧本编译 / 卡审 / 预算护栏）。
//         docs/musicbox-phase2-mv-plan.md §9 V13；docs/musicbox-phase2-architecture-design.md §7 S11（mock 验收路径）。
// 纪律：mock-only——fake executor 产字节桩/ffmpeg mock 产物；严禁触 :8188/:8090/GPU（boot env 已把端点指向不可达）。
//       wave-2 起 jobs/preview/boot/shots-jobs/suggest 已落地 → 转为真断言（含 3 个原 skip 转正）；
//       wave-3 起 assistant/tickets（v2.13–v2.14）转正 → V13-① 对应断言改为契约新语义（完整治理断言归 V16）。
//       LLM/comfy 不可达时全套件必须保持 mock 绿。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const H = require('./helpers.js');

const MVlanes = require('../../src/server/lanes/index.js'); // 白盒读 server lane 表（V13 CI 断言 laneOf 路由）

let S; // boot 上下文

function sumDelta(ledger) { return ledger.rows.reduce((s, r) => s + r.delta, 0); }

// 建一个带 work 的 MV 项目（work 白盒种子：adopt 链依赖 ffmpeg transcode，V13 不依赖）
async function newProject(guest, opts) {
  opts = opts || {};
  const workId = S.seedWork(guest.user.id, { lyrics: opts.lyrics === undefined ? '' : opts.lyrics });
  const body = { work_id: workId, brief: opts.brief || '' };
  if (opts.character !== null) body.character = Object.assign({ gender: 'f', source: 'ai' }, opts.character || {});
  const r = await S.api('POST', '/v1/mv/projects', { token: guest.token, json: body });
  return { r, workId };
}
// 可开机项目：先触发每日免费（避免白盒账本种子被 daily_reset 过期吞掉），再充值 + 播镜
async function fundedProject(guest, opts) {
  opts = opts || {};
  await S.credits(guest.token); // 触发 ensureDaily（先落 50 免费，再种子充值才不会被 daily_expire 吞）
  S.seedLedger(guest.user.id, opts.grant == null ? 1000 : opts.grant);
  const { r } = await newProject(guest, opts);
  const pid = r.json.project.id;
  const ids = [];
  for (let i = 1; i <= (opts.shots || 2); i++) ids.push(S.seedMvShot(pid, { seq: i, kind: opts.shotKind || 'story', status: 'draft' }));
  return { r, pid, ids };
}
// 走到「样片已出+报价卡就绪」：preview 首免 → done → status=previewed + est/est_ver
async function toPreviewed(g, pid) {
  const c0 = (await S.credits(g.token)).balance;
  const pv = await S.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
  assert.strictEqual(pv.status, 202, 'V13 preview 派单应 202，实际 ' + pv.status + ' ' + pv.text.slice(0, 200));
  assert.strictEqual(pv.json.credits_charged, 0, 'V13 样片每项目首次免费（D9），实际扣 ' + pv.json.credits_charged);
  assert.strictEqual((await S.credits(g.token)).balance, c0, 'V13 首免不得扣分');
  const job = await S.waitForJob(g.token, pv.json.job_id, { timeoutMs: 60000 });
  assert.strictEqual(job.status, 'done', 'V13 preview job 应 done，实际 ' + job.status);
  return pv.json.job_id;
}

describe('V13 MV 契约与账本（mock）', () => {
  before(async () => { S = await H.boot('V13'); });
  after(async () => { if (S) await S.close(); });

  it('V13-① 派单幂等（契约 v2.8.1）：重复 shoot 返回同一 job、只扣一次；延期项继续 404', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g);
    assert.strictEqual(r.status, 201, 'V13-① POST /v1/mv/projects 应 201 {project}（契约 v2.1），实际 ' + r.status + ' ' + r.text.slice(0, 200));
    const pid = r.json.project.id;
    const shotId = S.seedMvShot(pid, { seq: 1, kind: 'story', status: 'draft' });
    S.setMvProject(pid, { status: 'scripting' });
    // cast_image 派单：10⚡ 先扣后派单
    const ci = await S.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'cast_image' } });
    assert.strictEqual(ci.status, 202, 'V13-① jobs{cast_image} 应 202，实际 ' + ci.status + ' ' + ci.text.slice(0, 200));
    assert.strictEqual(ci.json.credits_charged, 10, 'V13-① cast_image=10⚡/角色（契约 v2.4），实际 ' + ci.json.credits_charged);
    const c0 = await S.credits(g.token);
    // 重复 shoot（同参幂等键=hash(user+project+type+ver+params)）→ 同 job 单扣
    const s1 = await S.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'shoot', params: { shot_id: shotId } } });
    assert.strictEqual(s1.status, 202, 'V13-① jobs{shoot} 应 202，实际 ' + s1.status + ' ' + s1.text.slice(0, 200));
    assert.strictEqual(s1.json.credits_charged, 40, 'V13-① shoot=40⚡/镜（契约 v2.4），实际 ' + s1.json.credits_charged);
    const s2 = await S.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'shoot', params: { shot_id: shotId } } });
    assert.strictEqual(s2.status, 202, 'V13-① 重复 shoot 应 202（幂等复用，不得 4xx）');
    assert.strictEqual(s2.json.job_id, s1.json.job_id, 'V13-① 重复 shoot 必须返回同一 job（幂等），实际 ' + s2.json.job_id + ' ≠ ' + s1.json.job_id);
    assert.strictEqual(s2.json.credits_charged, 0, 'V13-① 幂等命中不得重复扣分');
    assert.strictEqual(s2.json.idempotent, true, 'V13-① 幂等命中应标 idempotent:true');
    const c1 = await S.credits(g.token);
    assert.strictEqual(c1.balance, c0.balance - 40, 'V13-① 重复 shoot 全程只扣一次 40，before=' + c0.balance + ' after=' + c1.balance);
    const shotJobRows = S.mvJobRows(g.user.id, 'mv_shot').filter((x) => String(x.payload).includes(shotId));
    assert.strictEqual(shotJobRows.length, 1, 'V13-① 同镜重复派单 jobs 表恒一条 mv_shot（enqueueOnce 语义），实际 ' + shotJobRows.length);
    const led = S.db.ledgerRows(g.user.id);
    assert.strictEqual(led.rows.filter((x) => x.delta < 0 && /mv_shot/.test(x.reason || '')).length, 1, 'V13-① 账本 mv_shot 扣分行恒 1，实际=' + JSON.stringify(led.rows));
    // wave-3 转正（契约 v2.13–v2.14）：assistant 规则模式 200（聊天灰度关→meta.mode 如实 'rule'）；
    // 不存在的确认票 → 404（五连校验前的归属/存在性校验，V16 覆盖完整票据生命周期）
    const asst = await S.api('POST', '/v1/mv/assistant/messages', { token: g.token, json: { text: '进度如何', chips: [{ type: 'project', id: pid }] } });
    assert.strictEqual(asst.status, 200, 'V13-① assistant 已按 v2.13 转正，规则模式应 200，实际 ' + asst.status + ' ' + asst.text.slice(0, 200));
    assert.ok(asst.json && asst.json.session_id && asst.json.meta && asst.json.meta.mode === 'rule',
      'V13-① 灰度关时必须诚实规则模式（绝不冒充 LLM，v2.13），实际 ' + JSON.stringify(asst.json).slice(0, 200));
    const tick = await S.api('POST', '/v1/mv/tickets/t_1/confirm', { token: g.token, json: {} });
    assert.strictEqual(tick.status, 404, 'V13-① 不存在的确认票必须 404（契约 v2.14），实际 ' + tick.status);
    const badType = await S.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'hack' } });
    assert.strictEqual(badType.status, 400, 'V13-① 未知 jobs.type 必须 400 BAD_REQUEST（不得半实现），实际 ' + badType.status);
  });

  it('V13-② 报价未 accept 不扣分：建项目全程 0 扣分（账本白盒不变量）', async () => {
    const g = await S.newGuest();
    const c0 = await S.credits(g.token);
    assert.strictEqual(c0.balance, 50, 'V13-② 前置：游客余额应为 50，实际 ' + c0.balance);
    const { r, workId } = await newProject(g, { lyrics: '第一行歌词\n第二行歌词' }); // 歌唱曲形态
    assert.strictEqual(r.status, 201, 'V13-② 建项目应 201，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.strictEqual(r.json.project.kind, 'vocal', 'V13-② lyrics 非空 → kind=vocal（契约 v2.0 双形态），实际 ' + r.json.project.kind);
    const c1 = await S.credits(g.token);
    assert.strictEqual(c1.balance, 50, 'V13-② 建项目免积分（契约 v2.1"免积分"；报价未 accept 更不扣分），balance 应仍 50，实际 ' + c1.balance);
    const led = S.db.ledgerRows(g.user.id);
    assert.ok(!led.error, 'V13-② 白盒读账本失败：' + led.error);
    assert.strictEqual(sumDelta(led), c1.balance, 'V13-② 不变量 Σledger.delta==balance 破坏：Σ=' + sumDelta(led) + ' balance=' + c1.balance);
    const mvCharges = led.rows.filter((x) => x.delta < 0 && !/daily_expire/.test(x.reason || ''));
    assert.strictEqual(mvCharges.length, 0, 'V13-② MV 建项目不得产生任何扣分账（含未 accept 报价），实际扣分行=' + JSON.stringify(mvCharges));
  });

  it('V13-③ 取消未拍镜全额 refund：按账本核算恒 ≥0、金额精确、不重复退', async () => {
    // (a) 无扣费历史 → refunded 恒 0（不臆造退款）
    const g = await S.newGuest();
    const { r } = await newProject(g);
    const pid = r.json.project.id;
    S.seedMvShot(pid, { seq: 1, kind: 'story', status: 'draft' });
    S.seedMvShot(pid, { seq: 2, kind: 'singing', status: 'draft' });
    const c1 = await S.credits(g.token);
    const canc = await S.api('POST', '/v1/mv/projects/' + pid + '/cancel', { token: g.token, json: {} });
    assert.strictEqual(canc.status, 200, 'V13-③ POST cancel 应 200 {refunded}（契约 v2.1），实际 ' + canc.status + ' ' + canc.text.slice(0, 200));
    assert.ok(Number.isInteger(canc.json.refunded) && canc.json.refunded >= 0, 'V13-③ refunded 必须为 ≥0 整数（账本核算，不臆造退款），实际 ' + JSON.stringify(canc.json));
    const got = await S.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    assert.strictEqual(got.status, 200, 'V13-③ GET /v1/mv/projects/:id 应 200（契约 v2.1），实际 ' + got.status);
    assert.strictEqual(got.json.project.status, 'canceled', 'V13-③ 取消后 project.status 应为 canceled（架构 §5 状态机），实际 ' + got.json.project.status);
    const c2 = await S.credits(g.token);
    assert.ok(c2.balance >= c1.balance, 'V13-③ 取消只增不减余额（refund 语义），before=' + c1.balance + ' after=' + c2.balance);
    const led = S.db.ledgerRows(g.user.id);
    assert.strictEqual(sumDelta(led), c2.balance, 'V13-③ 取消后不变量 Σdelta==balance 破坏，Σ=' + sumDelta(led) + ' balance=' + c2.balance);
    const canc2 = await S.api('POST', '/v1/mv/projects/' + pid + '/cancel', { token: g.token, json: {} });
    assert.strictEqual(canc2.json.refunded, 0, 'V13-③ 重复取消不得重复退款，实际 ' + JSON.stringify(canc2.json));
    // (b) wave-2 转正：有派单扣费（ref=(mv_project,pid)）→ 未拍镜全额退、金额=min(reserved, 已扣未退净额)
    const g2 = await S.newGuest();
    await S.credits(g2.token); // 先落每日免费，再种子扣分账
    const { r: r2 } = await newProject(g2);
    const pid2 = r2.json.project.id;
    S.seedMvShot(pid2, { seq: 1, kind: 'story', status: 'draft' });     // 未拍 → reserved 40
    S.seedMvShot(pid2, { seq: 2, kind: 'story', status: 'clipReady' }); // 已拍 → 不退
    S.seedLedger(g2.user.id, -40, { reason: 'mv_shot', refType: 'mv_project', refId: pid2 });
    const c3 = await S.credits(g2.token);
    assert.strictEqual(c3.balance, 10, 'V13-③(b) 前置：50-40=10，实际 ' + c3.balance);
    const canc3 = await S.api('POST', '/v1/mv/projects/' + pid2 + '/cancel', { token: g2.token, json: {} });
    assert.strictEqual(canc3.status, 200);
    assert.strictEqual(canc3.json.refunded, 40, 'V13-③(b) 未拍镜应全额退 40（reserved=40/镜 且账本可退=40），实际 ' + canc3.json.refunded);
    const c4 = await S.credits(g2.token);
    assert.strictEqual(c4.balance, 50, 'V13-③(b) 退款后余额回到 50，实际 ' + c4.balance);
    const led2 = S.db.ledgerRows(g2.user.id);
    assert.strictEqual(sumDelta(led2), c4.balance, 'V13-③(b) 不变量破坏，Σ=' + sumDelta(led2) + ' balance=' + c4.balance);
    const canc4 = await S.api('POST', '/v1/mv/projects/' + pid2 + '/cancel', { token: g2.token, json: {} });
    assert.strictEqual(canc4.json.refunded, 0, 'V13-③(b) 重复取消仍恒 0（不重复退）');
  });

  it('V13-④ 系统补拍 credits_cost=0：user 发起=计费(40)；system 发起=0 分+origin system_auto+审计', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g);
    const pid = r.json.project.id;
    const shotId = S.seedMvShot(pid, { seq: 1, kind: 'singing', status: 'clipReady' });
    const cols = S.db.columns('mv_takes');
    assert.ok(cols.includes('origin'), 'V13-④ mv_takes 必须含 origin 列（auto|system_auto|user_reshoot，契约 v2/架构 §5）');
    assert.ok(cols.includes('ai_label'), 'V13-④ mv_takes 必须含 ai_label 列（成片/补拍标记，契约 v2.4 系统补拍恒免费+标注）');
    await S.credits(g.token); // 先落每日免费 50
    // user 发起重拍：40⚡（契约 v2.8.1）
    const c0 = (await S.credits(g.token)).balance;
    const ur = await S.api('POST', '/v1/mv/shots/' + shotId + '/jobs', { token: g.token, json: { type: 'reshoot', reason: '不像本人' } });
    assert.strictEqual(ur.status, 202, 'V13-④ user reshoot 应 202，实际 ' + ur.status + ' ' + ur.text.slice(0, 200));
    assert.strictEqual(ur.json.credits_charged, 40, 'V13-④ user reshoot=40⚡（mv_shot 价），实际 ' + ur.json.credits_charged);
    assert.strictEqual((await S.credits(g.token)).balance, c0 - 40, 'V13-④ user reshoot 应扣 40');
    const urRow = S.mvJobRows(g.user.id, 'mv_shot').find((x) => x.id === ur.json.job_id);
    assert.ok(urRow && Number(urRow.credits_cost) === 40, 'V13-④ user reshoot job.credits_cost 应=40（失败可全退），实际 ' + (urRow && urRow.credits_cost));
    const urTakes = await S.waitForJob(g.token, ur.json.job_id, { timeoutMs: 60000 });
    assert.strictEqual(urTakes.status, 'done', 'V13-④ user reshoot 应 done（mock），实际 ' + urTakes.status);
    assert.ok(S.db.mvTakesOf(shotId).rows.some((t) => t.origin === 'user_reshoot'), 'V13-④ user 重拍 take.origin 应=user_reshoot');
    // system 发起：0 分 + credits_cost=0 + origin system_auto + 审计 initiated_by=system（契约 v2.4 系统补拍恒免费）
    const c1 = (await S.credits(g.token)).balance;
    const sr = await S.api('POST', '/v1/mv/shots/' + shotId + '/jobs', { token: g.token, json: { type: 'reshoot', initiated_by: 'system', reason: '不像本人' } });
    assert.strictEqual(sr.status, 202, 'V13-④ system reshoot 应 202，实际 ' + sr.status + ' ' + sr.text.slice(0, 200));
    assert.strictEqual(sr.json.credits_charged, 0, 'V13-④ system reshoot 恒免费（credits_charged=0），实际 ' + sr.json.credits_charged);
    assert.strictEqual((await S.credits(g.token)).balance, c1, 'V13-④ system reshoot 不得扣分');
    const srRow = S.mvJobRows(g.user.id, 'mv_shot').find((x) => x.id === sr.json.job_id);
    assert.ok(srRow && Number(srRow.credits_cost) === 0, 'V13-④ system reshoot job.credits_cost 必须=0（账本诚信），实际 ' + (srRow && srRow.credits_cost));
    assert.ok(String(srRow.payload).includes('system_auto'), 'V13-④ system 补拍 payload 应标 origin=system_auto（明示）');
    const srJob = await S.waitForJob(g.token, sr.json.job_id, { timeoutMs: 60000 });
    assert.strictEqual(srJob.status, 'done', 'V13-④ system reshoot 应 done');
    assert.ok(S.db.mvTakesOf(shotId).rows.some((t) => t.origin === 'system_auto'), 'V13-④ system 补拍 take.origin 应=system_auto');
    const aud = S.db.auditRowsLike('mv.shot.system_action');
    assert.ok(!aud.error && aud.hits.length > 0, 'V13-④ system 补拍必须落审计 initiated_by=system，实际 ' + (aud.error || aud.hits.length + ' hits'));
    // chips 诊断链（§5.3 reason_history 单一真源）
    const shotRow = S.db.mvShotsOf(pid).rows.find((x) => x.id === shotId);
    const hist = JSON.parse(shotRow.reason_history || '[]');
    assert.ok(hist.some((h) => h.chip === '不像本人' && h.billed === true), 'V13-④ chips 应入 reason_history（含计费标记），实际 ' + shotRow.reason_history);
  });

  it('V13-⑤ mv 产物 ai_label 恒 1：项目默认 + mock compose 结果标记', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g);
    const p = r.json.project;
    assert.strictEqual(p.ai_label, true, 'V13-⑤ project.ai_label 必须恒 true（契约 §0/v2：AI 生成内容强制标注），实际 ' + p.ai_label);
    const dbp = S.db.mvProject(p.id);
    assert.ok(!dbp.error && dbp.row, 'V13-⑤ 白盒读 mv_projects 失败：' + (dbp.error || 'null'));
    assert.strictEqual(Number(dbp.row.ai_label), 1, 'V13-⑤ 落库 ai_label 必须=1（架构 §5 DDL 默认值），实际 ' + dbp.row.ai_label);
    // mock compose：fake executor 产物必须带 ai_label=1（result 白盒读 jobs.result）
    const jobId = S.seedMvJob({ type: 'mv_compose', payload: { takes: [], audio_master: 'x', title: 'T' }, userId: g.user.id });
    const job = await S.waitForJob(g.token, jobId, { timeoutMs: 60000 });
    assert.strictEqual(job.status, 'done', 'V13-⑤ mock mv_compose job 应 done，实际 ' + job.status + ' ' + JSON.stringify(job.error));
    const jr = S.db.mvJobsOf(g.user.id).rows.find((x) => x.id === jobId);
    const result = JSON.parse(jr.result || '{}');
    assert.strictEqual(result.ai_label, 1, 'V13-⑤ mv_compose mock 结果必须带 ai_label=1（契约 v2.3 compose sidecar），实际 ' + JSON.stringify(result).slice(0, 200));
  });

  it('V13-⑥ 人像上传：consent 缺失 400；魔数/去重；72h TTL 白盒', async () => {
    const g = await S.newGuest();
    const png = H.makePng();
    const noConsent = await S.api('POST', '/v1/mv/image', {
      token: g.token, multipart: { fields: {}, files: [{ field: 'file', filename: 'portrait.png', data: png, contentType: 'image/png' }] },
    });
    assert.strictEqual(noConsent.status, 400, 'V13-⑥ consent 缺失必须 400（契约 v2.5 consent 前置/PIPL），实际 ' + noConsent.status + ' ' + noConsent.text.slice(0, 200));
    assert.ok(noConsent.json && noConsent.json.code, 'V13-⑥ 400 应答须 {code,message}（契约 §0 错误约定），实际 ' + noConsent.text.slice(0, 200));
    const badMagic = await S.api('POST', '/v1/mv/image', {
      token: g.token, multipart: { fields: { consent: 'true' }, files: [{ field: 'file', filename: 'portrait.png', data: Buffer.from('这不是图片内容'), contentType: 'image/png' }] },
    });
    assert.strictEqual(badMagic.status, 400, 'V13-⑥ 魔数不符（非 FFD8FF/89504E47）必须 400（契约 v2.5 上传防线），实际 ' + badMagic.status);
    const ok1 = await S.api('POST', '/v1/mv/image', {
      token: g.token, multipart: { fields: { consent: 'true' }, files: [{ field: 'file', filename: 'portrait.png', data: png, contentType: 'image/png' }] },
    });
    assert.strictEqual(ok1.status, 200, 'V13-⑥ consent+有效 PNG 应 200 {image_id}（契约 v2.1），实际 ' + ok1.status + ' ' + ok1.text.slice(0, 200));
    assert.ok(ok1.json && ok1.json.image_id, 'V13-⑥ 200 应答应含 image_id，实际 ' + ok1.text.slice(0, 200));
    const ok2 = await S.api('POST', '/v1/mv/image', {
      token: g.token, multipart: { fields: { consent: 'true' }, files: [{ field: 'file', filename: 'portrait2.png', data: png, contentType: 'image/png' }] },
    });
    assert.strictEqual(ok2.json.image_id, ok1.json.image_id, 'V13-⑥ 同 sha256 未过期人像必须复用同一 image_id（契约 v2.5 去重），实际 ' + ok2.json.image_id + ' ≠ ' + ok1.json.image_id);
    // 白盒 TTL：kind='mv_portrait' 且 expire_at-created_at ≈ 72h（契约 v2.5，同 v1 uploads 生命周期）
    const rows = S.db.all("SELECT * FROM uploads WHERE user_id=? AND kind='mv_portrait' ORDER BY rowid DESC", g.user.id);
    assert.ok(rows.length >= 1, 'V13-⑥ uploads 应落 kind=mv_portrait 行（契约 v2.5），实际行数 ' + rows.length);
    const row = rows[0];
    const ttlHours = (Date.parse(row.expire_at) - Date.parse(row.created_at)) / 3600000;
    assert.ok(Math.abs(ttlHours - 72) < 0.5, 'V13-⑥ mv_portrait TTL 应为 72h（契约 v2.5），实际 ' + ttlHours.toFixed(2) + 'h');
    assert.ok(row.sha256 && row.sha256.length === 64, 'V13-⑥ uploads 必须记 sha256（去重/取证），实际 ' + row.sha256);
  });

  it('V13-⑦ laneOf 路由：mv_* 全类型正确落 lane（契约 v2.6；CI 钉死）', async () => {
    const cases = [
      ['mv_cast_image', 'imgspark'], ['mv_storyboard', 'imgspark'],
      ['mv_cast_video', 'vidspark'], ['mv_shot', 'vidspark'],
      ['mv_lipsync', 'lipsync'], ['mv_align', 'align'],
      ['mv_preview', 'ffmpeg'], ['mv_compose', 'ffmpeg'],
    ];
    for (const [type, lane] of cases) {
      assert.strictEqual(MVlanes.laneOf(type), lane, 'V13-⑦ laneOf(' + type + ') 应为 ' + lane + '（契约 v2.6），实际 ' + MVlanes.laneOf(type));
    }
    assert.deepStrictEqual(
      ['imgspark', 'vidspark', 'lipsync', 'align'].filter((l) => !MVlanes.allLanes().includes(l)), [],
      'V13-⑦ server lane 表必须登记 imgspark/vidspark/lipsync/align（契约 v2.6），实际 lanes=' + MVlanes.allLanes().join(','));
    assert.strictEqual(MVlanes.timeoutOf('mv_compose'), 600000, 'V13-⑦ mv_compose 超时应为 600s（架构 §3.2），实际 ' + MVlanes.timeoutOf('mv_compose'));
    assert.strictEqual(MVlanes.laneOf('transcode'), 'ffmpeg', 'V13-⑦ 回归：transcode 仍归 ffmpeg（一期语义不变）');
    // HTTP 面：register 必须接受新 lane（执行器镜像注册的前提）
    const reg = await S.api('POST', '/executor/register', {
      executorToken: H.EXECUTOR_TOKEN, json: { lanes: ['imgspark', 'vidspark', 'lipsync', 'align', 'ffmpeg'], version: 'mb-v13-check' },
    });
    assert.strictEqual(reg.status, 200, 'V13-⑦ /executor/register 应接受 mv lanes，实际 ' + reg.status + ' ' + reg.text.slice(0, 200));
  });

  it('V13-⑧ mock mp4 可播下限：字节桩非空+ftyp；端到端 compose 产物可下载且 magic 合法', async () => {
    // 字节桩下限（架构 §4.3 无 ffmpeg 路径）
    const stub = H.makeMp4Stub('v13');
    assert.ok(stub.length > 0, 'V13-⑧ mock mp4 字节桩不得为空（契约 v2/§4.3 mock 产物非空）');
    assert.strictEqual(stub.toString('ascii', 4, 8), 'ftyp', 'V13-⑧ 字节桩 magic 应为 ftyp（bytes[4..8]），实际 ' + stub.toString('ascii', 4, 8));
    assert.strictEqual(H.makePng().toString('hex', 0, 4), '89504e47', 'V13-⑧ mock png magic 应为 89504E47');
    // 端到端：seed mv_compose → fake executor 领单产 mp4 → /f/* 可取且 magic 合法
    const g = await S.newGuest();
    const jobId = S.seedMvJob({ type: 'mv_compose', payload: { takes: [], audio_master: 'x', title: 'V13' }, userId: g.user.id });
    const job = await S.waitForJob(g.token, jobId, { timeoutMs: 60000 });
    assert.strictEqual(job.status, 'done', 'V13-⑧ mv_compose 端到端应 done，实际 ' + job.status + '；fake executor 错误=' + JSON.stringify(S.executor.errors).slice(0, 300));
    const jr = S.db.mvJobsOf(g.user.id).rows.find((x) => x.id === jobId);
    const result = JSON.parse(jr.result || '{}');
    assert.ok(result.mv_video_url, 'V13-⑧ complete 应回填 mv_video_url（契约 §4 result.files → *_url），实际 ' + JSON.stringify(result).slice(0, 200));
    assert.ok(result.cover_url, 'V13-⑧ compose 应回填 cover_url（封面首帧，契约 v2.3）');
    const rel = String(result.mv_video_url).split('/f/')[1];
    assert.ok(rel, 'V13-⑧ mv_video_url 应为 /f/* 公共静态读（契约 §2），实际 ' + result.mv_video_url);
    const dl = await H.httpReq('GET', S.baseUrl + '/f/' + rel, {});
    assert.strictEqual(dl.status, 200, 'V13-⑧ 成片 mp4 应可下载，实际 ' + dl.status);
    assert.ok(dl.buffer.length > 0, 'V13-⑧ 成片 mp4 必须 >0 字节（"可播"下限），实际 ' + dl.buffer.length);
    assert.strictEqual(dl.buffer.toString('ascii', 4, 8), 'ftyp', 'V13-⑧ mp4 须含 ftyp 盒（可播下限断言；真实解码归 V14 真机），实际 ' + dl.buffer.toString('ascii', 4, 8));
  });

  it('V13-⑨ PATCH ver CAS（409 STALE）+ GET 聚合形状 + report STUB 诚实标注', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g);
    const p = r.json.project;
    assert.strictEqual(p.script_ver, 1, 'V13-⑨ 新项目 script_ver 应为 1（架构 §5），实际 ' + p.script_ver);
    const stale = await S.api('PATCH', '/v1/mv/projects/' + p.id, { token: g.token, json: { title: 'X', ver: 99 } });
    assert.strictEqual(stale.status, 409, 'V13-⑨ ver 失配应 409（契约 v2.1 STALE），实际 ' + stale.status + ' ' + stale.text.slice(0, 200));
    assert.strictEqual(stale.json.code, 'STALE', 'V13-⑨ 409 应答 code 应为 STALE（契约 v2.1），实际 ' + JSON.stringify(stale.json));
    const ok = await S.api('PATCH', '/v1/mv/projects/' + p.id, { token: g.token, json: { title: '新片名', ver: 1 } });
    assert.strictEqual(ok.status, 200, 'V13-⑨ ver 匹配应 200 {project}，实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
    assert.strictEqual(ok.json.project.title, '新片名', 'V13-⑨ PATCH title 应生效，实际 ' + ok.json.project.title);
    assert.strictEqual(ok.json.project.script_ver, 1, 'V13-⑨ 仅改 title 不 ver++（剧本编辑才 ver++），实际 ' + ok.json.project.script_ver);
    const sc = await S.api('PATCH', '/v1/mv/projects/' + p.id, { token: g.token, json: { script_json: { scenes: [{ shots: [{ seq: 1, kind: 'story', sec: 5 }] }] }, ver: 1 } });
    assert.strictEqual(sc.status, 200, 'V13-⑨ script_json 更新应 200，实际 ' + sc.status + ' ' + sc.text.slice(0, 200));
    assert.strictEqual(sc.json.project.script_ver, 2, 'V13-⑨ script_json 变更应 ver++（契约 v2.1 CAS 语义），实际 ' + sc.json.project.script_ver);
    const got = await S.api('GET', '/v1/mv/projects/' + p.id, { token: g.token });
    assert.ok(['project', 'characters', 'shots', 'tickets'].every((k) => got.json[k] !== undefined),
      'V13-⑨ GET 聚合应含 {project,characters[],shots[],tickets[]}（契约 v2.1），实际 keys=' + Object.keys(got.json).join(','));
    assert.strictEqual(got.json.characters.length, 1, 'V13-⑨ 建项目应固化 1 个角色（N1 单主演 D3），实际 ' + got.json.characters.length);
    // cast/confirm：拍板固化 viewRefs（S5 定妆链末端；status 推进已显式延期，见契约 v2.1 语义说明）
    const chId = got.json.characters[0].id;
    const confirm = await S.api('POST', '/v1/mv/projects/' + p.id + '/cast/confirm', {
      token: g.token, json: { character_id: chId, cast_image_url: S.baseUrl + '/f/mock/cast_1.png', frame_sel: [{ url: S.baseUrl + '/f/mock/frame_1.png', score: 0.9, sel: true }, { url: 'x', score: 0.5, sel: false }] },
    });
    assert.strictEqual(confirm.status, 200, 'V13-⑨ cast/confirm 应 200 {character}（契约 v2.1），实际 ' + confirm.status + ' ' + confirm.text.slice(0, 200));
    assert.ok(confirm.json.character.confirmed_at, 'V13-⑨ confirm 后 confirmed_at 应落库（架构 §5 mv_characters）');
    assert.strictEqual(confirm.json.character.viewrefs.length, 2, 'V13-⑨ viewrefs 应固化 frame_sel（身份真源），实际 ' + JSON.stringify(confirm.json.character.viewrefs));
    const confirmForeign = await S.api('POST', '/v1/mv/projects/' + p.id + '/cast/confirm', {
      token: g.token, json: { character_id: 'mvc_nonexistent', cast_image_url: 'x' },
    });
    assert.strictEqual(confirmForeign.status, 404, 'V13-⑨ 角色不属于项目必须 404（契约 v2.1 校验），实际 ' + confirmForeign.status);
    const rep = await S.api('GET', '/v1/mv/projects/' + p.id + '/report', { token: g.token });
    assert.strictEqual(rep.status, 200, 'V13-⑨ report 应 200（STUB 契约 v2.1），实际 ' + rep.status);
    assert.strictEqual(rep.json.stub, true, 'V13-⑨ STUB 应答必须诚实标注 stub:true（计费诚信纪律），实际 ' + JSON.stringify(rep.json).slice(0, 200));
    assert.deepStrictEqual(rep.json.degraded_shots, [], 'V13-⑨ STUB degraded_shots 应为空数组，实际 ' + JSON.stringify(rep.json.degraded_shots));
    assert.strictEqual(rep.json.phrase_hit, 0, 'V13-⑨ STUB phrase_hit 应为 0，实际 ' + rep.json.phrase_hit);
  });

  it('V13-⑩ 项目幂等与校验：同 work 重复建项目 409；非本人作品 404；开关语义', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g, { brief: '雨夜霓虹' });
    assert.strictEqual(r.status, 201);
    const dup = await S.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: r.json.project.work_id, character: { gender: 'm', source: 'ai' } } });
    assert.strictEqual(dup.status, 409, 'V13-⑩ 同 work 已有活跃项目必须 409（契约 v2.0 幂等约束，不静默复用），实际 ' + dup.status + ' ' + dup.text.slice(0, 200));
    const g2 = await S.newGuest();
    const foreign = await S.api('POST', '/v1/mv/projects', { token: g2.token, json: { work_id: r.json.project.work_id, character: { gender: 'f', source: 'ai' } } });
    assert.strictEqual(foreign.status, 404, 'V13-⑩ 非本人 work 必须 404（不泄露存在性），实际 ' + foreign.status);
    const badChar = await S.api('POST', '/v1/mv/projects', { token: g2.token, json: { work_id: S.seedWork(g2.user.id), character: { gender: 'x', source: 'ai' } } });
    assert.strictEqual(badChar.status, 400, 'V13-⑩ gender 非 m/f 必须 400（契约 v2.1），实际 ' + badChar.status);
    const upNoImage = await S.api('POST', '/v1/mv/projects', { token: g2.token, json: { work_id: S.seedWork(g2.user.id), character: { gender: 'f', source: 'upload' } } });
    assert.strictEqual(upNoImage.status, 400, 'V13-⑩ upload 通道缺 image_id 必须 400（先传后建，契约 v2.1），实际 ' + upNoImage.status);
    // 列表：mine=1 游标分页（契约 v2.1 GET /v1/mvs）
    const mine = await S.api('GET', '/v1/mvs?mine=1', { token: g.token });
    assert.strictEqual(mine.status, 200, 'V13-⑩ GET /v1/mvs?mine=1 应 200（契约 v2.1），实际 ' + mine.status);
    assert.ok(Array.isArray(mine.json.items) && mine.json.items.some((x) => x.id === r.json.project.id), 'V13-⑩ 列表应含自己的项目，实际 ' + JSON.stringify(mine.json).slice(0, 200));
    assert.ok('next_cursor' in mine.json, 'V13-⑩ 列表应答应含 next_cursor（游标分页），实际 keys=' + Object.keys(mine.json).join(','));
    const anon = await S.api('GET', '/v1/mvs?mine=1');
    assert.strictEqual(anon.status, 401, 'V13-⑩ 未登录访问 /v1/mvs 必须 401（契约 §0 鉴权），实际 ' + anon.status);
  });

  // ———— wave-2（契约 v2.8-v2.11）————

  it('V13-⑪ 报价→开机 CAS（v2.8.3）：boot 前置/est_ver CAS/逐镜一个 job 单扣/自动合成收口', async () => {
    const g = await S.newGuest();
    const { pid } = await fundedProject(g, { shots: 2, shotKind: 'story' });
    // ① 未出样片 boot → 409 NOT_READY（先看片再掏分）
    const b0 = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: 'x' } });
    assert.strictEqual(b0.status, 409, 'V13-⑪ boot 前置未满足应 409（契约 v2.8.1①），实际 ' + b0.status + ' ' + b0.text.slice(0, 200));
    assert.strictEqual(b0.json.code, 'NOT_READY', 'V13-⑪ 应答 code 应为 NOT_READY，实际 ' + JSON.stringify(b0.json));
    // ② 样片首免 → 报价卡（est/est_ver=hash12）
    await toPreviewed(g, pid);
    const got = await S.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
    assert.strictEqual(got.json.project.status, 'previewed', 'V13-⑪ 样片完成后 status 应=previewed，实际 ' + got.json.project.status);
    const est = got.json.project.est; const estVer = got.json.project.est_ver;
    assert.ok(est && Array.isArray(est.breakdown) && est.breakdown.length >= 1, 'V13-⑪ 报价 breakdown 形状（v2.8.3），实际 ' + JSON.stringify(est));
    assert.strictEqual(est.shots, 2, 'V13-⑪ 报价镜数应=2，实际 ' + est.shots);
    assert.strictEqual(est.credits, 2 * 40 + 10, 'V13-⑪ 纯音乐报价=拍摄 80+合成 10（align 不计，契约 v2.4），实际 ' + est.credits);
    assert.ok(typeof estVer === 'string' && estVer.length === 12, 'V13-⑪ est_ver 应为 hash12，实际 ' + estVer);
    // ③ 报价 CAS：错误 est_ver → 409 EST_STALE
    const bw = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: 'deadbeef0000' } });
    assert.strictEqual(bw.status, 409, 'V13-⑪ 错误 est_ver 应 409，实际 ' + bw.status);
    assert.strictEqual(bw.json.code, 'EST_STALE', 'V13-⑪ 应答 code 应为 EST_STALE（契约 v2.8.1②），实际 ' + JSON.stringify(bw.json));
    // ④ 正确 est_ver 开机：逐镜一个 job、40/镜
    const bal0 = (await S.credits(g.token)).balance;
    const b1 = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: estVer } });
    assert.strictEqual(b1.status, 202, 'V13-⑪ 正确报价开机应 202，实际 ' + b1.status + ' ' + b1.text.slice(0, 200));
    assert.strictEqual(b1.json.jobs.length, 2, 'V13-⑪ boot 应逐镜派 2 个 mv_shot job，实际 ' + JSON.stringify(b1.json));
    assert.strictEqual(b1.json.credits_charged, 80, 'V13-⑪ boot 扣=40×2（先扣后派单），实际 ' + b1.json.credits_charged);
    assert.strictEqual((await S.credits(g.token)).balance, bal0 - 80, 'V13-⑪ boot 实际扣款应与回执一致');
    // ⑤ 重复 boot：同批 job、不重复扣分（enqueueOnce 逐镜防重）
    const b2 = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: estVer } });
    assert.strictEqual(b2.status, 202);
    assert.strictEqual(b2.json.idempotent, true, 'V13-⑪ 重复 boot 应幂等');
    assert.strictEqual(b2.json.credits_charged, 0, 'V13-⑪ 重复 boot 不得重复扣分');
    assert.deepStrictEqual(b2.json.jobs.slice().sort(), b1.json.jobs.slice().sort(), 'V13-⑪ 重复 boot 必须返回同一批 job');
    const shotJobRows = S.mvJobRows(g.user.id, 'mv_shot');
    assert.strictEqual(shotJobRows.length, 2, 'V13-⑪ 每镜恒一个 mv_shot job（含重复 boot），实际 ' + shotJobRows.length);
    // ⑥ 全镜成片 → 自动合成（10⚡ 先扣后派单）→ project ready
    for (const jid of b1.json.jobs) {
      const j = await S.waitForJob(g.token, jid, { timeoutMs: 60000 });
      assert.strictEqual(j.status, 'done', 'V13-⑪ mv_shot job 应 done，实际 ' + j.status + ' ' + JSON.stringify(j.error));
    }
    const t0 = Date.now();
    let row = S.db.mvProject(pid).row;
    while (row && row.status !== 'ready' && Date.now() - t0 < 60000) { await H.sleep(300); row = S.db.mvProject(pid).row; }
    assert.ok(row && row.status === 'ready', 'V13-⑪ 全镜成片后应自动合成并 ready（架构 §3.1），实际 ' + (row && row.status));
    assert.ok(row.video_url, 'V13-⑪ ready 时 video_url 应落库（契约 v2.8），实际 ' + row.video_url);
    const composeRows = S.mvJobRows(g.user.id, 'mv_compose');
    assert.strictEqual(composeRows.length, 1, 'V13-⑪ 自动合成恒一个 mv_compose job（idem 含镜状态哈希），实际 ' + composeRows.length);
    assert.strictEqual(Number(composeRows[0].credits_cost), 10, 'V13-⑪ 自动合成 10⚡ 记账（契约 v2.8.4）');
    const led = S.db.ledgerRows(g.user.id);
    assert.strictEqual(sumDelta(led), (await S.credits(g.token)).balance, 'V13-⑪ 全程后账本不变量破坏');
  });

  it('V13-⑫ 预算护栏（v2.11/S10）：>120% → 402 BUDGET_EXCEEDED + paused；仅人工调高预算恢复', async () => {
    const g = await S.newGuest();
    const { pid } = await fundedProject(g, { shots: 2, shotKind: 'story' });
    await toPreviewed(g, pid);
    const estVer = (await S.api('GET', '/v1/mv/projects/' + pid, { token: g.token })).json.project.est_ver;
    // 人工压低预算（50 < 报价 90×1.2）
    const pt = await S.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { budget_credits: 50, ver: 1 } });
    assert.strictEqual(pt.status, 200, 'V13-⑫ PATCH budget_credits 应 200（v2.8.6），实际 ' + pt.status + ' ' + pt.text.slice(0, 200));
    assert.strictEqual(pt.json.project.budget_credits, 50, 'V13-⑫ 预算应落库 50，实际 ' + pt.json.project.budget_credits);
    // boot → 402 BUDGET_EXCEEDED + paused=1
    const b1 = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: estVer } });
    assert.strictEqual(b1.status, 402, 'V13-⑫ 超 120% boot 应 402，实际 ' + b1.status + ' ' + b1.text.slice(0, 200));
    assert.strictEqual(b1.json.code, 'BUDGET_EXCEEDED', 'V13-⑫ 应答 code 应为 BUDGET_EXCEEDED（契约 v2.11），实际 ' + JSON.stringify(b1.json));
    assert.strictEqual(S.db.mvProject(pid).row.paused, 1, 'V13-⑫ 触发护栏必须 paused=1（通告板横幅）');
    // paused 时一切计费派单被拒（样片重出 5⚡ 也是计费）
    const pr = await S.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
    assert.strictEqual(pr.status, 402, 'V13-⑫ paused 后重出样片（计费）必须 402，实际 ' + pr.status);
    assert.strictEqual(S.db.mvProject(pid).row.status, 'previewed', 'V13-⑫ 护栏触发不得推进项目状态');
    // 恢复唯一通道=人工调高预算（审计留痕），boot 放行
    const pt2 = await S.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { budget_credits: 2000, ver: 1 } });
    assert.strictEqual(pt2.status, 200);
    assert.strictEqual(pt2.json.project.paused, false, 'V13-⑫ 调高预算应解除 paused（仅人工，契约 v2.11）');
    const aud = S.db.auditRowsLike('mv.budget.manual_raise');
    assert.ok(!aud.error && aud.hits.length > 0, 'V13-⑫ 人工恢复必须落审计，实际 ' + (aud.error || aud.hits.length + ' hits'));
    const b2 = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: estVer } });
    assert.strictEqual(b2.status, 202, 'V13-⑫ 人工恢复后 boot 应放行，实际 ' + b2.status + ' ' + b2.text.slice(0, 200));
    assert.strictEqual(b2.json.jobs.length, 2);
    const led = S.db.ledgerRows(g.user.id);
    assert.strictEqual(sumDelta(led), (await S.credits(g.token)).balance, 'V13-⑫ 账本不变量破坏');
  });

  it('V13-⑬ 建议离线不装忙（v2.8.2）：LLM 不可达 → 409 NOT_READY 且快速返回（<30s，不挂起）', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g, { lyrics: '' });
    const pid = r.json.project.id;
    // 无剧本 → NOT_READY
    const s0 = await S.api('POST', '/v1/mv/projects/' + pid + '/suggest', { token: g.token, json: { note: '更燃一点' } });
    assert.strictEqual(s0.status, 409, 'V13-⑬ 无剧本建议应 409 NOT_READY，实际 ' + s0.status);
    assert.strictEqual(s0.json.code, 'NOT_READY');
    // 写入剧本后：LLM 端点不可达 → 409 NOT_READY（不硬答、不假 LLM）
    const sc = await S.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { script_json: { shots: [{ seq: 1, kind: 'story', sec: 5, desc: '雨夜街口', camera: '远景', cast_ids: [] }] }, ver: 1 } });
    assert.strictEqual(sc.status, 200, 'V13-⑬ 剧本 PATCH 应 200，实际 ' + sc.status);
    const t0 = Date.now();
    const s1 = await S.api('POST', '/v1/mv/projects/' + pid + '/suggest', { token: g.token, json: { note: '把副歌改得更有冲击力' }, timeoutMs: 30000 });
    const dt = Date.now() - t0;
    assert.strictEqual(s1.status, 409, 'V13-⑬ LLM 离线 suggest 必须 409（诚实拒绝），实际 ' + s1.status + ' ' + s1.text.slice(0, 200));
    assert.strictEqual(s1.json.code, 'NOT_READY', 'V13-⑬ 应答 code 应为 NOT_READY，实际 ' + JSON.stringify(s1.json));
    assert.ok(dt < 30000, 'V13-⑬ NOT_READY 必须快速返回不挂起（<30s），实际 ' + dt + 'ms');
    // 无挂起建议 → apply 404（suggest 挂了才谈采纳；且草稿不 ver++）
    const ap = await S.api('POST', '/v1/mv/projects/' + pid + '/suggest/apply', { token: g.token, json: { suggest_id: 'sgs_nonexistent', ver: 2 } });
    assert.strictEqual(ap.status, 404, 'V13-⑬ 建议不存在 apply 应 404，实际 ' + ap.status);
    assert.strictEqual(S.db.mvProject(pid).row.script_ver, 2, 'V13-⑬ 建议失败不得 ver++（草稿纪律），实际 ' + S.db.mvProject(pid).row.script_ver);
  });

  it('V13-⑭ 机检字段防伪造（v2.8.6）：PATCH 无法写入 ai_review/sync_score/paused/est_ver', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g);
    const pid = r.json.project.id;
    const forged = {
      title: '正规改名', ver: 1,
      ai_review: { engine: '规则机检', findings: [] }, sync_score: 0.99, paused: 1,
      credits_cost: 99999, credits_refunded: 99, est_ver: 'deadbeef0000', est_json: { credits: 0 }, status: 'ready',
      script_json: { shots: [{ seq: 1, kind: 'story', sec: 5, desc: '正常描述', camera: '远景', cast_ids: [] }], ai_review: { engine: '伪造机检通过' }, timings: [{ line: 'x', start: 0, end: 1 }] },
    };
    const ok = await S.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: forged });
    assert.strictEqual(ok.status, 200, 'V13-⑭ 带伪造键的 PATCH 应剥键后放行 200（静默剥除），实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
    const row = S.db.mvProject(pid).row;
    assert.ok(!String(row.script_json || '').includes('ai_review'), 'V13-⑭ script_json.ai_review 必须被剥（防伪造机检通过），实际 ' + row.script_json);
    assert.ok(!String(row.script_json || '').includes('timings'), 'V13-⑭ script_json.timings 必须被剥（仅 mv_align 可写），实际 ' + row.script_json);
    assert.strictEqual(Number(row.paused), 0, 'V13-⑭ PATCH 不得写 paused（仅护栏/人工恢复），实际 ' + row.paused);
    assert.strictEqual(Number(row.credits_cost), 0, 'V13-⑭ PATCH 不得写 credits_cost，实际 ' + row.credits_cost);
    assert.strictEqual(Number(row.credits_refunded), 0, 'V13-⑭ PATCH 不得写 credits_refunded');
    assert.strictEqual(row.est_ver, null, 'V13-⑭ PATCH 不得写 est_ver（仅 preview 完成生成），实际 ' + row.est_ver);
    assert.strictEqual(row.status, 'casting', 'V13-⑭ PATCH 不得直写 status（状态机由管线推进），实际 ' + row.status);
    assert.strictEqual(Number(row.ai_label), 1, 'V13-⑭ ai_label 恒 1 不可被改写');
    // shots 面无 PATCH 通道（sync_score 只在 mv_takes，仅 lipsync 管线写入）
    const shotRoutes = ['/v1/mv/shots/shot_x', '/v1/mv/shots/shot_x/sync'];
    for (const pth of shotRoutes) {
      const noPatch = await S.api('PATCH', pth, { token: g.token, json: { sync_score: 1 } });
      assert.strictEqual(noPatch.status, 404, 'V13-⑭ 镜级不存在可写 sync_score 的端点（' + pth + '），实际 ' + noPatch.status);
    }
  });

  it('V13-⑮ WSS mv.progress（v2.2/v2.8.5）：boot/preview 触发广播且形状合规', async () => {
    const g = await S.newGuest();
    const { r } = await newProject(g);
    const pid = r.json.project.id;
    S.seedMvShot(pid, { seq: 1, kind: 'story', status: 'draft' });
    const ws = await H.wsConnect(S.baseUrl, g.token);
    try {
      const pv = await S.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
      assert.strictEqual(pv.status, 202, 'V13-⑮ preview 派单应 202，实际 ' + pv.status + ' ' + pv.text.slice(0, 200));
      const job = await S.waitForJob(g.token, pv.json.job_id, { timeoutMs: 60000 });
      assert.strictEqual(job.status, 'done', 'V13-⑮ preview job 应 done');
      const evt = await ws.waitFor((e) => e.type === 'mv.progress' && e.project_id === pid, 15000);
      assert.ok(evt, 'V13-⑮ 30s 内应收到 mv.progress 事件（契约 v2.8.5 触发点=preview 完成），未收到');
      assert.strictEqual(typeof evt.status, 'string', 'V13-⑮ mv.progress.status 应为字符串，实际 ' + JSON.stringify(evt));
      assert.strictEqual(typeof evt.progress, 'number', 'V13-⑮ progress 应为数字');
      assert.ok(evt.progress >= 0 && evt.progress <= 100, 'V13-⑮ progress 应 0-100，实际 ' + evt.progress);
      assert.strictEqual(typeof evt.note, 'string', 'V13-⑮ note 应为字符串（已过禁词净化）');
      assert.ok(Array.isArray(evt.shots) && evt.shots.every((s) => s && s.id && typeof s.status === 'string'),
        'V13-⑮ shots 应为 [{id,status}] 数组，实际 ' + JSON.stringify(evt.shots));
      const evt2 = await ws.waitFor((e) => e.type === 'mv.progress' && e.project_id === pid && e.status === 'previewed', 15000);
      assert.ok(evt2, 'V13-⑮ 样片完成后应有 status=previewed 的通告板广播，实际事件流=' + JSON.stringify(ws.events.slice(-5)));
    } finally {
      ws.close();
    }
  });

  it('V13-⑯ PATCH 剧本同步物化（v2.15.1 批注）：改 desc→shoot motion 用新文案；成片镜不动；脚本移除的未成片行删行', async () => {
    const g = await S.newGuest();
    await S.credits(g.token); // shoot 40⚡ 需余额（游客 50 够，此处显式触发每日免费）
    const { r } = await newProject(g);
    const pid = r.json.project.id;
    const s1 = S.seedMvShot(pid, { seq: 1, kind: 'story', status: 'draft' });
    S.seedMvShot(pid, { seq: 2, kind: 'story', status: 'draft' });
    const sDone = S.seedMvShot(pid, { seq: 3, kind: 'story', status: 'clipReady' }); // 成片行（位置 3）
    const s4 = S.seedMvShot(pid, { seq: 4, kind: 'story', status: 'draft' });         // 将被脚本移除 → 删行
    const sc = await S.api('PATCH', '/v1/mv/projects/' + pid, {
      token: g.token, json: { ver: 1, script_json: { shots: [
        { seq: 1, kind: 'story', sec: 5, desc: '全新文案A：逆光奔跑', camera: '跟拍', cast_ids: [] },
        { seq: 2, kind: 'singing', sec: 4, lyric_from: 0, lyric_to: 1, desc: '全新文案B：天台合唱', camera: '近景', cast_ids: [] },
      ] } },
    });
    assert.strictEqual(sc.status, 200, 'V13-⑯ PATCH 剧本应 200，实际 ' + sc.status + ' ' + sc.text.slice(0, 200));
    assert.strictEqual(sc.json.project.script_ver, 2, 'V13-⑯ script_json 变更应 ver++');
    const shots = S.db.mvShotsOf(pid).rows;
    const row1 = shots.find((x) => x.id === s1);
    const row2 = shots.find((x) => x.seq === 2);
    assert.ok(row1 && String(row1.desc).includes('逆光奔跑'), 'V13-⑯ 未成片镜 desc 应同步新文案，实际 ' + JSON.stringify(row1));
    assert.strictEqual(row1.camera, '跟拍', 'V13-⑯ camera 应同步');
    assert.ok(row2 && row2.kind === 'singing' && Number(row2.sec) === 4, 'V13-⑯ kind/sec 应同步（位置 2），实际 ' + JSON.stringify(row2));
    const done = shots.find((x) => x.id === sDone);
    assert.ok(done && done.status === 'clipReady', 'V13-⑯ 成片镜绝不动（剧本不覆盖成片）');
    assert.ok(!shots.some((x) => x.id === s4), 'V13-⑯ 脚本移除的未成片行应删除（v2.15.1 删行语义）');
    assert.ok(S.db.auditRowsLike('mv.shot.script_removed').hits.length > 0, 'V13-⑯ 删行必须审计留痕');
    S.setMvProject(pid, { status: 'scripting' });
    const shoot = await S.api('POST', '/v1/mv/projects/' + pid + '/jobs', { token: g.token, json: { type: 'shoot', params: { shot_id: s1 } } });
    assert.strictEqual(shoot.status, 202, 'V13-⑯ shoot 派单应 202，实际 ' + shoot.status + ' ' + shoot.text.slice(0, 200));
    const jrow = S.mvJobRows(g.user.id, 'mv_shot').find((x) => x.id === shoot.json.job_id);
    const pl = JSON.parse(jrow.payload || '{}');
    assert.ok(String((pl.shot || {}).motion || '').includes('逆光奔跑'),
      'V13-⑯ shoot payload shot.motion 必须用新剧本 desc（杜绝改词仍按旧 motion 拍），实际 ' + JSON.stringify(pl.shot));
    const led = S.db.ledgerRows(g.user.id);
    assert.strictEqual(led.rows.reduce((a, x) => a + x.delta, 0), (await S.credits(g.token)).balance, 'V13-⑯ 账本不变量破坏');
  });
});

// ———— 终扫追加（2026-11-24，N1-5 非计算收尾：夜间档 / takes TTL / lane 指标；契约 v2.18 批注）————

async function mkProjectOn(Sc, guest, opts) {
  opts = opts || {};
  const workId = Sc.seedWork(guest.user.id, { lyrics: opts.lyrics || '' });
  const r = await Sc.api('POST', '/v1/mv/projects', { token: guest.token, json: { work_id: workId, character: { gender: 'f', source: 'ai' } } });
  if (r.status !== 201) throw new Error('建项目失败 ' + r.status + ' ' + r.text.slice(0, 200));
  return r.json.project.id;
}
const hoursAgoIso = (h) => new Date(Date.now() - h * 3600000).toISOString();

describe('V13-⑰ 夜间档派发过滤（N1-5 · 架构 §8/契约 v2.18，mock）', () => {
  let D, N;
  before(async () => {
    D = await H.boot('V13-nightDay', { env: { MB_MV_FORCE_DAY: '1' } }); // 强制窗口外（测试钩子，不受本机钟点影响）
    N = await H.boot('V13-nightOn', { env: { MB_MV_FORCE_NIGHT: '1' }, noFakeExecutor: true }); // 强制窗口内（自持执行器观测领单序）
  });
  after(async () => { if (D) await D.close(); if (N) await N.close(); });

  async function mk(Sc, mode) {
    const g = await Sc.newGuest();
    const pid = await mkProjectOn(Sc, g);
    if (mode === 'night') {
      const pt = await Sc.api('PATCH', '/v1/mv/projects/' + pid, { token: g.token, json: { queue_mode: 'night', ver: 1 } });
      assert.strictEqual(pt.status, 200, 'PATCH queue_mode 应 200（契约 v2.1 已支持）');
      assert.strictEqual(pt.json.project.queue_mode, 'night', 'PATCH 应落库 night（projects.queue_mode 列已存在）');
    }
    return { g, pid };
  }

  it('V13-⑰a 窗口外：night 项目 mv_* 不出队（queued 等待）；normal 照常且不被 night 挂起阻塞（防 starvation）', async () => {
    const n = await mk(D, 'night'); const m = await mk(D, 'normal');
    const nightJob = D.seedMvJob({ type: 'mv_preview', payload: { project_id: n.pid, board_urls: [], seg_sec: 2 }, userId: n.g.user.id });
    const normJob = D.seedMvJob({ type: 'mv_preview', payload: { project_id: m.pid, board_urls: [], seg_sec: 2 }, userId: m.g.user.id });
    const dj = await D.waitForJob(m.g.token, normJob, { timeoutMs: 30000 });
    assert.strictEqual(dj.status, 'done', '窗口外 normal job 必须照常出队完成（night 挂起不得阻塞其出队）');
    await H.sleep(2500); // 越过 2s 安全轮询 + 领单周期，night 若可派早该被领走
    const nrow = D.db.mvJobsOf(n.g.user.id).rows.find((x) => x.id === nightJob);
    assert.strictEqual(nrow.status, 'queued', '窗口外 night 项目 mv_preview 必须挂起 queued，实际 ' + nrow.status);
    // 无 project_id 的 mv_* 不受门控（防误伤：夜间档只认 projects.queue_mode）
    const orphan = D.seedMvJob({ type: 'mv_compose', payload: { takes: [], audio_master: 'x', title: '无主' }, userId: m.g.user.id });
    const oj = await D.waitForJob(m.g.token, orphan, { timeoutMs: 30000 });
    assert.strictEqual(oj.status, 'done', 'payload 无 project_id 的 mv_* 不得被夜间档误伤');
  });

  it('V13-⑰b 窗口内（MB_MV_FORCE_NIGHT=1）：night 出队且优先于更早的 normal；normal 不受影响', async () => {
    const n = await mk(N, 'night'); const m = await mk(N, 'normal');
    // 先种 normal（created_at 更早）、后种 night —— 若无 night 优先，按时间序必然先领 normal
    const normJob = N.seedMvJob({ type: 'mv_compose', payload: { project_id: m.pid, takes: [], audio_master: 'x', title: '日' }, userId: m.g.user.id });
    const nightJob = N.seedMvJob({ type: 'mv_compose', payload: { project_id: n.pid, takes: [], audio_master: 'x', title: '夜' }, userId: n.g.user.id });
    await N.executor.start(); // 单一执行器逐个领单 → 领单顺序可观测
    const a = await N.waitForJob(n.g.token, nightJob, { timeoutMs: 60000 });
    const b = await N.waitForJob(m.g.token, normJob, { timeoutMs: 60000 });
    assert.strictEqual(a.status, 'done', '窗口内 night job 必须出队完成');
    assert.strictEqual(b.status, 'done', '窗口内 normal job 不受影响');
    const order = [...N.executor.seenJobIds];
    assert.strictEqual(order[0], nightJob, '窗口内 night 必须优先于更早 normal 出队，实际领单序=' + order.join(','));
  });
});

describe('V13-⑱ takes TTL sweep（N1-5 · 架构 §8，mock，MB_SWEEP_MS=1000 加速）', () => {
  let S2;
  before(async () => { S2 = await H.boot('V13-ttl', { env: { MB_SWEEP_MS: '1000' } }); });
  after(async () => { if (S2) await S2.close(); });

  it('V13-⑱ 仅 老+未引用+项目ready满72h 才清（行+文件）；best take/新 take/新项目/未ready 全存活；无主产物随清+审计一条', async () => {
    const Sc = S2; const g = await Sc.newGuest();
    // P1：ready 满 72h（updated_at 80h 前）——老未引用 take 应清；best take 与新 take 存活。
    // 种子顺序：先建结构（updated_at=now → sweep 全部跳过）→ 挂 best_take 引用 → 最后回拨 ready 时间开窗，杜绝 1s sweep 抢跑竞态
    const p1 = await mkProjectOn(Sc, g);
    Sc.setMvProject(p1, { status: 'ready' });
    const sA = Sc.seedMvShot(p1, { seq: 1, status: 'clipReady' });
    const sB = Sc.seedMvShot(p1, { seq: 2, status: 'clipReady' });
    const tA = Sc.seedMvTake(sA, { ageHours: 80 });
    Sc.setMvShot(sA, { best_take_id: tA.id });
    const tB = Sc.seedMvTake(sB, { ageHours: 80 }); // 老+未引用 → 唯一清理对象
    const tC = Sc.seedMvTake(sB, { ageHours: 0 });  // 新 take → 存活
    Sc.setMvProject(p1, { updated_at: hoursAgoIso(80) }); // 最后开窗：此刻 tA 已受 best_take 保护
    // P2：ready 未满 72h → 老 take 绝不动
    const p2 = await mkProjectOn(Sc, g);
    Sc.setMvProject(p2, { status: 'ready', updated_at: new Date().toISOString() });
    const sD = Sc.seedMvShot(p2, { seq: 1, status: 'clipReady' });
    const tD = Sc.seedMvTake(sD, { ageHours: 80 });
    // P3：未 ready（shooting）→ 老 take 绝不动
    const p3 = await mkProjectOn(Sc, g);
    Sc.setMvProject(p3, { status: 'shooting', updated_at: hoursAgoIso(80) });
    const sE = Sc.seedMvShot(p3, { seq: 1, status: 'clipReady' });
    const tE = Sc.seedMvTake(sE, { ageHours: 80 });
    // 无主产物：老（应清）/ 新（mtime 保护，不得误删）
    const orOld = Sc.seedOutFile('orphans/f_stale_art.mp4', 80);
    const orNew = Sc.seedOutFile('orphans/f_fresh_art.mp4', 0);
    // 等 sweep（MB_SWEEP_MS=1000）动作：轮询 tB 消失（上限 25s）
    const t0 = Date.now();
    let gone = false;
    while (Date.now() - t0 < 25000) {
      gone = !Sc.db.mvTakesOf(sB).rows.some((x) => x.id === tB.id);
      if (gone) break;
      await H.sleep(400);
    }
    assert.ok(gone, '老+未引用+ready满72h 的 take 行应在 25s 内被 sweep 清理');
    assert.ok(!fs.existsSync(tB.abs), 'take 产物文件应随 DB 行一起清');
    assert.ok(Sc.db.mvTakesOf(sA).rows.some((x) => x.id === tA.id) && fs.existsSync(tA.abs), 'best_take 引用的 take（行+文件）永不删');
    assert.ok(Sc.db.mvTakesOf(sB).rows.some((x) => x.id === tC.id) && fs.existsSync(tC.abs), '未满 72h 的新 take 不得删');
    assert.ok(Sc.db.mvTakesOf(sD).rows.some((x) => x.id === tD.id) && fs.existsSync(tD.abs), 'ready 未满 72h 的项目 take 绝不动');
    assert.ok(Sc.db.mvTakesOf(sE).rows.some((x) => x.id === tE.id) && fs.existsSync(tE.abs), '未 ready（shooting）项目的 take 绝不动');
    assert.ok(!fs.existsSync(orOld.abs), '无主产物（无引用且 mtime>72h）应清理');
    assert.ok(fs.existsSync(orNew.abs), '新产物（mtime<72h）不得被无主清理误删（保存-回填竞态保护）');
    const aud = Sc.db.auditRowsLike('mv.takes.cleanup');
    assert.ok(!aud.error && aud.hits.length > 0, 'takes 清理必须留审计一条，实际 ' + (aud.error || aud.hits.length + ' hits'));
  });
});

describe('V13-⑲ lane 指标（N1-5 · 契约 v2.18 /healthz mv_metrics，mock）', () => {
  let S3;
  before(async () => { S3 = await H.boot('V13-metrics'); });
  after(async () => { if (S3) await S3.close(); });

  it('V13-⑲ healthz.mv_metrics 形状 + 一次 mock compose 后 done 计数增长', async () => {
    const Sc = S3; const g = await Sc.newGuest();
    const h0 = await Sc.api('GET', '/healthz');
    assert.strictEqual(h0.status, 200);
    const m0 = h0.json.mv_metrics;
    assert.ok(m0 && m0.types && m0.lanes, 'mv_enabled=true 时 /healthz 必须含 mv_metrics{types,lanes}（契约 v2.18），实际 ' + h0.text.slice(0, 200));
    for (const ln of ['ffmpeg', 'imgspark', 'vidspark', 'lipsync', 'align']) {
      assert.ok(m0.lanes[ln] && typeof m0.lanes[ln].queued === 'number' && typeof m0.lanes[ln].leased === 'number',
        'mv 相关 lane 深度必须齐（含零值 lane），缺/错 ' + ln + '：' + JSON.stringify(m0.lanes));
    }
    const d0 = (m0.types.mv_compose || {}).done || 0;
    const jobId = Sc.seedMvJob({ type: 'mv_compose', payload: { takes: [], audio_master: 'x', title: '指标' }, userId: g.user.id });
    const job = await Sc.waitForJob(g.token, jobId, { timeoutMs: 60000 });
    assert.strictEqual(job.status, 'done', '前置：mock compose 应 done，实际 ' + job.status);
    const h1 = await Sc.api('GET', '/healthz');
    const mc = h1.json.mv_metrics && h1.json.mv_metrics.types.mv_compose;
    assert.ok(mc && mc.done >= d0 + 1, '一次 mock compose 后 types.mv_compose.done 应增长，' + d0 + '→' + (mc && mc.done));
    assert.ok(Number.isFinite(mc.p50_ms) && mc.p50_ms >= 0, 'p50_ms 应为非负数，实际 ' + mc.p50_ms);
    assert.ok(Number.isFinite(mc.p90_ms) && mc.p90_ms >= mc.p50_ms, 'p90_ms 应 ≥ p50_ms，实际 ' + mc.p90_ms + '/' + mc.p50_ms);
  });
});
