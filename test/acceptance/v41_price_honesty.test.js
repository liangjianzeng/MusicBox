'use strict';
/*
 * V41 —— 「显示的价格」必须就是「真扣的价格」（2026-11-28）
 *
 * 现场：真实单价住在运营配置中心（`AC.credits()`，后台可改、热生效），扣费处读它
 * （works.js `AC.credits().per_candidate * count`），但 `/v1/credits` **根本不回价格**，
 * 于是端侧 `credit_guard.dart` 自己抄了一份 `kCreditGenerateEach = 15` 当权威 ——
 * 运营一改价，扣费闸门就拿着旧价放行用户，派单时再被服务端拒（界面说了不算）。
 * 而简约档更糟：候选数量写死 3 首，一键 = 闷声 45⚡，每日免费才 50。
 *
 * 本判词走真路径（真服务端 + 真管理端改价），钉四件事：
 *   ① /v1/credits 必须把真在用的单价下发给端侧；
 *   ② 下发价 × 候选数 == 真扣的 credits_charged（不是装饰字段）；
 *   ③ 运营在后台改价后，**显示价和真扣价必须一起动**（这是 ② 的负向对照：
 *      如果 prices 取的是 config.js 默认值而不是 COST()，这条立刻红）；
 *   ④ 简约档不许把候选数量写死，花费必须写在按钮上。
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers.js');

let S, ADMIN;
const P = 'admin1234'; // dev 默认口令（生产 fail-closed 由 V23 覆盖）

async function adminLogin() {
  const r = await S.api('POST', '/admin/login', { json: { username: 'admin', password: P } });
  assert.strictEqual(r.status, 200, 'V41 前置：管理员登录应 200，实际 ' + r.status);
  return r.json.token;
}
const adminCall = (m, p, body) => S.api(m, p, { headers: { authorization: 'Bearer ' + ADMIN }, json: body === undefined ? {} : body });

function genBody(count) {
  return { mode: 'simple', prompt: H.uniq('v41'), sec: 30, count };
}

describe('V41 价格诚实', () => {
  before(async () => { S = await H.boot('V41'); ADMIN = await adminLogin(); });
  after(async () => { if (S) await S.close(); });

  it('V41-① /v1/credits 必须把"真在用的单价"下发给端侧', async () => {
    const g = await S.newGuest();
    const r = await S.api('GET', '/v1/credits', { token: g.token });
    assert.strictEqual(r.status, 200, r.text);
    const p = r.json.prices;
    assert.ok(p && typeof p === 'object', '/v1/credits 必须带 prices 对象；端侧抄死单价的根因就是它不存在');
    for (const k of ['per_candidate', 'adjust', 'extend', 'cover', 'dsp']) {
      assert.ok(Number.isInteger(p[k]) && p[k] > 0, 'prices.' + k + ' 必须是正整数，实际 ' + JSON.stringify(p[k]));
    }
  });

  it('V41-② 显示价 × 候选数 == 真扣的钱（不是贴在响应里的装饰品）', async () => {
    const g = await S.newGuest();
    const shown = (await S.api('GET', '/v1/credits', { token: g.token })).json.prices.per_candidate;
    const r = await S.api('POST', '/v1/works/generate', { token: g.token, json: genBody(2) });
    assert.ok(r.ok, 'generate 应 2xx，实际 ' + r.status + ' ' + r.text);
    assert.strictEqual(r.json.credits_charged, shown * 2,
      '界面按 ' + shown + '/首 展示与放行，实际扣了 ' + r.json.credits_charged + '（2 首）—— 用户在按之前就被告知了错误的数');
  });

  it('V41-③ 运营后台改价后，显示价与真扣价必须一起动', async () => {
    const g = await S.newGuest();
    // 走**真路径**：运营配置中心（POST /admin/config/app），不是改 env、不是 monkeypatch
    const NEW = 23;
    const set = await adminCall('POST', '/admin/config/app', {
      patch: { credits: { per_candidate: NEW } }, reason: 'V41 契约用例',
    });
    assert.strictEqual(set.status, 200, set.text);
    const blob = set.json.blob && set.json.blob.credits;
    assert.ok(blob, '配置中心应保留 credits 段');
    assert.strictEqual(blob.per_candidate, NEW, '运营改价没落进 blob.credits.per_candidate：' + JSON.stringify(blob));
    assert.ok(Number.isInteger(blob.adjust) && blob.adjust > 0,
      '深合并把 credits.adjust 抹掉了（改一个价不能清掉别的价）：' + JSON.stringify(blob));

    // 余额补够（新游客 50，可能已被前面的用例吃掉）
    await adminCall('POST', '/admin/credits/adjust', { user_id: g.user.id, delta: 200, reason: 'V41 前置' });

    const shown = (await S.api('GET', '/v1/credits', { token: g.token })).json.prices.per_candidate;
    assert.strictEqual(shown, NEW,
      '运营已改成 ' + NEW + '，但 /v1/credits 还报 ' + shown + ' —— 说明 prices 取的是 config.js 默认值而不是 COST()，端侧闸门会拿着旧价放行');
    const r = await S.api('POST', '/v1/works/generate', { token: g.token, json: genBody(1) });
    assert.ok(r.ok, r.text);
    assert.strictEqual(r.json.credits_charged, NEW,
      '显示 ' + shown + ' 却扣了 ' + r.json.credits_charged + '：显示价与扣价不同源');
  });

  it('V41-④ 简约/标准档不许写死候选数量，花费必须写在按钮上', () => {
    const dir = path.join(__dirname, '..', '..', 'src', 'app', 'lib', 'features', 'create');
    // 深度档一直有数量控件；出事的简约/标准都写死过 3 首（一键 45⚡，每日免费才 50）
    for (const f of ['shell_easy.dart', 'shell_standard.dart']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!/'count':\s*3\b/.test(src),
        f + ' 又把候选数量写死成 3 了：一键 45⚡（每日免费才 50），用户既改不了也看不见');
      assert.ok(/'count':\s*n\b/.test(src),
        f + ' 的派单数量必须来自用户选的 n（`\'count\': n`）');
      assert.ok(/creditPrice\(\s*ref,\s*'per_candidate'/.test(src),
        f + ' 的单价必须取服务端 /v1/credits.prices，不许拿端侧抄的 kCreditGenerateEach 当权威');
      assert.ok(/CountPicker\(/.test(src),
        f + ' 必须有数量选择器（CountPicker 与主按钮同行，另起一行会挤掉主操作）');
      assert.ok(/首 · \$\{unit \* n\}⚡/.test(src),
        f + ' 的按钮必须写着"几首 · 多少⚡"：点下去要花多少，按之前就该知道');
    }
  });
});
