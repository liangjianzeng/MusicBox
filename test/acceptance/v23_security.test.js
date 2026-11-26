// V23 · 安全与越权回归（2026-11-26 抢救 P0 的守卫套件）
// 断言源：docs/musicbox-rescue-refactor-plan.md §2.1（三条默认后门）/§2.2（越权与路径穿越）
//         docs/runbook-dev.md §7「上线前必做」
// 纪律：本套件只碰 var-test，不依赖 fake executor（opts.noFakeExecutor），不做跨用例状态共享。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers.js');

let S; // 主实例（开 MB_DEV_OTP=1，用于「显式开发态仍可用」与越权断言）

// 白盒写库：必须带 busy_timeout（历史 P1：helpers 的白盒连接没设 → database is locked flake）
function writeDb(dbPath, fn) {
  const db = H.openWhiteDb(dbPath);
  try {
    db.exec('PRAGMA busy_timeout=5000;');
    return fn(db);
  } finally { try { db.close(); } catch (e) { /* noop */ } }
}

function insertWork(dbPath, { id, userId, audioMaster }) {
  return writeDb(dbPath, (db) => {
    db.prepare('DELETE FROM works WHERE id=?').run(id);
    db.prepare('INSERT INTO works(id,user_id,title,visibility,audio_master,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, userId, 'V23 探针', 'private', audioMaster, new Date().toISOString());
    return true;
  });
}

describe('V23 安全与越权回归', () => {
  before(async () => {
    // 关掉内置假执行器：本套件需要自己控制租约归属，不能被内置执行器抢单
    S = await H.boot('V23', { noFakeExecutor: true });
  });
  after(async () => { if (S) await S.close(); });

  it('V23-① 未显式开 MB_DEV_OTP 时，固定验证码 888888 不得登录（抢救前：默认恒可用）', async () => {
    const S2 = await H.boot('V23-noOtp', { env: { MB_DEV_OTP: '0', DEV_OTP: '0' }, noFakeExecutor: true });
    try {
      const phone = '139' + String(Date.now()).slice(-8);
      const sent = await S2.api('POST', '/v1/auth/phone/request-code', { json: { phone } });
      assert.strictEqual(sent.status, 200, 'V23-① 取码应 200，实际 ' + sent.status + ' ' + sent.text.slice(0, 120));
      const r = await S2.api('POST', '/v1/auth/phone/verify', { json: { phone, code: H.DEV_OTP } });
      assert.ok(!r.ok, 'V23-① MB_DEV_OTP=0 时固定验证码 888888 必须被拒，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.ok(!(r.json && r.json.access_token), 'V23-① 被拒的响应不得下发 access_token');
      assert.strictEqual(r.json && r.json.code, 'BAD_REQUEST', 'V23-① 应返回 BAD_REQUEST，实际 ' + r.text.slice(0, 120));
    } finally { await S2.close(); }
  });

  it('V23-② MB_ENV=prod 且缺安全配置 → 拒绝启动（退出码 2）且日志不含任何明文凭据', () => {
    const varDir = path.join(os.tmpdir(), 'musicbox-v23-prod-' + process.pid + '-' + Date.now());
    const r = spawnSync(process.execPath, ['src/server/index.js'], {
      cwd: H.ROOT,
      env: Object.assign({}, process.env, {
        MB_ENV: 'prod', MB_PORT: '0', MB_VAR_ROOT: varDir, NODE_NO_WARNINGS: '1',
        MB_ADMIN_USERNAME: '', MB_ADMIN_PASSWORD: '', MB_EXECUTOR_TOKEN: '', MB_DEV_OTP: '',
      }),
      encoding: 'utf8', timeout: 20000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.strictEqual(r.status, 2, 'V23-② prod 缺配置应退出码 2（区别于普通崩溃 1），实际 ' + r.status + '\n' + out.slice(0, 600));
    assert.match(out, /拒绝启动/, 'V23-② 应打印拒绝启动原因，实际日志：' + out.slice(0, 400));
    for (const secret of ['admin1234', '888888', 'dev-executor-token']) {
      assert.ok(out.indexOf(secret) < 0, 'V23-② 启动日志不得出现明文凭据「' + secret + '」');
    }
    fs.rmSync(varDir, { recursive: true, force: true });
  });

  it('V23-③ DSP params.srcs：穿越/绝对路径/他人产物三类全拒，本人产物放行（抢救前可读 /etc/passwd）', async () => {
    const g = await S.newGuest();
    const uid = g.user.id;
    insertWork(S.dbPath, { id: 'w_v23_own', userId: uid, audioMaster: 'mine.wav' });
    insertWork(S.dbPath, { id: 'w_v23_other', userId: 'u_not_me_v23', audioMaster: 'theirs.wav' });

    const dsp = (workId, src) => S.api('POST', '/v1/works/' + workId + '/dsp',
      { token: g.token, json: { op: 'trim', params: { srcs: [src], sec: 5 } } });

    const hostile = [
      ['../../../../../../etc/passwd', '相对穿越'],
      ['/etc/passwd', '绝对路径'],
      ['http://127.0.0.1:1/f/../../../../etc/passwd', '伪造 /f/ URL 夹带穿越'],
      ['..\\..\\windows\\win.ini', '反斜杠变体'],
    ];
    for (const [src, why] of hostile) {
      const r = await dsp('w_v23_own', src);
      assert.strictEqual(r.status, 400, 'V23-③ ' + why + ' 应 400 拒绝，实际 ' + r.status + ' ' + r.text.slice(0, 160));
      assert.strictEqual(r.json && r.json.code, 'BAD_REQUEST', 'V23-③ ' + why + ' 应 BAD_REQUEST，实际 ' + r.text.slice(0, 160));
    }
    const other = await dsp('w_v23_own', 'theirs.wav'); // 库里属于别人的产物文件名
    assert.strictEqual(other.status, 400, 'V23-③ 引用他人产物应 400，实际 ' + other.status + ' ' + other.text.slice(0, 160));
    assert.match(other.text, /不属于当前用户|不存在/, 'V23-③ 他人产物应给「不存在/不属于当前用户」口径，实际 ' + other.text.slice(0, 160));

    const mine = await dsp('w_v23_own', 'mine.wav');
    assert.strictEqual(mine.status, 202, 'V23-③ 本人产物应正常受理（校验不得过紧致功能回归），实际 ' + mine.status + ' ' + mine.text.slice(0, 200));
    assert.ok(mine.json && mine.json.job_id, 'V23-③ 应返回 job_id，实际 ' + mine.text.slice(0, 200));
  });

  it('V23-④ 执行器租约归属：不带/冒充 executor_id 一律 403，正主可操作（抢救前不带即绕过）', async () => {
    const g = await S.newGuest();
    const gen = await S.api('POST', '/v1/works/generate', {
      token: g.token, json: { mode: 'simple', prompt: H.uniq('v23'), sec: 15, count: 1 },
    });
    assert.strictEqual(gen.status, 202, 'V23-④ generate 应 202，实际 ' + gen.status + ' ' + gen.text.slice(0, 200));

    await S.api('POST', '/executor/register', { executorToken: H.EXECUTOR_TOKEN, json: { lanes: ['music'], version: 'v23' } });
    const poll = await S.api('POST', '/executor/poll', {
      executorToken: H.EXECUTOR_TOKEN, json: { lanes: ['music'], executor_id: 'ex_v23_owner' }, timeoutMs: 35000,
    });
    const job = poll.json && poll.json.job;
    assert.ok(job && job.id, 'V23-④ 应能领到 music job，实际 ' + poll.status + ' ' + poll.text.slice(0, 200));

    const noId = await S.api('POST', '/executor/jobs/' + job.id + '/progress', { executorToken: H.EXECUTOR_TOKEN, json: { progress: 50 } });
    assert.strictEqual(noId.status, 403, 'V23-④ 不带 executor_id 必须 403（此前可绕过归属校验），实际 ' + noId.status + ' ' + noId.text.slice(0, 160));

    const spoof = await S.api('POST', '/executor/jobs/' + job.id + '/fail', {
      executorToken: H.EXECUTOR_TOKEN, json: { executor_id: 'ex_attacker', code: 'X', message: 'x' },
    });
    assert.strictEqual(spoof.status, 403, 'V23-④ 冒充他人执行器必须 403，实际 ' + spoof.status + ' ' + spoof.text.slice(0, 160));

    const owner = await S.api('POST', '/executor/jobs/' + job.id + '/progress', {
      executorToken: H.EXECUTOR_TOKEN, json: { executor_id: 'ex_v23_owner', progress: 50 },
    });
    assert.ok(owner.ok, 'V23-④ 正主执行器应可上报进度，实际 ' + owner.status + ' ' + owner.text.slice(0, 160));
  });

  it('V23-⑤ 管理员：scrypt 加盐落库、令牌带过期、登录限流生效（抢救前：无盐 sha256/永不过期/无限流/明文入日志）', async () => {
    const ok = await S.api('POST', '/admin/login', { json: { username: 'admin', password: 'admin1234' } });
    assert.strictEqual(ok.status, 200, 'V23-⑤ 默认口令在 dev 下仍可登录，实际 ' + ok.status + ' ' + ok.text.slice(0, 160));
    assert.ok(ok.json && ok.json.token, 'V23-⑤ 应下发 token');
    assert.ok(ok.json.expire_at && Date.parse(ok.json.expire_at) > Date.now(), 'V23-⑤ 应答应带 expire_at（此前永不过期），实际 ' + ok.text.slice(0, 160));

    const rows = S.db.all('SELECT password_hash, token, token_expire_at FROM admins WHERE username=?', 'admin');
    assert.ok(rows.length, 'V23-⑤ admins 表应有种子管理员');
    assert.match(rows[0].password_hash, /^scrypt\$\d+\$\d+\$\d+\$/, 'V23-⑤ 口令必须 scrypt 加盐存储，实际前缀：' + String(rows[0].password_hash).slice(0, 24));
    assert.ok(rows[0].token_expire_at && Date.parse(rows[0].token_expire_at) > Date.now(), 'V23-⑤ 令牌必须带过期时间，实际 ' + rows[0].token_expire_at);

    let limited = null;
    for (let i = 0; i < 16 && !limited; i++) {
      const bad = await S.api('POST', '/admin/login', { json: { username: 'admin', password: 'wrong-password-' + i } });
      if (bad.status === 429) limited = bad;
    }
    assert.ok(limited, 'V23-⑤ 连续错口令应触发限流（RATE_LIMITED/429）');
    assert.strictEqual(limited.json && limited.json.code, 'RATE_LIMITED', 'V23-⑤ 限流错误码应为 RATE_LIMITED，实际 ' + limited.text.slice(0, 160));
  });

  it('V23-⑥ 口令散列原语：加盐随机、可校验、兼容历史无盐行（core/security 纯函数）', () => {
    const SEC = require('../../src/server/core/security.js');
    const a = SEC.hashPassword('p@ssw0rd');
    const b = SEC.hashPassword('p@ssw0rd');
    assert.notStrictEqual(a, b, 'V23-⑥ 同口令两次哈希必须不同（有盐）');
    assert.ok(SEC.verifyPassword('p@ssw0rd', a) && SEC.verifyPassword('p@ssw0rd', b), 'V23-⑥ 正确口令应校验通过');
    assert.ok(!SEC.verifyPassword('wrong', a), 'V23-⑥ 错误口令应校验失败');
    const legacy = require('node:crypto').createHash('sha256').update('p@ssw0rd').digest('hex');
    assert.ok(SEC.isLegacyHash(legacy), 'V23-⑥ 无盐 sha256 行应识别为 legacy');
    assert.ok(SEC.verifyPassword('p@ssw0rd', legacy), 'V23-⑥ 迁移期必须仍能校验历史无盐行（否则老库管理员全锁死）');
    assert.ok(!SEC.verifyPassword('p@ssw0rd', ''), 'V23-⑥ 空散列不得通过');
  });
});
