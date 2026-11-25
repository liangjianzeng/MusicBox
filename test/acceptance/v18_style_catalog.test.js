// V18 · 创作选择项目录（契约 v3.2 · 第 2 轮 UX 优化「标签改选择项」批）
// 断言源：CONTRACTS.md §v3.2 + §2 GET /v1/app/config。
// 背景：深度档原来是一个「标签（逗号分隔）：如 city pop, retro, synth」自由文本框——
//   用户不知道它是曲风还是情绪，示例还是英文；App 又硬编了一份 12+12 选项，
//   与服务端 24+18 词典不同源，选了词典没有的词，BPM/tags 补全静默失效。
//   本批把选项唯一真源收回服务端词典，经 /v1/app/config 下发，界面全中文、派单发英文规范词。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');
const dict = require('../../src/server/prompts/dictionary.js');

let S;

describe('V18 创作选择项目录（曲风/心情/风格点缀）', () => {
  before(async () => { S = await H.boot('V18'); });
  after(async () => { if (S) await S.close(); });

  it('V18-① GET /v1/app/config 下发 style_options：三段非空、中文标签 + 英文规范词齐备（契约 v3.2）', async () => {
    const r = await S.api('GET', '/v1/app/config', {});
    assert.strictEqual(r.status, 200, 'V18-① /v1/app/config 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    const so = r.json.style_options;
    assert.ok(so && typeof so === 'object', 'V18-① 响应应含 style_options 段（契约 v3.2），实际键=' + Object.keys(r.json || {}).join(','));
    for (const key of ['moods', 'genres', 'style_words']) {
      assert.ok(Array.isArray(so[key]) && so[key].length > 0, 'V18-① style_options.' + key + ' 应为非空数组，实际 ' + JSON.stringify(so[key]).slice(0, 120));
    }
    for (const g of so.genres) {
      assert.ok(typeof g.zh === 'string' && g.zh.trim().length > 0, 'V18-① 曲风必须有中文标签（界面用）：' + JSON.stringify(g));
      assert.ok(typeof g.en === 'string' && g.en.trim().length > 0, 'V18-① 曲风必须有英文规范词（派单用）：' + JSON.stringify(g));
    }
    for (const w of so.style_words) {
      assert.ok(typeof w.zh === 'string' && w.zh.trim().length > 0, 'V18-① 风格点缀必须有中文标签：' + JSON.stringify(w));
      assert.ok(typeof w.en === 'string' && w.en.trim().length > 0, 'V18-① 风格点缀必须有英文规范词：' + JSON.stringify(w));
    }
    for (const m of so.moods) {
      assert.ok(typeof m.zh === 'string' && m.zh.trim().length > 0, 'V18-① 心情必须有中文标签：' + JSON.stringify(m));
    }
    // 曲风/风格点缀必须给用户"看得懂的中文"，不许把模型词直接当界面文案
    assert.ok(so.genres.some((g) => /[一-龥]/.test(g.zh)), 'V18-① 曲风中文名必须是中文（不得直接暴露 city pop 这类模型词）');
    assert.ok(so.style_words.some((w) => /[一-龥]/.test(w.zh)), 'V18-① 风格点缀中文名必须是中文');
  });

  it('V18-② 下发内容 = 词典本身（唯一真源，不是另抄一份词表）', async () => {
    const r = await S.api('GET', '/v1/app/config', {});
    const so = r.json.style_options;
    const cat = dict.catalog();
    assert.strictEqual(so.moods.length, cat.moods.length, 'V18-② 心情数须与词典一致（两处各写一份必然漂移，正是本批要消灭的）');
    assert.strictEqual(so.genres.length, cat.genres.length, 'V18-② 曲风数须与词典一致');
    assert.strictEqual(so.style_words.length, cat.style_words.length, 'V18-② 风格点缀数须与词典一致');
    assert.deepStrictEqual(so.genres.map((g) => g.zh), cat.genres.map((g) => g.zh), 'V18-② 曲风中文序须与词典一致');
    assert.deepStrictEqual(so.genres.map((g) => g.en), cat.genres.map((g) => g.en), 'V18-② 曲风英文规范词须与词典一致');
  });

  it('V18-③ 用户选中的词必须原样进派单（中文靠词典补英文规范词，英文直发），不许静默丢弃', async () => {
    const g = await S.newGuest();
    const beforeN = S.executor.musicPayloads.length;
    // App 正常路径：发英文规范词（曲风 guofeng + 风格点缀 synth）
    const r1 = await S.api('POST', '/v1/works/generate', {
      token: g.token,
      json: { mode: 'simple', prompt: '夜色下的城市兜风', tags: ['guofeng', 'synth'], mood: '夜晚', count: 1 },
    });
    assert.strictEqual(r1.status, 202, 'V18-③ generate 应 202，实际 ' + r1.status + ' ' + r1.text.slice(0, 200));
    const t0 = Date.now();
    while (S.executor.musicPayloads.length === beforeN && Date.now() - t0 < 20000) await H.sleep(300);
    assert.ok(S.executor.musicPayloads.length > beforeN, 'V18-③ 应派生 music job，20s 内未领到；errors=' + JSON.stringify(S.executor.errors).slice(0, 300));
    const pl = S.executor.musicPayloads[S.executor.musicPayloads.length - 1];
    const tagStr = (Array.isArray(pl.tags) ? pl.tags : String(pl.tags || '').split(',')).join(',');
    assert.ok(tagStr.includes('guofeng'), 'V18-③ 用户选的曲风规范词 guofeng 必须进 payload.tags，实际 ' + tagStr);
    assert.ok(tagStr.includes('synth'), 'V18-③ 用户选的风格点缀 synth 必须进 payload.tags，实际 ' + tagStr);
    assert.strictEqual(pl.mood, '夜晚', 'V18-③ 心情选择须直发引擎（引擎 mood 本就吃中文），实际 ' + pl.mood);

    // 兼容路径：用户/旧版直接发中文曲风，须由词典翻出英文规范词一起下发
    const r2 = await S.api('POST', '/v1/works/generate', {
      token: g.token,
      json: { mode: 'simple', prompt: '雨天窗边', tags: ['电子'], count: 1 },
    });
    assert.strictEqual(r2.status, 202, 'V18-③ 中文曲风 generate 应 202，实际 ' + r2.status + ' ' + r2.text.slice(0, 200));
    const t1 = Date.now();
    while (S.executor.musicPayloads.length < beforeN + 2 && Date.now() - t1 < 20000) await H.sleep(300);
    assert.ok(S.executor.musicPayloads.length >= beforeN + 2, 'V18-③ 第二次 generate 也应派单，实际 payloads=' + S.executor.musicPayloads.length);
    const pl2 = S.executor.musicPayloads[S.executor.musicPayloads.length - 1];
    const tag2 = (Array.isArray(pl2.tags) ? pl2.tags : String(pl2.tags || '').split(',')).join(',');
    assert.ok(tag2.includes('electronic'), 'V18-③ 中文曲风「电子」须经词典补出英文规范词 electronic（否则模型收不到曲风信号），实际 ' + tag2);
  });
});
