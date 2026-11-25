// music lane —— 逐候选调用音乐生成服务(:8190) POST /music；persona 两段式克隆编排（2026-11-23）
// 失败口径：不可达→MUSIC_UNREACHABLE / 非200→MUSIC_HTTP / 超时→MUSIC_TIMEOUT；单候选 seed=seed_base+seed_delta
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('../lib/net.js');

const MUSIC_TIMEOUT_MS = 300000; // 单次生成最长 300s

function laneErr(code, message) { const e = new Error(message); e.failCode = code; e.failMessage = message; return e; }

// 网络层错误 → 契约错误码
function classifyNetErr(e) {
  if (e && e.failCode) return e;
  if (e && e.netCode === 'TIMEOUT') return laneErr('MUSIC_TIMEOUT', '音乐生成服务响应超时，请稍后重试');
  return laneErr('MUSIC_UNREACHABLE', '音乐生成服务不可达，请检查生成机状态');
}

// POST ${musicUrl}/music；body 见契约 §4；异常统一映射为 MUSIC_* 错误码
async function callMusic(musicUrl, body, log) {
  const base = String(musicUrl || '').replace(/\/+$/, '');
  const payload = JSON.stringify(body);
  let res;
  try {
    res = await net.request('POST', base + '/music', {
      headers: { 'content-type': 'application/json' },
      body: payload,
      timeoutMs: MUSIC_TIMEOUT_MS,
    });
  } catch (e) { throw classifyNetErr(e); }
  if (res.status !== 200) {
    log('生成服务返回 HTTP ' + res.status + '：' + res.body.slice(0, 200).toString('utf8'));
    throw laneErr('MUSIC_HTTP', '音乐生成服务响应异常（' + res.status + '）');
  }
  const j = res.json();
  if (!j || !j.file) throw laneErr('MUSIC_HTTP', '音乐生成服务返回数据不完整');
  return j; // {file, seconds, seed, gen_seconds, vram_peak_mb, task_type}
}

// 生成产物落盘到工作目录：file 为 URL 则下载，为本机路径则复制
async function ingestArtifact(fileField, destAbs, log) {
  const s = String(fileField || '');
  if (/^https?:\/\//i.test(s)) {
    let res;
    try { res = await net.request('GET', s, { timeoutMs: 60000 }); }
    catch (e) { throw classifyNetErr(e); }
    if (res.status !== 200 || res.body.length < 100) throw laneErr('MUSIC_HTTP', '音乐生成产物下载失败');
    fs.writeFileSync(destAbs, res.body);
    return;
  }
  // 本机绝对路径（生成服务与执行器同机部署，剧场 :8190 协议约定）
  if (fs.existsSync(s)) { fs.copyFileSync(s, destAbs); return; }
  throw laneErr('MUSIC_HTTP', '音乐生成产物缺失，无法取回');
}

// runMusic(job, ctx) → {result, files}；files=[{field, filename, abs}]，由 daemon 统一 multipart 上传
async function runMusic(job, ctx) {
  const cfg = ctx.cfg;
  const p = job.payload || {};
  const count = Math.max(1, Math.min(4, Number(p.count) || 3));
  const candidates = (Array.isArray(p.candidates) && p.candidates.length)
    ? p.candidates
    : Array.from({ length: count }, (_, i) => ({ seq: i + 1, seed_delta: i }));
  const seedBase = Number.isFinite(Number(p.seed_base)) ? Number(p.seed_base) : 424242;
  // 节点选择：job.payload 里的 music_endpoint/music_engine 由后台/用户选择决定（后端配置，不写死）；缺省回退本机 cfg
  const musicUrl = p.music_endpoint || cfg.musicUrl;
  const sec = Math.max(15, Math.min(240, Number(p.sec) || 45));
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(/[,，]/).filter(Boolean);
  const instrumental = !!p.instrumental;
  const persona = p.persona && p.persona.ref_abs_path ? p.persona : null;

  const files = [];
  const resultCandidates = [];
  const n = candidates.length;
  await ctx.progress(3, n + ' 个候选排队中');

  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const seq = Number(c.seq) || (i + 1);
    const seed = seedBase + (Number(c.seed_delta) || 0);
    // :8190 严格 schema（2026-11-23 实测 422 教训）：tags=逗号串（非数组）；bpm=null 或 30-300（0 非法）；seconds≤180 引擎硬限
    const baseBody = {
      mood: p.mood || '温暖',
      seconds: Math.max(15, Math.min(180, sec)),
      seed,
      tags: tags.join(','),
      lyrics: p.lyrics || '',
      prompt: p.prompt || [p.mood, tags.join(' ')].filter(Boolean).join(' '),
      instrumental,
    };
    const bpmN = Number(p.bpm);
    if (Number.isFinite(bpmN) && bpmN >= 30 && bpmN <= 300) baseBody.bpm = Math.round(bpmN);

    // ① guide：完整歌（无 ref_audio）
    const r1 = await callMusic(musicUrl, baseBody, ctx.log);
    let finalAbs = path.join(ctx.workDir, 'cand_' + seq + '.wav');
    await ingestArtifact(r1.file, finalAbs, ctx.log);
    let meta = { clone: { applied: false, stage2_failed: false }, gen_seconds: r1.gen_seconds, task_type: r1.task_type };
    let finalSeconds = Number(r1.seconds) || sec;
    let finalSeed = Number.isFinite(Number(r1.seed)) ? Number(r1.seed) : seed;

    // ② persona：cover 变声（ref_audio + cover_strength）；失败诚实降级交 ①
    if (persona) {
      meta.clone = { applied: true, stage2_failed: false, mode: persona.clone_mode || 'full', cover_strength: Number(persona.cover_strength) || 0.2 };
      try {
        const body2 = Object.assign({}, baseBody, {
          src_audio: finalAbs,                       // ① 的完整歌
          ref_audio: persona.ref_abs_path,           // 人格声纹参考
          cover_strength: Number(persona.cover_strength) || 0.2,
          instrumental: false,
        });
        const r2 = await callMusic(cfg.musicUrl, body2, ctx.log);
        const coverAbs = path.join(ctx.workDir, 'cand_' + seq + '.cover.wav');
        await ingestArtifact(r2.file, coverAbs, ctx.log);
        fs.renameSync(coverAbs, finalAbs);
        finalSeconds = Number(r2.seconds) || finalSeconds;
        meta.clone.gen_seconds = r2.gen_seconds;
      } catch (e) {
        ctx.log('候选' + seq + ' 变声阶段失败，降级使用初版：' + (e.failMessage || e.message));
        meta.clone.stage2_failed = true;
        meta.clone.stage2_error = e.failCode || 'INTERNAL';
      }
    }

    const field = 'master_' + seq;
    files.push({ field, filename: field + '.wav', abs: finalAbs });
    resultCandidates.push({
      seq, seed: finalSeed, seconds: finalSeconds,
      duration_sec: finalSeconds, // server completeMusic 读取此字段回填 candidates.duration_sec
      file: field, // 逻辑名，服务端据 result.files 映射回填 *_url
      title: '',
      meta,
    });
    await ctx.progress(Math.round(((i + 1) / n) * 99), '已完成第 ' + (i + 1) + '/' + n + ' 个候选');
  }

  const result = {
    files: {}, // {逻辑名: 上传字段名}，daemon 上传时同样填充
    candidates: resultCandidates,
    persona_applied: !!persona,
    mock: false,
  };
  return { result, files };
}

module.exports = { runMusic, callMusic, classifyNetErr, MUSIC_TIMEOUT_MS };
