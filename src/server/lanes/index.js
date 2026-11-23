// lane 注册表：job 类型→lane 映射、每 lane 超时与降档梯子（2026-11-23）
'use strict';
const config = require('../config');

// lane 声明：types=承接的 job 类型；timeoutMs=单 job 期望时限；ladder=按 attempts 降档
const LANES = {
  music: {
    types: ['music'],
    timeoutMs: 8 * 60000,
    // 降档梯子（2026-11-23 真机验收修正）：**不得裁剪计费维度**。count/sec 是用户已付费交付维度
    // （15 分/候选），静默降档=少交付不退款，违反账本诚信；重试保真重跑，仍失败由 engine 置 failed+全额 refund。
    // 若日后引擎侧需要减负开关（如 persona clone fast/full），只降技术档位、不降交付量。
    ladder(payload) { return { ...payload }; },
  },
  intent: {
    types: ['intent_voice', 'intent_image'],
    timeoutMs: 90000,
    ladder(payload) { return { ...payload }; },
  },
  ffmpeg: {
    types: ['transcode', 'dsp'],
    timeoutMs: 120000,
    ladder(payload) { return { ...payload }; },
  },
};

const typeIndex = new Map();
for (const [laneName, lane] of Object.entries(LANES)) {
  for (const t of lane.types) typeIndex.set(t, laneName);
}

function laneOf(type) { return typeIndex.get(type) || 'ffmpeg'; }
function lane(name) { return LANES[name]; }
function allLanes() { return Object.keys(LANES); }
function timeoutOf(type) { const l = LANES[laneOf(type)]; return l ? l.timeoutMs : 120000; }

// 重试用降档后的 payload
function ladderNext(type, payload, attempts) {
  const l = LANES[laneOf(type)];
  if (!l || !l.ladder) return payload;
  try { return l.ladder(payload || {}, attempts || 0); } catch (e) { return payload; }
}

module.exports = { LANES, laneOf, lane, allLanes, timeoutOf, ladderNext };
