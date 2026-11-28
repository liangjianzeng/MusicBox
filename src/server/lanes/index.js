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
    // intent_text：端侧转写 / 确认页改字 → 只过理解不过 ASR，同 lane 复用（2026-11-24）
    // replica_analyze（契约 v5.7.4）：复刻参考曲分析 —— 同 lane（ASR 模式同源），per-type 超时 300s：
    // 整首歌远超 intent 语音 60s 的设计目标，不能吃 lane 级 90s
    types: ['intent_voice', 'intent_image', 'intent_text', 'replica_analyze'],
    timeoutMs: 90000,
    timeouts: { replica_analyze: 300000 },
    ladder(payload) { return { ...payload }; },
  },
  ffmpeg: {
    types: ['transcode', 'dsp', 'mv_preview', 'mv_compose'],
    timeoutMs: 120000,
    timeouts: { mv_preview: 600000, mv_compose: 600000 }, // 架构 §3.2：mv 视频合成档 600s
    ladder(payload) { return { ...payload }; },
  },
  // —— MV 二期 lanes（架构 §3.2；executor 侧 ROUTE/KNOWN_LANES 镜像登记归施工方 B）——
  imgspark: {
    types: ['mv_cast_image', 'mv_storyboard'], // 生图：定妆照/分镜关键帧
    timeoutMs: 900000,                          // 900s
    ladder(payload) { return { ...payload }; }, // steps 8→4 恒定 turbo，重试保真；同参 OOM 不重试（铁律）
  },
  vidspark: {
    types: ['mv_cast', 'mv_cast_video', 'mv_shot'], // i2v：定妆视频（含方案一）/拍摄
    timeoutMs: 3600000,                         // 3600s
    ladder(payload) { return { ...payload }; }, // 帧网格≤362/steps 恒 4/不降分辨率档——计费诚信（DEV-LADDER-PAY），不降交付维度
  },
  lipsync: {
    types: ['mv_lipsync'],
    timeoutMs: 1800000,                         // 1800s；仍败走 B-roll 降级非 fail 全片（executor 语义）
    ladder(payload) { return { ...payload }; },
  },
  align: {
    types: ['mv_align'],                        // 歌词↔时间轴对齐（纯 CPU sidecar）
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
// 单 job 期望时限：per-type 覆盖优先（mv_preview/mv_compose 600s），否则 lane 级 timeoutMs
function timeoutOf(type) {
  const l = LANES[laneOf(type)];
  if (!l) return 120000;
  if (l.timeouts && l.timeouts[type] != null) return l.timeouts[type];
  return l.timeoutMs;
}

// 重试用降档后的 payload
function ladderNext(type, payload, attempts) {
  const l = LANES[laneOf(type)];
  if (!l || !l.ladder) return payload;
  try { return l.ladder(payload || {}, attempts || 0); } catch (e) { return payload; }
}

module.exports = { LANES, laneOf, lane, allLanes, timeoutOf, ladderNext };
