// MV 剧本结构校验（契约 v2.10 / mv-plan §5.1④）：确定性规则，warn 不 fail（2026-11-24）
'use strict';
const U = require('./util');
const scriptPrompt = require('../prompts/mv_script');
const MAX_SHOTS = 16;

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

function assertShotShape(script_json, { work, kind, characters } = {}) {
  const bad = (message) => { throw new U.ApiError('INVALID_LLM_OUTPUT', message, 422); };
  if (!script_json || typeof script_json !== 'object' || !Array.isArray(script_json.shots)) bad('LLM 输出 shots 必须为数组');
  const shots = script_json.shots;
  if (!shots.length || shots.length > MAX_SHOTS) bad('LLM 输出镜头数须在 1–16 之间');
  const castIds = new Set((characters || []).map((c) => c.id));
  const lineCount = kind === 'vocal' ? scriptPrompt.lyricLines(work).length : 0;
  const ids = new Set();
  shots.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) bad('第 ' + (i + 1) + ' 镜必须为对象');
    if (!Number.isInteger(s.seq) || s.seq !== i + 1) bad('第 ' + (i + 1) + ' 镜 seq 必须为从 1 开始的连续整数');
    if (!['singing', 'story', 'broll'].includes(s.kind)) bad('第 ' + (i + 1) + ' 镜 kind 不合法');
    if (typeof s.sec !== 'number' || !Number.isFinite(s.sec) || s.sec < 1 || s.sec > 30) bad('第 ' + (i + 1) + ' 镜 sec 须为 1–30 的数字');
    if (typeof s.desc !== 'string' || !s.desc.trim()) bad('第 ' + (i + 1) + ' 镜 desc 不能为空');
    if (s.cast_ids !== undefined && (!Array.isArray(s.cast_ids) || s.cast_ids.some((x) => typeof x !== 'string' || !castIds.has(x)) || new Set(s.cast_ids).size !== s.cast_ids.length)) bad('第 ' + (i + 1) + ' 镜 cast_ids 不合法');
    if (s.id !== undefined && (typeof s.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(s.id) || ids.has(s.id))) bad('镜头稳定 id 不合法或重复');
    if (s.id !== undefined) ids.add(s.id);
    if (s.lyric_from !== undefined && s.lyric_from !== null && (!Number.isInteger(s.lyric_from) || s.lyric_from < 0 || s.lyric_from >= lineCount)) bad('第 ' + (i + 1) + ' 镜 lyric_from 越界');
    if (s.lyric_to !== undefined && s.lyric_to !== null && (!Number.isInteger(s.lyric_to) || s.lyric_to < 1 || s.lyric_to > lineCount)) bad('第 ' + (i + 1) + ' 镜 lyric_to 越界');
    if (s.kind === 'singing' && (!Number.isInteger(s.lyric_from) || !Number.isInteger(s.lyric_to) || s.lyric_to <= s.lyric_from)) bad('第 ' + (i + 1) + ' 演唱镜须含有效歌词窗口');
  });
  return script_json;
}

module.exports = { MAX_SHOTS, validate, assertShotShape };
