// MV 剧本结构校验（契约 v2.10 / mv-plan §5.1④）：确定性规则，warn 不 fail（2026-11-24）
'use strict';
const U = require('./util');
const scriptPrompt = require('../prompts/mv_script');

// findings=[{check, level:'warn', message}]；绝不抛错、绝不阻断流程（拍板权在人）
function validate({ script_json, work, kind, characters }) {
  const findings = [];
  const warn = (check, message) => findings.push({ check, level: 'warn', message: U.sanitizeEngineNames(message) });
  const shots = (script_json && Array.isArray(script_json.shots)) ? script_json.shots : [];
  const duration = Number(work && work.duration_sec) || 45;
  const castIds = new Set((characters || []).map((c) => c.id));
  const lyricCount = kind === 'vocal' ? scriptPrompt.lyricLines(work).length : 0;

  if (!shots.length) { warn('empty', '剧本为空或未编译，建议先重新生成分镜'); return findings; }

  // ① 镜数 ↔ 时长（±30%）
  const expected = scriptPrompt.shotCountFor(duration);
  if (shots.length < expected * 0.7 || shots.length > expected * 1.3) {
    warn('shot_count', `镜头数 ${shots.length} 与 ${duration}s 时长的建议区间（${expected}±30%）偏差较大`);
  }
  // ② 首镜钩子/远景
  const first = shots[0] || {};
  const cam = String(first.camera || '') + ' ' + String(first.desc || '');
  if (first.kind === 'singing' || !/远|wide|钩|hook|全景|full/i.test(cam)) {
    warn('first_hook', '首镜建议为远景钩子（非演唱镜），提升开场抓人度');
  }
  // ③ 唱段全覆盖（歌唱曲：每句歌词至少一个演唱镜）
  if (kind === 'vocal' && lyricCount) {
    const covered = new Array(lyricCount).fill(false);
    for (const s of shots) {
      if (s.kind === 'singing' && Number.isInteger(s.lyric_from)) {
        for (let k = s.lyric_from; k < (Number.isInteger(s.lyric_to) ? s.lyric_to : s.lyric_from + 1); k++) {
          if (k >= 0 && k < lyricCount) covered[k] = true;
        }
      }
    }
    const missing = covered.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
    if (missing.length) warn('lyric_cover', `有 ${missing.length} 句歌词未被任何演唱镜覆盖（如第 ${missing.slice(0, 5).map((i) => i + 1).join('、')} 句）`);
  }
  // ④ cast_ids 合法
  for (const s of shots) {
    const bad = U.toArr(s.cast_ids).filter((x) => !castIds.has(x));
    if (bad.length) { warn('cast_ids', `第 ${s.seq} 镜引用了不存在的角色（${bad.slice(0, 2).join(',')}），拍摄时将忽略`); break; }
  }
  // ⑤ Σsec ≈ 时长 ±10%
  const sum = shots.reduce((acc, s) => acc + (Number(s.sec) || 0), 0);
  if (Math.abs(sum - duration) > duration * 0.1) {
    warn('sec_sum', `镜头总时长 ${Math.round(sum)}s 与歌曲 ${Math.round(duration)}s 偏差超过 10%，合成时按歌曲时长对齐`);
  }
  return findings;
}

module.exports = { validate };
