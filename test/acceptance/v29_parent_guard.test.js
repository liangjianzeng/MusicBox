// V29 · 父子任务看护上界（抢救计划 P1-2「资损总闸门」补口）
// 断言源：src/server/core/engine.js sweep()/expireStuckChildren()
// 为什么必须有这条：music 父 job 完成生成后停在 running progress=90，等 transcode 子 job 全部终态才收口。
// 旧 sweep 是「有子任务就无上限续租」——子任务被 parked / 执行器永久掉线时，父 job **永远** running，
// 用户那 15⚡ 既不到「交付」也不到「退款」，是最难被发现的一类资损（本轮真机排障期间发现的）。
// 现在看护必须有上界；同时上界又不能"见慢就杀"，否则正常长任务被误杀 —— 所以两条都要验。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const genBody = (over) => Object.assign({
  mode: 'simple', prompt: '雨夜里的爵士小酒馆，萨克斯与钢琴', mood: '忧郁', tags: ['jazz'],
  count: 1, sec: 15, params: {},
}, over || {});

async function auditCount(S, kind) {
  return S.db.all('SELECT COUNT(*) n FROM audit WHERE kind=?', kind)[0].n;
}
function ledgerInvariant(S, userId) {
  const rows = S.db.all('SELECT COALESCE(SUM(delta),0) s FROM credit_ledger WHERE user_id=?', userId);
  const last = S.db.all('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 1', userId);
  return { sum: rows[0].s, balance: last.length ? last[0].balance_after : null };
}

describe('V29 父子任务看护上界（父 job 不得永久挂账）', () => {
  it('V29-① 子 job 永不终态时，父 job 必须在上界内收敛到终态且账本不变量成立', async () => {
    const S = await H.boot('V29guard', {
      env: { MB_SWEEP_MS: '120', MB_LEASE_MS: '1500', MB_PARENT_GUARD_MS: '600' },
    });
    try {
      const g = await S.newGuest();
      const r = await S.generate(g.token, genBody({ count: 1 }));
      assert.strictEqual(r.status, 202, 'generate 应 202，实际 ' + r.status + ' ' + r.text);
      const jobId = r.json.job_id;
      assert.strictEqual(r.json.credits_charged, 15, 'count=1 应扣 15⚡');

      // 转码子 job 被 fake executor park 住（默认 transcodeMode='park'）→ 父 job 会停在 running/90
      let parent = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 45000) {
        const jr = await S.api('GET', '/v1/jobs/' + jobId, { token: g.token });
        assert.strictEqual(jr.status, 200, '查 job 应 200：' + jr.status + ' ' + jr.text);
        parent = jr.json;
        if (['done', 'failed', 'canceled'].includes(parent.status)) break;
        await sleep(300);
      }
      assert.ok(parent && ['done', 'failed', 'canceled'].includes(parent.status),
        '子任务永不终态时，父 job 必须被看护上界收敛到终态，实际停在 ' + (parent && parent.status)
        + ' progress=' + (parent && parent.progress) + '（旧实现就是在这里永久 running，积分永久挂账）。'
        + ' fake 错误：' + JSON.stringify(S.executor.errors.slice(0, 3)));

      // 看护超时必须留下可追责审计（不许静默收敛）
      const guardLogs = S.db.all("SELECT COUNT(*) n FROM audit WHERE kind='job.child_guard_timeout'")[0].n;
      assert.ok(guardLogs >= 1, '收敛必须由"看护超时"审计支撑（否则说不清是谁把子任务判死的），实际 ' + guardLogs + ' 条');
      const kids = S.db.all("SELECT status, COUNT(*) n FROM jobs WHERE parent_job_id=? GROUP BY status", jobId);
      for (const k of kids) {
        assert.ok(['done', 'failed', 'canceled'].includes(k.status), '子 job 也必须终态，实际 ' + k.status + '×' + k.n);
      }

      // 钱必须两头有着落：要么交付（候选可用），要么退款（成对账目）—— 不许停在中间态
      const { sum, balance } = ledgerInvariant(S, g.user.id);
      assert.strictEqual(sum, balance, '收敛后账本不变量 Σdelta==balance 必须成立（实际 ' + sum + ' vs ' + balance + '）');
      const cands = S.db.all('SELECT id, audio_master, format FROM candidates WHERE job_id=?', jobId);
      if (parent.status === 'failed') {
        const ref = S.db.all("SELECT COALESCE(SUM(delta),0) s FROM credit_ledger WHERE user_id=? AND reason LIKE '%refund%'", g.user.id)[0].s;
        assert.ok(ref >= 15, '父 job 判失败就必须全额退款（≥15⚡），实际退 ' + ref);
      } else {
        assert.ok(cands.length >= 1 && cands.some(c => c.audio_master),
          '父 job 判完成就必须有可交付候选（降级 WAV 也算交付），实际候选 ' + JSON.stringify(cands));
      }
    } finally { await S.close(); }
  });

  it('V29-② 上界不得"见慢就杀"：看护窗口内的正常在飞子任务必须继续被看护（防反向回归）', async () => {
    const S = await H.boot('V29ok', {
      env: { MB_SWEEP_MS: '120', MB_LEASE_MS: '1500', MB_PARENT_GUARD_MS: String(10 * 60 * 1000) },
    });
    try {
      const g = await S.newGuest();
      const r = await S.generate(g.token, genBody({ count: 1 }));
      assert.strictEqual(r.status, 202, 'generate 应 202，实际 ' + r.status + ' ' + r.text);
      const jobId = r.json.job_id;

      // 等父 job 进入"等子任务"状态（running/90），最多 20s
      let parent = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const jr = await S.api('GET', '/v1/jobs/' + jobId, { token: g.token });
        parent = jr.json;
        if (parent.status === 'running' && Number(parent.progress) >= 90) break;
        if (['done', 'failed', 'canceled'].includes(parent.status)) break;
        await sleep(250);
      }
      assert.ok(parent, '应能观察到父 job 状态');
      if (parent.status === 'running') {
        await sleep(2500); // 跑过 20 次 sweep
        const again = (await S.api('GET', '/v1/jobs/' + jobId, { token: g.token })).json;
        assert.strictEqual(again.status, 'running',
          '看护窗口内（parentGuardMs=10min）不得把正常等待子任务的父 job 判死，实际 ' + again.status);
        assert.strictEqual(await auditCount(S, 'job.child_guard_timeout'), 0,
          '未超上界却记了看护超时审计，说明上界形同虚设');
      } else {
        assert.ok(['done', 'failed', 'canceled'].includes(parent.status),
          '若已终态，必须是真终态（不能是 queued/leased 之类的中间态）：' + parent.status);
      }
    } finally { await S.close(); }
  });
});
