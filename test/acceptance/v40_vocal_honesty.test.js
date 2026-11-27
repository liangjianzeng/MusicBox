'use strict';
/*
 * V40 —— 「要人声但没歌词」不许静默变成纯音乐（2026-11-28 真机）
 *
 * 现场载荷（我从 jobs 表里原样取出来的，不是猜的）：
 *   {"lyrics":"", "instrumental":false, "persona":{...cover_strength:1}}
 * 端侧 `shell_pro.dart` 显式发了 instrumental:false（=有人声），服务端照发，执行器照发，
 * 引擎在**没有歌词**的情况下只能出纯音乐 —— 用户选了一次"人声演唱"，拿到的是纯音乐，
 * 而界面上写着「留空则由 AI 自动填词」，那个填词功能全仓零实现。
 *
 * 本判词跑的是执行器这条数据路径，钉三件事：
 *   ① 不许拿 instrumental:false 去骗引擎（引擎只会出纯音乐）；且必须留下 `meta.vocal` 说明没兑现；
 *   ② 真给了歌词时必须照发 instrumental:false，且 `meta.vocal.delivered=true`（不误伤正常路径）；
 *   ③ 纯音乐本来就是纯音乐，不许冒出"没兑现人声"的假告状；
 *   ④ 没有歌词时不许再去 cover：白烧 GPU + 谎称"用了你的人格"。
 * 反向验证：把执行器里那次 `sentInstrumental` 纠正删掉，①②④ 必红。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMusic } = require('../../src/executor/lanes/music.js');

const KEY = 'v40-test-key';
const audio = () => Buffer.concat([Buffer.from('RIFFV40'), Buffer.alloc(1200, 0x33)]);

function fakeEngine() {
  const hits = { music: [], ref: [], vfs: new Set() };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = String(req.url || '');
      if (url === '/ref' && req.method === 'POST') {
        const n = hits.ref.length + 1;
        const p = 'E:\\refs\\r' + n + '.wav';
        hits.ref.push({ bytes: body.length });
        hits.vfs.add(p);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'r' + n, path: p, bytes: body.length, ext: '.wav', pruned: 0 }));
      }
      if (url === '/music' && req.method === 'POST') {
        const j = JSON.parse(body.toString('utf8'));
        hits.music.push(j);
        for (const f of ['ref_audio', 'src_audio']) {
          if (j[f] && !hits.vfs.has(j[f])) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ detail: f + ' not found: ' + j[f] }));
          }
        }
        const n = hits.music.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'g' + n, file: 'E:\\out\\g' + n + '.wav', seconds: j.seconds || 45,
          gen_seconds: 1.0, task_type: j.src_audio ? 'cover' : (j.instrumental ? 'text2music_instrumental' : 'text2music'),
        }));
      }
      if (/^\/music\/[^/]+\/file$/.test(url)) { res.writeHead(200); return res.end(audio()); }
      res.writeHead(404); res.end('nope');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, hits })));
}

async function run(payload) {
  const { srv, port, hits } = await fakeEngine();
  const base = 'http://127.0.0.1:' + port;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v40_'));
  const refFile = path.join(workDir, 'persona_ref.wav');
  fs.writeFileSync(refFile, audio());
  const refBytes = audio();
  process.env.ACE_REF_KEY = KEY;
  const logs = [];
  try {
    const { result } = await runMusic({
      payload: Object.assign({
        mood: '夜晚', sec: 45, count: 1, candidates: [{ seq: 1, seed_delta: 0 }],
        tags: ['female vocal'], music_endpoint: base,
      }, payload),
    }, {
      cfg: { musicUrl: base, apiUrl: '', executorToken: '' },
      log: (m) => logs.push(String(m)), progress: async () => {}, workDir,
    });
    return { hits, cand: result.candidates[0], logs, refBytes };
  } finally {
    srv.close(); fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const persona = () => ({ id: 'p_v40', ref_abs_path: null, cover_strength: 1, clone_mode: 'fast' });

test('V40-① 要人声+空歌词：不许骗引擎，且必须把"没兑现"记下来', async () => {
  const { hits, cand } = await run({ instrumental: false, lyrics: '' });
  const sent = hits.music[0];
  assert.strictEqual(sent.instrumental, true,
    '没有歌词却发 instrumental:false 是拿谎话去问引擎 —— 引擎只会出纯音乐，那首"人声歌"从不存在');
  assert.ok(cand.meta.vocal, '必须留下 meta.vocal，让揭晓页能明说（不许静默交付一首和承诺不符的歌）');
  assert.strictEqual(cand.meta.vocal.requested, true, JSON.stringify(cand.meta.vocal));
  assert.strictEqual(cand.meta.vocal.delivered, false, JSON.stringify(cand.meta.vocal));
  assert.strictEqual(cand.meta.vocal.reason, 'no_lyrics', JSON.stringify(cand.meta.vocal));
});

test('V40-② 真给了歌词：不许误伤 —— 照发有人声，并如实记"已兑现"', async () => {
  const { hits, cand } = await run({ instrumental: false, lyrics: '[Verse] la la la' });
  assert.strictEqual(hits.music[0].instrumental, false, '给了歌词就该照发有人声，纠正不许扩大化');
  assert.strictEqual(cand.meta.vocal.delivered, true, JSON.stringify(cand.meta.vocal));
  assert.strictEqual(cand.meta.vocal.reason, null, JSON.stringify(cand.meta.vocal));
});

test('V40-③ 纯音乐本来就是纯音乐：不许冒出假告状', async () => {
  const { hits, cand } = await run({ instrumental: true, lyrics: '' });
  assert.strictEqual(hits.music[0].instrumental, true);
  assert.ok(cand.meta.vocal === undefined || cand.meta.vocal === null,
    '用户要的就是纯音乐，不该出现"人声没兑现"的告警块：' + JSON.stringify(cand.meta.vocal));
});

test('V40-④ 没歌词还挂人格：跳过 cover，且一个字节都不许往引擎写', async () => {
  const { hits, cand } = await run({ instrumental: false, lyrics: '', persona: persona() });
  assert.strictEqual(hits.ref.length, 0,
    '对一首没有人的歌做 cover = 白烧一次 GPU + 让用户以为"套上了我的人声"，一个字节都不许投');
  assert.strictEqual(cand.meta.clone.applied, false, JSON.stringify(cand.meta.clone));
  assert.strictEqual(cand.meta.clone.skipped_no_vocal, true, JSON.stringify(cand.meta.clone));
  assert.strictEqual(hits.music.length, 1, '只该有一次 text2music，不许有 cover');
});

/* —— 承诺 ↔ 能力 对账（2026-11-28 用户原话「这不是纯音乐么？」）——
 * 界面写着「留空则由 AI 自动填词」，而 `填词|genLyrics|lyricist` 在服务端**零命中**：
 * 承诺的能力根本不存在。这类谎最坏的地方是用户会以为是自己的问题（"我歌词没写好"）。
 *
 * 这条刻意**不是**永久禁令：哪天真实现了写词（服务端出现 lyricist 模块/生成函数），
 * 它会自动放行文案。判词要钉的是"说到做到"，不是把话钉死。
 */
const ROOT = path.join(__dirname, '..', '..');
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('V40-⑤ 界面承诺必须有实现兜着：没有写词模块就不许写「自动填词」', () => {
  const serverSrc = walk(path.join(ROOT, 'src', 'server'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const hasLyricist = /lyricist|writeLyrics|genLyrics|draftLyrics/i.test(serverSrc);

  const offenders = [];
  for (const f of walk(path.join(ROOT, 'src', 'app', 'lib')).filter((x) => x.endsWith('.dart'))) {
    const src = fs.readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('///')) return; // 注释留给工程师讲历史
      if (/自动填词|自动写词|AI\s*填词/.test(line)) {
        offenders.push(path.relative(ROOT, f) + ':' + (i + 1) + ' ' + t.slice(0, 70));
      }
    });
  }
  if (hasLyricist) {
    assert.ok(true); // 能力有了，文案解禁；此时应由别的判词去验它真能出词
    return;
  }
  assert.deepStrictEqual(offenders, [],
    '服务端没有写词实现（搜 lyricist|writeLyrics|genLyrics 零命中），界面却承诺自动填词：\n  '
      + offenders.join('\n  '));
});

