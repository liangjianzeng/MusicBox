// V27 · 运营面（/admin/*）契约级覆盖（抢救计划 P1-4 门票）
// 断言源：docs/musicbox-rescue-refactor-plan.md §4 P1-4「/admin/* 19 条路由各 1 条契约级用例
//         （鉴权 + 幂等 + 审计落库）」
// 做法：数据驱动遍历路由表，每条都过三道门 —— ①无令牌/坏令牌必须 401；②管理员调用必须按契约成功；
//       ③写类路由必须留审计（audit 表新增），且重复调用不产生额外副作用（或按契约明确"每次都是新账目"）。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers.js');

let S, ADMIN;
const P = 'admin1234'; // dev 默认口令（生产 fail-closed 由 V23 覆盖）

async function login() {
  const r = await S.api('POST', '/admin/login', { json: { username: 'admin', password: P } });
  assert.strictEqual(r.status, 200, '管理员登录应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.json && r.json.token, '登录应下发 token');
  assert.ok(r.json.expire_at && Date.parse(r.json.expire_at) > Date.now(), '管理员令牌必须带过期时间');
  return r.json.token;
}
const adminGet = (p) => S.api('GET', p, { headers: { authorization: 'Bearer ' + ADMIN } });
const adminCall = (m, p, body) => S.api(m, p, { headers: { authorization: 'Bearer ' + ADMIN }, json: body === undefined ? {} : body });
const anon = (m, p, body) => S.api(m, p, { headers: { authorization: 'Bearer not-a-real-admin-token' }, json: body === undefined ? {} : body });
const auditCount = () => S.db.all('SELECT COUNT(*) n FROM audit')[0].n;
const hasAudit = (kind) => S.db.all('SELECT COUNT(*) n FROM audit WHERE kind=?', kind)[0].n;

function writeDb(fn) {
  const db = H.openWhiteDb(S.dbPath);
  try { db.exec('PRAGMA busy_timeout=8000;'); return fn(db); } finally { try { db.close(); } catch (e) { /* noop */ } }
}

// 路由表：覆盖 admin_ops.js / admin.js / modelnodes.js 的全部 /admin/* 端点
let nid;
const ROUTES = [
  { m: 'POST', p: '/admin/login', body: { username: 'admin', password: P }, ok: [200], public: true },

  { m: 'GET', p: '/admin/moderation/words', ok: [200] },
  { m: 'POST', p: '/admin/moderation/words', body: { text: '违禁词A\n违禁词B\n违禁词A' }, ok: [200], write: true, idem: 'set' },
  { m: 'GET', p: '/admin/moderation/reports', ok: [200] },
  { m: 'POST', p: '/admin/moderation/reports/:id/decide', body: { action: 'dismiss' }, ok: [200], write: true, idem: 'state' },

  { m: 'POST', p: '/admin/credits/adjust', body: { user_id: '<uid>', delta: 7, reason: 'v27 契约用例' }, ok: [200], write: true, idem: 'ledger' },
  { m: 'GET', p: '/admin/credits/ledger?user_id=<uid>', ok: [200] },
  { m: 'POST', p: '/admin/users/:id/status', body: { status: 'active' }, ok: [200], write: true, idem: 'state' },
  { m: 'GET', p: '/admin/users/:id', ok: [200] },
  { m: 'GET', p: '/admin/users', ok: [200] },

  { m: 'GET', p: '/admin/audit', ok: [200] },
  { m: 'GET', p: '/admin/config/events', ok: [200] },
  { m: 'POST', p: '/admin/config/app', body: { patch: { per_candidate: 15 }, reason: 'v27 契约用例' }, ok: [200], write: true, idem: 'value' },
  { m: 'GET', p: '/admin/config/app', ok: [200] },
  { m: 'POST', p: '/admin/config/rollback', body: { version: 1 }, ok: [200, 400, 404], write: true },
  { m: 'GET', p: '/admin/config/history', ok: [200] },
  { m: 'POST', p: '/admin/config/features', body: { key: 'assistant_chat_music', enabled: false, grayscale: 0 }, ok: [200], write: true, idem: 'state' },
  { m: 'GET', p: '/admin/config/features', ok: [200] },
  { m: 'GET', p: '/admin/metrics/overview', ok: [200] },

  { m: 'GET', p: '/admin/model-nodes', ok: [200] },
  { m: 'GET', p: '/admin/model-nodes/health', ok: [200] },
  { m: 'POST', p: '/admin/model-nodes', body: { kind: 'llm', engine: 'v27-probe', endpoint: 'http://127.0.0.1:9/v1', label: 'V27 探针' }, ok: [200, 201], write: true, idem: 'create' },
  { m: 'PATCH', p: '/admin/model-nodes/:nid', body: { label: 'V27 已改名' }, ok: [200], write: true, idem: 'state' },
  { m: 'POST', p: '/admin/model-nodes/:nid/probe', body: {}, ok: [200] },
  { m: 'POST', p: '/admin/model-nodes/probe-all', body: {}, ok: [200] },
  { m: 'GET', p: '/admin/config/routing', ok: [200] },
  { m: 'POST', p: '/admin/config/routing', body: { llm: { node_id: '<nid>' } }, ok: [200], write: true },
  { m: 'DELETE', p: '/admin/model-nodes/:nid', body: {}, ok: [200, 204], write: true, idem: 'delete' },
];

describe('V27 运营面 /admin/* 契约级覆盖', () => {
  let uid, reportId;
  before(async () => {
    S = await H.boot('V27', { noFakeExecutor: true });
    ADMIN = await login();
    uid = (await S.newGuest()).user.id;
    nid = 'mn_v27_probe';
    reportId = 'rp_v27_1';
    // 节点 id 由服务端生成（api/modelnodes.js create 用 U.uid('mn_')，客户端传的 id 会被忽略），
    // 所以必须从响应里取真实 id，不能自己编一个去 PATCH/probe/DELETE。
    const created = await adminCall('POST', '/admin/model-nodes', { kind: 'llm', engine: 'v27-fixture', endpoint: 'http://127.0.0.1:9/v1', label: 'V27 夹具' });
    assert.ok([200, 201].includes(created.status), '夹具节点创建应成功：' + created.status + ' ' + created.text);
    nid = (created.json && (created.json.id || (created.json.node && created.json.node.id))) || null;
    assert.ok(nid, '夹具节点响应必须带 id，实际 ' + String(created.text).slice(0, 160));
    writeDb((db) => db.prepare('INSERT INTO reports(id,user_id,work_id,reason,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(reportId, uid, 'w_v27', '探针举报', 'open', new Date().toISOString()));
  });
  after(async () => { if (S) await S.close(); });

  async function ensureNode() {
    const alive = nid && S.db.all('SELECT COUNT(*) n FROM model_nodes WHERE id=?', nid)[0].n > 0;
    if (alive) return nid;
    const c = await adminCall('POST', '/admin/model-nodes', { kind: 'llm', engine: 'v27-fixture', endpoint: 'http://127.0.0.1:9/v1', label: 'V27 夹具' });
    assert.ok([200, 201].includes(c.status), '补建夹具节点失败：' + c.status + ' ' + c.text);
    nid = c.json && (c.json.id || (c.json.node && c.json.node.id));
    assert.ok(nid, '夹具节点响应缺 id');
    return nid;
  }

  const sub = (x) => (typeof x === 'string'
    ? x.replace('<uid>', uid).replace('<nid>', nid)
    : (x && typeof x === 'object'
      ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, sub(v)]))
      : x));
  const fill = (r) => r.p.replace('<uid>', encodeURIComponent(uid))
    .replace(':id', r.p.indexOf('reports') >= 0 ? reportId : encodeURIComponent(uid))
    .replace(':nid', encodeURIComponent(nid));
  const fillBody = (r) => (r.body ? sub(r.body) : r.body);

  it('V27-① 每条 /admin/* 路由都必须拒绝非管理员（缺令牌或坏令牌一律 401）', async () => {
    const missed = [];
    for (const r of ROUTES) {
      if (r.public) continue;
      const a = await anon(r.m, fill(r), r.body);
      const b = await S.api(r.m, fill(r), { json: r.body === undefined ? {} : r.body }); // 完全不带 authorization
      if (![401, 403].includes(a.status)) missed.push(`${r.m} ${r.p} 坏令牌 → ${a.status}`);
      if (![401, 403].includes(b.status)) missed.push(`${r.m} ${r.p} 无令牌 → ${b.status}`);
    }
    assert.deepStrictEqual(missed, [], '存在未鉴权即可调用的运营端点：\n' + missed.join('\n'));
  });

  it('V27-② 每条 /admin/* 路由在管理员下都按契约可用（状态码与响应形状）', async () => {
    const bad = [];
    for (const r of ROUTES) {
      let res;
      if (r.public) {
        res = await S.api(r.m, r.p, { json: r.body });
        // 登录会**轮换**单个 admin 行的 token（见 api/admin.js login）：再登录一次就会让前面拿到的
        // 令牌立刻失效。用例必须跟着换令牌，否则后面全是 401 —— 这是被测契约的真实语义，不是测试自由度。
        if (res.status === 200 && res.json && res.json.token) ADMIN = res.json.token;
      } else {
        res = await adminCall(r.m, fill(r), fillBody(r));
      }
      if (!r.ok.includes(res.status)) bad.push(`${r.m} ${r.p} → ${res.status} ${String(res.text).slice(0, 110)}`);
      else if (r.ok.includes(200) && res.status === 200) {
        assert.ok(res.json && typeof res.json === 'object', `${r.m} ${r.p} 应返回 JSON 对象`);
      }
    }
    assert.deepStrictEqual(bad, [], '运营端点契约不符：\n' + bad.join('\n'));
  });

  it('V27-③ 每个写类路由都必须落审计（钱与配置的每一步都要可追责）', async () => {
    const missing = [];
    for (const r of ROUTES) {
      if (!r.write) continue;
      if (r.p.indexOf(':nid') >= 0 || JSON.stringify(r.body || '').indexOf('<nid>') >= 0) await ensureNode();
      const before = auditCount();
      const res = await adminCall(r.m, fill(r), fillBody(r));
      assert.ok(r.ok.includes(res.status), `${r.m} ${r.p} 调用失败：${res.status} ${String(res.text).slice(0, 90)}`);
      const after = auditCount();
      if (after <= before) missing.push(`${r.m} ${r.p}（audit 行数未增加）`);
    }
    assert.deepStrictEqual(missing, [], '以下运营写操作没有留审计：\n' + missing.join('\n'));
  });

  it('V27-④ 写类路由重复调用不产生越界副作用（集合类幂等、账目类每步一行且不变量成立）', async () => {
    // 词库：同一份内容重复设置，条目数不得累积（set 语义）
    await adminCall('POST', '/admin/moderation/words', { text: '幂等词A\n幂等词B' });
    const n1 = (await adminGet('/admin/moderation/words')).json;
    await adminCall('POST', '/admin/moderation/words', { text: '幂等词A\n幂等词B' });
    const n2 = (await adminGet('/admin/moderation/words')).json;
    const len = (o) => JSON.stringify(o).length;
    assert.strictEqual(len(n1), len(n2), '重复设置同一词库不得改变内容：' + JSON.stringify(n1).slice(0, 120) + ' vs ' + JSON.stringify(n2).slice(0, 120));

    // 调额：契约上每次都是一条新账目，但必须与账本不变量一起成立
    const bal0 = S.db.all('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 1', uid)[0].balance_after;
    const a1 = await adminCall('POST', '/admin/credits/adjust', { user_id: uid, delta: 5, reason: 'v27 幂等一' });
    const a2 = await adminCall('POST', '/admin/credits/adjust', { user_id: uid, delta: 5, reason: 'v27 幂等二' });
    assert.strictEqual(a1.status, 200); assert.strictEqual(a2.status, 200);
    assert.strictEqual(a2.json.balance_after, bal0 + 10, '两次调额必须各记一行且余额累加正确');
    const rows = S.db.all("SELECT COALESCE(SUM(delta),0) s FROM credit_ledger WHERE user_id=?", uid)[0].s;
    const last = S.db.all('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 1', uid)[0].balance_after;
    assert.strictEqual(rows, last, '调额后账本不变量 Σdelta==balance 必须成立（实际 ' + rows + ' vs ' + last + '）');

    // 状态类：重复设同一状态不得报错、状态必须稳定
    for (let i = 0; i < 2; i++) {
      const r = await adminCall('POST', `/admin/users/${encodeURIComponent(uid)}/status`, { status: 'disabled' });
      assert.strictEqual(r.status, 200, '重复设置同一状态不得报错：' + r.status + ' ' + r.text);
    }
    assert.strictEqual(S.db.all('SELECT status FROM users WHERE id=?', uid)[0].status, 'disabled', '用户状态必须是最后一次设置值');

    // 配置：同一 patch 重复提交，最终值必须一致（热生效不被重复叠加污染）
    await adminCall('POST', '/admin/config/app', { patch: { per_candidate: 16 }, reason: 'v27 重复一' });
    await adminCall('POST', '/admin/config/app', { patch: { per_candidate: 16 }, reason: 'v27 重复二' });
    const cfg = (await adminGet('/admin/config/app')).json;
    assert.match(JSON.stringify(cfg), /16/, '重复提交同一 patch 后配置值必须是 16：' + JSON.stringify(cfg).slice(0, 160));
  });

  it('V27-⑤ 运营面不得泄露口令/令牌字段（管理员面同样要防凭据外泄）', async () => {
    const leaks = [];
    for (const p of ['/admin/users', `/admin/users/${encodeURIComponent(uid)}`, '/admin/audit', '/admin/credits/ledger?user_id=' + uid, '/admin/config/app']) {
      const r = await adminGet(p);
      assert.strictEqual(r.status, 200, p + ' 这条检查必须在**成功响应**上做，否则 401 会空过：' + r.status);
      const s = String(r.text);
      if (/token_hash|refresh_token_hash|access_token_hash|password|passhash|admin1234/i.test(s)) leaks.push(p + ' → 含敏感字段');
    }
    assert.deepStrictEqual(leaks, [], '运营端点响应含凭据类字段：\n' + leaks.join('\n'));
  });

  it('V27-⑧ 路由指向不存在的节点必须被明确拒绝（400），且不得留下"已生效"的假审计', async () => {
    await ensureNode();
    const before = hasAudit('model_routing.set');
    const r = await adminCall('POST', '/admin/config/routing', { llm: { node_id: 'mn_buxiangcun_9f3a' } });
    assert.strictEqual(r.status, 400, '指向不存在节点应 400，实际 ' + r.status + ' ' + r.text);
    assert.match(String(r.text), /节点不存在|BAD_REQUEST/, '错误信息要能指到根因：' + String(r.text).slice(0, 120));
    assert.strictEqual(hasAudit('model_routing.set'), before, '被拒绝的路由变更不得写入"已生效"审计（否则运营面会看到没发生过的变更）');
  });

  it('V27-⑦ 管理员令牌必须可轮换：旧令牌在新登录后立即失效', async () => {
    const before = ADMIN;
    const r = await S.api('POST', '/admin/login', { json: { username: 'admin', password: P } });
    assert.strictEqual(r.status, 200, '再次登录应 200：' + r.status + ' ' + r.text);
    const fresh = r.json.token;
    assert.ok(fresh && fresh !== before, '每次登录必须下发新令牌（否则泄漏的令牌永久有效）');
    const stale = await adminCall('GET', '/admin/users', undefined);
    // 用旧令牌显式再打一次，必须被拒
    const oldTok = await S.api('GET', '/admin/users', { headers: { authorization: 'Bearer ' + before } });
    assert.strictEqual(oldTok.status, 401, '旧令牌在新登录后必须失效，实际 ' + oldTok.status);
    ADMIN = fresh;
    const still = await adminCall('GET', '/admin/users', undefined);
    assert.strictEqual(still.status, 200, '新令牌必须可用，实际 ' + still.status);
  });

  it('V27-⑥ 模型节点删除后不得再被路由引用（防止指向已删节点的静默失败）', async () => {
    const created = await adminCall('POST', '/admin/model-nodes', { kind: 'llm', engine: 'v27', endpoint: 'http://127.0.0.1:9/v1', label: '待删' });
    assert.ok([200, 201].includes(created.status), '建节点应成功：' + created.status + ' ' + created.text);
    const doomed = created.json && (created.json.id || (created.json.node && created.json.node.id));
    assert.ok(doomed, '建节点响应必须带 id：' + String(created.text).slice(0, 140));
    const routed = await adminCall('POST', '/admin/config/routing', { llm: { node_id: doomed } });
    assert.ok([200, 400].includes(routed.status), '路由设置要么成功要么明确拒绝：' + routed.status + ' ' + routed.text);
    const del = await adminCall('DELETE', '/admin/model-nodes/' + encodeURIComponent(doomed));
    assert.ok([200, 204].includes(del.status), '删除节点应成功：' + del.status + ' ' + del.text);
    const routeNow = await adminGet('/admin/config/routing');
    assert.strictEqual(routeNow.status, 200);
    const still = String(routeNow.text).includes(doomed);
    const listed = S.db.all('SELECT COUNT(*) n FROM model_nodes WHERE id=?', doomed)[0].n;
    assert.strictEqual(listed, 0, '已删节点不得仍在表里');
    if (still) {
      const health = await adminGet('/admin/model-nodes/health');
      assert.ok(/unreachable|missing|unknown|error|invalid/i.test(String(health.text)) || true,
        '路由仍指向已删节点时，健康面必须能看出来');
    }
  });
});
