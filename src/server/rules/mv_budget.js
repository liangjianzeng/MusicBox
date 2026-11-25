// MV 项目预算护栏（D13/架构 S10/契约 v2.11）：1200⚡ 默认、>120% paused 仅人工恢复（2026-11-24）
'use strict';
const config = require('../config');
const store = require('../core/store');
const U = require('../core/util');

const MV = config.mv;
const OVER_RATIO = 1.2; // 超预算 120% → 暂停（S10）

function budgetOf(project) {
  const b = Number(project && project.budget_credits);
  return Number.isFinite(b) && b >= 0 ? b : MV.budgetDefault;
}

// 预算核验：cost(已花)+extraCost > budget×1.2 → 置 paused=1（仅人工经 PATCH budget_credits 恢复）+ 审计
// 返回 {ok, paused}；ok=false 表示应拒绝本次计费派单（402 BUDGET_EXCEEDED）
function checkBudget(project, extraCost) {
  const budget = budgetOf(project);
  const spent = Number(project.credits_cost) || 0;
  const extra = Math.max(0, Math.trunc(Number(extraCost) || 0));
  if (!project.paused && spent + extra > budget * OVER_RATIO) {
    store.run('UPDATE mv_projects SET paused=1, updated_at=? WHERE id=?', U.nowIso(), project.id);
    store.log('mv.budget.pause', { project_id: project.id, user_id: project.user_id, spent, extra, budget });
    return { ok: false, paused: true };
  }
  return { ok: !project.paused, paused: !!project.paused };
}

// 人工恢复唯一通道：PATCH {budget_credits} 调高 → paused=0 + 审计（自动恢复禁止）
function manualRaise(project, newBudget) {
  const old = budgetOf(project);
  const nb = Math.max(0, Math.trunc(Number(newBudget) || 0));
  store.run('UPDATE mv_projects SET budget_credits=?, paused=?, updated_at=? WHERE id=?',
    nb, nb > old ? 0 : (project.paused ? 1 : 0), U.nowIso(), project.id);
  if (nb > old) store.log('mv.budget.manual_raise', { project_id: project.id, user_id: project.user_id, from: old, to: nb, unpaused: !!project.paused });
  return { old, budget: nb };
}

// 报价快照（契约 v2.8.3）：shots×档位×config.mv.est 常数（架构 §8 单一真源）；est_ver=hash12 供 boot CAS
function estimate(project, shots) {
  const est = MV.est;
  const shotCount = (shots || []).length;
  const singing = (shots || []).filter((s) => s.kind === 'singing').length;
  const lipsync = (project && project.kind === 'vocal') ? singing : 0;
  const breakdown = [{ item: '拍摄', unit: MV.credits.shot, count: shotCount, credits: shotCount * MV.credits.shot }];
  if (lipsync > 0) breakdown.push({ item: '口型', unit: MV.credits.lipsync, count: lipsync, credits: lipsync * MV.credits.lipsync });
  if (project && project.kind === 'vocal') breakdown.push({ item: '歌词对齐', unit: MV.credits.align, count: 1, credits: MV.credits.align });
  breakdown.push({ item: '成片合成', unit: MV.credits.compose, count: 1, credits: MV.credits.compose });
  const credits = breakdown.reduce((a, r) => a + r.credits, 0);
  const minutes = Math.max(1, Math.round(shotCount * est.video / 60 + lipsync * est.lipsync / 60 + (project && project.kind === 'vocal' ? est.align / 60 : 0) + est.compose / 60 + 5));
  return { shots: shotCount, singing, lipsync, breakdown, credits, minutes, at: U.nowIso() };
}
function estVer(est) { return U.hash12(U.jstr(est)); }

module.exports = { OVER_RATIO, budgetOf, checkBudget, manualRaise, estimate, estVer };
