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

  it('V8-⑦ 卡面点改真落库（契约 v2.19 PATCH /v1/intent/:id）：改 mood/vocal/流派/sec/bpm/count 后 generate 必须带上，且不动 status/confidence', async () => {
    const g = await S.newGuest();
    const intentId = await uploadVoice(g.token, true);
    let intent = await S.waitForIntent(g.token, intentId, { timeoutMs: 30000 });
    if (intent.status !== 'ready') intent = await reachReady(g.token, intentId);
    assert.strictEqual(intent.status, 'ready', 'V8-⑦ 前置：卡应到 ready，实际 ' + intent.status);
    const confBefore = intent.confidence;

    const patch = { mood: ['摇滚', '治愈'], vocal: 'instrumental', genre_hypotheses: ['电子'], scene_desc: '雨夜霓虹下的独自行走', sec: 90, bpm: 128, count: 2 };
    const p = await S.api('PATCH', '/v1/intent/' + intentId, { token: g.token, json: patch });
    assert.strictEqual(p.status, 200, 'V8-⑦ clarifying/ready 卡 PATCH 应 200 {intent}（契约 §2 v2.19），实际 ' + p.status + ' ' + p.text.slice(0, 220));
    const got = p.json.intent || p.json;
    assert.ok(Array.isArray(got.mood) && got.mood.includes('摇滚') && got.mood.includes('治愈'),
      'V8-⑦ PATCH 后 intent.mood 必须为用户点改值（"可点改"不许只存 App 内存），实际 ' + JSON.stringify(got.mood));
    assert.strictEqual(got.vocal, 'instrumental', 'V8-⑦ PATCH 后 vocal 必须为 instrumental，实际 ' + got.vocal);
    assert.deepStrictEqual(got.genre_hypotheses, ['电子'], 'V8-⑦ PATCH 后 genre_hypotheses 必须为点改值，实际 ' + JSON.stringify(got.genre_hypotheses));
    assert.strictEqual(got.scene_desc, patch.scene_desc, 'V8-⑦ PATCH 后 scene_desc 必须为点改值，实际 ' + JSON.stringify(got.scene_desc));
    assert.strictEqual(got.status, 'ready', 'V8-⑦ 编辑不得改变 status（契约 v2.19：编辑与澄清纪律解耦），实际 ' + got.status);
    assert.strictEqual(got.confidence, confBefore, 'V8-⑦ 编辑不得改动 confidence（置信度只由答题推进），实际 ' + got.confidence + '（前 ' + confBefore + '）');
    const chk = await S.api('GET', '/v1/intent/' + intentId, { token: g.token });
    const chkI = chk.json.intent || chk.json;
    assert.deepStrictEqual(chkI.mood, got.mood, 'V8-⑦ GET 回读须与 PATCH 一致（真落库，不是响应里好看）');

    // 点改必须进派单：generate 的 music payload 带上用户显式选的 sec/bpm/count/tags/instrumental
    const beforeN = S.executor.musicPayloads.length;
    const ok = await S.api('POST', '/v1/intent/' + intentId + '/generate', { token: g.token, json: {} });
    assert.strictEqual(ok.status, 202, 'V8-⑦ ready 卡 generate 应 202，实际 ' + ok.status + ' ' + ok.text.slice(0, 220));
    const t0 = Date.now();
    while (S.executor.musicPayloads.length === beforeN && Date.now() - t0 < 20000) await H.sleep(300);
    assert.ok(S.executor.musicPayloads.length > beforeN, 'V8-⑦ generate 应派生 music job，20s 内未领到；executor.errors=' + JSON.stringify(S.executor.errors).slice(0, 300));
    const pl = S.executor.musicPayloads[S.executor.musicPayloads.length - 1];
    assert.strictEqual(pl.sec, 90, 'V8-⑦ 用户点改 sec=90 必须进 payload（契约 v2.19 参数优先级 gen_params>卡面>默认），实际 ' + pl.sec + '；全 payload=' + JSON.stringify(pl).slice(0, 300));
    assert.strictEqual(pl.bpm, 128, 'V8-⑦ 用户点改 bpm=128 必须进 payload，实际 ' + pl.bpm);
    assert.strictEqual(pl.count, 2, 'V8-⑦ 用户点改 count=2 必须进 payload——不得静默按 count_default 发 3 首（计费交付一致，对齐 DEV-LADDER-PAY），实际 ' + pl.count);
    assert.strictEqual(pl.candidates && pl.candidates.length, 2, 'V8-⑦ candidates 数须与点改 count 一致，实际 ' + JSON.stringify(pl.candidates));
    assert.strictEqual(pl.instrumental, true, 'V8-⑦ vocal=instrumental 点改必须落 instrumental=true，实际 ' + pl.instrumental);
    const moodStr = Array.isArray(pl.mood) ? pl.mood.join(' ') : String(pl.mood || '');
    assert.ok(moodStr.includes('摇滚'), 'V8-⑦ 点改 mood 必须进 payload，实际 ' + JSON.stringify(pl.mood));
    const tagStr = Array.isArray(pl.tags) ? pl.tags.join(',') : String(pl.tags || '');
    assert.ok(tagStr.includes('电子'), 'V8-⑦ 点改流派「电子」必须进 tags，实际 ' + JSON.stringify(pl.tags));
  });

  it('V8-⑧ 点改边界（契约 v2.19 服务端强制）：consumed 拒改、越界拒、超 3 项拒、空 body 拒、非卡主 404', async () => {
    const g = await S.newGuest();
    const intentId = await uploadVoice(g.token, true);
    let intent = await S.waitForIntent(g.token, intentId, { timeoutMs: 30000 });
    if (intent.status !== 'ready') intent = await reachReady(g.token, intentId);

    // ① 无字段
    const empty = await S.api('PATCH', '/v1/intent/' + intentId, { token: g.token, json: {} });
    assert.ok(empty.status >= 400, 'V8-⑧ 空 PATCH 必须被拒（无字段＝无事可做，不许 200 装成功），实际 ' + empty.status);
    // ② 越界 sec / bpm / count
    for (const [k, v] of [['sec', 9999], ['sec', 3], ['bpm', 999], ['count', 9]]) {
      const r = await S.api('PATCH', '/v1/intent/' + intentId, { token: g.token, json: { [k]: v } });
      assert.ok(r.status >= 400, 'V8-⑧ ' + k + '=' + v + ' 越界必须被拒（契约 v2.19 字段裁剪），实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(r.json && typeof r.json.code === 'string', 'V8-⑧ 拒绝须按契约 §0 回 {code,message}，实际 ' + r.text.slice(0, 160));
    }
    // ③ 超上限项数 / 非枚举
    const tooMany = await S.api('PATCH', '/v1/intent/' + intentId, { token: g.token, json: { mood: ['a', 'b', 'c', 'd'] } });
    assert.ok(tooMany.status >= 400, 'V8-⑧ mood 超 3 项必须被拒（契约 v2.19），实际 ' + tooMany.status);
    const badVocal = await S.api('PATCH', '/v1/intent/' + intentId, { token: g.token, json: { vocal: 'opera' } });
    assert.ok(badVocal.status >= 400, 'V8-⑧ vocal 非枚举必须被拒（song|instrumental|unknown），实际 ' + badVocal.status);
    // ④ 非卡主不可见不可改
    const g2 = await S.newGuest();
    const stranger = await S.api('PATCH', '/v1/intent/' + intentId, { token: g2.token, json: { mood: ['忧郁'] } });
    assert.ok(stranger.status === 404 || (stranger.json && stranger.json.code === 'NOT_FOUND'),
      'V8-⑧ 非卡主 PATCH 必须 404 NOT_FOUND（不得泄露他人卡存在性），实际 ' + stranger.status + ' ' + stranger.text.slice(0, 160));
    const mine = await S.api('GET', '/v1/intent/' + intentId, { token: g.token });
    const mineI = mine.json.intent || mine.json;
    assert.ok(!mineI.mood.includes('忧郁'), 'V8-⑧ 非卡主 PATCH 不得改到卡面，实际 mood=' + JSON.stringify(mineI.mood));
    // ⑤ consumed 后一律拒改（防改卡再派单）
    const gen = await S.api('POST', '/v1/intent/' + intentId + '/generate', { token: g.token, json: {} });
    assert.strictEqual(gen.status, 202, 'V8-⑧ 前置：ready 卡 generate 应 202，实际 ' + gen.status);
    const afterConsume = await S.api('PATCH', '/v1/intent/' + intentId, { token: g.token, json: { sec: 60 } });
    assert.ok(afterConsume.status >= 400, 'V8-⑧ consumed 卡 PATCH 必须被拒（与 generate 同口径，防改卡后再派单），实际 ' + afterConsume.status + ' ' + afterConsume.text.slice(0, 160));
  });

  // ---- v11 诚实化：端侧识别出的逐字要能进意图链；识别没起来必须显式标兜底 ----
  async function waitTextJob(needle) {
    for (let i = 0; i < 80; i++) {
      const rows = S.db.all("SELECT id,status,note FROM jobs WHERE type='intent_text' AND payload LIKE ?", '%' + needle + '%');
      if (rows.length && rows[0].status === 'done') return rows[0];
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('文本意图任务未在 16s 内完成（payload 含「' + needle + '」）');
  }

  it('V8-⑨ 文本意图线（端侧转写 / 确认页改字）：逐字必落库、改字重编译清答案、非法入参按契约拒', async () => {
    const g = await S.newGuest();
    // ① 端侧转写送进来 → 202，且「用户说了什么」必须逐字可回溯（此前库里根本没有这一列）
    const own = '想听点治愈的爵士，晚上一个人待着';
    const r = await S.api('POST', '/v1/intent/text', { token: g.token, json: { text: own } });
    assert.strictEqual(r.status, 202, 'V8-⑨ POST /v1/intent/text 应 202 {intent_id}，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    const intentId = r.json && r.json.intent_id;
    assert.ok(intentId, 'V8-⑨ 202 应含 intent_id，实际 ' + r.text.slice(0, 200));
    const done1 = await waitTextJob(own.slice(0, 8));
    const i1 = await S.waitForIntent(g.token, intentId, { timeoutMs: 20000 });
    assert.strictEqual(i1.source_kind, 'text', 'V8-⑨ source_kind 应为 text，实际 ' + i1.source_kind);
    assert.strictEqual(i1.source_text, own, 'V8-⑨ 用户原话必须逐字回显（不得只说"不理解"就完事），实际 ' + JSON.stringify(i1.source_text));
    assert.ok(i1.degraded === 1, 'V8-⑨ LLM 不可达走词典兜底须标 degraded=1（fake 执行器未命中 HIGHCONF），实际 ' + i1.degraded);
    assert.ok(/兜底/.test(done1.note || ''), 'V8-⑨ 兜底时 job.note 必须说明白，实际 ' + JSON.stringify(done1.note));
    // ② LLM 真编译成功（HIGHCONF）→ 不许标兜底
    const hiText = H.HIGHCONF_MARKER + ' 明亮的晨跑歌单';
    const r2 = await S.api('POST', '/v1/intent/text', { token: g.token, json: { text: hiText } });
    assert.strictEqual(r2.status, 202, 'V8-⑨ 高置信文本线应 202，实际 ' + r2.status);
    const i2 = await S.waitForIntent(g.token, r2.json.intent_id, { timeoutMs: 20000 });
    assert.strictEqual(i2.degraded, 0, 'V8-⑨ LLM 编译成功不得标兜底，实际 degraded=' + i2.degraded);
    assert.strictEqual(i2.source_text, hiText, 'V8-⑨ 高置信线同样要逐字落库，实际 ' + JSON.stringify(i2.source_text));
    // ③ 确认页改字 → 同一张卡原地重编译，旧答案作废（防止"答的是上一句"）
    const edited = '换成雨天适合听的民谣';
    const r3 = await S.api('POST', '/v1/intent/text', { token: g.token, json: { text: edited, intent_id: intentId } });
    assert.strictEqual(r3.status, 202, 'V8-⑨ 改字重编译应 202，实际 ' + r3.status + ' ' + r3.text.slice(0, 200));
    assert.strictEqual(r3.json.intent_id, intentId, 'V8-⑨ 改字须原地复用同一张卡（不新建），实际 ' + JSON.stringify(r3.json));
    const done3 = await waitTextJob(edited.slice(0, 6));
    const i3 = await S.waitForIntent(g.token, intentId, { timeoutMs: 20000 });
    assert.strictEqual(i3.source_text, edited, 'V8-⑨ 改字后逐字须更新为新句，实际 ' + JSON.stringify(i3.source_text));
    assert.deepStrictEqual(i3.answers, [], 'V8-⑨ 原话变了必须清空旧澄清答案，实际 ' + JSON.stringify(i3.answers));
    assert.ok(done3.status === 'done', 'V8-⑨ 改字任务应正常 done');
    // ④ 边界：空文本、超长、他人卡
    const empty = await S.api('POST', '/v1/intent/text', { token: g.token, json: { text: '   ' } });
    assert.ok(empty.status >= 400, 'V8-⑨ 空文本必须被拒，实际 ' + empty.status);
    const long = await S.api('POST', '/v1/intent/text', { token: g.token, json: { text: '雨'.repeat(600) } });
    assert.strictEqual(long.status, 202, 'V8-⑨ 超长文本应截断接受而非报错（契约：≤500 截断），实际 ' + long.status);
    const g2 = await S.newGuest();
    const stranger = await S.api('POST', '/v1/intent/text', { token: g2.token, json: { text: '借你的卡改一改', intent_id: intentId } });
    assert.ok(stranger.status === 404 || (stranger.json && stranger.json.code === 'NOT_FOUND'),
      'V8-⑨ 他人 intent_id 必须 404（不泄露存在性），实际 ' + stranger.status + ' ' + stranger.text.slice(0, 160));
  });

  it('V8-⑩ 语音识别没起来必须显式降级：degraded=1、逐字不得凭空造、job.note 说人话', async () => {
    const g = await S.newGuest();
    // 测试环境 ASR 指向不可达地址（helpers 里 MB_ASR_URL=127.0.0.1:9）——正是真机上周遇到的场景
    const intentId = await uploadVoice(g.token, false);
    const card = await S.waitForIntent(g.token, intentId, { timeoutMs: 25000 });
    assert.strictEqual(card.degraded, 1,
      'V8-⑩ 无转写（ASR 不可达）必须标 degraded=1，而不是继续报"意图卡已生成"，实际 ' + card.degraded);
    assert.ok(card.source_text == null || String(card.source_text).trim() === '',
      'V8-⑩ 没转写就没有逐字，不得凭空造一份，实际 ' + JSON.stringify(card.source_text));
    const rows = S.db.all("SELECT id,status,note FROM jobs WHERE type='intent_voice' AND payload LIKE ?", '%' + intentId + '%');
    assert.ok(rows.length, 'V8-⑩ 应能按 intent_id 找到语音意图任务');
    assert.strictEqual(rows[0].status, 'done', 'V8-⑩ 兜底路径任务仍须 done（契约 §0：兜底不报错中断）');
    assert.ok(/没听清|兜底/.test(rows[0].note || ''),
      'V8-⑩ job.note 必须把"这是兜底结果"讲清楚，实际 ' + JSON.stringify(rows[0].note));
  });
});
