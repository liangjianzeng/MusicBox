// scripts/degradation_drill.mjs — N2-5 降级演练（2026-11-24；施工计划 §5 N2-5 / 架构 §11 降级演练）
// 风格仿 e2e_smoke：PASS/FAIL 行 + exit code 化。EXECUTOR_MOCK=1 自举 server+真实 executor（随机空闲端口）。
// 场景 A（lipsync lane 断供）：MB_MV_MOCK_FAIL_LIPSYNC=1 → 演唱镜 sync 不过 → 免费补样×2（credits_cost=0）→
//   shot locked + flags.degraded=broll_subtitle → 自动 compose 仍出片 → project ready（mv_lipsync 只扣 1 次 20⚡）。
// 场景 B（compose 首败）：MB_MV_MOCK_FAIL_COMPOSE_ONCE=1 → mv_compose 首次 fail → attempts 回队重试 → 最终 done，
//   全程白盒账本闭合 Σdelta==balance（若最终 fail 则必须全额 refund——同样由闭合断言兜住）。
// 纪律：mock-only；GPU/剧场端点全部指向不可达 127.0.0.1:9；严禁触 :8188/:8090。
// 用法：node scripts/degradation_drill.mjs   （全部 PASS → exit 0；任一 FAIL → exit 1）
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const H = require(path.join(ROOT, 'test', 'acceptance', 'helpers.js')); // 复用一期自举（boot/白盒/白盒 seed），不重复造轮子

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail).slice(0, 200) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  [' + String(detail).slice(0, 200) + ']' : ''}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEAD = 'http://127.0.0.1:9'; // 一切外部端点不可达（mock 纪律）

let execChild = null;
let execLog = '';
function startExecutor(envExtra, label) {
  return new Promise(async (resolve, reject) => {
    execLog = '';
    execChild = spawn(process.execPath, ['src/executor/index.js',
      '--api', S.baseUrl, '--token', H.EXECUTOR_TOKEN,
      '--lanes', 'music,intent,ffmpeg,imgspark,vidspark,lipsync,align'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        EXECUTOR_MOCK: '1',
        MB_VAR_DIR: S.varDir,
        MB_COMFY_URL: DEAD, MB_LIPSYNC_URL: DEAD, MB_FACEGATE_URL: DEAD, MB_MV_ASR_URL: DEAD,
        MB_MUSIC_URL: DEAD, MB_ASR_URL: DEAD, MB_LLM_VLM_URL: DEAD + '/v1',
        NODE_NO_WARNINGS: '1',
      }, envExtra || {}),
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    execChild.stdout.on('data', (c) => { const s = c.toString(); execLog += s; if (execLog.length > 80000) execLog = execLog.slice(-60000); process.stdout.write('[exec] ' + s); });
    execChild.stderr.on('data', (c) => { const s = c.toString(); execLog += s; if (execLog.length > 80000) execLog = execLog.slice(-60000); process.stdout.write('[exec] ' + s); });
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      if (execLog.includes('已接入调度')) return resolve();
      await sleep(200);
    }
    reject(new Error('executor ' + label + ' 25s 内未接入调度。日志尾部:\n' + execLog.slice(-1500)));
  });
}
async function stopExecutor() {
  if (!execChild) return;
  const c = execChild; execChild = null;
  const alive = () => c.exitCode === null && c.signalCode === null;
  try { c.kill('SIGINT'); } catch (e) { /* 已退出 */ }
  const t0 = Date.now();
  while (alive() && Date.now() - t0 < 4000) await sleep(100);
  if (alive()) {
    console.log('# executor SIGINT 未生效，SIGKILL 兜底');
    try { c.kill('SIGKILL'); } catch (e) { /* noop */ }
    const t1 = Date.now();
    while (alive() && Date.now() - t1 < 5000) await sleep(100);
  }
  await sleep(1200); // 等 server 侧观察到 socket 关闭（幽灵 poll 防线依赖 socket.destroyed）
  console.log('# executor 已退出 code=' + c.exitCode + ' sig=' + c.signalCode + '（用时 ' + (Date.now() - t0) + 'ms）');
}

// 走到「开机」：guest→充值→建项目→播镜→样片→报价→boot（复用 V13-⑪ 已验证的 API 路径）
async function bootProject({ vocal, shotKinds, grant = 1000 }) {
  const g = await S.newGuest();
  await S.credits(g.token); // 先落每日免费 50，再种子充值（防 daily_expire 吞种子）
  S.seedLedger(g.user.id, grant);
  const workId = S.seedWork(g.user.id, { lyrics: vocal ? '第一行歌词\n第二行歌词\n第三行歌词' : '' });
  const pr = await S.api('POST', '/v1/mv/projects', { token: g.token, json: { work_id: workId, character: { gender: 'f', source: 'ai' } } });
  if (pr.status !== 201) throw new Error('建项目失败 ' + pr.status + ' ' + pr.text.slice(0, 200));
  const pid = pr.json.project.id;
  const ids = [];
  for (let i = 1; i <= shotKinds.length; i++) ids.push(S.seedMvShot(pid, { seq: i, kind: shotKinds[i - 1], status: 'draft', sec: 4 }));
  const pv = await S.api('POST', '/v1/mv/projects/' + pid + '/preview', { token: g.token, json: {} });
  if (pv.status !== 202) throw new Error('preview 派单失败 ' + pv.status + ' ' + pv.text.slice(0, 200));
  await S.waitForJob(g.token, pv.json.job_id, { timeoutMs: 90000 });
  const got = await S.api('GET', '/v1/mv/projects/' + pid, { token: g.token });
  const estVer = got.json.project.est_ver;
  const b = await S.api('POST', '/v1/mv/projects/' + pid + '/boot', { token: g.token, json: { est_ver: estVer } });
  if (b.status !== 202) throw new Error('boot 失败 ' + b.status + ' ' + b.text.slice(0, 200));
  return { g, pid, shotIds: ids, shotJobs: b.json.jobs };
}
async function waitProject(pid, want, timeoutMs) {
  const t0 = Date.now();
  let row = null;
  while (Date.now() - t0 < timeoutMs) {
    row = S.db.mvProject(pid).row;
    if (row && row.status === want) return row;
    await sleep(300);
  }
  return row;
}
async function ledgerClosed(guest) {
  const led = S.db.ledgerRows(guest.user.id);
  if (led.error) return { ok: false, why: led.error };
  const sum = led.rows.reduce((a, x) => a + x.delta, 0);
  const bal = (await S.credits(guest.token)).balance;
  return { ok: sum === bal, sum, bal };
}

let S = null;
try {
  // —— 自举：server（helpers 随机空闲口）+ 真实 executor（EXECUTOR_MOCK=1，helpers 不启动内置 fake）——
  S = await H.boot('DRILL', { noFakeExecutor: true });
  console.log('# 演练环境：server=' + S.baseUrl + ' var=' + S.varDir + ' ffmpeg=' + (S.ffmpeg ? '有' : '无(字节桩)'));

  // ================= 场景 A：lipsync lane 断供 → B-roll+字幕降级接管 =================
  await startExecutor({ MB_MV_MOCK_FAIL_LIPSYNC: '1' }, 'A(lipsync断供)');
  {
    const { g, pid, shotIds } = await bootProject({ vocal: true, shotKinds: ['singing'] });
    const row = await waitProject(pid, 'ready', 150000);
    const shot = (S.db.mvShotsOf(pid).rows || [])[0] || {};
    check('A 演唱镜降级收口 locked', shot.status === 'locked', 'shot.status=' + shot.status);
    check('A flags.degraded=broll_subtitle 明示', String(shot.flags_json || '').includes('broll_subtitle'), shot.flags_json);
    check('A 免费补样恰好 2 次（rerolls=2）', Number(shot.rerolls) === 2, 'rerolls=' + shot.rerolls);
    const lipRows = S.mvJobRows(g.user.id, 'mv_lipsync');
    check('A mv_lipsync 共 3 单（1 正拍+2 补样）', lipRows.length === 3, 'rows=' + lipRows.length);
    check('A 补样 2 单 credits_cost=0 且 origin system_auto（不扣分明示）',
      lipRows.filter((x) => /system_auto/.test(String(x.payload))).length === 2 &&
      lipRows.filter((x) => /system_auto/.test(String(x.payload))).every((x) => Number(x.credits_cost) === 0),
      JSON.stringify(lipRows.map((x) => [x.id.slice(0, 8), x.credits_cost])));
    const lipCharges = (S.db.ledgerRows(g.user.id).rows || []).filter((x) => /mv_lipsync/.test(x.reason || '') && x.delta < 0);
    check('A 口型全程只扣 1 次费（补样零扣，资金诚信）', lipCharges.length === 1, JSON.stringify(lipCharges));
    const comp = S.mvJobRows(g.user.id, 'mv_compose');
    check('A compose 仍出片（1 单 done）', comp.length === 1 && comp[0].status === 'done',
      JSON.stringify(comp.map((x) => [x.status, x.error_code])));
    check('A project ready + video_url 落库', row && row.status === 'ready' && !!row.video_url, row && row.status);
    const lc = await ledgerClosed(g);
    check('A 账本闭合 Σdelta==balance', lc.ok, JSON.stringify(lc));
    check('A mock 产物可下载（降级不毁交付）', await (async () => {
      if (!row || !row.video_url) return false;
      const v = String(row.video_url);
      const rel = v.includes('/f/') ? v.split('/f/')[1] : v; // 落库为 rel（completeMvCompose），URL 形则取 /f/ 尾段
      const dl = await H.httpReq('GET', S.baseUrl + '/f/' + rel, {});
      return dl.status === 200 && dl.buffer.length > 0 && dl.buffer.toString('ascii', 4, 8) === 'ftyp';
    })(), row && row.video_url);
    void shotIds;
  }
  await stopExecutor();

  // ================= 场景 B：mv_compose 首次 fail → attempts 回队重试 → 最终 done/账本闭合 =================
  await startExecutor({ MB_MV_MOCK_FAIL_COMPOSE_ONCE: '1' }, 'B(compose首败)');
  {
    const { g, pid } = await bootProject({ vocal: false, shotKinds: ['story'] });
    const row = await waitProject(pid, 'ready', 150000);
    const comp = S.mvJobRows(g.user.id, 'mv_compose');
    check('B compose 单条存在', comp.length === 1, 'rows=' + comp.length);
    const c0 = comp[0] || {};
    check('B 首败→回队重试：attempts>=1', Number(c0.attempts) >= 1, 'attempts=' + c0.attempts);
    check('B compose 最终 done（重试闭环；fail 方向则须全额退见账本项）',
      c0.status === 'done' || (c0.status === 'failed' && Number(c0.credits_cost) === 0),
      'status=' + c0.status + ' credits_cost=' + c0.credits_cost + ' err=' + c0.error_code);
    check('B 首败错误码留痕 MOCK_COMPOSE_FAIL', String(c0.error_code || '') === 'MOCK_COMPOSE_FAIL' || c0.status === 'done',
      'error_code=' + c0.error_code);
    check('B project ready', row && row.status === 'ready', row && row.status);
    const lc = await ledgerClosed(g);
    check('B 账本闭合 Σdelta==balance（含 fail+refund 路径）', lc.ok, JSON.stringify(lc));
  }
  await stopExecutor();
} catch (e) {
  check('演练执行未异常中断', false, ((e && (e.message)) || String(e)) + ' | executor日志尾部: ' + execLog.slice(-1200));
} finally {
  try { await stopExecutor(); } catch (e) { /* noop */ }
  if (S) { try { await S.close(); } catch (e) { /* noop */ } }
}

const pass = results.filter((x) => x.ok).length;
console.log(`\n总计 ${pass}/${results.length} 通过${process.exitCode ? '（存在 FAIL → exit 1）' : ''}`);
if (!results.length) process.exitCode = 1;
