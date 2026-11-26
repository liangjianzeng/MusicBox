// V32 · 并发写冲突必须"可辨识、可重试、不丢钱"
// 断言源：store.tx 的 BEGIN IMMEDIATE 与 SERVICE_BUSY(503) 映射。
// 为什么必须有这条：实机日志里出现过 `ERROR INTERNAL database is locked @ store.js:366`。
// deferred BEGIN 在 WAL 下的"读→写升级死锁"会**立刻**回 SQLITE_BUSY（busy_timeout 不生效），
// 于是用户看到 500 INTERNAL；而这条路径正是扣钱+派单的单事务 —— 500 到底有没有扣钱，谁也说不清。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const genBody = (idem) => ({
  mode: 'simple', prompt: '清晨海边的轻电子', mood: '治愈', tags: ['electronic'],
  count: 1, sec: 15, idem_key: idem,
});
const ledgerSum = (userId) => S.db.all('SELECT COALESCE(SUM(delta),0) s FROM credit_ledger WHERE user_id=?', userId)[0].s;
// 余额一律走契约口 GET /v1/me（那才是用户看到的数），不查内部列名，防止用例跟实现列名一起腐烂
const balance = async (token) => (await S.credits(token)).balance;

let S;
describe('V32 数据库并发写冲突（SERVICE_BUSY 而非 500）', () => {
  before(async () => { S = await H.boot('V32', { env: { MB_SWEEP_MS: '5000' } }); });
  after(async () => { if (S) await S.close(); });

  it('V32-① 写锁被长期持有时，扣钱+派单必须回可重试的 503，且一分钱都不能扣', async () => {
    const g = await S.newGuest();
    const bal0 = await balance(g.token);
    assert.strictEqual(bal0, 50, '游客初始 50⚡');

    // 另开一条白盒连接，持有写锁 6.5s（> 服务端 busy_timeout=5000），把服务端逼进真实锁竞争
    const holder = H.openWhiteDb(S.dbPath);
    holder.exec('PRAGMA busy_timeout=10000;');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare("INSERT INTO audit(id,kind,obj,created_at) VALUES('a_v32_hold','v32.hold','{}',?)").run(new Date().toISOString());
    const t0 = Date.now();
    let res;
    try {
      res = await S.api('POST', '/v1/works/generate', { token: g.token, json: genBody('v32-busy-1') });
    } finally {
      try { holder.exec('ROLLBACK'); } catch (e) { /* noop */ }
      try { holder.close(); } catch (e) { /* noop */ }
    }
    const waited = Date.now() - t0;

    assert.strictEqual(res.status, 503,
      '锁竞争超时应回 503 SERVICE_BUSY（可重试），实际 ' + res.status + ' ' + String(res.text).slice(0, 200)
      + '；旧实现这里是 500 INTERNAL "database is locked"');
    assert.strictEqual(res.json && res.json.code, 'SERVICE_BUSY', '错误码必须是 SERVICE_BUSY，实际 ' + JSON.stringify(res.json));
    assert.ok(/重试/.test(String(res.json && res.json.message)), '错误信息必须告诉客户端可重试：' + JSON.stringify(res.json));
    assert.ok(waited >= 4000,
      '必须真的排队等过 busy_timeout（IMMEDIATE 才会等；deferred 是立刻 Busy 直接 500），实际等待 ' + waited + 'ms');
    assert.strictEqual(await balance(g.token), bal0, '被拒的派单绝不能扣钱');
    assert.strictEqual(ledgerSum(g.user.id), await balance(g.token),
      '锁失败后账本不变量 Σdelta==balance 必须仍然成立，实际 ' + ledgerSum(g.user.id) + ' vs ' + await balance(g.token));
    // 不能按 idem_key LIKE 判存在 —— idem_key 是 normalizeForIdem 出的**哈希**，那样判永远是 0（空洞断言）
    assert.strictEqual(S.db.all("SELECT COUNT(*) n FROM jobs WHERE user_id=?", g.user.id)[0].n, 0,
      '绝不能留下半截 job（该用户名下必须一个 job 都没有）');
  });

  it('V32-② 锁释放后同参重试必须成功且账目配对（证明 503 真是"可重试"而不是推卸）', async () => {
    const g = await S.newGuest();
    const bal0 = await balance(g.token);
    // 这一条同时是"txDepth 没泄漏"的证据：上一条 BUSY 失败之后，同一个 server 进程的事务必须还能正常配对
    const r = await S.api('POST', '/v1/works/generate', { token: g.token, json: genBody('v32-retry-1') });
    assert.strictEqual(r.status, 202, '无锁竞争时应正常 202，实际 ' + r.status + ' ' + String(r.text).slice(0, 180));
    assert.strictEqual(r.json.credits_charged, 15);
    assert.strictEqual(await balance(g.token), bal0 - 15, '重试成功必须正常扣 15⚡');
    assert.strictEqual(ledgerSum(g.user.id), await balance(g.token), '成功后账本不变量 Σdelta==balance 必须成立（游客另有每日免费入账行，所以判不变量而不是绝对值）');
    assert.ok(r.json.job_id, '响应必须带 job_id');
    const jr = S.db.all('SELECT id, status, credits_cost, user_id FROM jobs WHERE id=?', r.json.job_id);
    assert.strictEqual(jr.length, 1, '重试成功必须真的落一条 job（按主键判，不按 idem_key 猜）');
    assert.strictEqual(jr[0].user_id, g.user.id, 'job 必须归属该用户');
    assert.strictEqual(jr[0].credits_cost, 15, 'job 上记录的扣费必须与实际扣款一致');
  });

  it('V32-③ 短锁（< busy_timeout）必须自动排队成功，不惊动客户端', async () => {
    const g = await S.newGuest();
    const holder = H.openWhiteDb(S.dbPath);
    holder.exec('PRAGMA busy_timeout=10000;');
    holder.exec('BEGIN IMMEDIATE');
    holder.prepare("INSERT INTO audit(id,kind,obj,created_at) VALUES('a_v32_hold2','v32.hold','{}',?)").run(new Date().toISOString());
    const p = S.api('POST', '/v1/works/generate', { token: g.token, json: genBody('v32-short-1') });
    await sleep(1200);                       // 让服务端进入排队
    try { holder.exec('COMMIT'); } catch (e) { /* noop */ }
    try { holder.close(); } catch (e) { /* noop */ }
    const res = await p;
    assert.strictEqual(res.status, 202, '锁在 busy_timeout 内释放就该静默成功，实际 ' + res.status + ' ' + String(res.text).slice(0, 180));
    assert.strictEqual(await balance(g.token), 35, '排队成功照常扣 15⚡');
    assert.strictEqual(ledgerSum(g.user.id), await balance(g.token), '排队成功同样必须守住 Σdelta==balance');
  });
});
