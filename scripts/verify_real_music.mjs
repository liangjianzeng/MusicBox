#!/usr/bin/env node
// 音乐线真机验收（5060 Ti / GeekPro 侧执行）：对**运行中的 server** + **真实 ACE-Step 引擎**做端到端量化判定。
// 零依赖：只用 node:（≥22，全局 fetch / node:sqlite）+ 外部 ffprobe/ffmpeg（可用 MB_FFPROBE / MB_FFMPEG 指定）。
//
// 为什么要这个脚本：README 里「音乐线完工」的说法此前从未被真引擎验证过；验收套件用的是 FakeExecutor，
// 只能证明状态机对，证明不了「一条歌真能出来且能播」。所以这里的一切判据都是可机检的物理量，
// 并且 **job status=done 一律不算通过** —— 必须音频真能解码、非静音、候选互不相同、账本自洽。
//
// 用法（在能同时访问 server 与 5060 Ti 的机器上跑）：
//   MB_SERVER=http://192.168.1.10:7800 MB_MUSIC_URL=http://192.168.1.x:8190 \
//   MB_DB=/home/jianzengliang/MusicBox/var/db/musicbox.sqlite \
//   node scripts/verify_real_music.mjs [--sec 45] [--count 3] [--seed 20261127] [--skip-assistant]
//
// 环境变量：
//   MB_SERVER       server 基址（默认 http://127.0.0.1:7800）
//   MB_MUSIC_URL    ACE-Step 服务（默认取 server 侧同名配置，仅用于预检提示）
//   MB_LLM_URL      助手 LLM（默认 http://127.0.0.1:8090/v1，DGX 已托管 qwen38-fp4）
//   MB_EXPECT_MODEL 期望模型 id（默认 qwen38-fp4；不匹配即判失败 —— 用户明确要求助手用这个）
//   MB_DB           server 的 sqlite 路径；给了就做白盒账本对账，不给则只验 HTTP 侧余额差
//   MB_ADMIN_USER / MB_ADMIN_PASSWORD  给了就允许余额不足时自动充值（测试台专用，走 /admin 接口）
'use strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = (process.env.MB_SERVER || 'http://127.0.0.1:7800').replace(/\/+$/, '');
const MUSIC = process.env.MB_MUSIC_URL || 'http://127.0.0.1:8190';
const LLM = (process.env.MB_LLM_URL || 'http://127.0.0.1:8090/v1').replace(/\/+$/, '');
const EXPECT_MODEL = process.env.MB_EXPECT_MODEL || 'qwen38-fp4';
const DB = process.env.MB_DB || '';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);
const REQ_SEC = Number(arg('sec', process.env.MB_SEC || 45));
const COUNT = Number(arg('count', process.env.MB_COUNT || 3));
const SEED = Number(arg('seed', process.env.MB_SEED || 20261127));
const BUDGET_MS = Number(process.env.MB_BUDGET_MS || 15 * 60 * 1000);
const EVID = path.join(ROOT, 'var', 'evidence', 'music-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(EVID, { recursive: true });

const ENGINE_WORDS = /\b(ace[- ]?step|acestep|comfyui|comfy|arcface|echomimic|sensevoice|funasr|qwen|vllm|sherpa)\b/i;
const results = [];
function check(id, name, ok, detail) {
  results.push({ id, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${id} ${name}${detail !== undefined ? ' —— ' + detail : ''}`);
  return !!ok;
}
function note(msg) { console.log('  · ' + msg); }
function findBin(pref, name) {
  const envv = process.env[pref];
  if (envv && fs.existsSync(envv)) return envv;
  const w = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
  const line = (w.stdout || '').split(/\r?\n/)[0];
  return line && fs.existsSync(line) ? line : null;
}
const FFPROBE = findBin('MB_FFPROBE', 'ffprobe');
const FFMPEG = findBin('MB_FFMPEG', 'ffmpeg');

async function req(method, p, { token, body, raw, headers } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(SERVER + p, { method, headers: h, body: payload, signal: AbortSignal.timeout(raw ? 120000 : 30000) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 二进制 */ }
  return { status: r.status, json, buf, text: json ? null : buf.toString('utf8').slice(0, 300) };
}

// ── 0 预检 ────────────────────────────────────────────────────────────────
console.log('▶ 0 预检（server / 音乐引擎 / 助手 LLM）');
console.log(`  server=${SERVER}  music=${MUSIC}  llm=${LLM}  sec=${REQ_SEC} count=${COUNT} seed=${SEED}`);
const health = await req('GET', '/healthz').catch((e) => ({ status: 0, text: String(e.message) }));
if (!check('A1', 'server /healthz 可达', health.status === 200, `HTTP ${health.status} ${health.text || ''}`)) {
  console.log('\n✗ server 不可达，后续全部无意义。先起服：bash bin/start-server.sh（见 docs/runbook-dev.md）');
  process.exit(1);
}
try {
  const m = await fetch(MUSIC + '/health', { signal: AbortSignal.timeout(6000) }).catch(() => null);
  check('A2', 'ACE-Step 音乐引擎可达', !!m && m.ok, m ? `HTTP ${m.status} @ ${MUSIC}` : `连不上 ${MUSIC}（5060 Ti 上的服务没起，或 MB_MUSIC_URL 写错）`);
} catch (e) { check('A2', 'ACE-Step 音乐引擎可达', false, String(e.message)); }
try {
  const l = await fetch(LLM + '/models', { signal: AbortSignal.timeout(8000) });
  const j = await l.json().catch(() => ({}));
  const ids = (j.data || []).map((x) => x.id);
  check('A3', `助手 LLM 就绪且模型=${EXPECT_MODEL}`, l.ok && ids.includes(EXPECT_MODEL), `HTTP ${l.status} 模型列表=[${ids.join(',')}]`);
} catch (e) { check('A3', '助手 LLM 就绪', false, String(e.message) + '（DGX 上应是 http://127.0.0.1:8090/v1）'); }
check('A4', 'ffprobe 可用（音频判据依赖）', !!FFPROBE, FFPROBE || '缺 → 装 ffmpeg 或设 MB_FFPROBE；没有它只能验到「能下载」验不到「能解码」');
const online = health.json && Number(health.json.online || 0);
check('A4b', '至少一个执行器在线（否则任务只会永远排队）', online >= 1,
  `online=${online}；起执行器：bash bin/start-executor.sh（GeekPro 上要带 MB_MUSIC_URL 指向本机 5060 Ti 服务）`);

// ── 1 身份与余额 ──────────────────────────────────────────────────────────
console.log('▶ 1 访客身份与积分');
const g = await req('POST', '/v1/auth/guest', { body: { device_id: 'verify-music-' + Date.now() } });
const token = g.json && (g.json.access_token || (g.json.user && g.json.user.access_token));
if (!check('A5', '访客登录成功', g.status === 200 && !!token, `HTTP ${g.status} ${g.text || ''}`)) process.exit(1);
const uid = g.json.user && g.json.user.id;
let bal0 = await req('GET', '/v1/credits', { token });
check('A6', '积分查询可用', bal0.status === 200 && bal0.json && typeof bal0.json.balance === 'number', `余额=${bal0.json && bal0.json.balance}`);
const balOf = (r) => (r.json && typeof r.json.balance === 'number' ? r.json.balance : NaN);
let balance0 = balOf(bal0);

// ── 2 真实生成 ────────────────────────────────────────────────────────────
const blocked = !results.find((r) => r.id === 'A2')?.ok || !results.find((r) => r.id === 'A4b')?.ok;
if (blocked) {
  console.log('▶ 2 真实生成：跳过 —— 音乐引擎或执行器未就位，生成不可能成功（先修 A2/A4b，别在假绿上继续）');
  for (const id of ['A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14', 'A15', 'A16', 'A17', 'A18', 'A19']) {
    results.push({ id, name: '（前置未就位，未执行）', ok: false, detail: 'skipped：A2/A4b 未通过' });
  }
  finish();
}
console.log('▶ 2 提交真实生成（走 server 全链路：扣费 → 派单 → 5060 Ti 推理 → 落库）');
const gen = await req('POST', '/v1/works/generate', {
  token,
  body: { mode: 'simple', prompt: '深夜城市霓虹下的轻电子流行，女声，温暖而克制', sec: REQ_SEC, count: COUNT, seed_base: SEED, instrumental: false },
});
const jobId = gen.json && (gen.json.job_id || (gen.json.job && gen.json.job.id));
const charged = gen.json && gen.json.credits_charged;
check('A7', '生成请求被接受（202/200 + job_id）', [200, 202].includes(gen.status) && !!jobId,
  `HTTP ${gen.status} 扣费=${charged ?? '-'} ${gen.text || JSON.stringify(gen.json || {}).slice(0, 160)}`);
if (!jobId) {
  if (gen.json && /积分|余额|INSUFFICIENT/.test(JSON.stringify(gen.json))) {
    note('积分不足：设 MB_ADMIN_USER / MB_ADMIN_PASSWORD 可让本脚本自动充值，或手工在运营后台给该用户加分。');
  }
  finish();
}
const t0 = Date.now();
let job = null;
while (Date.now() - t0 < BUDGET_MS) {
  const j = await req('GET', '/v1/jobs/' + encodeURIComponent(jobId), { token });
  job = j.json && (j.json.job || j.json);
  if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) break;
  process.stdout.write(`\r  等待中 ${job.status} ${job.progress ?? 0}%  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
  await new Promise((r) => setTimeout(r, 2000));
}
console.log();
check('A8', '任务在预算内进入终态', !!job && ['done', 'failed', 'cancelled'].includes(job && job.status),
  job ? `status=${job.status} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s` : '轮询超时');
check('A9', '任务成功（done）', job && job.status === 'done', job ? `status=${job.status} error=${job.error || job.error_code || '-'}` : '');
if (!job || job.status !== 'done') finish();

// ── 3 候选音频的物理判据 ─────────────────────────────────────────────────
console.log('▶ 3 候选音频物理判据（status=done 不算通过，必须能解码/非静音/互不相同）');
const workIds = (job.result && (job.result.work_ids || job.result.works)) || [];
const works = [];
for (const id of workIds) {
  const d = await req('GET', '/v1/works/' + encodeURIComponent(id), { token });
  if (d.status === 200) works.push(d.json.work || d.json);
}
check('A10', `候选数量 == ${COUNT}`, works.length === COUNT, `实得 ${works.length}${workIds.length !== COUNT ? '（job.result 只给了 ' + workIds.length + '）' : ''}`);
const clips = [];
for (const w of works) {
  const src = w.audio_master || w.audio_playback || (w.files && (w.files.audio_master || w.files.audio_playback));
  if (!src) { check('A11', `作品 ${w.id} 有音频地址`, false, JSON.stringify(Object.keys(w)).slice(0, 160)); continue; }
  const url = /^https?:/.test(src) ? src : SERVER + (src.startsWith('/') ? '' : '/f/') + src;
  const dl = await req('GET', url.replace(SERVER, ''), { token, raw: true }).catch((e) => ({ status: 0, buf: Buffer.alloc(0), text: String(e.message) }));
  const size = dl.buf ? dl.buf.length : 0;
  const okDl = dl.status === 200 && size > 50 * 1024;
  check('A11', `作品 ${w.id} 音频可下载且非空壳`, okDl, `HTTP ${dl.status} ${size}B ${url}`);
  if (!okDl) continue;
  const f = path.join(EVID, `${w.id}.audio`);
  fs.writeFileSync(f, dl.buf);
  const sha = crypto.createHash('sha256').update(dl.buf).digest('hex').slice(0, 16);
  let probe = null;
  if (FFPROBE) {
    const p = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f], { encoding: 'utf8' });
    try { probe = JSON.parse(p.stdout); } catch (e) { probe = null; }
  }
  const st = (probe && (probe.streams || []).find((s) => s.codec_type === 'audio')) || {};
  const dur = Number((probe && probe.format && probe.format.duration) || st.duration || 0);
  const sr = Number(st.sample_rate || 0); const ch = Number(st.channels || 0);
  check('A12', `作品 ${w.id} 可解码且时长在 ${REQ_SEC}s ±25%`, !!probe && dur >= REQ_SEC * 0.75 && dur <= REQ_SEC * 1.25,
    probe ? `dur=${dur.toFixed(2)}s codec=${st.codec_name || '?'}` : 'ffprobe 解不开（不是合法音频容器）');
  check('A13', `作品 ${w.id} 采样率/声道合法`, [44100, 48000, 32000, 24000].includes(sr) && [1, 2].includes(ch), `sr=${sr} ch=${ch}`);
  let mean = null;
  if (FFMPEG) {
    const v = spawnSync(FFMPEG, ['-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume: (-?[\d.]+) dB/.exec((v.stderr || '') + (v.stdout || ''));
    mean = m ? Number(m[1]) : null;
  }
  check('A14', `作品 ${w.id} 非静音（mean_volume > -55dB）`, mean !== null && mean > -55, mean === null ? (FFMPEG ? '没解析到 mean_volume' : '缺 ffmpeg，无法判定（不许默认通过）') : `mean=${mean}dB`);
  clips.push({ id: w.id, sha, title: w.title || '', src });
  const banned = ENGINE_WORDS.exec(`${w.title || ''} ${JSON.stringify(w.tags || [])} ${w.error || ''}`);
  check('A15', `作品 ${w.id} 用户面字符串无引擎型号名`, !banned, banned ? `命中「${banned[0]}」` : '');
}
const shas = clips.map((c) => c.sha);
check('A16', '候选两两不同（同 seed 也要真出多版）', clips.length > 1 ? new Set(shas).size === clips.length : clips.length === 1,
  `${new Set(shas).size}/${clips.length} 唯一 sha256`);

// ── 4 计费自洽 ───────────────────────────────────────────────────────────
console.log('▶ 4 计费自洽（账本是钱的真源）');
const bal1 = await req('GET', '/v1/credits', { token });
const balance1 = balOf(bal1);
const spent = balance0 - balance1;
check('A17', '生成确有扣费且未扣成负数', Number.isFinite(spent) && spent > 0 && balance1 >= 0, `${balance0} → ${balance1}（本次 ${spent}）`);
if (DB && fs.existsSync(DB)) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  db.exec('PRAGMA busy_timeout=8000;');
  const sum = db.prepare('SELECT COALESCE(SUM(delta),0) s FROM credit_ledger WHERE user_id=?').get(uid);
  check('A18', '账本不变量 Σdelta == 当前余额', Number(sum.s) === balance1, `Σdelta=${sum.s} 余额=${balance1}`);
  const rows = db.prepare('SELECT kind,delta,ref_type,ref_id FROM credit_ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 12').all(uid);
  fs.writeFileSync(path.join(EVID, 'ledger.json'), JSON.stringify(rows, null, 2));
  const debits = rows.filter((r) => r.delta < 0).length; const refunds = rows.filter((r) => r.delta > 0).length;
  const failedCandidates = COUNT - works.length;
  check('A19', '失败候选有配对退款', failedCandidates === 0 || refunds >= failedCandidates,
    `失败候选≈${failedCandidates}，退款行=${refunds}（明细 ${path.relative(ROOT, EVID)}/ledger.json）`);
  note(`最近账本行：${rows.slice(0, 4).map((r) => `${r.kind}:${r.delta}`).join(' ')}`);
} else {
  note('未给 MB_DB → 跳过白盒账本对账（强烈建议给，账本问题只有白盒能抓到）');
}

// ── 5 助手线（真 LLM） ───────────────────────────────────────────────────
if (!has('skip-assistant')) {
  console.log('▶ 5 助手线（真 LLM ' + EXPECT_MODEL + '）：意图解析合格率与「免费工具不扣费」');
  const boot = await req('GET', '/v1/assistant/bootstrap', { token });
  check('A20', '助手 bootstrap 可用', boot.status === 200 && boot.json && boot.json.available === true,
    `HTTP ${boot.status} mode=${boot.json && boot.json.mode} caps=${JSON.stringify((boot.json || {}).capabilities || {})}`);
  if (boot.status === 200 && boot.json && boot.json.available) {
    const cases = [
      ['帮我看看还有多少积分', ['credit', 'assistant']],
      ['查询任务进度', ['assistant.task_query', 'music.query_status']],
      ['这首音乐进度如何', ['music.query_status', 'work.explain']],
      ['搜索星河', ['library.search']],
      ['把这首歌改得更明亮一点', ['music', 'work', 'assistant']],
      ['还有票吗', ['assistant.ticket_query', 'assistant']],
    ];
    const balA = balOf(await req('GET', '/v1/credits', { token }));
    let hit = 0; const bad = [];
    for (const [text, wantAny] of cases) {
      const r = await req('POST', '/v1/assistant/messages', { token, body: { text } });
      const j = r.json || {}; const meta = j.meta || {};
      const tool = String(meta.tool || '');
      const okTool = r.status === 200 && wantAny.some((w) => tool.startsWith(w));
      if (okTool) hit++; else bad.push(`「${text}」→ tool=${tool || '-'} status=${r.status} mode=${meta.mode || '-'} ${String(j.text || '').slice(0, 60)}`);
      if (j.ticket) bad.push(`「${text}」免费/读类工具不该发票却发了票`);
    }
    const balB = balOf(await req('GET', '/v1/credits', { token }));
    check('A21', `意图解析合格率 ≥ 5/6`, hit >= 5, `${hit}/${cases.length}${bad.length ? ' | ' + bad.join(' | ') : ''}`);
    check('A22', '助手对话（含读工具）不扣费', balA === balB, `${balA} → ${balB}`);
    fs.writeFileSync(path.join(EVID, 'assistant.json'), JSON.stringify({ hit, cases: cases.length, bad }, null, 2));
  }
}

finish();
function finish() {
  const skipped = results.filter((r) => !r.ok && /skipped：/.test(r.detail));
  const failed = results.filter((r) => !r.ok && !/skipped：/.test(r.detail));
  fs.writeFileSync(path.join(EVID, 'report.json'), JSON.stringify({ at: new Date().toISOString(), SERVER, MUSIC, LLM, REQ_SEC, COUNT, SEED, results }, null, 2));
  console.log(`\n${failed.length === 0 ? '✓ 音乐线真机验收通过' : '✗ 音乐线真机验收未通过：' + failed.length + ' 项失败' + (skipped.length ? ` + ${skipped.length} 项因前置未就位未执行` : '') + '（共 ' + results.length + ' 项判据）'}`);
  for (const f of failed) console.log(`   ✗ ${f.id} ${f.name} —— ${f.detail}`);
  if (skipped.length) console.log(`   （${skipped.length} 项未执行，原因见上；修好 A2/A4b 再跑，别在假绿上继续）`);
  console.log(`  证据目录：${path.relative(ROOT, EVID)}/report.json`);
  process.exit(failed.length === 0 ? 0 : 1);
}
