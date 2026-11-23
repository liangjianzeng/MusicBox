// V4 · 曲库（验收驱动施工 · 施工方 D · 2026-11-23）
// 断言源：CONTRACTS.md §2（adopt / GET /v1/works 筛选与 cursor / GET /v1/works/:id 父链 / PATCH）与 work 形状。
// 前置：adopt 需要 done 的 job（契约 §2"transcode 完成后 job 才算 done"）→ 本套件的 done 方向依赖 ffmpeg（施工计划 §2 待装）。
//       本机无 ffmpeg 时逐条 skip 并注明前置，fail 方向覆盖见 V2-⑤（断言方向按环境自动选择）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S;
const W = {}; // 跨用例共享的测试作品（guest/token/work）

function needFf(t) {
  if (!S.ffmpeg) {
    t.skip('V4 前置：本机无 ffmpeg，transcode 无法完成 → 无 done job 可 adopt（施工计划 §2"ffmpeg 二进制 待装"）。装好或设 MB_TEST_FFMPEG 后重跑。');
    return true;
  }
  return false;
}
function genBody(overrides) {
  return Object.assign({ mode: 'simple', prompt: H.uniq('v4'), sec: 15, count: 1 }, overrides || {});
}
function hasVal(list, v) {
  return (list || []).some((x) => String(x).toLowerCase() === String(v).toLowerCase());
}

describe('V4 曲库（adopt/筛选/PATCH/详情父链/分页）', () => {
  before(async () => {
    S = await H.boot('V4');
    S.executor.transcodeMode = 'real'; // 需要真实转码产出 mp3 播放档（无 ffmpeg 时各用例自行 skip）
  });
  after(async () => {
    if (S) { S.executor.transcodeMode = 'park'; await S.close(); }
  });

  it('V4-① adopt 候选 → work 形状齐全且出现在 mine 列表（契约 §2 work 形状）', async (t) => {
    if (needFf(t)) return;
    const g = await S.newGuest();
    const { job, cand, work } = await S.genAndAdopt(g.token, genBody({ mood: 'v4快乐', tags: ['v4popX', '流行'], bpm: 120 }));
    assert.ok(work && work.id, 'V4-① adopt 应返回 {work}（契约 §2），实际 ' + JSON.stringify(work).slice(0, 200));
    assert.strictEqual(typeof work.title, 'string', 'V4-① work.title 应为字符串（契约 work 形状），实际 ' + work.title);
    assert.ok(['draft', 'published', 'retired'].includes(work.status), 'V4-① work.status 应为枚举值，实际 ' + work.status);
    assert.strictEqual(work.ai_label, true, 'V4-① AI 生成内容必须带 ai_label=true（契约 §0 用户面纪律）');
    assert.strictEqual(work.lineage && work.lineage.kind, 'origin', 'V4-① 直接生成的谱系 kind 应为 origin，实际 ' + JSON.stringify(work.lineage));
    assert.ok(['private', 'public'].includes(work.visibility), 'V4-① visibility 应为枚举值（契约默认 private 起步），实际 ' + work.visibility);
    assert.ok(Array.isArray(work.genres) && hasVal(work.genres, 'v4popX'), 'V4-① generate.tags 应落到 work.genres（契约 work 形状 genres:[]），实际 ' + JSON.stringify(work.genres));
    assert.ok(String(work.mood || '').includes('v4快乐'), 'V4-① generate.mood 应落到 work.mood，实际 ' + work.mood);
    assert.strictEqual(Number(work.bpm), 120, 'V4-① generate.bpm 应落到 work.bpm，实际 ' + work.bpm);
    assert.ok(typeof work.audio_url === 'string' && /^https?:\/\//.test(work.audio_url), 'V4-① work.audio_url 应为绝对 URL（契约 §0），实际 ' + work.audio_url);
    assert.ok(work.duration_sec >= 10 && work.duration_sec <= 25, 'V4-① duration_sec 应≈请求的 15s，实际 ' + work.duration_sec);
    assert.ok(!Number.isNaN(Date.parse(work.created_at)), 'V4-① created_at 应为可解析时间（契约 work 形状），实际 ' + work.created_at);
    // mine 列表可见
    const list = await S.api('GET', '/v1/works?mine=1', { token: g.token });
    assert.strictEqual(list.status, 200, 'V4-① GET /v1/works?mine=1 应 200，实际 ' + list.status);
    assert.ok(Array.isArray(list.json.items), 'V4-① 列表响应应为 {items,next_cursor}（契约 §2），实际 ' + list.text.slice(0, 150));
    assert.ok(list.json.items.some((x) => x.id === work.id), 'V4-① adopt 后的 work 应出现在 ?mine=1 列表');
    W.a = { guest: g, work };
  });

  it('V4-② 筛选正确性：genre / mood / bpm 区间 / q（契约 §2 GET /v1/works 查询参数）', async (t) => {
    if (needFf(t)) return;
    // 三个互斥样本：A(电子/欢快/140) B(摇滚/忧伤/80) C(民谣/欢快/120)，全部置 public
    const specs = [
      { key: 'a', tags: ['v4elec'], mood: 'v4happy', bpm: 140, title: '紫罗兰V4A' },
      { key: 'b', tags: ['v4rock'], mood: 'v4sad', bpm: 80, title: '玄武V4B' },
      { key: 'c', tags: ['v4folk'], mood: 'v4happy', bpm: 120, title: '流星V4C' },
    ];
    for (const sp of specs) {
      const g = await S.newGuest();
      const { work } = await S.genAndAdopt(g.token, genBody({ mood: sp.mood, tags: [sp.tags[0]], bpm: sp.bpm }));
      const pt = await S.api('PATCH', '/v1/works/' + work.id, { token: g.token, json: { title: sp.title, visibility: 'public' } });
      assert.strictEqual(pt.status, 200, 'V4-② 前置 PATCH title/visibility 应 200，实际 ' + pt.status + ' ' + pt.text.slice(0, 150));
      W[sp.key] = { guest: g, work };
    }
    const anyToken = W.a.guest.token;
    const listQ = async (q) => {
      const r = await S.api('GET', '/v1/works?' + q, { token: anyToken });
      assert.strictEqual(r.status, 200, 'V4-② 列表 ?' + q + ' 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 150));
      assert.ok(Array.isArray(r.json.items), 'V4-② 列表应返回 {items,next_cursor}，实际 ' + r.text.slice(0, 150));
      return r.json.items.map((x) => x.id);
    };
    const idsA = W.a.work.id, idsB = W.b.work.id, idsC = W.c.work.id;
    let ids = await listQ('public=1&genre=' + encodeURIComponent('v4elec'));
    assert.ok(ids.includes(idsA) && !ids.includes(idsB) && !ids.includes(idsC), 'V4-② genre=v4elec 应命中 A 排除 B/C，实际命中 ' + JSON.stringify({ A: ids.includes(idsA), B: ids.includes(idsB), C: ids.includes(idsC) }));
    ids = await listQ('public=1&mood=' + encodeURIComponent('v4happy'));
    assert.ok(ids.includes(idsA) && ids.includes(idsC) && !ids.includes(idsB), 'V4-② mood=v4happy 应命中 A/C 排除 B，实际 ' + JSON.stringify({ A: ids.includes(idsA), B: ids.includes(idsB), C: ids.includes(idsC) }));
    ids = await listQ('public=1&bpm_min=130&bpm_max=200');
    // spec：A=140 B=80 C=120 —— 区间 [130,200] 唯一命中 A(140)（2026-11-23 修正：原断言把 A/C 数值写反）
    assert.ok(ids.includes(idsA) && !ids.includes(idsB) && !ids.includes(idsC), 'V4-② bpm_min=130 应只命中 A(140)，B(80)/C(120) 排除');
    ids = await listQ('public=1&bpm_max=90');
    assert.ok(ids.includes(idsB) && !ids.includes(idsA) && !ids.includes(idsC), 'V4-② bpm_max=90 应只命中 B(80)');
    ids = await listQ('public=1&q=' + encodeURIComponent('紫罗兰V4A'));
    assert.ok(ids.includes(idsA) && !ids.includes(idsB) && !ids.includes(idsC), 'V4-② q 按标题检索应只命中 A（PATCH 过的唯一标题）');
  });

  it('V4-③ PATCH 评分/可见性：rating 1-5 生效、越界 400；visibility 变化影响 public 列表（契约 §2）', async (t) => {
    if (needFf(t)) return;
    const { guest, work } = W.b;
    const p1 = await S.api('PATCH', '/v1/works/' + work.id, { token: guest.token, json: { rating: 4 } });
    assert.strictEqual(p1.status, 200, 'V4-③ PATCH rating=4 应 200，实际 ' + p1.status + ' ' + p1.text.slice(0, 150));
    assert.strictEqual(p1.json.work ? p1.json.work.rating : p1.json.rating, 4, 'V4-③ 响应应回带更新后 work 且 rating=4（契约 §2 → 200 {work}），实际 ' + p1.text.slice(0, 150));
    const bad = await S.api('PATCH', '/v1/works/' + work.id, { token: guest.token, json: { rating: 6 } });
    assert.strictEqual(bad.status, 400, 'V4-③ rating=6 越界（契约 rating?1-5）应 400，实际 ' + bad.status);
    assert.ok(bad.json && bad.json.code === 'BAD_REQUEST', 'V4-③ 越界应 {code:BAD_REQUEST}，实际 ' + bad.text.slice(0, 150));
    const p2 = await S.api('PATCH', '/v1/works/' + work.id, { token: guest.token, json: { visibility: 'private' } });
    assert.strictEqual(p2.status, 200, 'V4-③ PATCH visibility=private 应 200，实际 ' + p2.status);
    const vis = p2.json.work ? p2.json.work.visibility : p2.json.visibility;
    assert.strictEqual(vis, 'private', 'V4-③ PATCH 后 visibility 应为 private，实际 ' + vis);
    const pubList = await S.api('GET', '/v1/works?public=1&genre=v4rock', { token: W.a.guest.token });
    assert.ok(!pubList.json.items.some((x) => x.id === work.id), 'V4-③ 置 private 后不应再出现在 ?public=1 列表（越权可见性缺陷）');
    const mineList = await S.api('GET', '/v1/works?mine=1&genre=v4rock', { token: guest.token });
    assert.ok(mineList.json.items.some((x) => x.id === work.id), 'V4-③ private 后作者 ?mine=1 仍应可见');
  });

  it('V4-④ 详情父链：adjust 子作品 lineage.parent_id/lineage_parents 与父 children_count（契约 §2）', async (t) => {
    if (needFf(t)) return;
    const g = W.a.guest, parent = W.a.work; // V4-① 的 work（余额 35，够 adjust 10 分）
    const adj = await S.api('POST', '/v1/works/' + parent.id + '/adjust', { token: g.token, json: { text: '更欢快一点' } });
    assert.strictEqual(adj.status, 200, 'V4-④ adjust 应 200 {understood,job_id}（契约 §2），实际 ' + adj.status + ' ' + adj.text.slice(0, 150));
    assert.strictEqual(adj.json.understood, true, 'V4-④ "更欢快一点"应被理解 understood=true，实际 ' + adj.text.slice(0, 150));
    assert.ok(adj.json.job_id, 'V4-④ understood 时应回 job_id，实际 ' + adj.text.slice(0, 150));
    const job = await S.waitForJob(g.token, adj.json.job_id, { timeoutMs: 150000 });
    assert.strictEqual(job.status, 'done', 'V4-④ adjust 子 job 应 done，实际 ' + job.status + ' error=' + JSON.stringify(job.error));
    // 子 work：优先 result_work_id；否则 adopt 候选
    let child = null;
    if (job.result_work_id) {
      const d = await S.api('GET', '/v1/works/' + job.result_work_id, { token: g.token });
      if (d.ok) child = d.json.work || d.json;
    }
    if (!child) {
      const cand = (job.candidates || [])[0];
      assert.ok(cand, 'V4-④ adjust done 后应有 result_work_id 或 candidates');
      child = await S.adoptCandidate(g.token, job, cand);
    }
    assert.strictEqual(child.lineage && child.lineage.parent_id, parent.id, 'V4-④ 子 work.lineage.parent_id 应指向父（契约 lineage:{kind,parent_id,depth}），实际 ' + JSON.stringify(child.lineage));
    assert.ok(['adjust', 'variation'].includes(child.lineage.kind), 'V4-④ adjust 产物 kind 应为 adjust/variation，实际 ' + child.lineage.kind);
    assert.ok(child.lineage.depth >= 1, 'V4-④ 子 work.lineage.depth 应 ≥1，实际 ' + child.lineage.depth);
    const pd = await S.api('GET', '/v1/works/' + child.id, { token: g.token });
    assert.strictEqual(pd.status, 200, 'V4-④ GET 详情应 200，实际 ' + pd.status);
    assert.ok(Array.isArray(pd.json.lineage_parents), 'V4-④ 详情应含 lineage_parents:[work(简)]（契约 §2），实际 ' + JSON.stringify(Object.keys(pd.json)) + '；偏差清单 DEV-PARENTS');
    assert.ok((pd.json.lineage_parents || []).some((x) => x.id === parent.id), 'V4-④ lineage_parents 应包含父 work（简版）');
    assert.ok(typeof pd.json.children_count === 'number', 'V4-④ 详情应含 children_count（契约 §2）');
    const parentDetail = await S.api('GET', '/v1/works/' + parent.id, { token: g.token });
    assert.ok((parentDetail.json.children_count || 0) >= 1, 'V4-④ 父 work.children_count 应 ≥1，实际 ' + parentDetail.json.children_count);
    W.child = { guest: g, work: child };
  });

  it('V4-⑤ cursor 分页：沿 next_cursor 遍历不重不漏（契约 §2 ?cursor → {items,next_cursor}）', async (t) => {
    if (needFf(t)) return;
    const token = W.a.guest.token;
    // V4-③ 已把 B 置 private（那是③的断言），本例需要全集 public —— 先复位（2026-11-23 修正用例顺序冲突）
    const repub = await S.api('PATCH', '/v1/works/' + W.b.work.id, { token: W.b.guest.token, json: { visibility: 'public' } });
    assert.strictEqual(repub.status, 200, 'V4-⑤ 前置复位 B 为 public 应 200，实际 ' + repub.status);
    const seen = new Map(); // id → 出现次数
    let cursor = null, pages = 0, sawCursor = false;
    for (;;) {
      const qs = 'public=1&' + (cursor ? 'cursor=' + encodeURIComponent(cursor) : 'limit=2&');
      const r = await S.api('GET', '/v1/works?' + qs, { token });
      assert.strictEqual(r.status, 200, 'V4-⑤ 分页请求应 200，实际 ' + r.status + ' ' + r.text.slice(0, 150));
      assert.ok(Array.isArray(r.json.items), 'V4-⑤ 每页应为 {items,next_cursor}，实际 ' + r.text.slice(0, 150));
      for (const it of r.json.items) {
        assert.ok(it && it.id, 'V4-⑤ 列表项应为 work 简形（含 id），实际 ' + JSON.stringify(it).slice(0, 120));
        seen.set(it.id, (seen.get(it.id) || 0) + 1);
      }
      pages++;
      cursor = r.json.next_cursor || null;
      if (cursor) sawCursor = true;
      if (!cursor || pages >= 30) break;
    }
    for (const [id, n] of seen) assert.strictEqual(n, 1, 'V4-⑤ cursor 分页不得重复返回 work ' + id + '（出现 ' + n + ' 次）');
    for (const k of ['a', 'b', 'c']) assert.ok(seen.has(W[k].work.id), 'V4-⑤ 遍历必须覆盖全部 public work（缺 ' + k + '）');
    if (!sawCursor) {
      // 单页返回全部：契约允许（next_cursor 可空），但 limit 未生效 → 记为观察项而非硬失败
      console.log('[V4-⑤ 观察] 服务端未提供多页切分（next_cursor 恒空，limit=2 未生效）——契约未固化 limit 参数，见偏差清单 DEV-LIMIT');
    }
  });
});
