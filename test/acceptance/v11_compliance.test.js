// V11 · 合规与隐私（验收驱动施工 · 施工方 D · 2026-11-23）
// 断言源：CONTRACTS.md §0（审核/用户面纪律/AI 标注）/§2（report 仅落审计）
//         docs/musicbox-construction-plan.md §5 V11：审核软门拦截样例；AI 角标；上传物 72h TTL；举报链路可用。
// 词库为外置文件：helpers 在 var-test 写入占位词「测试违禁词A/B」，经 MB_MODERATION_WORDS_FILE 传给服务端
//   （契约未固化词库路径 env —— 见偏差清单 DEV-WORDS，server 必须支持该注入否则本用例无法验收）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S;
const W_LAST = {}; // V11-② 产出的 work 缓存给 V11-④ 复用（避免重复生成浪费积分与时间）

const ENGINE_NAME_RE = /ace-?\s*step|qwen|sensevoice|sense\s*voice|vllm|deepseek|whisper|cuda|\bgpu\b/i;

describe('V11 合规与隐私', () => {
  before(async () => { S = await H.boot('V11'); });
  after(async () => { if (S) await S.close(); });

  it('V11-① 审核软门：占位词「' + H.WORD_A + '」命中 → MODERATION_BLOCK、不扣分；面向用户文案不泄露引擎型号', async () => {
    const g = await S.newGuest();
    // 命中样例走 custom 线（lyrics 也受审）；prompt 命中样例见 V2-③
    const r = await S.generate(g.token, { mode: 'custom', lyrics: '第一段歌词里出现' + H.WORD_A + '的字样', tags: ['流行'], sec: 15 });
    assert.strictEqual(r.status, 400, 'V11-① lyrics 命中审核词库应 400（契约 §0 MODERATION_BLOCK），实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.ok(r.json && r.json.code === 'MODERATION_BLOCK', 'V11-① 应返回 code=MODERATION_BLOCK，实际 ' + r.text.slice(0, 200));
    assert.ok(typeof r.json.message === 'string' && r.json.message.length > 0, 'V11-① 拒绝应给可读 message');
    assert.ok(!ENGINE_NAME_RE.test(r.text), 'V11-① 面向用户的错误文案不得出现引擎型号名（契约 §0 用户面纪律），实际 ' + r.text.slice(0, 200));
    const c = await S.credits(g.token);
    assert.strictEqual(c.balance, 50, 'V11-① 被审核拦截不得扣分（balance 应为 50），实际 ' + c.balance);
    const ok = await S.generate(g.token, { mode: 'simple', prompt: H.uniq('v11-clean'), sec: 15 });
    assert.strictEqual(ok.status, 202, 'V11-① 对照组（不含占位词）应正常受理 202，实际 ' + ok.status + ' ' + ok.text.slice(0, 150));
  });

  it('V11-② ai_label 恒 true：adopt 产物与详情响应都必须带（契约 §0/§2 work 形状）', async (t) => {
    if (!S.ffmpeg) { t.skip('V11-② 前置：无 ffmpeg → 无 done job 可 adopt 出 work（施工计划 §2 ffmpeg 待装）'); return; }
    S.executor.transcodeMode = 'real';
    try {
      const g = await S.newGuest();
      const { work } = await S.genAndAdopt(g.token, { mode: 'simple', prompt: H.uniq('v11ai'), sec: 15, count: 1 });
      assert.strictEqual(work.ai_label, true, 'V11-② adopt 返回的 work.ai_label 必须为 true（契约 §0：AI 生成内容必须带 ai_label 标记）');
      const d = await S.api('GET', '/v1/works/' + work.id, { token: g.token });
      assert.strictEqual(d.status, 200, 'V11-② GET /v1/works/:id 应 200，实际 ' + d.status);
      const w2 = d.json.work || d.json;
      assert.strictEqual(w2.ai_label, true, 'V11-② 详情响应的 work.ai_label 必须恒为 true（AI 角标数据源），实际 ' + w2.ai_label);
      assert.ok(!ENGINE_NAME_RE.test(JSON.stringify(w2)), 'V11-② work 面向用户字段不得出现引擎型号名（契约 §0 用户面纪律）');
      W_LAST.work = w2; W_LAST.token = g.token;
    } finally {
      S.executor.transcodeMode = 'park';
    }
  });

  it('V11-③ 上传物 72h TTL：intent 上传落库必须带 created+≈72h 的过期字段（施工计划 §5 V11）', async () => {
    const g = await S.newGuest();
    const png = H.makePng('v11-img');
    const r = await S.api('POST', '/v1/intent/image', {
      token: g.token, multipart: { fields: {}, files: [{ field: 'file', filename: 'v11-scene.png', data: png, contentType: 'image/png' }] },
    });
    assert.strictEqual(r.status, 202, 'V11-③ 图像上传应 202 {intent_id}（契约 §2 /v1/intent/image），实际 ' + r.status + ' ' + r.text.slice(0, 200));
    await H.sleep(800); // 留落库窗口
    const res = S.db.uploadTtlRows(g.user.id);
    assert.ok(!res.error, 'V11-③ 上传物 TTL 白盒检查失败：' + res.error + '（契约意图：上传物 72h TTL 可验证；server 必须落 created+expire 字段，见偏差清单 DEV-TTL）');
    const hit = res.rows.find((x) => typeof x.ttlHours === 'number' && !Number.isNaN(x.ttlHours));
    assert.ok(hit, 'V11-③ uploads 行应有可解析的 created+expire（用于 72h TTL 验证），实际 ' + JSON.stringify(res.rows.slice(0, 3)));
    assert.ok(hit.ttlHours > 71 && hit.ttlHours < 73, 'V11-③ 上传物 TTL 应为 ≈72h（施工计划 §5 V11"72h TTL"），实际 ' + hit.ttlHours + 'h');
  });

  it('V11-④ report 落审计：举报 200 {ok:true} 且审计表可按原因检索到记录（M2 前仅落审计，契约 §2）', async (t) => {
    if (!S.ffmpeg) { t.skip('V11-④ 前置：无 ffmpeg → 无 work 可举报（施工计划 §2 ffmpeg 待装）'); return; }
    let target = W_LAST.work, token = W_LAST.token;
    if (!target) {
      S.executor.transcodeMode = 'real';
      try {
        const g = await S.newGuest();
        const adopted = await S.genAndAdopt(g.token, { mode: 'simple', prompt: H.uniq('v11rep'), sec: 15, count: 1 });
        target = adopted.work; token = g.token;
      } finally { S.executor.transcodeMode = 'park'; }
    }
    const needle = H.uniq('V11举报审计样例');
    const r = await S.api('POST', '/v1/works/' + target.id + '/report', { token, json: { reason: needle + '：内容不适' } });
    assert.strictEqual(r.status, 200, 'V11-④ POST /v1/works/:id/report 应 200（契约 §2 → 200 {ok:true}），实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.strictEqual(r.json.ok, true, 'V11-④ report 响应应为 {ok:true}，实际 ' + r.text.slice(0, 200));
    const aud = S.db.auditRowsLike(needle, [/report/i]);
    assert.ok(!aud.error, 'V11-④ 审计白盒检查失败：' + aud.error + '（契约 §2"report 仅落审计"，server 必须有审计落库，见偏差清单 DEV-AUDIT）');
    assert.ok(aud.hits.length >= 1, 'V11-④ 举报必须落审计（举报链路可用，施工计划 §5 V11）：audit/reports 表未检索到含「' + needle + '」的行');
    if (!aud.hits.some((h) => /audit/i.test(h.table))) {
      console.log('[V11-④ 观察] 举报理由文本只落了 reports 表、audit 事件未含 reason 原文（M2 审核闭环前可接受，记观察）');
    }
  });
});
