// V1 · 账号与账本（验收驱动施工 · 施工方 D · 2026-11-23）
// 断言源：CONTRACTS.md §1（积分口径）/§2（auth、/v1/me）/§4（fail→attempts>=3 时 failed+refund）
//         docs/musicbox-construction-plan.md §5 V1：Σledger==balance；幂等键重复请求不双扣。
// 说明：契约未提供账本查询端点 → Σdelta 与 refund 行用白盒只读 SQLite 核对（helpers.db，偏差清单 DEV-LEDGER）。
//       fake executor 默认 transcodeMode='park'（不改变 job 状态），保证资金断言无退款竞态。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S; // boot 上下文（before 中赋值）

function genBody(overrides) {
  // 每次不同 prompt → 幂等键不同，避免跨用例误命中（幂等用例除外）
  // sec 必须落在契约 §2 的 15-240 区间（用 10 会被服务端正确拒绝——套件自纠过一次，勿再低于 15）
  return Object.assign({ mode: 'simple', prompt: H.uniq('v1'), sec: 15, count: 3 }, overrides || {});
}

function sumDelta(ledger) {
  return ledger.rows.reduce((s, r) => s + r.delta, 0);
}

describe('V1 账号与账本', () => {
  before(async () => { S = await H.boot('V1'); });
  after(async () => { if (S) await S.close(); });

  it('V1-① 新游客初始余额=50 且 is_guest=true（契约 §1 每日免费积分 50）', async () => {
    const g = await S.newGuest();
    assert.strictEqual(g.user.is_guest, true, 'V1-① /v1/auth/guest 应返回 user.is_guest=true（契约 §2）');
    const c = await S.credits(g.token);
    assert.strictEqual(c.balance, 50, 'V1-① 新游客 credits.balance 应为 50（契约 §1），实际 ' + c.balance);
    assert.strictEqual(c.daily_quota, 50, 'V1-① credits.daily_quota 应为 50（契约 §1），实际 ' + c.daily_quota);
  });

  it('V1-② generate 默认 count=3 扣 45（15/候选，契约 §1）', async () => {
    const g = await S.newGuest();
    const body = genBody();
    const r = await S.generate(g.token, body);
    assert.strictEqual(r.status, 202, 'V1-② generate 应 202（契约 §2），实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.ok(r.json && r.json.job_id, 'V1-② 202 响应应含 job_id，实际 ' + r.text.slice(0, 200));
    assert.strictEqual(r.json.credits_charged, 45, 'V1-② 默认 count=3 → credits_charged 应为 45（15×3，契约 §1），实际 ' + r.json.credits_charged);
    assert.strictEqual(r.json.idempotent, false, 'V1-② 首次提交 idempotent 应为 false，实际 ' + JSON.stringify(r.json));
    const c = await S.credits(g.token);
    assert.strictEqual(c.balance, 5, 'V1-② 扣费后 balance 应为 50-45=5，实际 ' + c.balance);
  });

  it('V1-③ 幂等：同参数重复提交返回同一 job 且不重复扣分（契约 §2 幂等键）', async () => {
    const g = await S.newGuest();
    const body = genBody({ prompt: 'v1-idempotent-fixed-params' }); // 两次必须完全同参
    const r1 = await S.generate(g.token, body);
    assert.strictEqual(r1.status, 202, 'V1-③ 首次 generate 应 202，实际 ' + r1.status + ' ' + r1.text.slice(0, 200));
    const c1 = await S.credits(g.token);
    assert.strictEqual(c1.balance, 5, 'V1-③ 首次扣分后 balance 应为 5，实际 ' + c1.balance);
    const r2 = await S.generate(g.token, body); // 余额只剩 5，若服务端在幂等命中前做扣费前置校验会错报 CREDITS_NOT_ENOUGH —— 契约要求幂等命中直接返回同 job
    assert.strictEqual(r2.status, 202, 'V1-③ 同参数重发必须仍 202（幂等命中不扣费，不应被余额校验拦截），实际 ' + r2.status + ' ' + r2.text.slice(0, 200));
    assert.strictEqual(r2.json.idempotent, true, 'V1-③ 重发响应 idempotent 应为 true，实际 ' + JSON.stringify(r2.json));
    assert.strictEqual(r2.json.job_id, r1.json.job_id, 'V1-③ 重发应返回同一 job_id（幂等键=hash(user+归一化参数)），实际 ' + r2.json.job_id + ' ≠ ' + r1.json.job_id);
    const c2 = await S.credits(g.token);
    assert.strictEqual(c2.balance, 5, 'V1-③ 幂等重发不得重复扣分，balance 应仍为 5，实际 ' + c2.balance);
  });

  it('V1-④ 失败 → 自动全额 refund（ledger 增 reason=refund 行，契约 §1/§4）', async () => {
    const g = await S.newGuest();
    // fake executor 连败 3 次 → 服务端 attempts>=3 → failed + 全额 refund（契约 §4）
    // 前面用例 generate 后不等终态，会留下在飞的 music job —— 必须显式排除，
    // 否则它们把 3 次计划失败吃掉，本用例的 job 就会卡在 progress=90（等一个 parked 的转码子 job）直到 60s 超时。
    const stale = S.db.all("SELECT id FROM jobs WHERE type='music' AND status NOT IN ('done','failed','canceled')").map((r) => r.id);
    S.executor.planFail({ type: 'music', code: 'MOCK_ENGINE_ERROR', times: 3, message: '验收模拟：后台生成失败', exclude: stale });
    try {
      const r = await S.generate(g.token, genBody({ count: 1 }));
      assert.strictEqual(r.status, 202, 'V1-④ generate 应 202，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(r.json.credits_charged, 15, 'V1-④ count=1 → credits_charged 应为 15，实际 ' + r.json.credits_charged);
      const c1 = await S.credits(g.token);
      assert.strictEqual(c1.balance, 35, 'V1-④ 扣分后 balance 应为 35，实际 ' + c1.balance);
      const job = await S.waitForJob(g.token, r.json.job_id, { timeoutMs: 60000 });
      assert.strictEqual(job.status, 'failed', 'V1-④ 连败 3 次后 job 应为 failed（契约 §2 状态机），实际 ' + job.status + ' error=' + JSON.stringify(job.error));
      assert.ok(job.error && job.error.code, 'V1-④ 失败 job 应呈现真实错误码 {code,message}（V2 断言"失败呈现真实错误码"，契约 §2/§4）');
      assert.strictEqual(job.error.code, 'MOCK_ENGINE_ERROR', 'V1-④ error.code 应透传执行器 fail 的 code，实际 ' + JSON.stringify(job.error));
      const c2 = await S.credits(g.token);
      assert.strictEqual(c2.balance, 50, 'V1-④ 失败后应自动全额 refund，balance 应回到 50，实际 ' + c2.balance);
      const led = S.db.ledgerRows(g.user.id);
      assert.ok(!led.error, 'V1-④ 白盒读账本失败：' + led.error);
      const refundRows = led.rows.filter((x) => x.reason && /refund/i.test(x.reason));
      assert.ok(refundRows.length >= 1, 'V1-④ ledger 应有 reason=refund 的行（契约 §1"失败自动全额 refund（ledger reason=refund）"），实际 reasons=' + JSON.stringify(led.rows.map((x) => x.reason)));
      assert.ok(refundRows.some((x) => x.delta === 15), 'V1-④ refund 行 delta 应为 +15（全额），实际=' + JSON.stringify(refundRows));
    } finally {
      S.executor.failPlan = null;
    }
  });

  it('V1-⑤ 账本链：Σdelta == balance（复式记账不变量，施工计划 §5 V1）', async () => {
    const g = await S.newGuest();
    const c0 = await S.credits(g.token); // 先取余额（触发每日发放落账），再读账本核对 Σ
    assert.strictEqual(c0.balance, 50, 'V1-⑤ 前置：游客余额应为 50');
    const led0 = S.db.ledgerRows(g.user.id);
    assert.ok(!led0.error, 'V1-⑤ 白盒读账本失败：' + led0.error + '（契约缺账本查询端点，白盒兜底；server 必须落每日发放行）');
    assert.strictEqual(sumDelta(led0), c0.balance, 'V1-⑤ 注册后 Σledger.delta 必须等于 credits.balance（含初始发放行 +50），Σ=' + sumDelta(led0) + ' balance=' + c0.balance);
    await S.generate(g.token, genBody({ count: 1 }));
    const led1 = S.db.ledgerRows(g.user.id);
    assert.ok(!led1.error, 'V1-⑤ 白盒读账本失败：' + led1.error);
    const c1 = await S.credits(g.token);
    assert.strictEqual(sumDelta(led1), c1.balance, 'V1-⑤ 扣分后 Σledger.delta 必须等于 balance，Σ=' + sumDelta(led1) + ' balance=' + c1.balance + '；行=' + JSON.stringify(led1.rows));
  });

  it('V1-⑥ 新日重置：跨日后 expire+refill 两笔账（UPDATE last_credit_date 模拟跨日）', async () => {
    const g = await S.newGuest();
    await S.generate(g.token, genBody({ count: 1 })); // 消费 15 → balance 35
    const c0 = await S.credits(g.token);
    assert.strictEqual(c0.balance, 35, 'V1-⑥ 前置：消费后 balance 应为 35，实际 ' + c0.balance);
    const ledBefore = S.db.ledgerRows(g.user.id);
    assert.ok(!ledBefore.error, 'V1-⑥ 白盒读账本失败：' + ledBefore.error);
    // 模拟跨日：把 last_credit_date 改到昨天
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const upd = S.db.setLastCreditDate(g.user.id, yesterday);
    assert.ok(!upd.error, 'V1-⑥ 跨日模拟失败：' + upd.error + '（server 需按契约意图持久化 last_credit_date 类字段）');
    // 触发懒重置（先打 /v1/me；若服务端只在扣费点做重置则再用一次 generate 触发）
    await S.me(g.token);
    let led = S.db.ledgerRows(g.user.id);
    let newRows = led.rows.slice(ledBefore.rows.length);
    let triggeredByCharge = false;
    if (!newRows.some((x) => x.delta === -35) || !newRows.some((x) => x.delta === 50)) {
      const gr = await S.generate(g.token, genBody({ count: 1 }));
      assert.strictEqual(gr.status, 202, 'V1-⑥ 跨日后余额已重置为 50，generate(count=1,15 分) 必须 202，实际 ' + gr.status + ' ' + gr.text.slice(0, 200));
      triggeredByCharge = true;
      led = S.db.ledgerRows(g.user.id);
      newRows = led.rows.slice(ledBefore.rows.length);
    }
    const deltas = newRows.map((x) => x.delta);
    assert.ok(deltas.includes(-35), 'V1-⑥ 跨日应补记一笔 expire 账（delta=-重置前余额 35，不结转），新增行=' + JSON.stringify(newRows));
    assert.ok(deltas.includes(50), 'V1-⑥ 跨日应补记一笔 refill 账（delta=+50，契约 §1 每日免费积分），新增行=' + JSON.stringify(newRows));
    const expireRow = newRows.find((x) => x.delta === -35);
    const refillRow = newRows.find((x) => x.delta === 50);
    assert.ok(!expireRow.reason || /expire|reset|clear/i.test(expireRow.reason), 'V1-⑥ expire 行 reason 应可辨识（实际 ' + expireRow.reason + '）');
    assert.ok(!refillRow.reason || /refill|grant|daily|renew/i.test(refillRow.reason), 'V1-⑥ refill 行 reason 应可辨识（实际 ' + refillRow.reason + '）');
    const cFinal = await S.credits(g.token);
    const expected = triggeredByCharge ? 35 : 50; // 若由第二次 generate 触发，则重置后又扣了 15
    assert.strictEqual(cFinal.balance, expected, 'V1-⑥ 跨日重置后 balance 应为 ' + expected + '（不结转+重发' + (triggeredByCharge ? '，并含第二次 generate 扣 15' : '') + '），实际 ' + cFinal.balance);
    assert.strictEqual(sumDelta(led), cFinal.balance, 'V1-⑥ 跨日后仍须满足不变量 Σdelta==balance，Σ=' + sumDelta(led) + ' balance=' + cFinal.balance);
  });
});
