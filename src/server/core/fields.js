// 字段长度单一真源（2026-11-27，契约 v5.2.4）
// 放在 core 是因为 api 层与 l2 治理层都要用：l2 放行 60 字 / 落库截成 20 字的漂移就是这么来的。
// 新增字段上限请改这里，不要在调用点写字面量（V30-⑤ 会把字面量判红）。
'use strict';
const config = require('../config');

const FIELD_LIMITS = {
  mood: 20,   // canonical = api/works.js 落库前的截断长度
  scene_desc: 300,
  genre: 24,  // 单个流派词；列表上限另见 api/intent.js 的 unionArr cap=3
  voice: 24,  // v5.5.9「谁来唱」承载位（intent_cards.voice）
};

// 意图卡可调参数（契约 v5.5.9）：**唯一真源**。
// 这套参数历史上被抄了四份 —— l2music/governance 的 def.params、l2assistant/core 的工具白名单、
// l2music/execute 的透传键列表、l2assistant/facade 的 sanitizePlan 白名单。
// 而 governance_core 会把**未在 def.params 声明的键静默丢掉**（不报错、不审计），
// 少抄一个键就表现为「助手说改好了，卡其实没动」，用户只能反复重试。
// 加参数只改这里，四处 import 同一份 —— 这是防漂移，不是洁癖。
const SET_CARD_PARAMS = {
  mood: { kind: 'string', min: 1, max: FIELD_LIMITS.mood, optional: true },
  vocal: { kind: 'enum', values: ['song', 'instrumental', 'unknown'], optional: true },
  sec: { kind: 'integer', min: config.gen.sec_min, max: config.gen.sec_max, optional: true },
  bpm: { kind: 'integer', min: 40, max: 200, optional: true },
  count: { kind: 'integer', min: config.gen.count_min, max: config.gen.count_max, optional: true },
  scene_desc: { kind: 'string', min: 1, max: FIELD_LIMITS.scene_desc, optional: true },
  // v5.5.9 新增：此前想改流派只能走 HTTP PATCH，助手通道连声明都没声明 → 被 governance_core 静默丢弃
  genre_hypotheses: { kind: 'string', min: 1, max: FIELD_LIMITS.genre * 3 + 2, optional: true },
  voice: { kind: 'string', min: 1, max: FIELD_LIMITS.voice, optional: true },
};
const SET_CARD_KEYS = Object.keys(SET_CARD_PARAMS);

module.exports = { FIELD_LIMITS, SET_CARD_PARAMS, SET_CARD_KEYS };
