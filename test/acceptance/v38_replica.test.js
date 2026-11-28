// V38 · 复刻（风格画像）与翻唱入口（契约 v5.7，2026-11-27 追加）
// 断言源：CONTRACTS.md §v5.7.1–v5.7.11。纪律：
//  · mock 先行（fake executor 产确定性假观测；闸门默认 LLM 不可达 → 规则画像 degraded=1，
//    正好把 v5.7.10 降级诚实断言钉死）；
//  · **每个用例独立 guest**：/v1/replica/* 的限流桶是按用户的（6 次/60s），共用 guest 必然互相打爆
//    （实测教训：feedback 的「400」里有的是 RATE_LIMITED 伪装，独立 guest 后自愈）；
//  · work 源全链要走 generate→transcode 真链，boot 后显式 transcodeMode='real'
//    （boot 默认 'park' 是给资金断言免竞态用的，不切真转码 job 永远停在 running）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S, adminToken;
let chain = {}; // ⑥ 的产物（prof/workId/token），⑦ 主权断言续用（避免重复烧限流桶）
const MOCK_TEXT = 'mock 参考曲转写：轻快的电子节拍，温暖的钢琴与弦乐铺底，女声气声唱法';

async function setFlag(key, enabled, grayscale) {
  const r = await S.api('POST', '/admin/config/features', {
    token: adminToken,
    json: { key, enabled, grayscale: grayscale === undefined ? (enabled ? 1 : 0) : grayscale },
  });
  assert.strictEqual(r.status, 200, 'setFlag ' + key + ' 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 160));
}

async function makeWork(token) {
  // 真链路建 work：generate(mock 执行器) → 等 done → adopt。产物才有 audio_master 可供分析。
  const g = await S.api('POST', '/v1/works/generate', {
    token,
    json: { mode: 'simple', prompt: '测试参考曲：轻快电子，温暖钢琴', count: 1, tags: ['electronic'] },
  });
  assert.strictEqual(g.status, 202, 'generate 应 202，实际 ' + g.status + ' ' + g.text.slice(0, 160));
  const jobId = g.json.job_id;
  let done = '';
  for (let i = 0; i < 60; i++) {
    const jr = await S.api('GET', '/v1/jobs/' + jobId, { token });
    done = jr.json && jr.json.status;
    if (done === 'done' || done === 'failed') break;
    await H.sleep(500);
  }
  assert.strictEqual(done, 'done', 'music job 应 done，实际 ' + done);
  const cand = (S.db.all('SELECT id FROM candidates WHERE job_id=? ORDER BY seq ASC', jobId)[0] || {}).id;
  assert.ok(cand, 'music job 应有候选');
  const a = await S.api('POST', '/v1/works/x/adopt', { token, json: { candidate_id: cand } });
  assert.strictEqual(a.status, 200, 'adopt 应 200，实际 ' + a.status + ' ' + a.text.slice(0, 160));
  return a.json.work.id;
}

async function analyzeWork(token, workId, title) {
  return S.api('POST', '/v1/replica/analyze', {
    token, json: { source: { kind: 'work', ref: workId, title: title || '我的参考曲' } },
  });
}

async function waitProfile(jobId, token, tries) {
  for (let i = 0; i < (tries || 60); i++) {
    const jr = await S.api('GET', '/v1/jobs/' + jobId, { token });
    const st = jr.json && jr.json.status;
    if (st === 'done' || st === 'failed') {
      const items = (await S.api('GET', '/v1/replica/profiles?job_id=' + jobId, { token })).json.items || [];
      return { status: st, note: (jr.json && jr.json.note) || '', items };
    }
    await H.sleep(500);
  }
  return { status: 'timeout', items: [] };
}

// 词表封闭断言（v5.7.5/6）：features 四域的每个词都必须逐字出现在服务端 catalog 对应域。
// 直接 require 服务端词典（单点真源），不复制一份词表进测试 —— 那正是机检要防的第二真源。
function assertCatalogClosed(features) {
  const dict = require('../../src/server/prompts/dictionary.js');
  const cat = dict.catalog();
  const inList = (w, list) => list.some((x) => x.zh === w);
  for (const w of features.moods || []) assert.ok(inList(w, cat.moods), `特征词「${w}」必须落在 catalog moods 域（v5.7.5 词表封闭），四域=${JSON.stringify(features)}`);
  for (const w of features.genres || []) assert.ok(inList(w, cat.genres), `特征词「${w}」必须落在 catalog genres 域，四域=${JSON.stringify(features)}`);
  for (const w of features.styleWords || []) assert.ok(inList(w, cat.style_words), `特征词「${w}」必须落在 catalog style_words 域，四域=${JSON.stringify(features)}`);
  for (const w of features.voice || []) assert.ok(inList(w, cat.voice), `特征词「${w}」必须落在 catalog voice 域，四域=${JSON.stringify(features)}`);
}

describe('V38 复刻（风格画像）与翻唱入口', () => {
  before(async () => {
    S = await H.boot('V38', {});
    S.executor.transcodeMode = 'real'; // 见文件头纪律第三条
    const lg = await S.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
    adminToken = lg.json && lg.json.token;
    await setFlag('replicaMode', true, 1);
  });
  after(async () => { if (S) await S.close(); });

  it('V38-① 灰度关：/v1/replica/* 一律 404（不给探测面，v5.7.2）', async () => {
    const u = await S.newGuest();
    await setFlag('replicaMode', false, 0);
    for (const [m, p] of [['GET', '/v1/replica/profiles'], ['POST', '/v1/replica/analyze']]) {
      const r = await S.api(m, p, { token: u.token, json: { source: { kind: 'web', query: '晴天' } } });
      assert.strictEqual(r.status, 404, `${m} ${p} 灰度关应 404，实际 ${r.status}`);
    }
    const cfg = await S.api('GET', '/v1/app/config');
    assert.strictEqual(cfg.json.features && cfg.json.features.replicaMode, false,
      'app/config 必须下发 replicaMode=false（运营关断面）');
    await setFlag('replicaMode', true, 1); // 恢复：后续用例要开态
  });

  it('V38-② work 源全链：分析 job done → 建谱 → 词表封闭 + degraded 如实（闸门默认 LLM 不可达）', async () => {
    const u = await S.newGuest();
    const empty = await S.api('GET', '/v1/replica/profiles', { token: u.token });
    assert.strictEqual(empty.status, 200, '灰度开 → 列表应 200，实际 ' + empty.status);
    assert.deepStrictEqual(empty.json.items, [], '新用户列表应为空');

    const workId = await makeWork(u.token);
    const an = await analyzeWork(u.token, workId);
    assert.strictEqual(an.status, 202, 'work 源分析应 202 {job_id}，实际 ' + an.status + ' ' + an.text.slice(0, 160));
    const out = await waitProfile(an.json.job_id, u.token);
    assert.strictEqual(out.status, 'done', '分析 job 应 done，实际 ' + out.status + ' note=' + out.note);
    assert.strictEqual(out.items.length, 1, '应恰好建出一份谱');
    const prof = out.items[0];
    assert.strictEqual(prof.source_kind, 'work');
    assert.strictEqual(prof.job_id, an.json.job_id, '谱必须能按 job 反查（端侧取谱依赖它）');
    assertCatalogClosed(prof.features);
    assert.strictEqual(prof.degraded, true,
      '闸门默认 LLM 不可达 → 规则画像必须 degraded=1（v5.7.10 降级诚实）');
    assert.ok(/降级|元数据/.test(prof.summary || ''), '降级谱的 summary 必须明说没走理解服务，实际：' + prof.summary);
  });

  it('V38-③ 上传规格：魔数/去重幂等/超限拒收/他人不可见（v5.7.3）', async () => {
    const u = await S.newGuest();
    const wav = () => H.makeSineWav({ sec: 12, freq: 440 });
    const up = await S.api('POST', '/v1/replica/source/upload', {
      token: u.token,
      multipart: { fields: {}, files: [{ field: 'file', filename: 'ref.wav', data: wav(), contentType: 'audio/wav' }] },
    });
    assert.strictEqual(up.status, 200, '合法 wav 应 200，实际 ' + up.status + ' ' + up.text.slice(0, 160));
    assert.ok(up.json.upload_id, '应回 upload_id');
    const again = await S.api('POST', '/v1/replica/source/upload', {
      token: u.token,
      multipart: { fields: {}, files: [{ field: 'file', filename: 'ref.wav', data: wav(), contentType: 'audio/wav' }] },
    });
    assert.strictEqual(again.json.upload_id, up.json.upload_id, '同 sha256 重传必须幂等返回同一 upload_id');
    const bad = await S.api('POST', '/v1/replica/source/upload', {
      token: u.token,
      multipart: { fields: {}, files: [{ field: 'file', filename: 'fake.mp3', data: Buffer.from('这不是音频', 'utf8'), contentType: 'audio/mpeg' }] },
    });
    assert.strictEqual(bad.status, 400, '伪魔数必须 400，实际 ' + bad.status);
    const big = await S.api('POST', '/v1/replica/source/upload', {
      token: u.token,
      multipart: { fields: {}, files: [{ field: 'file', filename: 'big.wav', data: Buffer.alloc(21 * 1024 * 1024 + 44, 0x55), contentType: 'audio/wav' }] },
    });
    assert.strictEqual(big.status, 400, '>20MB 必须 400（worker 上限同一口径），实际 ' + big.status);
    const other = await S.newGuest();
    const foreign = await S.api('POST', '/v1/replica/analyze', {
      token: other.token, json: { source: { kind: 'upload', ref: up.json.upload_id } },
    });
    assert.strictEqual(foreign.status, 404, '他人上传件必须 404（不给存在性探测面）');
  });

  it('V38-④ web 源：歌手名拦截 + 无检索源如实说（v5.7.6/10）', async () => {
    const u = await S.newGuest();
    const blocked = await S.api('POST', '/v1/replica/analyze', {
      token: u.token, json: { source: { kind: 'web', query: '像邓紫棋那样的风格' } },
    });
    assert.strictEqual(blocked.status, 200, 'web 拦截应 200（业务层结果，不是错误）');
    assert.strictEqual(blocked.json.ok, false, '拦截必须 ok:false');
    assert.strictEqual(blocked.json.artist_blocked, true, '必须带 artist_blocked 标记');
    assert.ok(/不能模仿具体歌手|声纹/.test(blocked.json.reason || ''),
      '话术必须明说「不能模仿具体歌手的声音/不提取声纹」，实际：' + blocked.json.reason);
    const dead = await S.api('POST', '/v1/replica/analyze', {
      token: u.token, json: { source: { kind: 'web', query: '晴天' } },
    });
    assert.strictEqual(dead.json.ok, false, '无检索源必须 ok:false');
    assert.ok((dead.json.reason || '').length > 0, '必须给明确原因，绝不空数组假装搜过');
  });

  it('V38-⑤ feedback → 预填意图卡：ask_budget=3、题 ≤3、gen_params.replica 落库；审核零豁免（v5.7.7）', async () => {
    const u = await S.newGuest();
    const workId = await makeWork(u.token);
    const an = await analyzeWork(u.token, workId);
    const out = await waitProfile(an.json.job_id, u.token);
    const prof = out.items[0];
    assert.ok(prof, '前置：谱必须建成');
    const emptyText = await S.api('POST', '/v1/replica/profiles/' + prof.id + '/feedback', {
      token: u.token, json: { text: '' },
    });
    assert.strictEqual(emptyText.status, 400, '空文本必须 400（v5.7.7 text 必填）');
    const bad = await S.api('POST', '/v1/replica/profiles/' + prof.id + '/feedback', {
      token: u.token, json: { text: '副歌' + H.WORD_A },
    });
    assert.strictEqual(bad.status, 400, '审核词库必须拦（复刻不是审核旁路），实际 ' + bad.status + ' ' + bad.text.slice(0, 120));
    const fb = await S.api('POST', '/v1/replica/profiles/' + prof.id + '/feedback', {
      token: u.token, json: { text: '节奏再慢一点，主题写深夜的城市霓虹' },
    });
    assert.strictEqual(fb.status, 200, '正常反馈应 200，实际 ' + fb.status + ' ' + fb.text.slice(0, 160));
    const intent = fb.json.intent;
    assert.ok(intent && fb.json.intent_id, '应回 intent_id + intent');
    assert.strictEqual(intent.ask_budget, 3, '复刻卡 ask_budget 必须 3（v5.7.7）');
    assert.ok((intent.questions || []).length <= 3 && (intent.questions || []).length >= 1,
      '首轮题 1-3 道，实际 ' + (intent.questions || []).length);
    const gpRow = S.db.all('SELECT gen_params FROM intent_cards WHERE id=?', fb.json.intent_id)[0];
    const gp = JSON.parse(gpRow.gen_params || '{}');
    assert.ok(gp.replica && gp.replica.profile_id === prof.id, 'gen_params.replica 必须落库（溯源挂靠意图卡）');
    assert.ok(['work', 'upload', 'web'].includes(gp.replica.source_kind), 'source_kind 必须是三来源之一');
  });

  it('V38-⑥ 出歌与溯源：lineage=replica、ai_label=1、计费一致、Σdelta==balance（v5.7.8）', async () => {
    const u = await S.newGuest();
    const workId = await makeWork(u.token);
    const an = await analyzeWork(u.token, workId);
    const out = await waitProfile(an.json.job_id, u.token);
    const prof = out.items[0];
    assert.ok(prof, '前置：谱必须建成');
    const fb = await S.api('POST', '/v1/replica/profiles/' + prof.id + '/feedback', {
      token: u.token, json: { text: '照这份风格画像创作' },
    });
    assert.strictEqual(fb.status, 200, 'feedback 应 200，实际 ' + fb.status + ' ' + fb.text.slice(0, 160));
    const answers = (fb.json.intent.questions || []).map((q) => ({ q_idx: q.q_idx, option_idx: q.recommended_idx }));
    const ans = await S.api('POST', '/v1/intent/' + fb.json.intent_id + '/answer', {
      token: u.token, json: { answers },
    });
    assert.strictEqual(ans.json.status, 'ready', '答完推荐项应 ready，实际 ' + ans.json.status);
    // 点改 count=1 再出歌：50 日免要先付 makeWork 的 15，出歌只剩 35 —— 正好走「用户显式点改
    // count 才覆盖默认」的既有路径（v2.19），也把 402/CREDITS_NOT_ENOUGH 从验收里挡出去。
    // 真机上余额不足给出路是端侧简报卡的职责（契约 v5.5 简报卡），服务端只负责拒收不扣分。
    const patched = await S.api('PATCH', '/v1/intent/' + fb.json.intent_id, {
      token: u.token, json: { count: 1 },
    });
    assert.strictEqual(patched.status, 200, '点改 count 应 200，实际 ' + patched.status + ' ' + patched.text.slice(0, 160));
    const bal0 = (await S.api('GET', '/v1/credits', { token: u.token })).json.balance;
    const gen = await S.api('POST', '/v1/intent/' + fb.json.intent_id + '/generate', { token: u.token, json: {} });
    assert.strictEqual(gen.status, 202, '出歌应 202，实际 ' + gen.status + ' ' + gen.text.slice(0, 160));
    const charged = gen.json.credits_charged;
    assert.strictEqual(charged, 15, '点改 1 候选 × per_candidate=15 = 15，实际 ' + charged);
    let done = '';
    for (let i = 0; i < 60; i++) {
      const jr = await S.api('GET', '/v1/jobs/' + gen.json.job_id, { token: u.token });
      done = jr.json && jr.json.status;
      if (done === 'done' || done === 'failed') break;
      await H.sleep(500);
    }
    assert.strictEqual(done, 'done', 'music job 应 done');
    const payload = JSON.parse(S.db.all('SELECT payload FROM jobs WHERE id=?', gen.json.job_id)[0].payload || '{}');
    assert.strictEqual(payload.lineage && payload.lineage.kind, 'replica', 'payload.lineage.kind 必须 replica');
    const cand = S.db.all('SELECT id FROM candidates WHERE job_id=? ORDER BY seq ASC', gen.json.job_id)[0].id;
    const adopt = await S.api('POST', '/v1/works/x/adopt', { token: u.token, json: { candidate_id: cand } });
    assert.strictEqual(adopt.status, 200);
    const w = adopt.json.work;
    assert.strictEqual(w.lineage.kind, 'replica', 'works.lineage 必须 replica，实际 ' + JSON.stringify(w.lineage));
    assert.strictEqual(w.ai_label, true, 'ai_label=1 不变（AI 生成标注）');
    const gp = JSON.parse(S.db.all('SELECT gen_params FROM works WHERE id=?', w.id)[0].gen_params || '{}');
    assert.ok(gp.replica && gp.replica.profile_id === prof.id, 'works.gen_params.replica 必须随 adopt 落库');
    const ledger = S.db.all('SELECT COALESCE(SUM(delta),0) s FROM credit_ledger WHERE user_id=?', u.user.id);
    const bal = (await S.api('GET', '/v1/credits', { token: u.token })).json.balance;
    assert.strictEqual(ledger[0].s, bal, 'Σdelta == balance（账本不变量）');
    assert.strictEqual(bal, bal0 - charged, '余额扣减 = 本单扣费');
    chain = { prof, workId: w.id, token: u.token, userId: u.user.id }; // ⑦ 续用
  });

  it('V38-⑦ 主权：他人 404、可删、删谱不删作品（v5.7.9）', async () => {
    const { prof, workId, token } = chain;
    assert.ok(prof && prof.id, '前置：⑥ 必须已产出谱');
    const other = await S.newGuest();
    const foreign = await S.api('GET', '/v1/replica/profiles/' + prof.id, { token: other.token });
    assert.strictEqual(foreign.status, 404, '他人访问必须 404');
    const foreignDel = await S.api('DELETE', '/v1/replica/profiles/' + prof.id, { token: other.token });
    assert.strictEqual(foreignDel.status, 404, '他人删除必须 404');
    const withWorks = S.db.all('SELECT id FROM works WHERE gen_params LIKE ?', '%' + prof.id + '%');
    assert.ok(withWorks.some((x) => x.id === workId), '前置：该谱至少已出过一首歌（⑥ 产出）');
    const del = await S.api('DELETE', '/v1/replica/profiles/' + prof.id, { token });
    assert.strictEqual(del.status, 200, '属主删除应 200');
    const after = (await S.api('GET', '/v1/replica/profiles', { token })).json.items;
    assert.ok(!after.some((x) => x.id === prof.id), '删后列表不得再有它');
    for (const w of withWorks) {
      const gp = JSON.parse(S.db.all('SELECT gen_params FROM works WHERE id=?', w.id)[0].gen_params || '{}');
      assert.ok(gp.replica, '删谱不删作品的溯源标注（v5.7.9）');
    }
  });

  it('V38-⑧ 转写零落库：全库搜不到 ASR 原文（v5.7.5 合规锚）', async () => {
    // ASR 转写只作归纳入参用后即弃：replica_profiles/audit/jobs(result,payload) 全部不得出现原文。
    const leaks = [];
    for (const [table, cols] of [
      ['replica_profiles', ['features_json', 'summary', 'title']],
      ['audit', ['obj']],
      ['jobs', ['result', 'payload']],
    ]) {
      for (const col of cols) {
        try {
          const rows = S.db.all(`SELECT ${col} v FROM ${table} WHERE instr(${col}, ?) > 0 LIMIT 1`, MOCK_TEXT);
          if (rows.length) leaks.push(`${table}.${col}`);
        } catch (e) { /* 列不存在跳过 */ }
      }
    }
    assert.deepStrictEqual(leaks, [], '以下表/列泄漏了转写原文：' + leaks.join(','));
    // jobs.result 的净化版只允许观测摘要（has_text），不得带 text 字段内容
    const results = S.db.all("SELECT result FROM jobs WHERE type='replica_analyze' AND result IS NOT NULL");
    assert.ok(results.length >= 1, '前置：套件内应有 replica_analyze 终态 job');
    for (const r of results) {
      assert.ok(!String(r.result).includes('mock 参考曲转写'), 'jobs.result 泄漏转写原文');
      assert.ok(!/"text"\s*:/.test(String(r.result)), 'jobs.result 不得携带任何文本转写字段');
    }
  });

  it('V38-⑨ 规则画像质量：work 源元数据直映射能命中词表（降级也有用，v5.7.10）', async () => {
    const u = await S.newGuest();
    const workId = await makeWork(u.token);
    const an = await analyzeWork(u.token, workId);
    const out = await waitProfile(an.json.job_id, u.token);
    assert.strictEqual(out.status, 'done');
    const prof = out.items[0];
    assert.ok(prof, '规则画像也必须建谱');
    assertCatalogClosed(prof.features);
    const anyWord = (prof.features.moods || []).length + (prof.features.genres || []).length
      + (prof.features.styleWords || []).length + (prof.features.voice || []).length;
    assert.ok(anyWord >= 1 || prof.bpm_est != null, '降级画像不能是空的（空谱=假装分析过，v5.7.10）');
  });

  it('V38-⑩ 翻唱入口（既有链路回归）：仅本人作品 + persona 归属校验 + cover 计费（v5.7.11）', async () => {
    const u = await S.newGuest();
    const workId = await makeWork(u.token);
    const pr = await S.api('POST', '/v1/personas', {
      token: u.token,
      multipart: { fields: { name: '翻唱声线' }, files: [{ field: 'file', filename: 'voice.wav', data: H.makeSineWav({ sec: 22, freq: 320 }), contentType: 'audio/wav' }] },
    });
    assert.strictEqual(pr.status, 200, '建 persona 应 200，实际 ' + pr.status + ' ' + pr.text.slice(0, 160));
    const personaId = pr.json.persona.id;
    const other = await S.newGuest();
    const foreign = await S.api('POST', '/v1/works/' + workId + '/cover', { token: other.token, json: { persona_id: personaId } });
    assert.strictEqual(foreign.status, 403, '他人作品的翻唱必须 403（ownWork 既有语义：非属主 FORBIDDEN）');
    const bal0 = (await S.api('GET', '/v1/credits', { token: u.token })).json.balance;
    const cov = await S.api('POST', '/v1/works/' + workId + '/cover', { token: u.token, json: { persona_id: personaId } });
    assert.strictEqual(cov.status, 202, '本人翻唱应 202，实际 ' + cov.status + ' ' + cov.text.slice(0, 160));
    const bal1 = (await S.api('GET', '/v1/credits', { token: u.token })).json.balance;
    assert.strictEqual(bal0 - bal1, cov.json.credits_charged, 'cover 计费与扣减一致');
  });

  it('V38-⑪ 灰度收尾：关掉后服务端保证端点 404 + config 下发 false（持久化回落由端侧 resolveStoredTier 负责）', async () => {
    const u = await S.newGuest();
    await setFlag('replicaMode', false, 0);
    const cfg = await S.api('GET', '/v1/app/config');
    assert.strictEqual(cfg.json.features.replicaMode, false);
    const r = await S.api('POST', '/v1/replica/analyze', {
      token: u.token, json: { source: { kind: 'web', query: '晴天' } },
    });
    assert.strictEqual(r.status, 404, '关断后 analyze 必须回 404');
    await setFlag('replicaMode', true, 1); // 留干净环境给后续套件
  });
});
