// 积分：每日免费 50 惰性重置（daily_expire+daily_free 成对入账）、扣分/退款原语、/v1/credits（2026-11-23）
'use strict';
const config = require('../config');
const store = require('../core/store');
const bus = require('../core/bus');
const U = require('../core/util');

const COST = config.credits;

// 新自然日首次触碰：balance>0 记 daily_expire，再 +daily_free 记 daily_free（账本链不变量由 appendLedger 保证）
function ensureDaily(userId) {
  const today = U.todayLocal();
  const last = store.getPref(userId, 'credit_reset_day');
  if (last === today) return;
  store.tx(() => {
    // 事务内二次确认（防并发）
    if (store.getPref(userId, 'credit_reset_day') === today) return;
    const bal = store.getBalance(userId);
    let after = bal;
    if (bal > 0) after = store.appendLedger(userId, -bal, 'daily_expire', 'day', today);
    after = store.appendLedger(userId, COST.daily_free, 'daily_free', 'day', today);
    store.setPref(userId, 'credit_reset_day', today);
    bus.creditDelta(userId, after - bal, after);
  });
  store.log('credit.daily_reset', { user_id: userId, day: today });
}

// 扣分（先扣分后派单）；余额不足抛 CREDITS_NOT_ENOUGH
function charge(userId, cost, reason, refType, refId) {
  cost = Math.max(0, Math.trunc(Number(cost) || 0));
  if (cost === 0) return { ok: true, balance_after: store.getBalance(userId) };
  if (!U.allowRate('credit:' + userId, 60, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  ensureDaily(userId);
  return store.tx(() => {
    const bal = store.getBalance(userId);
    if (bal < cost) throw new U.ApiError('CREDITS_NOT_ENOUGH', `积分不足，本次需要 ${cost} 积分，当前余额 ${bal}`);
    const after = store.appendLedger(userId, -cost, reason, refType, refId);
    bus.creditDelta(userId, -cost, after);
    return { ok: true, balance_after: after };
  });
}

// 退款（失败自动全额退回；幂等由调用方保证只调一次）
function refund(userId, cost, refType, refId) {
  cost = Math.max(0, Math.trunc(Number(cost) || 0));
  if (!cost) return;
  const after = store.tx(() => store.appendLedger(userId, cost, 'refund', refType, refId));
  bus.creditDelta(userId, cost, after);
}

function summary(userId) {
  ensureDaily(userId);
  const balance = store.getBalance(userId);
  const used = store.get(
    `SELECT COALESCE(SUM(CASE WHEN delta<0 AND reason<>'daily_expire' THEN -delta
                              WHEN reason='refund' THEN -delta ELSE 0 END),0) AS used
     FROM credit_ledger
     WHERE user_id=? AND rowid > COALESCE((SELECT rowid FROM credit_ledger WHERE user_id=? AND reason='daily_free' ORDER BY rowid DESC LIMIT 1),0)`,
    userId, userId);
  return { balance, daily_quota: COST.daily_free, daily_used: Math.max(0, (used && used.used) || 0) };
}

// GET /v1/credits → {balance, daily_quota, daily_used, items}
function getCredits(ctx) {
  const user = ctx.requireUser();
  const s = summary(user.id);
  const items = store.all(
    'SELECT delta,reason,balance_after,ref_type,ref_id,created_at FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 50', user.id)
    .map(r => ({ delta: r.delta, reason: r.reason, balance_after: r.balance_after, ref_type: r.ref_type, ref_id: r.ref_id, created_at: r.created_at }));
  return { status: 200, body: { ...s, items } };
}

module.exports = { ensureDaily, charge, refund, summary, routes: [{ m: 'GET', p: '/v1/credits', h: getCredits }] };
