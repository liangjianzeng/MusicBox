'use strict';
// 音画报告真聚合（契约 v2.21，替换 api/mv.js STUB）。纯读既有表列，来源缺失则该项 0/[] 并如实；
// stub 仅在项目无任何 shot 时为 true（对齐“诚实占位”，绝不把全 0 当真数——App 侧据此判空态）。
const store = require('./store');
const config = require('../config');

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const r4 = (n) => (Number.isFinite(n) ? Number(n.toFixed(4)) : 0);
const safeParse = (x) => { if (!x) return null; if (typeof x === 'object') return x; try { return JSON.parse(x); } catch { return null; } };

function getReport(projectId) {
  const proj = store.get('SELECT id,kind,script_json FROM mv_projects WHERE id=?', projectId);
  const shots = store.all('SELECT id,seq,kind,status,best_take_id,flags_json FROM mv_shots WHERE project_id=? ORDER BY seq ASC', projectId);
  const out = {
    align_report: { aligned_lines: 0, mean_abs_err_ms: 0, within_150ms_ratio: 0 },
    sync_dist: { count: 0, mean: 0, p50: 0, p90: 0, below_threshold: 0 },
    phrase_hit: 0,
    degraded_shots: [],
    stub: true,
  };
  if (!shots.length) return out; // 无任何镜 → 诚实 STUB

  // sync 分布（各镜 best_take.sync_score）
  const thr = Number(config.mv.syncThreshold) || 0.6;
  const syncs = [];
  for (const s of shots) {
    if (!s.best_take_id) continue;
    const t = store.get('SELECT sync_score FROM mv_takes WHERE id=?', s.best_take_id);
    if (t && t.sync_score != null) {
      const v = Number(t.sync_score);
      if (Number.isFinite(v)) { syncs.push(v); if (v < thr) out.sync_dist.below_threshold++; }
    }
  }
  out.sync_dist.count = syncs.length;
  out.sync_dist.mean = r4(mean(syncs));
  out.sync_dist.p50 = r4(pct(syncs, 0.5));
  out.sync_dist.p90 = r4(pct(syncs, 0.9));

  // 降级镜清单（flags_json.degraded 归一）
  for (const s of shots) {
    const fj = safeParse(s.flags_json);
    const deg = fj && fj.degraded;
    const arr = Array.isArray(deg) ? deg : (deg ? [deg] : []);
    for (const label of arr) out.degraded_shots.push({ seq: Number(s.seq), label: String(label) });
  }

  // 对齐/命中（script_json.timings，align 回流写入；无则 0，纯器乐亦 0 且如实）
  const sj = safeParse(proj && proj.script_json);
  const tm = sj && sj.timings;
  if (tm) {
    const lines = Array.isArray(tm) ? tm : (Array.isArray(tm.lines) ? tm.lines : []);
    out.align_report.aligned_lines = lines.length;
    const errs = lines.map((l) => l && l.abs_err_ms).map(Number).filter(Number.isFinite);
    if (errs.length) {
      out.align_report.mean_abs_err_ms = Number(mean(errs).toFixed(1));
      out.align_report.within_150ms_ratio = Number((errs.filter((e) => e <= 150).length / errs.length).toFixed(3));
    }
    const shotsArr = (sj && Array.isArray(sj.shots)) ? sj.shots : [];
    const vocal = shotsArr.filter((x) => x && x.kind === 'singing');
    if (vocal.length) {
      const hit = vocal.filter((x) => x.timed || x.has_timing || String(x.text || x.lyric || '').trim()).length;
      out.phrase_hit = Number((hit / vocal.length).toFixed(3));
    }
  }
  // STUB 判据（计费诚信）：无任何真实聚合来源才标 stub:true；有任一真实信号即真值
  out.stub = !(out.sync_dist.count > 0 || out.align_report.aligned_lines > 0 || out.degraded_shots.length > 0);
  return out;
}

module.exports = { getReport };
