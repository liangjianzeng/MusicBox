// lane 指标最小可观测集（N1-5 · 架构 §11 子集，2026-11-24）：
// per-type job 完成耗时（p50/p90 粗略估计，进程内环形样本）+ per-lane 队列深度（queued/leased）。
// 纪律：纯内存、零依赖、重启清零；只进 /healthz 观测面（契约 v2.18），不进业务路径、不做告警承诺。
'use strict';
const store = require('./store');
const lanes = require('../lanes');

const MAX_SAMPLES = 500; // 每 type 环形样本上限（粗略分位足够，常驻内存有界）
const byType = new Map(); // type → { done, samples:[ms] }

// finishDone 钩子：job 全程耗时（created_at → done），观测口径=用户等待总时长
function recordDone(type, durationMs) {
  try {
    const t = String(type || 'unknown');
    let e = byType.get(t);
    if (!e) { e = { done: 0, samples: [] }; byType.set(t, e); }
    e.done++;
    const d = Number(durationMs);
    if (Number.isFinite(d) && d >= 0) {
      e.samples.push(Math.min(24 * 3600000, Math.round(d)));
      if (e.samples.length > MAX_SAMPLES) e.samples.shift();
    }
  } catch (err) { /* 观测永不阻断业务 */ }
}

// 粗略分位：排序样本取上整位（单样本即自身；样本少时偏保守，符合"粗略桶即可"）
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

// /healthz mv_metrics 段快照（契约 v2.18）：{ types:{<type>:{done,p50_ms,p90_ms}}, lanes:{<lane>:{queued,leased}} }
function snapshot() {
  const U = require('./util');
  const types = {};
  for (const [t, e] of byType.entries()) {
    const s = e.samples.slice().sort((a, b) => a - b);
    types[t] = { done: e.done, p50_ms: pct(s, 0.5), p90_ms: pct(s, 0.9) };
  }
  const out = {};
  for (const ln of lanes.allLanes()) out[ln] = { queued: 0, leased: 0 };
  try {
    for (const r of store.all("SELECT type, status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','leased','running') GROUP BY type, status")) {
      const ln = lanes.laneOf(r.type);
      if (!out[ln]) out[ln] = { queued: 0, leased: 0 };
      if (r.status === 'queued') out[ln].queued += r.n;
      else out[ln].leased += r.n; // leased 与 running（租约看护中，含父任务等子）统一计 leased
    }
  } catch (e) { /* 深度读失败返回已有零值 */ }
  return { updated_at: U.nowIso(), types, lanes: out };
}

module.exports = { recordDone, snapshot };
