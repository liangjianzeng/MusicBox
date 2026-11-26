// V31 · persona 归属校验（他人声纹不得被克隆）+ 跨机声纹回捞
// 断言源：docs/contract-draft-adjudications.md 判定 2 的延伸（api/works.js 取 persona 不校验归属）
//        与一期复核缺陷 2（payload.persona.ref_abs_path 是服务端绝对路径，跨机必失效）
// 真机语境：server 在 DGX、ACE-Step 在 GeekPro。旧实现只判断"payload 里有没有 ref_abs_path"，
// 于是变声阶段拿着一个执行机上根本不存在的路径去请求引擎 —— 用户以为克隆生效，其实从来没有。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const H = require('./helpers.js');
const { runMusic } = require(path.join(H.ROOT, 'src/executor/lanes/music.js'));

const VOICE = H.makeSineWav({ sec: 22, freq: 320 });  // 上传的声纹样本（persona 需 20-40s）
const SONG = H.makeSineWav({ sec: 15, freq: 440 });   // 假引擎"生成"出来的歌

let S, owner, other, personaId;
const engines = [];

// 假 ACE-Step：记录每次 /music 请求；产物按真机协议只给**异机绝对路径**（逼执行器走取件口回捞）
function startEngine(tag) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/music') {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf || '{}'); } catch (e) { /* 原样记录 */ }
        reqs.push({ body, host: req.headers.host });
        const n = reqs.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: tag + '_gen_' + n,
          file: 'E:\\Work\\X-Theater\\runtime\\acestep\\out\\' + tag + '_' + n + '.wav', // 异机绝对路径（真机实测形态）
          seconds: 15, seed: body.seed, gen_seconds: 0.4, task_type: body.ref_audio ? 'cover' : 'text2music',
        }));
      });
      return;
    }
    const m = /^\/music\/([^/]+)\/file$/.exec(req.url || '');
    if (req.method === 'GET' && m) { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(SONG); return; }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"detail":"not found"}');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const e = { srv, reqs, base: 'http://127.0.0.1:' + srv.address().port, tag };
      engines.push(e);
      resolve(e);
    });
  });
}

function basePayload(persona) {
  return {
    mode: 'simple', prompt: '雨夜爵士', mood: '忧郁', tags: ['jazz'], lyrics: '', instrumental: true,
    sec: 15, count: 1, seed_base: 424242, bpm: 90,
    candidates: [{ seq: 1, seed_delta: 0, id: 'c_v31' }],
    persona,
  };
}
async function drive(payload, cfg) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v31-work-'));
  const logs = [];
  const out = await runMusic({ id: 'job_v31', type: 'music', payload }, {
    cfg, workDir, log: (m) => logs.push(String(m)), progress: async () => {},
  });
  return Object.assign({ logs, workDir }, out);
}

describe('V31 persona 归属与跨机声纹', () => {
  let engineA, engineB;
  before(async () => {
    S = await H.boot('V31', { noFakeExecutor: true });
    owner = await S.newGuest();
    other = await S.newGuest();
    const up = await S.api('POST', '/v1/personas', {
      token: owner.token,
      multipart: { fields: { name: '我的声线' }, files: [{ field: 'file', filename: 'v.wav', data: VOICE, contentType: 'audio/wav' }] },
    });
    assert.strictEqual(up.status, 200, '上传声纹应 200，实际 ' + up.status + ' ' + up.text.slice(0, 160));
    personaId = up.json.persona.id;
    engineA = await startEngine('A');
    engineB = await startEngine('B');
  });
  after(async () => {
    for (const e of engines) { try { e.srv.close(); } catch (err) { /* noop */ } }
    if (S) await S.close();
  });

  it('V31-① 他人（含公开人格）不得用别人的人格派单；本人可用且 payload 带 persona.id', async () => {
    const denied = await S.api('POST', '/v1/works/generate', {
      token: other.token, json: { mode: 'simple', prompt: '偷声', mood: '忧郁', count: 1, sec: 15, persona_id: personaId },
    });
    assert.strictEqual(denied.status, 403, '他人 persona 必须 403（未经同意的声纹克隆），实际 ' + denied.status + ' ' + denied.text.slice(0, 160));
    assert.strictEqual(denied.json.credits_charged || 0, 0, '被拒的派单不得扣分：' + denied.text.slice(0, 160));
    assert.strictEqual(S.db.all("SELECT COUNT(*) n FROM jobs WHERE type='music' AND payload LIKE ?", '%' + personaId + '%')[0].n, 0,
      '越权派单不得留下 job');
    const denied2 = await S.api('POST', '/v1/works/generate', {
      token: other.token, json: { mode: 'simple', prompt: '偷声2', mood: '忧郁', count: 1, sec: 15, persona_id: personaId, idem_key: 'v31-steal-2' },
    });
    assert.strictEqual(denied2.status, 403, '换幂等键再试也必须 403，实际 ' + denied2.status);
    assert.ok(S.db.all("SELECT COUNT(*) n FROM audit WHERE kind='persona.use_denied'")[0].n >= 2,
      '越权使用人格必须留审计（谁想克隆谁）');

    // 白盒把人格设为公开：仅可浏览，仍不可被他人用于克隆
    const db = H.openWhiteDb(S.dbPath);
    try { db.exec("PRAGMA busy_timeout=8000; UPDATE personas SET is_public=1 WHERE id='" + personaId + "'"); } finally { try { db.close(); } catch (e) { /* noop */ } }
    const denied3 = await S.api('POST', '/v1/works/generate', {
      token: other.token, json: { mode: 'simple', prompt: '偷声3', mood: '忧郁', count: 1, sec: 15, persona_id: personaId, idem_key: 'v31-steal-3' },
    });
    assert.strictEqual(denied3.status, 403, '公开人格也只公开元数据，实际 ' + denied3.status);

    const ok = await S.api('POST', '/v1/works/generate', {
      token: owner.token, json: { mode: 'simple', prompt: '雨夜爵士', mood: '忧郁', count: 1, sec: 15, persona_id: personaId, idem_key: 'v31-own' },
    });
    assert.strictEqual(ok.status, 202, '本人使用自己的人格应 202，实际 ' + ok.status + ' ' + ok.text.slice(0, 160));
    const row = S.db.all('SELECT payload FROM jobs WHERE id=?', ok.json.job_id)[0];
    const pl = JSON.parse(row.payload);
    assert.ok(pl.persona && pl.persona.id === personaId,
      'payload.persona 必须带 id，执行器才能经鉴权取件口取声纹，实际 ' + JSON.stringify(pl.persona).slice(0, 200));
  });

  it('V31-② 跨机：ref_abs_path 在执行机不可读时，必须经鉴权取件口回捞并真的送去克隆', async () => {
    engineA.reqs.length = 0;
    const payload = basePayload({
      id: personaId,
      ref_abs_path: 'E:\\Work\\X-Theater\\voices\\not-on-this-host.wav', // 真机形态：服务端算出的路径在执行机侧不存在
      cover_strength: 0.3, clone_mode: 'fast',
    });
    const r = await drive(payload, { musicUrl: engineA.base, apiUrl: S.baseUrl, executorToken: H.EXECUTOR_TOKEN });
    assert.strictEqual(engineA.reqs.length, 2, '应发生 guide + cover 两次生成请求，实际 ' + engineA.reqs.length
      + '；日志：' + JSON.stringify(r.logs.slice(0, 6)));
    const cover = engineA.reqs[1].body;
    assert.ok(cover.ref_audio, 'cover 请求必须带 ref_audio');
    assert.ok(fs.existsSync(cover.ref_audio), 'ref_audio 必须是执行机**真实可读**的文件（旧实现这里是个不存在的路径）：' + cover.ref_audio);
    assert.strictEqual(fs.readFileSync(cover.ref_audio).length, VOICE.length,
      '回捞到的声纹必须与上传的样本同字节（证明来自鉴权取件口，不是凭空造的）');
    assert.ok(cover.src_audio && fs.existsSync(cover.src_audio), 'cover 必须带 guide 产物作为 src_audio');
    assert.strictEqual(cover.cover_strength, 0.3, 'cover_strength 必须透传');
    assert.ok(r.logs.some((l) => l.includes('按鉴权取件口回捞成功')),
      '跨机回捞必须留可追责日志，实际日志：' + JSON.stringify(r.logs.slice(0, 8)));
    assert.strictEqual(r.result.persona_applied, true, '真克隆成功才允许报 persona_applied');
    assert.strictEqual(r.result.candidates[0].meta.clone.applied, true, 'meta.clone.applied 必须真实');
    assert.strictEqual(r.result.candidates[0].meta.clone.stage2_failed, false, '本轮 cover 应当成功，不该记 stage2_failed');
    assert.ok(r.files.length === 1 && fs.existsSync(r.files[0].abs), '产物必须落盘（引擎只给异机路径，需走 /music/{id}/file 回捞）');
    assert.strictEqual(fs.readFileSync(r.files[0].abs).length, SONG.length, '产物字节应来自取件口');
  });

  it('V31-③ 取不到声纹必须诚实降级：不谎称已克隆，但用户仍有可交付产物', async () => {
    engineB.reqs.length = 0;
    const payload = basePayload({
      id: 'p_不存在的人格', ref_abs_path: '/nonexistent/voice.wav', cover_strength: 0.2, clone_mode: 'fast',
    });
    const r = await drive(payload, { musicUrl: engineB.base, apiUrl: S.baseUrl, executorToken: H.EXECUTOR_TOKEN });
    assert.strictEqual(engineB.reqs.length, 1, '取不到声纹就不该拿假路径去请求 cover（只应有 guide），实际 ' + engineB.reqs.length);
    assert.strictEqual(r.result.persona_applied, false, '没真克隆却报 persona_applied=true 就是骗用户');
    const cl = r.result.candidates[0].meta.clone;
    assert.strictEqual(cl.applied, false, 'meta.clone.applied 必须为 false');
    assert.strictEqual(cl.ref_unavailable, true, '必须标注"声纹不可得"这一真实原因');
    assert.strictEqual(cl.stage2_failed, false, '没发起 cover，不该记 stage2_failed');
    assert.ok(r.files.length === 1 && fs.existsSync(r.files[0].abs), '降级后仍必须交付 guide 产物（积分不白花）');
    assert.ok(r.logs.some((l) => l.includes('不谎称已克隆') || l.includes('按不克隆交付')),
      '降级必须留说明性日志，实际：' + JSON.stringify(r.logs.slice(0, 6)));
  });

  it('V31-④ 同一 job 的 guide 与 cover 必须打到同一引擎（payload.music_endpoint 说了算）', async () => {
    engineA.reqs.length = 0; engineB.reqs.length = 0;
    const payload = basePayload({ id: personaId, ref_abs_path: null, cover_strength: 0.2, clone_mode: 'fast' });
    payload.music_endpoint = engineA.base; // 后台/路由选择的节点
    const r = await drive(payload, { musicUrl: engineB.base, apiUrl: S.baseUrl, executorToken: H.EXECUTOR_TOKEN });
    assert.strictEqual(engineA.reqs.length, 2, 'guide 与 cover 都必须走 payload.music_endpoint（' + engineA.base
      + '），实际 A=' + engineA.reqs.length + ' B=' + engineB.reqs.length
      + '；写死 cfg.musicUrl 会让变声打到另一台机器；日志：' + JSON.stringify(r.logs.slice(0, 6)));
    assert.strictEqual(engineB.reqs.length, 0, '不得有请求漏到 cfg.musicUrl 那台');
  });
});
