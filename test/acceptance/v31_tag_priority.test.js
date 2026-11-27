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
        // cap 不许写死在判词里（今天就被契约变更打中一次）：从 works.js 读真源。
    const capM = read('src/server/api/works.js')
      .match(/unionArr\(\s*U\.to(?:Tag)?Arr\(params\.tags\),\s*scan\.tags,\s*(\d+)\s*\)/);
    assert.ok(capM, 'V31-① 读不到服务端 tags cap，改法要同步本测试');
    assert.ok(p.tags.length <= Number(capM[1]),
      'V31-① 派单 tags ' + p.tags.length + ' 个，超过服务端 cap ' + capM[1] + '：说明截断没生效');
  });

  it('V31-② 「微醺」必须可选且归属正确（判词随 2026-11-27 模型修正改写）', () => {
    // 这条判词原先断言「微醺必须在心情目录」——那是当时的错误建模。微醺是**演唱状态**
    // （开心的事能微醺唱，难过的事也能）；当心情会连带把 vibe 词与 bpm 塞进配方，
    // 真机就把一首冷战摊牌的歌做成了小酒馆 BGM（用户：「你要用喜庆的方式说难受的事情么」）。
    // 所以判词改成四条：① 在人声维度里可选（用户最初诉求的本意）；② 不得再当心情；
    // ③ 扫描不得产出 chill/laid-back 这类背景乐词；④ 速度归情绪管，不许由"微醺"定 84。
    const so = dict.catalog();
    const v = (so.voice || []).find((x) => x.zh === '微醺');
    assert.ok(v && v.dim === 'delivery', 'V31-② 微醺必须在 voice(dim=delivery) 里可选，实际 ' + JSON.stringify(v));
    assert.ok(!so.moods.some((m) => m.zh === '微醺'), 'V31-② 微醺不该再是心情');
    const hit = dict.scan('微醺感，女声真唱');
    assert.ok(!hit.tags.some((t) => ['chill', 'laid-back', 'easy-listening'].includes(t)),
      'V31-② 微醺不该注入咖啡馆背景乐词：' + hit.tags.join(','));
    assert.strictEqual(dict.scan('悲伤摊牌，微醺').bpm, 72, 'V31-② 速度须由情绪给（悲伤72），不许微醺给成84');
  });

  it('V31-③ App 四组上限之和与总闸门都必须等于服务端 cap（选了却被静默丢 = 端侧在撒谎）', () => {
    // 2026-11-27 真机两次踩同一坑：
    //   第一次 —— App 允许 曲风3+点缀6=9，服务端 cap 6，「女声」被无声丢掉；
    //   第二次 —— 我把人声拆成独立维度后，四组上限变成 1+2+3+3=9，服务端仍是 6，
    //             同一个缺陷只是换了个位置。判词因此升级为"读真源、四组全算、闸门对齐"。
    const picker = read('src/app/lib/features/create/style_picker.dart');
    const num = (re, what) => { const m = picker.match(re); assert.ok(m, 'V31-③ 读不到 ' + what + '，style_picker.dart 结构变了要同步本测试'); return Number(m[1]); };
    const maxGenres = num(/this\.maxGenres\s*=\s*(\d+)/, 'maxGenres');
    const maxWords = num(/this\.maxStyleWords\s*=\s*(\d+)/, 'maxStyleWords');
    const maxDeliv = num(/this\.maxDelivery\s*=\s*(\d+)/, 'maxDelivery');
    const maxTotal = num(/this\.maxTotal\s*=\s*(\d+)/, 'maxTotal');
    const genderMax = num(/谁在唱（性别）[\s\S]{0,400}?max: (\d+)/, '性别组上限');
    const works = read('src/server/api/works.js');
    const capM = works.match(/unionArr\(\s*U\.to(?:Tag)?Arr\(params\.tags\),\s*scan\.tags,\s*(\d+)\s*\)/);
    assert.ok(capM, 'V31-③ 读不到服务端 tags cap（works.js unionArr 第三参），改法要同步本测试');
    const cap = Number(capM[1]);
    const sum = genderMax + maxDeliv + maxGenres + maxWords;
    assert.ok(sum <= cap,
      `V31-③ App 四组上限 ${genderMax}+${maxDeliv}+${maxGenres}+${maxWords}=${sum} 超过服务端 cap ${cap}：` +
      '多出来的会被无声丢掉。要么收紧界面，要么放宽契约，两端不许各说一套');
    assert.strictEqual(maxTotal, cap,
      `V31-③ App 总闸门 maxTotal=${maxTotal} 必须等于服务端 cap=${cap}，否则提示语里的数字是在骗人`);
  });
});

// —— v31-④⑤（2026-11-27 追加）：人声是独立维度，不是风格点缀 ——
// 现场：用户在深度档勾了「女声」，出来的歌却是男声。根因不止顺序 ——
// 女声/男声 当初被放进 STYLE_WORDS（风格点缀），于是"谁来唱"和"用什么乐器/加不加黑胶噪点"
// 抢同一份 tags 配额（cap 6），还能被挤掉。歌声与曲声不是一回事，分类必须把它们分开。
'use strict';
{
  const { describe, it, before, after } = require('node:test');
  const assert = require('node:assert');
  const dict = require('../../src/server/prompts/dictionary.js');
  let S2;
  describe('V31 人声维度（谁在唱 ≠ 怎么编曲）', () => {
    before(async () => { S2 = await H.boot('V31b'); });
    after(async () => { if (S2) await S2.close(); });

    it('V31-⑥ 任务详情必须回吐用户自己提交的歌词与配方（歌词不能用完就丢）', async () => {
      const g = await S2.newGuest();
      const lyrics = '[Verse]\n测试歌词甲\n测试歌词乙\n[Chorus]\n测试歌词丙';
      const r = await S2.api('POST', '/v1/works/generate', { token: g.token, json: {
        mode: 'custom', prompt: '悲伤 流行', lyrics, mood: '悲伤', tags: ['female vocal'], sec: 15, count: 1,
      } });
      assert.strictEqual(r.status, 202, 'V31-⑥ generate 应 202，实际 ' + r.status + ' ' + (r.text || '').slice(0, 160));
      const jid = r.json.job_id || (r.json.job && r.json.job.id);
      const j = await S2.api('GET', '/v1/jobs/' + jid, { token: g.token });
      assert.strictEqual(j.status, 200, 'V31-⑥ 任务详情应 200，实际 ' + j.status);
      const gen = j.json.gen;
      assert.ok(gen && typeof gen === 'object', 'V31-⑥ 响应应含 gen（契约 v3.3 用户输入回显），实际键=' + Object.keys(j.json || {}).join(','));
      assert.ok(String(gen.lyrics || '').includes('测试歌词甲'),
        'V31-⑥ 用户填的歌词必须在任务详情里回得来，否则候选一旦离开生成页就再也看不到歌词：' + JSON.stringify(gen.lyrics));
      assert.strictEqual(gen.mood, '悲伤', 'V31-⑥ 配方 mood 应回显，实际 ' + gen.mood);
      assert.ok(Array.isArray(gen.tags) && gen.tags.indexOf('female vocal') >= 0,
        'V31-⑥ 配方 tags 应回显且带空格规范词不许被切碎：' + JSON.stringify(gen.tags));
    });

    it('V31-④ /v1/app/config 下发 voice 维度，且性别/演唱状态词绝不留在 style_words 里', async () => {
      const r = await S2.api('GET', '/v1/app/config', {});
      const so = r.json.style_options;
      assert.ok(Array.isArray(so.voice) && so.voice.length >= 8,
        'V31-④ style_options.voice 应为非空数组（契约 v3.2 人声维度），实际 ' + JSON.stringify(so.voice).slice(0, 120));
      const dims = new Set(so.voice.map((v) => v.dim));
      for (const d of ['gender', 'delivery']) {
        assert.ok(dims.has(d), 'V31-④ voice 必须覆盖 dim=' + d + '，实际 ' + [...dims].join(','));
      }
      for (const v of so.voice) {
        assert.ok(typeof v.zh === 'string' && typeof v.en === 'string', 'V31-④ voice 每项须有 zh/en：' + JSON.stringify(v));
      }
      const leaked = so.style_words.filter((w) => /vocal|children|choir|tipsy|breathy|husky|spoken|behind the beat/i.test(w.en));
      assert.deepStrictEqual(leaked, [],
        'V31-④ 人声词混进了风格点缀（歌声≠曲声）：' + JSON.stringify(leaked));
      assert.ok(!so.style_words.some((w) => w.zh === '女声' || w.zh === '男声'),
        'V31-④ 女声/男声 必须属于人声维度，不能还当装饰词');
      // 真机截图现场：「风格点缀」里「循环洗脑 hypnotic」出现两行 —— 目录里有重复项，
      // 用户看到两个一样的 chip，点一个另一个也亮，等于界面在抖。
      for (const [name, arr] of Object.entries(so)) {
        if (!Array.isArray(arr)) continue;
        const zh = arr.map((x) => x.zh);
        const dup = zh.filter((v, k) => zh.indexOf(v) !== k);
        assert.deepStrictEqual(dup, [], 'V31-④ style_options.' + name + ' 有重复项：' + [...new Set(dup)].join(','));
      }
    });

    it('V31-⑤ 自由文本写「女声/微醺」也能进引擎，且性别词占住配额首位（曲风次之，质感最后）', () => {
      const r = dict.scan('悲伤摊牌，女声微醺真唱，流行古典，钢琴弦乐铺底，气声，不要轻快摇摆');
      assert.strictEqual(r.tags[0], 'female vocal', 'V31-⑤ 性别词必须排第一，否则 cap 一砍就没它了：' + r.tags.join(','));
      assert.ok(r.tags.indexOf('pop') >= 0 && r.tags.indexOf('pop') < r.tags.indexOf('piano'),
        'V31-⑤ 曲风应优先于质感词（决定"会不会把摊牌做成咖啡馆BGM"的是曲风）：' + r.tags.join(','));
      assert.ok(r.tags.includes('tipsy vocal'), 'V31-⑤ 「微醺」作为演唱状态必须能被扫描出来：' + r.tags.join(','));
      assert.ok(!r.moods.includes('微醺'), 'V31-⑤ 微醺不是情绪：开心的事能微醺唱，难过的事也能');
      assert.strictEqual(r.bpm, 72, 'V31-⑤ 速度应由情绪给（悲伤 72），不能由"微醺"给成慵懒 84');
    });
  });
}
