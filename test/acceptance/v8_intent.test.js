// V8 · 澄清纪律（验收驱动施工 · 施工方 D · 2026-11-23）
// 断言源：CONTRACTS.md §2（intent 形状 + 澄清纪律"服务端强制"：总轮次≤2、每轮≤2 题、每题必带 recommended_idx、
//         confidence≥0.75 时 questions 为空直接 ready；generate 仅 ready 可调；adjust 不识别必追问不瞎猜）
//         docs/musicbox-construction-plan.md §5 V8。
// 机制：fake executor 产意图卡——上传字节含 HIGHCONF 标记 → confidence=0.92（且故意带题，验证服务端强制清空）；
//       无标记 → confidence=0.32 带 2 题。真实 LLM/ASR 端点被指到不可达地址 → 同时验证契约 §0 启发式兜底不报错。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S;

async function uploadVoice(token, withMarker) {
  const wav = H.makeSineWav({ sec: 3, freq: 330, marker: withMarker ? H.HIGHCONF_MARKER : null });
  const r = await S.api('POST', '/v1/intent/voice', {
    token, multipart: { fields: {}, files: [{ field: 'file', filename: 'v8-voice.wav', data: wav, contentType: 'audio/wav' }] },
  });
  assert.strictEqual(r.status, 202, 'V8 上传语音应 202 {intent_id}（契约 §2 /v1/intent/voice），实际 ' + r.status + ' ' + r.text.slice(0, 200));
  assert.ok(r.json && r.json.intent_id, 'V8 202 响应应含 intent_id，实际 ' + r.text.slice(0, 200));
  return r.json.intent_id;
}
function answerPayload(intent) {
  return { answers: (intent.questions || []).map((q) => ({ q_idx: q.q_idx, option_idx: q.recommended_idx != null ? q.recommended_idx : 0 })) };
}
// 通过答题把卡片推到 ready（服务端 answer 状态机会随答案升 confidence，可确定性到达 ≥0.75→ready）
async function reachReady(token, intentId) {
  let intent = await S.waitForIntent(token, intentId);
  for (let round = 0; round < 2 && intent.status === 'clarifying'; round++) {
    const r = await S.api('POST', '/v1/intent/' + intentId + '/answer', { token, json: answerPayload(intent) });
    assert.strictEqual(r.status, 200, 'V8 前置：answer 第 ' + (round + 1) + ' 轮应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    intent = await S.waitForIntent(token, intentId, { timeoutMs: 8000 }).catch(() => r.json.intent || r.json);
  }
  return intent;
}

describe('V8 多模态意图与澄清纪律', () => {
  before(async () => { S = await H.boot('V8'); });
  after(async () => { if (S) await S.close(); });

  it('V8-① 硬不变量：intent.confidence≥0.75 ⇒ questions==[] 且 status=ready（契约澄清纪律：高置信零提问）', async () => {
    const g = await S.newGuest();
    // 高置信样例：fake 执行器结果卡 confidence=0.92（且故意带 1 题，考验服务端强制）
    const intentId = await uploadVoice(g.token, true);
    const intent = await S.waitForIntent(g.token, intentId, { timeoutMs: 30000 });
    assert.strictEqual(intent.id, intentId, 'V8-① GET /v1/intent/:id 应回同一 intent');
    assert.strictEqual(intent.source_kind, 'voice', 'V8-① source_kind 应为 voice，实际 ' + intent.source_kind);
    assert.ok(Array.isArray(intent.mood) && Array.isArray(intent.genre_hypotheses), 'V8-① intent.mood/genre_hypotheses 应为数组（契约 intent 形状），实际 ' + JSON.stringify({ mood: intent.mood, genre_hypotheses: intent.genre_hypotheses }));
    assert.ok(['song', 'instrumental', 'unknown'].includes(intent.vocal), 'V8-① vocal 应为枚举 song|instrumental|unknown，实际 ' + intent.vocal);
    assert.strictEqual(typeof intent.confidence, 'number', 'V8-① confidence 应为数值（契约 intent 形状）');
    if (intent.confidence >= 0.75) {
      assert.deepStrictEqual(intent.questions, [], 'V8-① conf≥0.75 时 questions 必须为 []（服务端强制），实际 ' + JSON.stringify(intent.questions));
      assert.strictEqual(intent.status, 'ready', 'V8-① conf≥0.75 应直接 ready，实际 ' + intent.status);
    } else {
      // 契约 §0 LLM 可选性允许"confidence 降低即可"（本机 LLM :8193 不可达时会走词典兜底降置信）。
      // 但执行器结果卡（0.92）被整体丢弃重编译属架构偏离 → 记观察项（偏差清单 DEV-CARD）。
      console.log('[V8-① 观察] 执行器结果卡 conf=0.92 被服务端重编译为 ' + intent.confidence + '（LLM 不可达→启发式兜底，§0 允许降置信；' +
        '但契约 §4 语义是执行器编译、服务端强制纪律——结果卡被丢弃属偏差 DEV-CARD）');
      assert.ok(['clarifying', 'ready'].includes(intent.status), 'V8-① 兜底路径不得报错中断，status 应为 clarifying/ready，实际 ' + intent.status);
      if (intent.status === 'ready') assert.deepStrictEqual(intent.questions, [], 'V8-① ready 时 questions 必须为 []');
      else assert.ok((intent.questions || []).length <= 2, 'V8-① 每轮问题数须 ≤2，实际 ' + (intent.questions || []).length);
    }
    // 硬不变量的另一条确定性通路：answer 升级 conf≥0.75 → ready 且 questions 清空（不依赖 LLM）
    const g2 = await S.newGuest();
    const id2 = await uploadVoice(g2.token, false);
    const readyCard = await reachReady(g2.token, id2);
    assert.strictEqual(readyCard.status, 'ready', 'V8-① 两轮 answer 应把低置信卡推到 ready（answer 状态机），实际 ' + readyCard.status);
    assert.ok(readyCard.confidence >= 0.75, 'V8-① answer 升级后 conf 应 ≥0.75，实际 ' + readyCard.confidence);
    assert.deepStrictEqual(readyCard.questions, [], 'V8-① conf≥0.75 的 answer 终态 questions 必须为 []（服务端强制），实际 ' + JSON.stringify(readyCard.questions));
  });

  it('V8-② 低置信 → clarifying 且提问纪律：每轮≤2 题、options 2-4、每题必带 recommended_idx', async () => {
    const g = await S.newGuest();
    const intentId = await uploadVoice(g.token, false); // 低置信样例（fake 卡 confidence=0.32 带 2 题）
    const intent = await S.waitForIntent(g.token, intentId, { statuses: ['clarifying', 'ready', 'consumed'], timeoutMs: 25000 });
    // 若服务端启发式把该样例判成高置信直接 ready：属于兜底策略差异，只有它给出 ready 且零题才允许（此时本用例断言其纪律仍成立）
    if (intent.status === 'ready') {
      assert.deepStrictEqual(intent.questions, [], 'V8-② 低置信样例被判 ready 时必须零题（高置信才允许 ready），实际 ' + JSON.stringify(intent.questions));
      return;
    }
    assert.strictEqual(intent.status, 'clarifying', 'V8-② 低置信应进入 clarifying，实际 ' + intent.status);
    assert.ok(Array.isArray(intent.questions) && intent.questions.length >= 1 && intent.questions.length <= 2,
      'V8-② 每轮问题数须 ≤2（契约澄清纪律，本卡给 2 题），实际 ' + (intent.questions || []).length);
    for (const q of intent.questions || []) {
      assert.ok(typeof q.q === 'string' && q.q.length > 0, 'V8-② 每题须有题目文案 q，实际 ' + JSON.stringify(q).slice(0, 120));
      assert.ok(Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4,
        'V8-② 每题 options 恒 2-4 个（契约 intent 形状），实际 ' + JSON.stringify(q.options && q.options.map((o) => o.label)));
      assert.ok(Number.isInteger(q.recommended_idx), 'V8-② 每题必带 recommended_idx（契约：可跳过+推荐项；服务端强制项），实际题=' + JSON.stringify(q).slice(0, 120));
      assert.ok(q.recommended_idx >= 0 && q.recommended_idx < (q.options || []).length,
        'V8-② recommended_idx 必须落在 options 范围内，实际 ' + q.recommended_idx + '/' + (q.options || []).length);
    }
  });

  it('V8-③ 总轮次≤2：clarifying 态 answer 至多 2 次成功、第 3 次必被拒（契约：≤2 轮服务端强制）', async () => {
    const g = await S.newGuest();
    const intentId = await uploadVoice(g.token, false);
    let last = await S.waitForIntent(g.token, intentId, { statuses: ['clarifying', 'ready', 'consumed'], timeoutMs: 30000 });
    if (!(last.status === 'clarifying' && (last.questions || []).length)) {
      // LLM 在线且直接判成 ready：轮次上限天然满足，校验终态纪律后放行
      assert.deepStrictEqual(last.questions, [], 'V8-③ 前置：非 clarifying 时 questions 必为 []，实际 ' + JSON.stringify(last.questions));
      console.log('[V8-③ 观察] 低置信样例被判 ready（LLM 在线），3 轮拒绝路径跳过（轮次纪律已平凡满足）');
      return;
    }
    let okAnswers = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const wasClarifying = last.status === 'clarifying' && (last.questions || []).length > 0;
      if (!wasClarifying && attempt <= 2) break; // 服务端自行提前终结澄清 → 轮次上限平凡满足
      const r = await S.api('POST', '/v1/intent/' + intentId + '/answer', { token: g.token, json: answerPayload(last) });
      if (attempt === 3) {
        assert.ok(r.status >= 400,
          'V8-③ 第 3 轮 answer 必须被拒（契约：总轮次≤2、服务端强制；即便卡已 ready 也不得继续受理澄清答案），实际 ' + r.status + ' ' + r.text.slice(0, 200));
        assert.ok(r.json && typeof r.json.code === 'string', 'V8-③ 拒绝须按契约 §0 返回 {code,message}，实际 ' + r.text.slice(0, 200));
      } else {
        assert.strictEqual(r.status, 200, 'V8-③ clarifying 态第 ' + attempt + ' 轮 answer 应 200 {intent}（契约 §2），实际 ' + r.status + ' ' + r.text.slice(0, 200));
        okAnswers++;
        last = r.json.intent || r.json;
        if (last.status === 'clarifying' && !(last.questions || []).length) {
          await H.sleep(1200); // 服务端可能异步补题，取最新态
          const g2 = await S.api('GET', '/v1/intent/' + intentId, { token: g.token });
          last = g2.json.intent || g2.json;
        }
      }
    }
    assert.ok(okAnswers <= 2, 'V8-③ clarifying 态成功 answer 次数必须 ≤2，实际 ' + okAnswers);
    if (last.status === 'ready') assert.deepStrictEqual(last.questions, [], 'V8-③ 终态 ready 时 questions 必须为 []，实际 ' + JSON.stringify(last.questions));
  });

  it('V8-④ generate 仅 ready 可调：clarifying 时被拒且不消费；ready 后 202 且卡变 consumed（契约 §2）', async () => {
    const g = await S.newGuest();
    // ① clarifying 态不可 generate
    const lowId = await uploadVoice(g.token, false);
    const low = await S.waitForIntent(g.token, lowId, { statuses: ['clarifying', 'ready', 'consumed'], timeoutMs: 25000 });
    if (low.status === 'clarifying') {
      const bad = await S.api('POST', '/v1/intent/' + lowId + '/generate', { token: g.token, json: {} });
      assert.ok(bad.status >= 400, 'V8-④ status=clarifying 时 generate 必须被拒（契约：仅 status=ready 可调），实际 ' + bad.status + ' ' + bad.text.slice(0, 200));
      const chk = await S.api('GET', '/v1/intent/' + lowId, { token: g.token });
      const chkI = chk.json.intent || chk.json;
      assert.strictEqual(chkI.status, 'clarifying', 'V8-④ generate 被拒后卡不得变 consumed，实际 status=' + chkI.status);
    }
    // ② ready 态可 generate → 202 {job_id}，卡变 consumed（用 answer 升级的 ready 卡，不依赖 LLM 在线）
    const hiId = await uploadVoice(g.token, true);
    let hi = await S.waitForIntent(g.token, hiId, { timeoutMs: 30000 });
    if (hi.status !== 'ready') hi = await reachReady(g.token, hiId);
    assert.strictEqual(hi.status, 'ready', 'V8-④ 前置：卡应能到 ready（直接高置信或 answer 升级），实际 ' + hi.status);
    const ok = await S.api('POST', '/v1/intent/' + hiId + '/generate', { token: g.token, json: {} });
    assert.strictEqual(ok.status, 202, 'V8-④ ready 卡 generate 应 202 {job_id}（契约 §2），实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
    assert.ok(ok.json && ok.json.job_id, 'V8-④ generate 响应应含 job_id，实际 ' + ok.text.slice(0, 200));
    const after = await S.api('GET', '/v1/intent/' + hiId, { token: g.token });
    const afterI = after.json.intent || after.json;
    assert.strictEqual(afterI.status, 'consumed', 'V8-④ generate 后卡应变 consumed（契约 §2 注释"卡变 consumed"），实际 ' + afterI.status);
    // 幂等防护：consumed 后再 generate 应被拒
    const twice = await S.api('POST', '/v1/intent/' + hiId + '/generate', { token: g.token, json: {} });
    assert.ok(twice.status >= 400, 'V8-④ consumed 卡重复 generate 必须被拒（防重复扣分），实际 ' + twice.status);
  });

  it('V8-⑤ adjust "更欢快一点" → understood=true 且 delta.mood 含「欢快」（落到 job payload）', async (t) => {
    if (!S.ffmpeg) { t.skip('V8-⑤ 前置：无 ffmpeg → 无 done job 可 adopt，adjust 无从挂载（施工计划 §2 ffmpeg 待装）'); return; }
    S.executor.transcodeMode = 'real';
    try {
      const g = await S.newGuest();
      const { work } = await S.genAndAdopt(g.token, { mode: 'simple', prompt: H.uniq('v8adj'), sec: 15, count: 1 });
      const beforeN = S.executor.musicPayloads.length;
      const r = await S.api('POST', '/v1/works/' + work.id + '/adjust', { token: g.token, json: { text: '更欢快一点' } });
      assert.strictEqual(r.status, 200, 'V8-⑤ adjust 应 200（契约 §2），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(r.json.understood, true, 'V8-⑤ "更欢快一点"必被理解（V8：adjust 识别成功率≥80% 的必过样例），实际 ' + r.text.slice(0, 200));
      assert.ok(r.json.job_id, 'V8-⑤ understood=true 应回 job_id，实际 ' + r.text.slice(0, 200));
      // 等 fake executor 领到这条 variation job
      const t0 = Date.now();
      while (S.executor.musicPayloads.length === beforeN && Date.now() - t0 < 20000) await H.sleep(300);
      assert.ok(S.executor.musicPayloads.length > beforeN, 'V8-⑤ adjust 应派生 music job（执行器可见 payload），20s 内未领到；executor.errors=' + JSON.stringify(S.executor.errors).slice(0, 300));
      const p = S.executor.musicPayloads[S.executor.musicPayloads.length - 1];
      const moodStr = Array.isArray(p.mood) ? p.mood.join(' ') : String(p.mood || '');
      assert.ok(moodStr.includes('欢快'),
        'V8-⑤ adjust 的 delta.mood 必须含「欢快」（契约 §2 adjust 语义：文本→参数 delta），实际 payload.mood=' + JSON.stringify(p.mood) + '；全 payload=' + JSON.stringify(p).slice(0, 300));
    } finally {
      S.executor.transcodeMode = 'park';
    }
  });

  it('V8-⑥ adjust 乱码 → understood=false 且必给 clarify（不识别必追问不瞎猜，契约 §2/V8）', async (t) => {
    if (!S.ffmpeg) { t.skip('V8-⑥ 前置：无 ffmpeg → 无 done job 可 adopt（施工计划 §2 ffmpeg 待装）'); return; }
    S.executor.transcodeMode = 'real';
    try {
      const g = await S.newGuest();
      const { work } = await S.genAndAdopt(g.token, { mode: 'simple', prompt: H.uniq('v8gar'), sec: 15, count: 1 });
      const beforeN = S.executor.musicPayloads.length;
      const r = await S.api('POST', '/v1/works/' + work.id + '/adjust', { token: g.token, json: { text: '阿斯蒂芬qwerty###!!!？？？呜呜呜' } });
      assert.strictEqual(r.status, 200, 'V8-⑥ adjust 不识别也应 200 {understood:false,clarify}（契约 §2 两分支均为 200），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.strictEqual(r.json.understood, false, 'V8-⑥ 乱码必判 understood=false（不许瞎猜成参数），实际 ' + r.text.slice(0, 200));
      assert.strictEqual(typeof r.json.clarify, 'string', 'V8-⑥ understood=false 必带 clarify 追问文案（契约 §2），实际 ' + r.text.slice(0, 200));
      assert.ok(r.json.clarify && r.json.clarify.length > 0, 'V8-⑥ clarify 不得为空串');
      await H.sleep(1500);
      assert.strictEqual(S.executor.musicPayloads.length, beforeN, 'V8-⑥ understood=false 不得派生新 job（不瞎猜不扣分）');
    } finally {
      S.executor.transcodeMode = 'park';
    }
  });
});
