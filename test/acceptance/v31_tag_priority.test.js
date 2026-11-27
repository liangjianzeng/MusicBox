// V31 · 用户手选优先于扫描猜测 + 词表/配额一致性（2026-11-27 小米13 真机验收批）
// 断言源：CONTRACTS.md §2 POST /v1/works/generate（tags ≤6）+ §v3.2 GET /v1/app/config。
// 现场：深度档勾了「女声」，派单出去 tags 里没有 female vocal —— works.js 把 `scan.tags`
//   排在 `params.tags` 前面，6 个配额被"从文案里猜的词"占满，用户明确勾的选项被静默丢弃，
//   结果用户要女声、模型收到的是无人称标签，出一首男声还怪不到任何地方。
//   另一半原因在 App：曲风上限 3 + 风格点缀上限 6 = 9，而服务端 cap 是 6 —— 界面允许选 9 个、
//   后端留 6 个，消失的 3 个从不告知。故本文件同时钉住"两端承诺必须一致"。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');
const dict = require('../../src/server/prompts/dictionary.js');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let S;
describe('V31 用户手选优先 + 词表配额一致', () => {
  before(async () => { S = await H.boot('V31'); });
  after(async () => { if (S) await S.close(); });

  it('V31-① 用户手选的 tags 不得被扫描猜测挤出（真机"要女声出男声"的回归钉）', async () => {
    const g = await S.newGuest();
    // prompt 里塞满词典词，让 dict.scan 一次就能把 6 个配额占满 —— 正是当初挤掉 female vocal 的形态
    const r = await S.generate(g.token, {
      mode: 'custom',
      prompt: '欢快 电子 合成器 鼓机 现场感 循环洗脑 热血 史诗 弦乐铺底 节奏切分',
      lyrics: '[Verse]\n测试歌词第一行\n测试歌词第二行',
      tags: ['female vocal'],
      sec: 15,
      count: 1,
    });
    assert.strictEqual(r.status, 202, 'V31-① generate 应 202（契约 §2 → 202 {job_id,credits_charged,idempotent}），实际 ' + r.status + ' ' + (r.text || '').slice(0, 200));
    const jobId = r.json.job_id || (r.json.job && r.json.job.id) || r.json.id;
    assert.ok(jobId, 'V31-① 响应应含 job_id，实际键=' + Object.keys(r.json || {}).join(','));
    const rows = S.db.all('SELECT payload FROM jobs WHERE id = ?', jobId);
    assert.ok(rows.length, 'V31-① 派单应落 jobs 表，job_id=' + jobId);
    const p = JSON.parse(rows[0].payload);
    assert.ok(Array.isArray(p.tags), 'V31-① payload.tags 应为数组，实际 ' + JSON.stringify(p.tags));
    assert.ok(p.tags.indexOf('female vocal') >= 0,
      'V31-① 用户明确勾了「女声」，派单 tags 里却找不到 female vocal —— 被扫描猜测挤掉了：' + JSON.stringify(p.tags));
    assert.strictEqual(p.tags[0], 'female vocal',
      'V31-① 用户手选必须排在猜测之前（配额吃紧时先保用户的话）：' + JSON.stringify(p.tags));
    assert.ok(p.tags.length <= 6, 'V31-① 契约 tags ≤6，实际 ' + p.tags.length);
  });

  it('V31-② 心情「微醺」必须同时进词典与下发目录（真机用户要微醺，原 24 档无处可选）', () => {
    const scan = dict.scan('微醺慵懒的夜晚');
    assert.ok(scan.moods.indexOf('微醺') >= 0, 'V31-② dict.scan 应命中心情 微醺，实际 ' + JSON.stringify(scan.moods));
    assert.ok(scan.tags.indexOf('tipsy') >= 0, 'V31-② 微醺应带出规范词 tipsy，实际 ' + JSON.stringify(scan.tags));
    assert.ok(Number.isInteger(scan.bpm) && scan.bpm >= 60 && scan.bpm <= 180,
      'V31-② 微醺应有合理典型速度，实际 ' + scan.bpm);
  });

  it('V31-③ App 可选 tags 上限之和不得超过服务端 cap（选了却被静默丢 = 端侧在撒谎）', () => {
    const picker = read('src/app/lib/features/create/style_picker.dart');
    const g = picker.match(/this\.maxGenres\s*=\s*(\d+)/);
    const w = picker.match(/this\.maxStyleWords\s*=\s*(\d+)/);
    assert.ok(g && w, 'V31-③ 读不到 App 的分组上限，style_picker.dart 结构变了要同步本测试');
    const works = read('src/server/api/works.js');
    const cap = works.match(/unionArr\(\s*U\.toArr\(params\.tags\),\s*scan\.tags,\s*(\d+)\s*\)/);
    assert.ok(cap, 'V31-③ 读不到服务端 tags cap（works.js unionArr 第三参），改法要同步本测试');
    const sum = Number(g[1]) + Number(w[1]);
    assert.ok(sum <= Number(cap[1]),
      `V31-③ App 允许选 ${g[1]} 曲风 + ${w[1]} 风格点缀 = ${sum} 个，服务端只留 ${cap[1]} 个：` +
      '多出来的会被无声丢掉（真机就丢过「女声」）。要么收紧界面，要么放宽契约，两端不许各说一套');
  });
});
