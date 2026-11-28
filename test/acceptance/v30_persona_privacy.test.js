// V30 · 声纹样本私有化（PIPL 敏感个人信息）+ 字段长度单一真源
// 断言源：docs/contract-draft-adjudications.md 判定 2（真缺陷）与判定 4（真缺陷）；契约 v5.2
// 为什么要这条：api/personas.js 曾把用户上传的声纹样本 U.saveToOut(config.paths.out, …) 落进
// **/f/* 公共静态目录** —— 任何拿到 URL 的人都能下载别人的声纹。声纹属敏感个人信息，
// 这不是"整洁度"问题，是合规与人身权益问题。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');

let S;
const WAV = () => H.makeSineWav({ sec: 22, freq: 320 }); // persona 需 20-40s

async function newPersona(token, name) {
  const r = await S.api('POST', '/v1/personas', {
    token,
    multipart: { fields: { name }, files: [{ field: 'file', filename: 'voice.wav', data: WAV(), contentType: 'audio/wav' }] },
  });
  assert.strictEqual(r.status, 200, '上传声纹样本应 200，实际 ' + r.status + ' ' + r.text.slice(0, 180));
  assert.ok(r.json && r.json.persona && r.json.persona.id, '响应应含 persona.id：' + r.text.slice(0, 160));
  return r.json.persona;
}
const refOf = (id) => S.db.all('SELECT voice_ref FROM personas WHERE id=?', id)[0].voice_ref;

describe('V30 声纹私有化与字段长度真源', () => {
  let owner, other, personaId;
  before(async () => {
    S = await H.boot('V30', { noFakeExecutor: true });
    owner = await S.newGuest();
    other = await S.newGuest();
    personaId = (await newPersona(owner.token, '我的声线')).id;
  });
  after(async () => { if (S) await S.close(); });

  it('V30-① 声纹样本必须落在私有目录，且**不得**能从公共 /f/* 取到', async () => {
    const ref = refOf(personaId);
    assert.ok(typeof ref === 'string' && ref.startsWith('voices/'),
      '新写入的声纹必须以 voices/ 前缀存私有区，实际 voice_ref=' + JSON.stringify(ref));
    const privAbs = path.join(S.varDir, 'voices', ref.slice('voices/'.length));
    assert.ok(fs.existsSync(privAbs), '私有目录里必须真有样本文件：' + privAbs);
    assert.ok(path.resolve(privAbs).startsWith(path.resolve(S.varDir, 'voices') + path.sep),
      '解析后的绝对路径必须仍在 voices 之内（防目录穿越）');
    const publicCopy = path.join(S.varDir, 'out', path.basename(ref));
    assert.strictEqual(fs.existsSync(publicCopy), false, 'out（公共 /f/* 映射目录）里不得留有声纹副本');
    const viaF = await S.api('GET', '/f/' + encodeURIComponent(path.basename(ref)));
    assert.strictEqual(viaF.status, 404, '公共 /f/* 必须取不到声纹，实际 ' + viaF.status);
    const viaFnested = await S.api('GET', '/f/' + ref.split('/').map(encodeURIComponent).join('/'));
    assert.strictEqual(viaFnested.status, 404, '按完整相对路径走 /f/* 也必须 404，实际 ' + viaFnested.status);
  });

  it('V30-② 取件口必须按身份把关：属主可取、他人 403、未登录 401、公开人格也不外泄声纹', async () => {
    const mine = await S.api('GET', '/v1/personas/' + personaId + '/voice', { token: owner.token });
    assert.strictEqual(mine.status, 200, '属主应能取回自己的声纹，实际 ' + mine.status + ' ' + mine.text);
    assert.ok(/^audio\//.test(String(mine.headers['content-type'])), 'content-type 应为音频，实际 ' + mine.headers['content-type']);
    assert.match(String(mine.headers['cache-control'] || ''), /no-store/,
      '声纹响应必须 private, no-store（不得被任何中间缓存留存），实际 ' + mine.headers['cache-control']);
    assert.ok(mine.buffer && mine.buffer.length > 1000, '取回的字节数应与上传同量级，实际 ' + (mine.buffer && mine.buffer.length));

    const stranger = await S.api('GET', '/v1/personas/' + personaId + '/voice', { token: other.token });
    assert.strictEqual(stranger.status, 403, '他人（合法用户）不得取他人声纹，实际 ' + stranger.status);

    const anon = await S.api('GET', '/v1/personas/' + personaId + '/voice');
    assert.strictEqual(anon.status, 401, '未登录必须 401，实际 ' + anon.status);

    // 公开人格：只公开元数据。把 is_public=1 当成"声纹也可公开"就是未经同意的声纹扩散。
    writeDb((db) => db.prepare('UPDATE personas SET is_public=1 WHERE id=?').run(personaId));
    const pubStranger = await S.api('GET', '/v1/personas/' + personaId + '/voice', { token: other.token });
    assert.strictEqual(pubStranger.status, 403, '人格公开 ≠ 声纹公开，他人仍须 403，实际 ' + pubStranger.status);
    const listOther = await S.api('GET', '/v1/personas', { token: other.token });
    assert.strictEqual(listOther.status, 200);
    assert.ok(!JSON.stringify(listOther.json).includes('voice_ref'),
      '列表响应不得带出 voice_ref（路径本身也不外泄）：' + JSON.stringify(listOther.json).slice(0, 200));

    assert.ok(hasAudit('persona.voice_fetch') >= 1, '取件必须留审计（谁在什么时候取过声纹）');
  });

  it('V30-③ 执行器持令牌必须能取件（否则跨机声线克隆只能静默失效）', async () => {
    const r = await S.api('GET', '/v1/personas/' + personaId + '/voice', { headers: { 'X-Executor-Token': H.EXECUTOR_TOKEN } });
    assert.strictEqual(r.status, 200, '执行器持 X-Executor-Token 应可取件，实际 ' + r.status + ' ' + r.text.slice(0, 140));
    assert.ok(/^audio\//.test(String(r.headers['content-type'])), '执行器取件也应返回音频流');
    const badTok = await S.api('GET', '/v1/personas/' + personaId + '/voice', { headers: { 'X-Executor-Token': 'wrong-token' } });
    assert.ok([401, 403].includes(badTok.status), '错误执行器令牌不得取件，实际 ' + badTok.status);
  });

  it('V30-④ 历史行（曾误存公共 out 目录）必须仍可解析，不因加固把用户数据判死', async () => {
    const rel = 'legacy-v30/voice.wav';
    const abs = path.join(S.varDir, 'out', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, WAV());
    const legacyId = 'p_v30_legacy';
    writeDb((db) => db.prepare('INSERT INTO personas(id,user_id,name,is_public,voice_ref,clone_params,derived_from_work,use_count,created_at) VALUES(?,?,?,?,?,?,NULL,0,?)')
      .run(legacyId, owner.user.id, '历史人格', 0, rel, '{}', new Date().toISOString()));
    const r = await S.api('GET', '/v1/personas/' + legacyId + '/voice', { token: owner.token });
    assert.strictEqual(r.status, 200, '历史 voice_ref（out 相对路径）必须仍可取回，实际 ' + r.status + ' ' + r.text.slice(0, 140));
    const ghost = await S.api('GET', '/v1/personas/' + personaId + '/voice', { token: owner.token });
    assert.strictEqual(ghost.status, 200, '正常路径不能被兼容逻辑带崩，实际 ' + ghost.status);
  });

  it('V30-⑤ 同一字段的长度上限必须单点供给（mood 曾在两处写成 60 / 20，用户静默丢字）', () => {
    const fields = require(path.join(H.ROOT, 'src/server/core/fields.js'));
    const core = require(path.join(H.ROOT, 'src/server/l2/governance_core.js'));
    assert.strictEqual(core.FIELD_LIMITS, fields.FIELD_LIMITS, 'l2 治理层必须转出自 core/fields，不得各留一份');
    assert.ok(Number.isInteger(fields.FIELD_LIMITS.mood) && fields.FIELD_LIMITS.mood > 0, 'FIELD_LIMITS.mood 必须是正整数');

    // ① 两个助手入口的 mood 上限必须**转出**到 core/fields 的唯一真源（v5.5.9：参数表收进 SET_CARD_PARAMS）。
    //    真源合并后"逐文件核对内联声明"已无对象，这里改判三件事，比原来更严：
    //    (a) 消费方必须显式引用 core/fields 并把参数表转交 SET_CARD_PARAMS；
    //    (b) 消费方不得再自带一份 mood 参数声明 —— 自带就是漂移的重新开始；
    //    (c) 真源自己的上限也必须是常量引用，不是写死的数字。
    const gates = [
      ['src/server/l2assistant/core.js', /\.\.\/core\/fields/],
      ['src/server/l2music/governance.js', /\.\.\/core\/fields/],
    ];
    for (const [rel, reqRe] of gates) {
      const src = fs.readFileSync(path.join(H.ROOT, rel), 'utf8');
      assert.ok(reqRe.test(src),
        rel + ' 必须引用 core/fields（mood 长度上限的唯一真源）—— 请同步修改本用例，而不是把它删掉');
      assert.ok(/params:\s*FL\.SET_CARD_PARAMS/.test(src),
        rel + ' 的 music.set_card 参数表必须转交 SET_CARD_PARAMS，不得在自己文件里另列一份');
      assert.ok(!/mood:\s*\{\s*kind:\s*'string'/.test(src),
        rel + ' 里不得再自带 mood 参数声明（当年就是 60 / 20 两处并存，用户静默丢字）');
    }
    const fieldsSrc = fs.readFileSync(path.join(H.ROOT, 'src/server/core/fields.js'), 'utf8');
    const fm = /mood:\s*\{\s*kind:\s*'string'[^}]*?max:\s*([^,}]+)/.exec(fieldsSrc);
    assert.ok(fm, 'src/server/core/fields.js 里没找到 mood 参数声明 —— 请同步修改本用例，而不是把它删掉');
    assert.ok(!/^\d+$/.test(fm[1].trim()), '唯一真源的 mood 上限必须是常量引用，实际写死 ' + fm[1].trim());
    assert.strictEqual(fm[1].trim().split('.').slice(-1)[0], 'mood', '唯一真源的 mood 上限必须取自 FIELD_LIMITS.mood');

    // ② 落库/搜索处的截断长度也不得写字面量：曾经 落库 20 / 搜索 30 / 助手 60 三个数并存
    const works = fs.readFileSync(path.join(H.ROOT, 'src/server/api/works.js'), 'utf8').split('\n');
    let seen = 0;
    works.forEach((line, i) => {
      if (!/mood/.test(line)) return;
      const m = /\.slice\(0,\s*([^)]+)\)/.exec(line);
      if (!m) return;
      // 只判"这一行截的就是 mood 本身"（String(<含 mood 的表达式>) 之后的 slice），排除同行别的字段
      const strArg = /String\(([^)]*mood[^)]*)\)\s*\.slice\(0,\s*([^)]+)\)/.exec(line);
      if (!strArg) return;
      seen++;
      assert.ok(!/^\d+$/.test(strArg[2].trim()),
        'api/works.js:' + (i + 1) + ' 的 mood 截断必须引用 FIELD_LIMITS，实际写死 ' + strArg[2].trim()
        + '；写死数字正是"助手放行、写入静默截断"的成因');
    });
    assert.ok(seen >= 2, '至少应扫到落库与搜索两处 mood 截断（实际 ' + seen + ' 处）—— 代码变了要同步本用例');
  });
});

function writeDb(fn) {
  const db = H.openWhiteDb(S.dbPath);
  try { db.exec('PRAGMA busy_timeout=8000;'); return fn(db); } finally { try { db.close(); } catch (e) { /* noop */ } }
}
function hasAudit(kind) {
  return S.db.all('SELECT COUNT(*) n FROM audit WHERE kind=?', kind)[0].n;
}
