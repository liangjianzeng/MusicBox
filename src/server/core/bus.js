// 事件总线：进程内事件 → 按 user 定向 WSS 广播（CONTRACTS §3 五种事件）（2026-11-23）
'use strict';
const { EventEmitter } = require('node:events');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

// 在线连接：Map<user_id, Set<{send(obj), close()}>>
const clients = new Map();

function attach(userId, conn) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(conn);
  return () => detach(userId, conn);
}
function detach(userId, conn) {
  const s = clients.get(userId);
  if (!s) return;
  s.delete(conn);
  if (!s.size) clients.delete(userId);
}

// 定向广播一条事件给某用户的全部连接；send 抛错即摘除
function push(userId, obj) {
  const s = clients.get(userId);
  if (!s) return;
  for (const conn of [...s]) {
    try { conn.send(obj); } catch (e) { try { conn.close(); } catch (e2) {} s.delete(conn); }
  }
  emitter.emit('event', userId, obj); // 供 long-poll 等内部消费者
}

// —— CONTRACTS §3 五种事件 ——
function jobProgress(userId, jobId, progress, note) {
  push(userId, { type: 'job.progress', job_id: jobId, progress: Math.round(progress), note: note || '' });
}
function jobDone(userId, jobId, result) {
  push(userId, { type: 'job.done', job_id: jobId, result: result || null, error: null });
}
function jobError(userId, jobId, error) {
  push(userId, { type: 'job.done', job_id: jobId, result: null, error });
}
function intentCard(userId, intentId, status) {
  push(userId, { type: 'intent.card', intent_id: intentId, status });
}
function creditDelta(userId, delta, balanceAfter) {
  push(userId, { type: 'credit.delta', delta, balance_after: balanceAfter });
}

function waitEvent(predicate, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;
    const onEvt = (userId, obj) => {
      if (!predicate(userId, obj)) return;
      cleanup(); resolve(obj);
    };
    const cleanup = () => { emitter.off('event', onEvt); if (timer) clearTimeout(timer); };
    timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
    emitter.on('event', onEvt);
  });
}

function onlineCount() { return clients.size; }

module.exports = { attach, detach, push, jobProgress, jobDone, jobError, intentCard, creditDelta, waitEvent, onlineCount };
