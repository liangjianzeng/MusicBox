// V28 · 上线面安全验收（一期 P0-3 门票）
// 断言源：docs/musicbox-rescue-refactor-plan.md §4 P0-3「默认值 fail-closed：
//         生产缺关键配置必须非零退出；日志不得出现明文凭据；登录限流；管理员令牌过期」
// 实现源：src/server/core/security.js audit()/assertBootable()、src/server/index.js:234、src/server/api/admin.js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const H = require('./helpers.js');

const SERVER = path.join(H.ROOT, 'src', 'server', 'index.js');
const PROD_PASS = 'V28-Prod-Pass-9f3a'; // 只用于"日志里绝不能出现它"的探针
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function httpJson(method, url, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = String(data.length); }
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs || 4000 },
      (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保留 text */ }
        resolve({ status: res.statusCode, text, json });
      }); });
    req.on('error', (e) => resolve({ status: 0, text: String(e.message), json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout', json: null }); });
    if (data) req.write(data);
    req.end();
  });
}
// 起一个"真进程"服（不是 H.boot），以便拿到退出码与完整日志
function bootProd(extra) {
  return new Promise(async (resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v28-'));
    const port = await freePort();
    const env = Object.assign({}, process.env, {
      MB_VAR_ROOT: dir, MB_VAR_DIR: dir, MB_PORT: String(port), MB_ENV: 'prod',
      MB_DEV_OTP: '0', MB_MV_ENABLED: '0',
      MB_EXECUTOR_TOKEN: 'v28-exec-token', MB_ADMIN_USERNAME: 'v28admin', MB_ADMIN_PASSWORD: PROD_PASS,
      MB_PUBLIC_BASE_URL: 'http://127.0.0.1:' + port,
    }, extra || {});
    const child = spawn(process.execPath, [SERVER], { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const done = {};
    child.on('exit', (code) => { done.code = code; done.log = () => log; done.dir = dir; done.port = port; resolve(done); });
    let health = 0;
    for (let i = 0; i < 45 && done.code === undefined; i++) {
      await sleep(300);
      const r = await httpJson('GET', 'http://127.0.0.1:' + port + '/healthz');
      if (r.status === 200) { done.health = r; done.code = null; done.log = () => log; done.dir = dir; done.port = port; done.child = child; return resolve(done); }
    }
    try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
    done.log = () => log; done.dir = dir; done.port = port;
    resolve(done);
  });
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 已清理 */ } };

describe('V28 上线面安全（P0-3 门票）', () => {
  it('V28-① MB_ENV=prod 缺关键配置必须拒绝启动并以非零码退出（不是"警告后照常服务"）', async () => {
    const missing = [
      { env: { MB_EXECUTOR_TOKEN: '' }, key: 'MB_EXECUTOR_TOKEN' },
      { env: { MB_ADMIN_PASSWORD: '' }, key: 'MB_ADMIN_PASSWORD' },
      { env: { MB_PUBLIC_BASE_URL: '' }, key: 'MB_PUBLIC_BASE_URL' },
      { env: { MB_DEV_OTP: '1' }, key: 'MB_DEV_OTP' },
    ];
    for (const c of missing) {
      const r = await bootProd(c.env);
      assert.ok(typeof r.code === 'number' && r.code !== 0,
        `缺 ${c.key} 时 prod 必须非零退出，实际退出码=${r.code}；日志尾部：\n` + String(r.log()).slice(-400));
      const log = r.log();
      assert.ok(log.includes(c.key), `拒绝启动时必须点名缺哪个配置键（${c.key}），否则运维无从下手。日志：\n` + log.slice(-400));
      assert.match(log, /拒绝启动|MB_ENV=prod/, '日志要说明是 prod fail-closed，而不是别的崩溃');
      if (r.child) { try { r.child.kill('SIGKILL'); } catch (e) { /* noop */ } }
      clean(r.dir);
    }
  });

  it('V28-② prod 配齐后必须真能起服并处理请求（fail-closed 不得顺手把正常路径也闸死）', async () => {
    const r = await bootProd();
    try {
      assert.strictEqual(r.code, null, '配齐后应能起服。日志尾部：\n' + String(r.log()).slice(-500));
      assert.strictEqual(r.health.status, 200);
      const g = await httpJson('POST', 'http://127.0.0.1:' + r.port + '/v1/auth/guest', { device_key: 'v28-probe-' + Date.now() });
      assert.strictEqual(g.status, 200, 'prod 下访客仍可注册：' + g.status + ' ' + g.text);
      // prod 不得保留开发后门：固定验证码路径必须不可用
      const req0 = await httpJson('POST', 'http://127.0.0.1:' + r.port + '/v1/auth/phone/request-code', { phone: '13800000001' });
      const otp = await httpJson('POST', 'http://127.0.0.1:' + r.port + '/v1/auth/phone/verify', { phone: '13800000001', code: '888888' });
      if (otp.status === 200) assert.fail('prod 下固定验证码竟可通过（MB_DEV_OTP=0 未真正生效）；request-code 先返回 ' + req0.status);
      assert.ok([400, 401, 404].includes(otp.status), '验证码登录在 prod 下应被拒绝，实际 ' + otp.status + ' ' + otp.text);
    } finally {
      if (r.child) { try { r.child.kill('SIGKILL'); } catch (e) { /* noop */ } }
      clean(r.dir);
    }
  });

  it('V28-③ 任何模式下日志与错误响应都不得出现明文凭据（含 prod 显式配置的口令本身）', async () => {
    const r = await bootProd();
    try {
      const log = String(r.log());
      for (const secret of [PROD_PASS, 'admin1234', '888888', 'v28-exec-token']) {
        assert.ok(!log.includes(secret), `日志泄露明文凭据（${secret.slice(0, 3)}…）—— 曾因此被判 P0：\n` + log.slice(-400));
      }
      assert.match(log, /MB_ADMIN_PASSWORD|安全|security|开发模式|拒绝启动|listening|启动|started|http/i,
        '日志要有可诊断的启动信息（去掉明文不等于去掉信息）');
    } finally {
      if (r.child) { try { r.child.kill('SIGKILL'); } catch (e) { /* noop */ } }
      clean(r.dir);
    }
  });

  it('V28-④ 管理员登录必须限流，且失败尝试进审计但不含口令', async () => {
    const S = await H.boot('V28rate', { noFakeExecutor: true });
    try {
      let codes = [];
      for (let i = 0; i < 14; i++) {
        const r = await S.api('POST', '/admin/login', { json: { username: 'admin', password: 'wrong-' + i } });
        codes.push(r.status);
      }
      assert.ok(codes.includes(429), '连续错口令必须触发限流 429，实际状态序列：' + codes.join(','));
      const limited = await S.api('POST', '/admin/login', { json: { username: 'admin', password: 'wrong-final' } });
      assert.strictEqual(limited.status, 429, '限流窗口内后续尝试仍应 429，实际 ' + limited.status);
      const fails = S.db.all("SELECT COUNT(*) n FROM audit WHERE kind='admin.login_failed'")[0].n;
      assert.ok(fails >= 1, '失败的登录尝试必须留审计（用于发现撞库），实际 ' + fails + ' 条');
      const objs = S.db.all("SELECT obj FROM audit WHERE kind='admin.login_failed'");
      for (const o of objs) {
        const s = String(o.obj);
        assert.ok(!/wrong-|admin1234|password_hash/i.test(s), '审计里不得出现口令或其散列：' + s.slice(0, 140));
      }
    } finally { await S.close(); }
  });

  it('V28-⑤ 管理员令牌必须有有效期，过期后立即失效（此前永不过期是 P0）', async () => {
    const S = await H.boot('V28tok', { noFakeExecutor: true });
    try {
      const ok = await S.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
      assert.strictEqual(ok.status, 200, 'dev 默认口令应可登录：' + ok.status + ' ' + ok.text);
      const tok = ok.json.token;
      assert.ok(ok.json.expire_at && Date.parse(ok.json.expire_at) > Date.now(), '响应必须带 expire_at 且在未来');
      const ttl = (Date.parse(ok.json.expire_at) - Date.now()) / 3600000;
      assert.ok(ttl > 0 && ttl <= 12.1, '令牌有效期应 ≤12h，实际 ' + ttl.toFixed(2) + 'h');
      const before = await S.api('GET', '/admin/users', { headers: { authorization: 'Bearer ' + tok } });
      assert.strictEqual(before.status, 200, '未过期令牌应可用：' + before.status);
      // 白盒把有效期改到过去 → 必须立即失效
      const db = H.openWhiteDb(S.dbPath);
      try {
        db.exec('PRAGMA busy_timeout=8000;');
        const n = db.prepare("UPDATE admins SET token_expire_at=? WHERE token=?").run('2000-01-01T00:00:00.000Z', tok).changes;
        assert.strictEqual(n, 1, '白盒应命中该令牌行（否则本用例失去意义）');
      } finally { try { db.close(); } catch (e) { /* noop */ } }
      await sleep(60);
      const after = await S.api('GET', '/admin/users', { headers: { authorization: 'Bearer ' + tok } });
      assert.strictEqual(after.status, 401, '过期令牌必须 401，实际 ' + after.status);
    } finally { await S.close(); }
  });
});
