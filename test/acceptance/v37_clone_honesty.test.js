// V37 · 克隆不许说谎 + 强度唯一真源 + 身份可自助恢复（契约 v5.6.0 / v5.3.0）
//
// 现场（2026-11-27 小米13 真机）：
//   1) 人格生成选了「悲伤 · 候选1」，服务端 cover 变声**失败**（meta.clone.stage2_error=MUSIC_HTTP），
//      但 `meta.clone.applied` 仍是 true —— 用户以为拿到自己的声线，其实拿到的是默认音色。
//   2) cover_strength（唯一能锁住音色/性别的旋钮）在服务端/执行器被硬编码成 0.2 共三处，
//      用户想锁音色也锁不住；App 连调的地方都没有。
//   3) 老作品 tags 被按空格切碎（`female,vocal` / `vinyl,crackle`），曲库显示成两个词，
//      引擎收到的也是两个残缺词。
//   4) 游客号换机/重装后无人能恢复，最后靠运维手工 UPDATE guest_key 救回来 —— 那不该是产品机制。
//
// 判词纪律：**不硬编码数值/文案**，能从源码读的就读源码；UI 只验"语义接线"（引用了哪个 getter），
// 不验中文措辞，免得改个标点就把闸门弄红、逼人把判词注释掉。
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers.js');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
// 判词只审**代码**，不审注释：解释"以前硬编码 0.2"的说明注释是资产，不该把闸门弄红。
// （判词一旦能被注释弄红，下一个改代码的人就会去删注释 —— 那是判词自己在制造无知。）
const code = (p) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/([^:'"])\/\/[^'"\n]*$/gm, '$1');

let S;
const mint = (body, token) =>
  S.api('POST', '/v1/auth/guest', { json: body, token });
const userCount = () => S.db.all('SELECT COUNT(*) AS n FROM users')[0].n;

describe('V37 克隆诚实性 / 强度唯一真源 / 身份可恢复（v5.6.0）', () => {
  before(async () => { S = await H.boot('V37', { noFakeExecutor: true }); });
  after(async () => { if (S) await S.close(); });

  // ---------- ① 执行器：没套上就不许说"已克隆" ----------
  it('V37-① meta.clone.applied 只允许在成品被变声版替换之后置真', () => {
    const src = code('src/executor/lanes/music.js');
    assert.ok(!/applied:\s*true/.test(src),
      'V37-① 对象字面量里不许出现 applied:true —— 在发起 cover 之前就写 true，失败时它就是谎话（真机 2026-11-27）');
    const trues = src.match(/meta\.clone\.applied\s*=\s*true/g) || [];
    assert.strictEqual(trues.length, 1,
      'V37-① 全文件必须**恰好一处**把 applied 置真（置真的位置就是"说谎与否"的唯一闸门）');
    const idxTrue = src.indexOf('meta.clone.applied = true');
    const idxRename = src.indexOf('renameSync(coverAbs');
    assert.ok(idxRename > 0, 'V37-① 找不到变声成品替换动作 renameSync(coverAbs…) —— 结构变了，判词得跟着改');
    assert.ok(idxTrue > idxRename,
      'V37-① applied 置真必须发生在成品替换**之后**（在此之前置真=还没成功就宣布成功）');
    assert.ok(/meta\.clone\.stage2_failed\s*=\s*true/.test(src),
      'V37-① 失败分支必须显式 stage2_failed=true，端侧才有东西可展示');
    assert.ok(!/cover_strength[^;\n]*\|\|\s*0?\.\d+/.test(src),
      'V37-① 执行器不许自带 cover_strength 默认数（真源只有 config.persona）');
    // 契约 v5.6.10：变声失败必须留下可诊断面包屑 —— 跨机拓扑下 MUSIC_HTTP 绝大多数是
    // "引擎那台机器读不到这个路径"，本次真机就是靠执行器日志里的 ref_audio not found 才定位到。
    assert.ok(/meta\.clone\.ref_path\s*=/.test(src),
      'V37-① 失败分支必须把"引擎被要求读的声纹路径"落到 meta.clone.ref_path（契约 v5.6.10）');
    assert.ok(/meta\.clone\.engine\s*=/.test(src),
      'V37-① 失败分支必须把引擎地址落到 meta.clone.engine，否则每次都要翻执行器日志重查');
  });

  // ---------- ② cover_strength 只有一个真源 ----------
  it('V37-② 强度默认值的唯一真源 = config.persona，服务端/执行器/端侧都不许自带数字', () => {
    const cfg = require(path.join(SRC, 'server', 'config.js'));
    assert.ok(cfg.persona && Number.isFinite(Number(cfg.persona.defaultCoverStrength)),
      'V37-② config.persona.defaultCoverStrength 必须是有限数');
    assert.ok(cfg.persona.defaultCoverStrength >= cfg.persona.minCoverStrength &&
      cfg.persona.defaultCoverStrength <= cfg.persona.maxCoverStrength,
      'V37-② 默认值必须落在 [min,max] 内');

    const personas = code('src/server/api/personas.js');
    assert.ok(personas.includes('config.persona.defaultCoverStrength'),
      'V37-② 建人格时必须从 config.persona 取默认强度（曾经硬编码 0.2）');
    assert.ok(!/cover_strength:\s*0?\.\d+/.test(personas),
      'V37-② personas.js 里不许出现字面量强度默认值');

    const works = code('src/server/api/works.js');
    assert.ok(works.includes('config.persona.defaultCoverStrength') &&
      works.includes('config.persona.minCoverStrength') &&
      works.includes('config.persona.maxCoverStrength'),
      'V37-② generate 的强度必须"缺省走 config、给了就 clamp 到 [min,max]"');

    // 端侧不许有第二个真源：默认值必须由 /v1/app/config 下发，取不到就如实显示"没取到"
    const appcfg = code('src/server/api/appconfig.js');
    assert.ok(/persona\s*=\s*\{[\s\S]{0,200}default_cover_strength:\s*config\.persona\.defaultCoverStrength/.test(appcfg),
      'V37-② /v1/app/config 必须把 config.persona 的默认强度下发给端侧');
    const pro = code('src/app/lib/features/create/shell_pro.dart');
    assert.ok(!/coverStrength\s*\?\?\s*0?\.\d+/.test(pro),
      'V37-② App 不许写 `coverStrength ?? 0.6` 这类端侧默认（第二个真源：服务端一改，界面显示的和实际跑的就对不上）');
    assert.ok(pro.includes("'cover_strength'"),
      'V37-② App 选了人格必须能把强度带给服务端（否则用户没有锁音色的入口）');
    const rc = code('src/app/lib/core/state.dart');
    assert.ok(rc.includes('personaDefaultCoverStrength') && /return\s+null/.test(rc),
      'V37-② 端侧读不到下发值时要返回 null（宁可显示"没取到"，不许编数）');
  });

  // ---------- ③ 人格没套上，必须在揭晓页对用户说出来（语义接线，不验措辞） ----------
  it('V37-③ 端侧必须把"没套上"接到 UI 上，而不是只写进 meta 里自娱自乐', () => {
    const models = code('src/app/lib/core/models.dart');
    assert.ok(/bool get personaApplied/.test(models) && /bool get personaFailed/.test(models),
      'V37-③ Candidate 必须暴露 personaApplied / personaFailed（meta.clone 的语义入口）');
    assert.ok(models.includes("'clone'") && models.includes('stage2_failed'),
      'V37-③ 这两个 getter 必须真读 meta.clone（否则永远 false，等于没有）');
    const reveal = code('src/app/lib/features/create/reveal_page.dart');
    assert.ok(reveal.includes('personaFailed') && reveal.includes('personaFailReason'),
      'V37-③ 揭晓页必须引用 personaFailed/personaFailReason —— 只在 meta 里记录而界面不说，用户就会把默认音色当成自己的声线');
  });

  // ---------- ④ 谁来唱：三档都要能定性别 ----------
  it('V37-④ 简约档也必须能选"谁来唱"（性别是最贵的选择，不该只有高阶档配决定）', () => {
    const easy = code('src/app/lib/features/create/shell_easy.dart');
    assert.ok(easy.includes('genders'),
      'V37-④ 简约档必须出现性别选项（曾经只有标准/深度档能选）');
    assert.ok(/single:\s*true/.test(easy),
      'V37-④ 性别是单选 —— 多选等于把"女声+男声"两个互斥标签一起喂给模型');
    assert.ok(easy.includes('wireOf'),
      'V37-④ 必须走词典的中文→规范词（端侧不许另立词表）');
  });

  // ---------- ⑤ 老作品被切碎的 tags：一次性修复脚本 ----------
  it('V37-⑤ 修复脚本：只按词典精确重组、默认干跑、幂等、留审计', () => {
    const script = path.join(__dirname, '..', '..', 'scripts', 'repair_split_tags.mjs');
    const src = code('scripts/repair_split_tags.mjs');
    assert.ok(/require\(.*dictionary/.test(src),
      'V37-⑤ 词表必须从词典真源读（src/server/prompts/dictionary）');
    assert.ok(!/['"`][a-z]+ [a-z]+['"`]/.test(src),
      'V37-⑤ 代码里不许出现任何"带空格的规范词"字面量 —— 词表只能来自词典真源，否则词典一改脚本就成了第二个真源并开始漏修');
    assert.ok(/--apply/.test(src) && /APPLY\s*\?/.test(src) !== false,
      'V37-⑤ 必须显式 --apply 才写库');

    // 现场复现：一条被空格切碎的存量作品（逗号串，就是库里真实的存法）
    const db = new DatabaseSync(S.dbPath);
    db.prepare('INSERT INTO works(id,user_id,title,genres,status,created_at) VALUES(?,?,?,?,?,?)')
      .run('w_v37_split', 'u_v37', '切碎样本', 'female,vocal,saxophone,vinyl,crackle', 'done',
        new Date().toISOString());
    db.close();

    const run = (extra) => spawnSync(process.execPath,
      [script, S.dbPath].concat(extra || []), { encoding: 'utf8' });
    const g = () => new DatabaseSync(S.dbPath)
      .prepare('SELECT genres FROM works WHERE id=?').get('w_v37_split').genres;

    const dry = run([]);
    assert.strictEqual(dry.status, 0, '干跑必须成功：' + dry.stderr);
    assert.ok(/可修复/.test(dry.stdout) && /female,vocal/.test(g()),
      'V37-⑤ 默认必须**只打印不写库**（改数据这种事得让人先看一眼）');

    const apply = run(['--apply']);
    assert.strictEqual(apply.status, 0, '写库必须成功：' + apply.stderr);
    const after = g();
    assert.ok(after.includes('female vocal'), 'V37-⑤ 应重组出 female vocal，实际 ' + after);
    assert.ok(after.includes('vinyl crackle'), 'V37-⑤ 应重组出 vinyl crackle，实际 ' + after);
    assert.ok(!/(^|,)vocal(,|$)/.test(after) && !/(^|,)crackle(,|$)/.test(after),
      'V37-⑤ 碎词必须被合掉，且**按原逗号串格式写回**（顺手改成 JSON 会把读侧弄成空）');

    const again = run([]);
    assert.ok(/可修复（干跑，未写库） 0 条/.test(again.stdout),
      'V37-⑤ 必须幂等：修完再跑一次得是 0 改动，实际 ' + again.stdout);
    const audit = S.db.all("SELECT * FROM audit WHERE kind='tags.repair'");
    assert.ok(audit.length >= 1, 'V37-⑤ 改用户数据必须留审计（可追溯改了几条、谁改的）');
  });

  // ---------- ⑥ 身份可自助恢复：备份码 + 认领 ----------
  it('V37-⑥ 备份码只发一次、rotate 换码即作废旧码、认领换锚点并作废旧会话', async () => {
    const dev = 'a1'.repeat(16);
    const n0 = userCount();
    const r1 = await mint({ device_key: dev });
    assert.strictEqual(r1.status, 200, '建号应 200：' + r1.text.slice(0, 200));
    assert.strictEqual(r1.json.first_time, true, '首次必须是 first_time=true');
    const code = String(r1.json.recovery_code || '');
    assert.ok(code.replace(/-/g, '').length >= 12,
      'V37-⑥ 首次建号必须当场发备份码，否则游客号就是"重装即丢"的一次性身份：' + r1.text.slice(0, 200));
    assert.strictEqual(userCount(), n0 + 1, '一次 mint 只该建一个号');

    // 再 mint 一次（同锚点）不许把码再吐一遍 —— 恢复凭证不是配置项
    const r2 = await mint({ device_key: dev });
    assert.strictEqual(r2.json.first_time, false, '同锚点必须复用同一身份');
    assert.ok(!r2.json.recovery_code,
      'V37-⑥ 备份码只能回显一次；每次登录都吐码 = 把账号凭证挂在常驻响应里');

    // 未鉴权不许换码
    const rot0 = await S.api('POST', '/v1/auth/recovery/rotate', {});
    assert.strictEqual(rot0.status, 401, '未登录不许生成备份码，实际 ' + rot0.status);

    const rot = await S.api('POST', '/v1/auth/recovery/rotate', { token: r1.json.access_token });
    assert.strictEqual(rot.status, 200, 'rotate 应 200：' + rot.text.slice(0, 200));
    const code2 = String(rot.json.recovery_code || '');
    assert.ok(code2 && code2 !== code, 'V37-⑥ rotate 必须发新码');

    // 旧码当场作废
    const stale = await S.api('POST', '/v1/auth/claim',
      { json: { device_key: 'b2'.repeat(16), recovery_code: code } });
    assert.strictEqual(stale.status, 401,
      'V37-⑥ rotate 之后旧码必须当场失效（否则旧码泄漏=账号被接管），实际 ' + stale.status);

    // 乱码不许凭空建号/认领
    const n1 = userCount();
    const junk = await S.api('POST', '/v1/auth/claim',
      { json: { device_key: 'c3'.repeat(16), recovery_code: 'ZZZZ-ZZZZ-ZZZZ' } });
    assert.strictEqual(junk.status, 401, '备份码不对必须 401，实际 ' + junk.status);
    assert.strictEqual(userCount(), n1, 'V37-⑥ 认领失败绝不许顺手建号');

    const bad = await S.api('POST', '/v1/auth/claim',
      { json: { device_key: 'short', recovery_code: code2 } });
    assert.strictEqual(bad.status, 400, '缺 device_key/过短必须 400，实际 ' + bad.status);

    // 真认领：换一台设备（新 device_key）用备份码认回同一身份
    const newDev = 'd4'.repeat(16);
    const claimed = await S.api('POST', '/v1/auth/claim',
      { json: { device_key: newDev, recovery_code: code2 } });
    assert.strictEqual(claimed.status, 200, '正确备份码应认领成功：' + claimed.text.slice(0, 200));
    assert.strictEqual(claimed.json.recovered, true, '认领必须如实标 recovered');
    assert.strictEqual(claimed.json.user.id, r1.json.user.id,
      'V37-⑥ 认领回来的必须是**同一个身份**，否则作品还是找不回');

    // 旧设备的会话必须作废（丢掉的那台不该继续能调）
    const staleMe = await S.api('GET', '/v1/me', { token: r1.json.access_token });
    assert.strictEqual(staleMe.status, 401,
      'V37-⑥ 认领后旧 access_token 必须失效（真机语境：旧机器可能已丢失/被他人拿到），实际 ' + staleMe.status);

    // 新锚点从此就是这个身份：用新 device_key 走正常 guest 也应认回同一个人
    const back = await mint({ device_key: newDev });
    assert.strictEqual(back.json.user.id, r1.json.user.id,
      'V37-⑥ 认领后新锚点必须永久绑住该身份（重装后 guestLogin 就能直接认回）');
    assert.ok(S.db.all("SELECT * FROM audit WHERE kind='auth.claim'").length >= 1,
      'V37-⑥ 认领必须留审计：这是"谁在什么时候改走了账号"的唯一现场证据');
  });

  // ---------- ⑦⑧ 重装的真实顺序（判词曾经漏掉这条，被真机当场打脸） ----------
  // V37-⑥ 用的是两个"干净"的 device_key，于是永远撞不上真实场景：
  // 真机重装后 App 会**先**自动建一个临时游客号，用户这才想起输备份码 —— 本机锚点已被占用。
  it('V37-⑦ 本机已自动建号后，仍必须能用备份码认回老身份（曾经 500 撞 UNIQUE）', async () => {
    const oldDev = 'a9'.repeat(16);
    const old0 = await mint({ device_key: oldDev });
    assert.strictEqual(old0.status, 200, '建老身份应 200：' + old0.text.slice(0, 200));
    const code = String(old0.json.recovery_code || '');
    const oldId = old0.json.user.id;
    const w = new DatabaseSync(S.dbPath);
    w.prepare('INSERT INTO works(id,user_id,title,status,created_at) VALUES(?,?,?,?,?)')
      .run('w_v37_keep', oldId, '要保住的歌', 'done', new Date().toISOString());
    w.close();

    const newDev = 'b8'.repeat(16);
    const fresh = await mint({ device_key: newDev });
    assert.strictEqual(fresh.json.first_time, true, '重装首启应当新建临时身份');

    const c = await S.api('POST', '/v1/auth/claim',
      { json: { device_key: newDev, recovery_code: code } });
    assert.strictEqual(c.status, 200,
      'V37-⑦ 本机已有临时号时必须仍能认领。真机 2026-11-27 在这里 500' +
      '（UNIQUE users.guest_key）——恢复通道在最需要它的那一刻失灵：' + c.text.slice(0, 200));
    assert.strictEqual(c.json.user.id, oldId, 'V37-⑦ 必须认回原身份');

    const kept = S.db.all('SELECT id FROM works WHERE user_id=?', oldId).map((r) => r.id);
    assert.ok(kept.includes('w_v37_keep'), 'V37-⑦ 认领不许动用户内容：作品必须还在');

    const back = await mint({ device_key: newDev });
    assert.strictEqual(back.json.user.id, oldId,
      'V37-⑦ 认领后同一 device_key 只能认得这一个身份（临时号必须被摘锚）');
    assert.ok(S.db.all("SELECT * FROM audit WHERE kind='auth.claim_retire_placeholder'").length >= 1,
      'V37-⑦ 摘掉临时号锚点必须留审计');
    // 摘锚用"改键"而不是删行：积分流水等外键还指着那一行，删了会留孤儿账
    const retired = S.db.all("SELECT * FROM users WHERE guest_key LIKE 'retired-%'");
    assert.ok(retired.length >= 1, 'V37-⑦ 临时号应被摘锚退役（保留行，不毁账）');
  });

  it('V37-⑧ 本机临时号已经有作品时必须 403 停下，而不是静默毁掉内容', async () => {
    const oldDev = 'c7'.repeat(16);
    const old0 = await mint({ device_key: oldDev });
    const code = String(old0.json.recovery_code || '');
    const newDev = 'd6'.repeat(16);
    const fresh = await mint({ device_key: newDev });
    const w = new DatabaseSync(S.dbPath);
    w.prepare('INSERT INTO works(id,user_id,title,status,created_at) VALUES(?,?,?,?,?)')
      .run('w_v37_local', fresh.json.user.id, '本机已经写出来的歌', 'done', new Date().toISOString());
    w.close();

    const c = await S.api('POST', '/v1/auth/claim',
      { json: { device_key: newDev, recovery_code: code } });
    assert.strictEqual(c.status, 403,
      'V37-⑧ 本机号里有东西时必须拒绝顶替（毁数据换便利是不可接受的）：' + c.status + ' ' + c.text.slice(0, 200));
    assert.ok(/作品|绑定手机/.test(String((c.json || {}).message || '')),
      'V37-⑧ 拒绝必须说清原因和下一步，实际 ' + c.text.slice(0, 200));
    assert.ok(S.db.all('SELECT id FROM works WHERE user_id=?', fresh.json.user.id).length >= 1,
      'V37-⑧ 拒绝的同时本机内容一行都不许少');
  });

  // ---------- ⑨ 用户选的强度必须抵达引擎 ----------
  // V37-② 只钉住"默认值只有一个真源"，却漏了另一半：用户**改了**的值必须真的走到引擎。
  // 真机 2026-11-27 21:35：滑杆显示 100%，job payload 里却是 0.6 ——
  // /v1/works/generate 的字段白名单没放 cover_strength，用户的选择被静默丢掉（V31-③ 同一类缺陷）。
  it('V37-⑨ 深度档选的音色贴近程度必须抵达引擎 payload（不许被白名单静默丢掉）', async () => {
    const config = require('../../src/server/config');
    const me = await mint({ device_key: 'e3'.repeat(16) });
    assert.strictEqual(me.status, 200, '建测试身份应 200：' + me.text.slice(0, 160));
    const uid = me.json.user.id;
    const tok = me.json.access_token;
    // 测试充值走 helpers 的账本种子（维持 balance_after 链，别手改 balance）。
    // 必须先 GET /v1/credits 触发 ensureDaily：否则第一次派单时 daily_free 重置会把这里发的分
    // 当成"昨天的余额"清零重发，判词会莫名其妙卡在 CREDITS_NOT_ENOUGH。
    await S.api('GET', '/v1/credits', { token: tok });
    if (typeof S.seedLedger === 'function') S.seedLedger(uid, 600);
    const db = new DatabaseSync(S.dbPath);
    db.prepare('INSERT INTO personas(id,user_id,name,is_public,voice_ref,clone_params,created_at)'
      + ' VALUES(?,?,?,?,?,?,?)')
      .run('p_v37_strength', uid, '判词声线', 0, '2026-11/v37.wav', '{}', new Date().toISOString());
    db.close();

    const payloadOf = (jobId) => {
      const row = S.db.all('SELECT payload FROM jobs WHERE id=?', jobId)[0];
      assert.ok(row, '派单必须留下 job：' + jobId);
      return JSON.parse(row.payload);
    };
    const gen = async (extra, key) => {
      const r = await S.api('POST', '/v1/works/generate', {
        token: tok,
        json: Object.assign({ mode: 'simple', prompt: '判词', mood: '平静', count: 1, sec: 15,
          persona_id: 'p_v37_strength', idem_key: key }, extra || {}),
      });
      // 派单成功是 202（Accepted，异步任务），不是 200 —— 判词别把自己的期望写死成 200
      assert.ok(r.status === 200 || r.status === 202,
        '本人带人格派单应 200/202，实际 ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(r.json && r.json.job_id, '派单必须返回 job_id：' + r.text.slice(0, 200));
      // 只改强度也必须是一单新的活：幂等键漏了 cover_strength 时，拖完滑杆按生成会被旧 job 吃掉
      assert.notStrictEqual(r.json.idempotent, true,
        'V37-⑨ 改变强度/clone_mode 不得命中幂等旧单（否则滑杆等于没拖）：' + r.text.slice(0, 200));
      const p = payloadOf(r.json.job_id);
      assert.ok(p.persona, 'payload 必须带 persona：' + JSON.stringify(p).slice(0, 200));
      return p.persona;
    };

    const dflt = await gen({}, 'v37-st-default');
    assert.strictEqual(dflt.cover_strength, config.persona.defaultCoverStrength,
      'V37-⑨ 未选强度时必须等于 config.persona.defaultCoverStrength（唯一真源，判词不写死数字）');

    const max = await gen({ cover_strength: 1 }, 'v37-st-max');
    assert.strictEqual(max.cover_strength, 1,
      'V37-⑨ 用户把滑杆拉到 100% 时，payload 必须是 1 —— 真机在这里被静默丢成默认值');

    const mid = await gen({ cover_strength: 0.35 }, 'v37-st-mid');
    assert.strictEqual(mid.cover_strength, 0.35,
      'V37-⑨ 中间值也必须原样抵达，否则滑杆只是装饰');

    const over = await gen({ cover_strength: 9 }, 'v37-st-over');
    assert.strictEqual(over.cover_strength, config.persona.maxCoverStrength,
      'V37-⑨ 越界值必须被夹到 config.persona.maxCoverStrength（夹紧可以，丢弃不行）');

    const full = await gen({ clone_mode: 'full' }, 'v37-st-full');
    assert.strictEqual(full.clone_mode, 'full',
      'V37-⑨ clone_mode 同样必须过白名单，否则永远只能 fast');
  });

  // ---------- ⑩ 克隆诚实性的公开路径只有一个：meta.clone ----------
  // 真机 2026-11-27 21:36：数据是诚实的（raw.meta.clone.stage2_failed=true），但揭晓页什么都不显示 ——
  // 执行器把引擎回执整包塞在 raw.meta，端侧读的是 meta.clone，读不到就等于说谎。
  // V37-③ 只查了 reveal_page "引用了 personaFailed"，是条假判词：这里换成真的走一遍 API。
  it('V37-⑩ 揭晓页要读的 meta.clone 必须在 API 返回的根上（不许埋在 raw.meta 里）', async () => {
    const me = await mint({ device_key: 'f2'.repeat(16) });
    const uid = me.json.user.id;
    const tok = me.json.access_token;
    await S.api('GET', '/v1/credits', { token: tok });
    if (typeof S.seedLedger === 'function') S.seedLedger(uid, 300);
    const r = await S.api('POST', '/v1/works/generate', {
      token: tok,
      json: { mode: 'simple', prompt: '判词⑩', mood: '平静', count: 1, sec: 15, idem_key: 'v37-honesty-path' },
    });
    assert.ok(r.status === 200 || r.status === 202, '派单应 200/202，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    const jobId = r.json.job_id;

    // 灌入真机实测的那条形 meta：clone 只在 raw.meta 下面
    const lying = {
      seed: 152053, gen: null,
      raw: { seq: 1, seed: 152053, meta: { clone: { applied: false, attempted: true, stage2_failed: true, stage2_error: 'MUSIC_HTTP', cover_strength: 1, mode: 'fast' } } },
    };
    const db = new DatabaseSync(S.dbPath);
    let rows = db.prepare('SELECT id FROM candidates WHERE job_id=?').all(jobId);
    if (rows.length === 0) {
      // 本用例跑的是 noFakeExecutor：没有执行器落候选，就自己补一行（判词不依赖执行器在不在）
      db.prepare('INSERT INTO candidates(id,job_id,seq,title,duration_sec,format,meta,adopted,created_at)'
        + ' VALUES(?,?,?,?,?,?,?,?,?)')
        .run('c_v37_path', jobId, 1, '', 45, 'wav', '{}', 0, new Date().toISOString());
      rows = [{ id: 'c_v37_path' }];
    }
    db.close();
    const w2 = new DatabaseSync(S.dbPath);
    for (const row of rows) {
      w2.prepare('UPDATE candidates SET meta=? WHERE id=?').run(JSON.stringify(lying), row.id);
    }
    w2.close();

    const job = await S.api('GET', '/v1/jobs/' + jobId, { token: tok });
    assert.strictEqual(job.status, 200, '查任务应 200，实际 ' + job.status + ' ' + job.text.slice(0, 200));
    const cands = (job.json.candidates || []);
    assert.ok(cands.length >= 1, 'API 必须返回候选列表');
    for (const c of cands) {
      const clone = (c.meta || {}).clone;
      assert.ok(clone,
        'V37-⑩ 候选 meta 根上必须有 clone（端侧只认这一个路径；埋在 raw.meta 里 = 揭晓页永远不显示"没有套上"）');
      assert.strictEqual(clone.stage2_failed, true,
        'V37-⑩ 阶段②失败必须原样抵达端侧，实际 ' + JSON.stringify(clone));
      assert.strictEqual(clone.applied, false, 'V37-⑩ 没套上就必须说没套上，不许留空让端侧猜');
      assert.strictEqual(clone.cover_strength, 1, 'V37-⑩ 强度回执必须一并抵达（用户要能核对滑杆是不是白拖）');
    }
  });
});
