// V36 · 游客身份可恢复性（身份耐久 P0 · 2026-11-27 真机）
// 断言源：CONTRACTS.md v5.3.0。
// 现场：App 的 POST /v1/auth/guest **从来没送过 device_key**，服务端 `if (!user) INSERT` 于是
// 每次 mint 都建一条全新账号并返回 200；401→刷新失败→静默重新 mint 的路径（不用重装就能踩到）
// 会让用户的全部作品"凭空消失"，界面零提示。用户原话：「重装覆盖不能保存本地内容？？？？？？？？？？」。
// 本套判词锁死三件事：无锚点不许建号、同锚点必须复用、客户端不许把锚点弄丢。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');

let S;
const userCount = () => S.db.all('SELECT COUNT(*) AS n FROM users')[0].n; // 探针只提供 all()
const mint = (body) => S.api('POST', '/v1/auth/guest', { json: body });

describe('V34 游客身份可恢复性（v5.3.0 身份锚点）', () => {
  before(async () => { S = await H.boot('V36', { noFakeExecutor: true }); });
  after(async () => { if (S) await S.close(); });

  it('V36-① 无 device_key / 锚点过短 → 400，且绝对不许凭空建号', async () => {
    const n0 = userCount();
    for (const bad of [undefined, '', 'short', 'a'.repeat(15), '   ']) {
      const r = await mint(bad === undefined ? {} : { device_key: bad });
      assert.strictEqual(r.status, 400,
        `V36-① device_key=${JSON.stringify(bad)} 应 400（静默建号=换人=作品找不回），实际 ${r.status} ${r.text.slice(0, 160)}`);
      assert.ok(r.json && r.json.code === 'BAD_REQUEST',
        'V36-① 错误码应为 BAD_REQUEST，实际 ' + r.text.slice(0, 160));
      assert.ok(/设备标识|device_key/.test(String((r.json || {}).message || '')),
        'V36-① 文案必须说清缺的是设备标识，实际 ' + JSON.stringify(r.json));
    }
    assert.strictEqual(userCount(), n0,
      'V36-① 拒绝建号必须是真的没建：旧写法在这里悄悄 INSERT 并返回 200，是"内容全丢"的源头');
  });

  it('V36-② 同一 device_key 必须复用同一游客号（重装/清数据后可恢复的地基）', async () => {
    const dk = 'v34-same-device-' + Date.now();
    const a = await mint({ device_key: dk });
    assert.strictEqual(a.status, 200, 'V36-② 合格锚点应 200，实际 ' + a.status + ' ' + a.text.slice(0, 160));
    assert.strictEqual(a.json.first_time, true, 'V36-② 首次建号必须回 first_time=true（客户端据此对用户说实话）');

    const b = await mint({ device_key: dk });
    assert.strictEqual(b.status, 200, 'V36-② 复用应 200，实际 ' + b.status);
    assert.strictEqual(b.json.user.id, a.json.user.id,
      'V36-② 同一 device_key 两次 mint 必须是同一个人（不同就是身份不可恢复）：' + a.json.user.id + ' vs ' + b.json.user.id);
    assert.strictEqual(b.json.first_time, false, 'V36-② 复用必须回 first_time=false');
  });

  it('V36-③ 不同 device_key 必须是不同身份（锚点不是全局令牌）', async () => {
    const a = await mint({ device_key: 'v34-dev-A-' + Date.now() });
    const b = await mint({ device_key: 'v34-dev-B-' + Date.now() });
    assert.strictEqual(a.status, 200, 'V36-③ A 应 200');
    assert.strictEqual(b.status, 200, 'V36-③ B 应 200');
    assert.notStrictEqual(a.json.user.id, b.json.user.id,
      'V36-③ 两台设备（不同锚点）不能落到同一个号上，否则一台的内容会串进另一台');
  });

  it('V36-④ 源码级防回归：客户端必须送锚点、锚点幂等、清 token 不许连锚点一起清', () => {
    const root = path.resolve(__dirname, '../..');
    const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

    const api = read('src/app/lib/core/api_client.dart');
    const gl = api.slice(api.indexOf('guestLogin'), api.indexOf('requestCode'));
    assert.ok(gl.length > 40, 'V36-④ 读不到 guestLogin 实现，api_client.dart 结构变了要同步本测试');
    assert.ok(/device_key/.test(gl) && /ensureDeviceKey/.test(gl),
      'V36-④ 客户端 mint 必须带 device_key（当年就是这里裸 post /v1/auth/guest，身份每次都是新的）');
    assert.ok(!/_dio\.post\('\/v1\/auth\/guest'\)/.test(api),
      'V36-④ 检测到无 body 的 /v1/auth/guest 调用，静默换人的老写法不许回来');

    const prefs = read('src/app/lib/core/config.dart');
    assert.ok(/Future<String> ensureDeviceKey\(\)/.test(prefs), 'V36-④ Prefs 必须提供 ensureDeviceKey');
    assert.ok(/if \(cur != null && cur\.length >= 32\) return cur;/.test(prefs),
      'V36-④ 锚点必须幂等（已有即原样返回）；重新生成 = 换人');
    assert.ok(/Random\.secure\(\)/.test(prefs), 'V36-④ 锚点必须来自 CSPRNG，不能用时间戳/设备指纹这类可猜测值');
    const clear = prefs.slice(prefs.indexOf('Future<void> clearTokens()'), prefs.indexOf('clearTokens()') + 400);
    assert.ok(clear.length > 10 && !/_kDeviceKey/.test(clear),
      'V36-④ clearTokens（登出/刷新失败）不得清除 device_key —— 清 token 是登出，不是丢身份');

    const auth = read('src/server/api/auth.js');
    const fn = auth.slice(auth.indexOf('function guest('), auth.indexOf('issueSession(user.id)'));
    assert.ok(/device_key/.test(fn) && /length < 16/.test(fn),
      'V36-④ 服务端必须校验锚点合格性（长度下限），否则客户端一个空串就能换人');
    assert.ok(/first_time/.test(fn), 'V36-④ 服务端必须回 first_time，客户端才有信息说实话');
    assert.ok(!/U\.uid\('gk_'\)/.test(fn),
      'V36-④ 无锚点时落随机 gk_ 的写法不许回来：那个值永远匹配不上，身份结构上不可能恢复');
  });
});
