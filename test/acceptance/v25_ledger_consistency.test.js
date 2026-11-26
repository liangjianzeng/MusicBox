// V25 · 账本与状态机一致性（抢救计划 P1-2「资损总闸门」门票套件）
// 断言源：docs/musicbox-rescue-refactor-plan.md §2.3 资损面 + §4 P1-2 门票
//   「新增账本一致性套件（崩溃重放、双 fail 竞态、cancel+fail 叠加、租约回收）进闸门」
// 纪律：只碰 var-test；不依赖内置假执行器；每条断言都对应一个历史上真实存在的资损路径。
'use strict';
// ⚠️ 必须在 require 任何服务端模块之前固定 var 根：本文件里有 in-process 直接用 store 的用例，
//    若 config 先被默认值初始化，会把测试写进生产 var/。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const INPROC_VAR = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v25-inproc-'));
process.env.MB_VAR_ROOT = INPROC_VAR;
process.env.MB_VAR_DIR = INPROC_VAR;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S;
const EX = 'ex_v25_owner';

function writeDb(dbPath, fn) {
  const db = H.openWhiteDb(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=8000;');
    return fn(db);
  } finally { try { db.close(); } catch (e) { /* noop */ } }
}
const rows = (sql, ...p) => S.db.all(sql, ...p);
function refundsFor(refId) {
  return rows("SELECT id,delta,reason,ref_type,ref_id FROM credit_ledger WHERE reason='refund' AND ref_id=?", refId);
}
function auditLike(kind) {
  return rows('SELECT kind,obj FROM audit WHERE kind=? ORDER BY rowid DESC LIMIT 5', kind);
}
async function newGuestWithGen(count) {
  const g = await S.newGuest();
  const r = await S.api('POST', '/v1/works/generate', {
    token: g.token,
    json: { mode: 'simple', prompt: '冬夜壁炉边的治愈钢琴', mood: '温暖', tags: ['治愈'], count: count || 1, sec: 30, params: {} },
  });
  return { g, resp: r, jobId: r.json && r.json.job_id, charged: r.json && r.json.credits_charged };
}

describe('V25 账本与状态机一致性', () => {
  before(async () => {
    // 关掉内置假执行器（要自己控制租约归属）；把 sweep 加速，让租约回收与不变量巡检在秒级发生
    S = await H.boot('V25', { noFakeExecutor: true, env: { MB_SWEEP_MS: '500', MB_CREDIT_AUDIT_TICKS: '1' } });
  });
  after(async () => {
    if (S) await S.close();
    try { fs.rmSync(INPROC_VAR, { recursive: true, force: true }); } catch (e) { /* 临时目录回收失败不影响结论 */ }
  });

  it('V25-① 同参并发派单不再"扣了再退"——账本必须只有一行扣费，而不是 -cost/+cost 对冲两行', async () => {
    const g = await S.newGuest();
    const body = { mode: 'simple', prompt: '同参幂等探针：清晨雨声吉他', mood: '温暖', tags: ['治愈'], count: 1, sec: 30, params: { seed_base: 777001 } };
    const [a, b] = await Promise.all([
      S.api('POST', '/v1/works/generate', { token: g.token, json: body }),
      S.api('POST', '/v1/works/generate', { token: g.token, json: body }),
    ]);
    for (const r of [a, b]) assert.strictEqual(r.status, 202, 'generate 应 202，实际 ' + r.status + ' ' + r.text);
    const uid = g.user.id;
    const gen = rows("SELECT delta,reason FROM credit_ledger WHERE user_id=? AND reason='gen'", uid);
    const refund = rows("SELECT delta,reason FROM credit_ledger WHERE user_id=? AND reason='refund'", uid);
    assert.strictEqual(gen.length, 1, '同参两次派单只能有一行 gen 扣费，实际 ' + JSON.stringify(gen));
    assert.strictEqual(refund.length, 0,
      '幂等竞态必须整笔回滚（同事务），不得"先扣再退"留下对冲两行，实际 refund 行=' + JSON.stringify(refund));
    const bal = await S.credits(g.token);
    const cost = a.json.credits_charged || b.json.credits_charged;
    assert.ok(cost > 0, '确有一次扣费');
    assert.strictEqual(bal.balance, 50 - cost, '余额必须 = 起始 50 − 一次扣费，实际 ' + bal.balance + '（扣费 ' + cost + '）');
  });

  it('V25-② 终态失败只退一次：把状态白盒改回 running 再报第二次 fail，退款行数仍必须为 1（CAS 生效）', async () => {
    const { g, jobId, charged, resp } = await newGuestWithGen(1);
    assert.ok(jobId, '派单必须成功才有得测：' + String(resp.status) + ' ' + resp.text);
    assert.ok(charged > 0, '本用例要求确有扣费');
    // 第一次 fail：attempts 直接抬到上限-1，让它一次就落终态 + 退款
    writeDb(S.dbPath, (db) => db.prepare("UPDATE jobs SET attempts=?, status='running', executor_id=?, lease_expire_at=? WHERE id=?")
      .run(2, EX, new Date(Date.now() + 600000).toISOString(), jobId));
    const f1 = await S.api('POST', '/executor/jobs/' + encodeURIComponent(jobId) + '/fail',
      { executorToken: H.EXECUTOR_TOKEN, json: { executor_id: EX, code: 'ENGINE_DOWN', message: '引擎掉了' } });
    assert.strictEqual(f1.status, 200, '首次 fail 应被接受，实际 ' + f1.status + ' ' + f1.text);
    let r1 = refundsFor(jobId);
    assert.strictEqual(r1.length, 1, '首次失败必须退款且只退一次，实际 ' + JSON.stringify(r1));
    const balAfter1 = (rows('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 1', g.user.id)[0] || {}).balance_after;

    // 模拟并发第二个上报者：它在第一个上报提交**之前**就读到了 job（credits_cost>0），
    // 现在才来上报 —— 旧实现（三步分开、守卫读快照）这里会退第二遍。
    writeDb(S.dbPath, (db) => db.prepare("UPDATE jobs SET status='running', executor_id=? WHERE id=?").run(EX, jobId));
    const f2 = await S.api('POST', '/executor/jobs/' + encodeURIComponent(jobId) + '/fail',
      { executorToken: H.EXECUTOR_TOKEN, json: { executor_id: EX, code: 'ENGINE_DOWN', message: '引擎又掉了' } });
    const r2 = refundsFor(jobId);
    assert.strictEqual(r2.length, 1,
      'credits_cost 的 CAS（WHERE credits_cost>0 且 changes===1）必须让第二个上报者退不了款；实际退款行数=' + r2.length + '（第二次 fail 返回 ' + f2.status + '）');
    const balAfter2 = (rows('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 1', g.user.id)[0] || {}).balance_after;
    assert.strictEqual(balAfter2, balAfter1, '二次上报绝不能改动余额');
  });

  it('V25-③ 崩溃重放：扣费与后续写同事务，中途抛错必须零净扣费、零余额推送', () => {
    const store = require('../../src/server/core/store.js'); // in-process 实例，独立 var（见文件头 MB_VAR_ROOT）
    const bus = require('../../src/server/core/bus.js');
    const uid = 'u_v25_crash';
    store.init();
    store.appendLedger(uid, 100, 'daily_free', 'day', 'seed');
    const before = store.getBalance(uid);
    let pushed = 0;
    const orig = bus.creditDelta;
    bus.creditDelta = (...a) => { pushed++; return orig.apply(bus, a); };
    try {
      assert.throws(() => store.tx(() => {
        store.appendLedger(uid, -30, 'gen', 'job', 'j_crash');
        store.onCommit(() => bus.creditDelta(uid, -30, 0)); // 提交后才推 —— 回滚时必须被丢弃
        throw new Error('模拟崩溃');
      }), /模拟崩溃/, 'tx 必须把异常抛出来');
      assert.strictEqual(store.getBalance(uid), before, '事务内扣费必须随回滚一起消失（旧实现：钱扣了 job 没建）');
      assert.strictEqual(pushed, 0, '回滚的扣费绝不能推给客户端（WSS 幻影扣款）');
      // 正常提交路径：推送必须发生，且发生在 COMMIT 之后
      const after = store.tx(() => {
        const bal = store.appendLedger(uid, -20, 'gen', 'job', 'j_ok');
        store.onCommit(() => bus.creditDelta(uid, -20, bal));
        assert.strictEqual(pushed, 0, 'COMMIT 之前不许推余额');
        return bal;
      });
      assert.strictEqual(pushed, 1, '提交后必须推一次余额');
      assert.strictEqual(store.getBalance(uid), before - 20);
      assert.strictEqual(after, before - 20);
    } finally { bus.creditDelta = orig; }
  });

  it('V25-④ 迟到上报：租约过期被回收后，慢执行器的 fail 必须 403 且真错误进审计（不再静默丢失）', async () => {
    const { jobId } = await newGuestWithGen(1);
    writeDb(S.dbPath, (db) => db.prepare("UPDATE jobs SET status='running', executor_id=?, lease_expire_at=? WHERE id=?")
      .run(EX, new Date(Date.now() - 5000).toISOString(), jobId));
    // 等 sweep（已加速到 500ms）把过期租约回收
    let swept = false;
    for (let i = 0; i < 40 && !swept; i++) {
      await H.sleep(300);
      swept = (rows('SELECT status FROM jobs WHERE id=?', jobId)[0] || {}).status === 'queued';
    }
    assert.ok(swept, 'sweep 必须回收过期租约并回队（实际状态 ' + JSON.stringify(rows('SELECT status,executor_id FROM jobs WHERE id=?', jobId)) + '）');
    const late = await S.api('POST', '/executor/jobs/' + encodeURIComponent(jobId) + '/fail',
      { executorToken: H.EXECUTOR_TOKEN, json: { executor_id: EX, code: 'MUSIC_HTTP', message: '音乐生成产物缺失，无法取回' } });
    assert.strictEqual(late.status, 403, '非归属执行器的上报必须 fail-closed 403，实际 ' + late.status + ' ' + late.text);
    const stale = auditLike('job.stale_report');
    assert.ok(stale.length >= 1, '拒收可以，但真错误必须进审计（本轮真机就栽在这里：403 把根因吞了）');
    assert.match(String(stale[0].obj), /MUSIC_HTTP|产物缺失/, '审计里要能看到执行器到底报了什么');
  });

  it('V25-⑤ 账本不变量巡检能抓破损：Σdelta != balance_after 时记审计并暴露到 /healthz', async () => {
    const uid = (await S.newGuest()).user.id;
    // 造一条破损账（白盒直插，绕过 appendLedger 的链式 balance_after）
    const last = rows('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 1', uid)[0];
    const bal = last ? last.balance_after : 0;
    writeDb(S.dbPath, (db) => db.prepare(
      'INSERT INTO credit_ledger(id,user_id,delta,balance_after,reason,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('cl_v25_broken', uid, 9999, bal, 'tamper', 'test', 'v25', new Date().toISOString()));
    let seenViolations = 0;
    for (let i = 0; i < 30; i++) {
      await H.sleep(300);
      const h = await S.api('GET', '/healthz');
      seenViolations = (h.json && h.json.credit_violations) || 0;
      if (seenViolations >= 1) break;
    }
    assert.ok(seenViolations >= 1, '/healthz 必须暴露 credit_violations 计数（巡检没跑或没抓到）');
    const v = auditLike('credit.invariant_violation');
    assert.ok(v.length >= 1, '破损必须落审计事件 credit.invariant_violation');
    assert.match(String(v[0].obj), /tamper|"diff"|diff/, '审计要含差额线索');
  });

  it('V25-⑥ store.tx 拒绝 async 闭包（否则 COMMIT 会早于异步业务写，账本失去原子性）', () => {
    const store = require('../../src/server/core/store.js');
    store.init();
    assert.throws(() => store.tx(async () => 1), /不得返回 Promise/, 'async 闭包必须被拒绝');
    assert.throws(() => store.tx(() => Promise.resolve(1)), /不得返回 Promise/, '返回 thenable 的同步闭包同样拒绝');
  });
});
