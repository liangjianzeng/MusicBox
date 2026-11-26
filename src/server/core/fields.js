// 字段长度单一真源（2026-11-27，契约 v5.2.4）
// 放在 core 是因为 api 层与 l2 治理层都要用：l2 放行 60 字 / 落库截成 20 字的漂移就是这么来的。
// 新增字段上限请改这里，不要在调用点写字面量（V30-⑤ 会把字面量判红）。
'use strict';
const FIELD_LIMITS = {
  mood: 20,   // canonical = api/works.js 落库前的截断长度
};
module.exports = { FIELD_LIMITS };
