// V26 · 迁移收口与 SQL 列名对账（抢救计划 P1-5 门票）
// 断言源：docs/musicbox-rescue-refactor-plan.md §4 P1-5「幂等 ALTER（先查 pragma table_info）+
//         "任意历史库升级到最新并起服"演练用例」
// 另加一条本机自造的防线：本轮真机排障发现代码里写了 `job.lease_until`（真实列是 lease_expire_at），
// 异常被 catch{} 吞掉导致审计静默不落 —— 列名拼错必须由闸门抓住，不能靠人肉读码。
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');
const H = require('./helpers.js');

const ROOT = H.ROOT;
const STORE = path.join(ROOT, 'src', 'server', 'core', 'store.js');
const SERVER = path.join(ROOT, 'src', 'server', 'index.js');

function nodeIn(code, varRoot) {
  return spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { MB_VAR_ROOT: varRoot, MB_VAR_DIR: varRoot }),
    encoding: 'utf8',
    timeout: 120000,
  });
}
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mb-v26-'));
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs || 3000 }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}
function latestVersion() {
  const r = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();' +
    'process.stdout.write(String(st.get("SELECT version FROM schema_version").version));', mkTmp());
  assert.strictEqual(r.status, 0, '取最新版本号失败：' + r.stderr);
  return Number(r.stdout);
}

describe('V26 迁移收口与 SQL 列名对账', () => {
  it('V26-① 历史库（只升到 v3）能被最新代码升级并真正起服可用', async () => {
    const dir = mkTmp();
    // 第 1 步：独立进程造"历史库"（只跑前 3 个迁移）
    const a = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.initTo(3);' +
      'const v=st.get("SELECT version FROM schema_version").version;' +
      'const n=st.get("SELECT COUNT(*) n FROM sqlite_master WHERE type=\'table\'").n;' +
      'process.stdout.write(JSON.stringify({v,n}));', dir);
    assert.strictEqual(a.status, 0, '造历史库失败：' + a.stderr);
    const old = JSON.parse(a.stdout);
    assert.strictEqual(old.v, 3, '历史库应停在 v3，实际 ' + old.v);

    // 第 2 步：用最新代码起服（新进程）指向该库 —— 升级必须在启动路径里自动完成
    const port = await freePort(); // 不能用固定端口：撞车时会读到别人的 server，把失败判成通过
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        MB_VAR_ROOT: dir, MB_VAR_DIR: dir, MB_PORT: String(port), MB_ENV: 'dev', MB_DEV_OTP: '1', MB_MV_ENABLED: '0',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    try {
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) { await sleep(400); ok = (await httpGet('http://127.0.0.1:' + port + '/healthz')).status === 200; }
      assert.ok(ok, '历史库升级后必须能起服（/healthz 200）。日志尾部：\n' + log.slice(-500));

      // 第 3 步：升级后的库必须真能用（不只是能连）
      const g = await new Promise((resolve) => {
        const body = '{}';
        const req = http.request('http://127.0.0.1:' + port + '/v1/auth/guest', {
          method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 5000,
        }, (res) => { const cs = []; res.on('data', (c) => cs.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString('utf8') })); });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.end(body);
      });
      assert.strictEqual(g.status, 200, '升级后的库必须能签发访客：' + g.status + ' ' + g.body);
      assert.match(g.body, /access_token/, '访客响应应含 access_token');
      // 交叉验证：这条访客必须落在**本用例的 var 目录**里 —— 防止端口撞车时读到别人的 server（假通过）
      const chk = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();' +
        'process.stdout.write(String(st.get("SELECT COUNT(*) n FROM users").n));', dir);
      assert.strictEqual(Number(chk.stdout) >= 1, true,
        '访客必须写进本用例的库（否则说明应答来自别的进程）：users=' + chk.stdout);
    } finally {
      try { child.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
    }

    // 第 4 步：schema 必须已到最新版且关键表齐备
    const c = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();' +
      'const v=st.get("SELECT version FROM schema_version").version;' +
      'const ts=st.all("SELECT name FROM sqlite_master WHERE type=\'table\'").map(r=>r.name);' +
      'process.stdout.write(JSON.stringify({v,ts}));', dir);
    assert.strictEqual(c.status, 0, '复核 schema 失败：' + c.stderr);
    const after = JSON.parse(c.stdout);
    assert.strictEqual(after.v, latestVersion(), '升级后 schema_version 必须等于最新版本，实际 ' + after.v);
    for (const t of ['jobs', 'credit_ledger', 'works', 'candidates', 'audit', 'users']) {
      assert.ok(after.ts.includes(t), '升级后关键表缺失：' + t);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('V26-② 半成品库（表已在、版本记账落后）重放迁移不得抛错，且重复语句被容忍跳过', () => {
    const dir = mkTmp();
    // 先建最新库
    let r = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();process.stdout.write("ok");', dir);
    assert.strictEqual(r.status, 0, '建最新库失败：' + r.stderr);
    // 再把版本记账打回 v1，模拟"表已存在但迁移要整段重跑"的半成品库（旧实现在这里 duplicate column 直接崩）
    r = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();st.run("UPDATE schema_version SET version=1");process.stdout.write("ok");', dir);
    assert.strictEqual(r.status, 0, '打回版本失败：' + r.stderr);
    // 新进程重新打开：必须不抛错，且确实跳过了重复语句
    r = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();' +
      'process.stdout.write(JSON.stringify({v:st.get("SELECT version FROM schema_version").version,skips:st.getMigrationSkips()}));', dir);
    assert.strictEqual(r.status, 0, '半成品库重放迁移不得抛错，实际 stderr：\n' + String(r.stderr).slice(-600));
    const j = JSON.parse(r.stdout);
    assert.strictEqual(j.v, latestVersion(), '重放后版本必须到最新');
    assert.ok(j.skips > 0, '重复的 CREATE/ALTER 必须被容忍跳过（skips>0），实际 ' + j.skips + ' —— 为 0 说明幂等路径没被走到，用例失去意义');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('V26-③ 代码里 UPDATE <表> SET 的列名必须真实存在（防 lease_until 类拼写错静默失效）', () => {
    const dir = mkTmp();
    const r = nodeIn('const st=require(' + JSON.stringify(STORE) + ');st.init();' +
      'const ts=st.all("SELECT name FROM sqlite_master WHERE type=\'table\'").map(x=>x.name);' +
      'const out={};for(const t of ts) out[t]=st.all("PRAGMA table_info("+t+")").map(c=>c.name);' +
      'process.stdout.write(JSON.stringify(out));', dir);
    assert.strictEqual(r.status, 0, '取 schema 失败：' + r.stderr);
    const cols = JSON.parse(r.stdout);
    fs.rmSync(dir, { recursive: true, force: true });

    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p);
      }
    })(path.join(ROOT, 'src', 'server'));

    const bad = [];
    let checked = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([^"'`;]*?)\s+WHERE/gi;
      let m;
      while ((m = re.exec(src))) {
        const table = m[1];
        if (!cols[table]) continue; // 表不存在交给其它用例管
        for (const asg of m[2].split(',')) {
          const name = (asg.split('=')[0] || '').trim();
          if (!/^[a-z_][a-z0-9_]*$/i.test(name)) continue; // 表达式/子查询不参与对账
          if (/^(MAX|MIN|COALESCE|julianday|strftime)$/i.test(name)) continue;
          checked++;
          if (!cols[table].includes(name)) bad.push(path.relative(ROOT, f) + ' → UPDATE ' + table + ' SET ' + name);
        }
      }
    }
    assert.ok(checked >= 20, '对账覆盖过少（只核了 ' + checked + ' 个列名），说明正则没抓到东西，用例失去意义');
    assert.deepStrictEqual(bad, [], '存在不存在的列名（这类错误会被 catch 吞掉或运行期才炸）：\n' + bad.join('\n'));
  });
});
