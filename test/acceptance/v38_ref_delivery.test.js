'use strict';
/*
 * V38 —— 声纹/源曲投递口（①「人格音色锁定」能不能真跑起来的唯一前提）
 *
 * 现场（2026-11-27 真机，查了 20 分钟）：`[执行器] 生成服务返回 HTTP 400：
 * {"detail":"ref_audio not found: /tmp/mb-dev/voices/2026-11/f_8cacd01e989b3a4e6846.wav"}`。
 * 引擎在另一台机器上，`ref_audio`/`src_audio` 只认**它自己文件系统里的路径**（os.path.isfile），
 * 我们递过去的是执行器本机的 Linux 路径 —— 所以人格克隆自上线以来**一次都没真的生效过**。
 *
 * 本判词不检查"代码里有没有调用 /ref"（那种判词删掉修复也不会红），而是起一个**带虚拟文件系统的
 * 假引擎**：没投递过的路径一律按引擎真实脾气回 400。于是——
 *   · 投了 → cover 成功 → `meta.clone.applied === true`（这条路径此前从未在任何测试里被跑通过）；
 *   · 没投/投失败 → cover 必 400 → `applied:false + stage2_failed:true` 且原因落到 meta。
 * 把修复删掉，这里必红。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const { runMusic } = require('../../src/executor/lanes/music.js');

const KEY = 'v38-test-ref-key';
function wavBytes(tag) {
  // ≥100 字节：resolvePersonaRef 会拒绝太小的"声纹"
  return Buffer.concat([Buffer.from('RIFF' + tag), Buffer.alloc(1024, 0x11)]);
}

// 假引擎：照抄 vendor/acestep/server.py 的脾气 —— 只认落在它"磁盘"上的路径
function fakeEngine(mode) {
  const hits = { seq: [], ref: [], music: [], vfs: new Set() };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = String(req.url || '');
      if (url === '/ref' && req.method === 'POST') {
        if (mode === 'missing') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no route'); }
        if (mode === 'deny') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":"bad x-mb-ref-key"}'); }
        if (mode === 'disabled') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"detail":"ref intake disabled"}'); }
        const n = hits.ref.length + 1;
        const p = 'E:\\refs\\r' + n + '.wav';
        hits.seq.push('ref');
        hits.ref.push({ key: req.headers['x-mb-ref-key'] || '', ext: req.headers['x-mb-ext'] || '',
          ctype: req.headers['content-type'] || '', bytes: body.length, body });
        hits.vfs.add(p);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ id: 'r' + n, path: p, bytes: body.length, ext: '.wav', pruned: 0 }));
      }
      if (url === '/music' && req.method === 'POST') {
        let j = {};
        try { j = JSON.parse(body.toString('utf8')); } catch (e) { /* 下面按坏请求处理 */ }
        hits.seq.push('music');
        hits.music.push(j);
        // 引擎真实校验（vendor/acestep/server.py）：路径不存在直接 400，detail 原样带路径
        for (const field of ['ref_audio', 'src_audio']) {
          const v = j[field];
          if (v && !hits.vfs.has(v)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ detail: field + ' not found: ' + v }));
          }
        }
        const n = hits.music.length;
        const isCover = !!j.src_audio;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'g' + n, file: 'E:\\out\\g' + n + '.wav',
          seconds: j.seconds || 45, gen_seconds: 1.1, task_type: isCover ? 'cover' : 'text2music',
        }));
      }
      const m = url.match(/^\/music\/([^/]+)\/file$/);
      if (m) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wavBytes('OUT')); }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, hits })));
}

async function runOnce(mode) {
  const { srv, port, hits } = await fakeEngine(mode);
  const base = 'http://127.0.0.1:' + port;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v38_work_'));
  const refFile = path.join(workDir, 'persona_ref.wav');
  fs.writeFileSync(refFile, wavBytes('REF!'));
  const refBytes = wavBytes('REF!');   // 工作目录会在 finally 里删掉，字节必须先留在手上
  process.env.ACE_REF_KEY = KEY;
  const logs = [];
  try {
    const { result } = await runMusic({
      payload: {
        mood: '夜晚', sec: 45, count: 1, candidates: [{ seq: 1, seed_delta: 0 }],
        tags: ['夜晚'], lyrics: '[Verse] 测试歌词', instrumental: false,
        music_endpoint: base,
        persona: { id: 'p_v38', ref_abs_path: refFile, cover_strength: 1, clone_mode: 'fast' },
      },
    }, {
      cfg: { musicUrl: base, apiUrl: '', executorToken: '' },
      log: (m) => logs.push(String(m)),
      progress: async () => {},
      workDir,
    });
    return { hits, result, logs, refFile, refBytes, workDir };
  } finally {
    srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test('V38-① 跨机必须先把声纹与源曲投进引擎，cover 才可能成功（applied 才允许为真）', async () => {
  const { hits, result, refBytes } = await runOnce('ok');

  assert.strictEqual(hits.music.length, 2, '① 完整歌 + ② 变声，两次 /music');
  assert.ok(hits.seq.slice(0, 3).join(',') !== '', '必须有请求发生');
  // 投递必须发生在变声那一发之前
  const coverAt = hits.seq.lastIndexOf('music');
  const lastRefAt = hits.seq.lastIndexOf('ref');
  assert.ok(lastRefAt >= 0 && lastRefAt < coverAt,
    '声纹/源曲必须在 cover 之前投递，实际顺序 ' + hits.seq.join(','));

  assert.strictEqual(hits.ref.length, 2,
    'ref_audio 与 src_audio **两个都得投**：只投声纹等于修了一半，源曲照样 HTTP 400');
  for (const r of hits.ref) {
    assert.strictEqual(r.key, KEY, '投递必须带共享密钥（引擎侧没配 key 会 503，见 ref_intake 自测）');
    assert.ok(r.bytes >= 100 && r.body.length === r.bytes, '必须真把音频字节送过去');
    assert.ok(/^\.(wav|mp3|flac|m4a|ogg)$/.test(r.ext), '扩展名必须显式给：' + r.ext);
  }
  // 第一发投的必须真的是人格 WAV 的字节
  assert.ok(hits.ref[0].body.equals(refBytes),
    '第一发投递的字节必须就是那个人格 WAV（不能是随便一个文件）');

  const cover = hits.music[1];
  assert.ok(cover.src_audio && hits.vfs.has(cover.src_audio),
    'cover 的 src_audio 必须是引擎本机路径（投回来的），实际 ' + cover.src_audio);
  assert.ok(cover.ref_audio && hits.vfs.has(cover.ref_audio),
    'cover 的 ref_audio 必须是引擎本机路径，实际 ' + cover.ref_audio);
  assert.ok(!cover.ref_audio.startsWith('/tmp'),
    '不许再把执行器本机路径递给引擎 —— 那就是 ref_audio not found 的老坑：' + cover.ref_audio);
  assert.strictEqual(cover.cover_strength, 1, '强度回执必须照原样带走（v5.6.7）');

  const clone = result.candidates[0].meta.clone;
  assert.strictEqual(clone.applied, true,
    '引擎真读到声纹并出了变声版，applied 才允许为真 —— 这条路径此前从未被跑通过');
  assert.strictEqual(clone.stage2_failed, false, JSON.stringify(clone));
  assert.strictEqual(clone.ref_delivery.uploaded, true, JSON.stringify(clone.ref_delivery));
  assert.strictEqual(clone.src_delivery.uploaded, true, JSON.stringify(clone.src_delivery));
  assert.strictEqual(result.persona_applied, true, '只报真的克隆成功了几个');
});

test('V38-② 老引擎没有 /ref：诚实退回本机路径，失败原因必须落到 meta（不许谎称已克隆）', async () => {
  const { hits, result } = await runOnce('missing');
  assert.strictEqual(hits.ref.length, 0, '404 之后不该继续尝试');
  const cover = hits.music[1];
  assert.ok(cover.ref_audio.startsWith('/'), '退回本机路径（同机部署本就正确）：' + cover.ref_audio);
  const clone = result.candidates[0].meta.clone;
  assert.strictEqual(clone.applied, false, '没投成功就不许说套上了');
  assert.strictEqual(clone.stage2_failed, true, '引擎必然读不到，必须诚实报失败');
  assert.strictEqual(clone.stage2_error, 'MUSIC_HTTP', JSON.stringify(clone));
  assert.strictEqual(clone.ref_delivery.reason, 'unsupported', JSON.stringify(clone.ref_delivery));
  assert.ok(clone.ref_path && clone.ref_local, '面包屑必须留下"引擎被要求读什么"和"我们手上是什么"');
  assert.ok(clone.src_path, '源曲路径也要留面包屑，否则下次还得翻执行器日志');
  assert.ok(typeof clone.engine === 'string' && clone.engine.length > 0, '必须记下是哪个引擎拒绝的');
});

test('V38-③ 密钥被拒 / 投递口未开：各自报得出名字，不许糊成一句"变声失败"', async () => {
  const denied = await runOnce('deny');
  assert.strictEqual(denied.result.candidates[0].meta.clone.ref_delivery.reason, 'key_rejected',
    JSON.stringify(denied.result.candidates[0].meta.clone.ref_delivery));
  assert.strictEqual(denied.result.candidates[0].meta.clone.applied, false);

  const off = await runOnce('disabled');
  assert.strictEqual(off.result.candidates[0].meta.clone.ref_delivery.reason, 'intake_disabled',
    JSON.stringify(off.result.candidates[0].meta.clone.ref_delivery));
  assert.strictEqual(off.result.candidates[0].meta.clone.applied, false);
});

test('V38-④ 没选人格时不许多打一次投递口（别把无关音频塞进 GPU 机）', async () => {
  const { srv, port, hits } = await fakeEngine('ok');
  const base = 'http://127.0.0.1:' + port;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v38_nop_'));
  try {
    const { result } = await runMusic({
      payload: { mood: '夜晚', sec: 45, count: 1, candidates: [{ seq: 1, seed_delta: 0 }], tags: ['夜晚'] },
    }, { cfg: { musicUrl: base }, log: () => {}, progress: async () => {}, workDir });
    assert.strictEqual(hits.ref.length, 0, '没选人格就不该往引擎写任何文件');
    assert.strictEqual(result.persona_applied, false);
  } finally { srv.close(); fs.rmSync(workDir, { recursive: true, force: true }); }
});

test('V38-⑤ 投递口自己的规矩（鉴权/上限/白名单/防穿越/到期清理）由 python 自测钉住', () => {
  const py = spawnSync('python3', ['scripts/check_ace_ref_intake.py'], { cwd: ROOT, encoding: 'utf8' });
  if (py.error || py.status === null) {
    // 没有 python3 的机器上诚实跳过，但要把话说清楚（不许静默当通过）
    console.log('  ! 本机无 python3，跳过 ref_intake 自测（装了 Python 的机器上这一步会真拦人）');
    return;
  }
  assert.strictEqual(py.status, 0, 'ref_intake 自测失败：\n' + (py.stdout || '') + (py.stderr || ''));
  assert.ok(/ref_intake 自测全过/.test(py.stdout || ''), '自测脚本没有明确报绿：\n' + (py.stdout || ''));
});
