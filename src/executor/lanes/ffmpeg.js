// ffmpeg lane —— 转码(wav→mp3 320k + peaks 400 点)与六项 DSP；参数基线见契约 §4（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveSrc } = require('../lib/paths.js');
const { parseWavHeader } = require('../lib/wav.js');

const TRANSCODE_TIMEOUT_MS = 180000;
const DSP_TIMEOUT_MS = 300000;

function laneErr(code, message) { const e = new Error(message); e.failCode = code; e.failMessage = message; return e; }

// 组件可用性探测（进程内缓存）。注意：spawn ENOENT 时只发 'error' 不发 'close'，两事件都要计数。
let availCache = null;
function probe(cfg) {
  if (availCache) return availCache;
  availCache = new Promise((resolve) => {
    let ffmpeg = false, ffprobe = false, pending = 2, s1 = false, s2 = false;
    const done = () => { if (--pending === 0) resolve({ ffmpeg, ffprobe }); };
    const child1 = spawn(cfg.ffmpegBin || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    child1.on('error', () => { if (!s1) { s1 = true; ffmpeg = false; done(); } });
    child1.on('close', (c) => { if (!s1) { s1 = true; ffmpeg = c === 0; done(); } });
    const child2 = spawn(cfg.ffprobeBin || 'ffprobe', ['-version'], { stdio: 'ignore' });
    child2.on('error', () => { if (!s2) { s2 = true; ffprobe = false; done(); } });
    child2.on('close', (c) => { if (!s2) { s2 = true; ffprobe = c === 0; done(); } });
  });
  return availCache;
}

// 运行一次命令行；返回 {code, stdout, stderr}；ENOENT→code:null + missing=true
function runCmd(bin, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out = [], err = [];
    let outSize = 0;
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, opts.timeoutMs || 120000);
    child.stdout.on('data', (c) => { out.push(c); outSize += c.length; if (outSize > 512 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch (e) {} } });
    child.stderr.on('data', (c) => { if (err.reduce((s, x) => s + x.length, 0) < 64 * 1024) err.push(c); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(e.message || ''), missing: e.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8').slice(0, 800) }); });
  });
}

async function needFfmpeg(cfg) {
  const av = await probe(cfg);
  if (!av.ffmpeg) throw laneErr('FFMPEG_MISSING', '本机尚未安装音频处理组件，请检查执行机环境');
}

// 时长探测：ffprobe 优先，退回 wav 头解析；失败返回 null
async function probeDuration(cfg, abs) {
  const av = await probe(cfg);
  if (av.ffprobe) {
    const r = await runCmd(cfg.ffprobeBin || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { timeoutMs: 30000 });
    const d = r.code === 0 ? Number(String(r.stdout).trim()) : NaN;
    if (Number.isFinite(d) && d > 0) return d;
  }
  try {
    const h = parseWavHeader(fs.readFileSync(abs).slice(0, 4096));
    if (h && h.seconds > 0) return h.seconds;
  } catch (e) { /* ignore */ }
  return null;
}

// PCM(s16le 单声道 8k) → 400 点峰值（0~1）
function pcmToPeaks(pcm, points) {
  points = points || 400;
  const n = Math.floor(pcm.length / 2);
  const peaks = [];
  if (n <= 0) return new Array(points).fill(0);
  const bucket = Math.max(1, Math.floor(n / points));
  for (let b = 0; b < points; b++) {
    const start = b * bucket;
    if (start >= n) { peaks.push(0); continue; }
    const end = Math.min(n, start + bucket);
    let mx = 0;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2);
      const a = v < 0 ? -v : v;
      if (a > mx) mx = a;
    }
    peaks.push(Math.round((mx / 32768) * 10000) / 10000);
  }
  return peaks;
}

async function decodePeaks(cfg, srcAbs) {
  const r = await runCmd(cfg.ffmpegBin || 'ffmpeg',
    ['-v', 'error', '-i', srcAbs, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '8000', 'pipe:1'],
    { timeoutMs: TRANSCODE_TIMEOUT_MS });
  if (r.missing) throw laneErr('FFMPEG_MISSING', '本机尚未安装音频处理组件，请检查执行机环境');
  if (r.code !== 0) throw laneErr('FFMPEG_FAILED', '音频波形分析失败：' + (r.stderr || '未知原因'));
  return pcmToPeaks(r.stdout, 400);
}

// 落盘：主产物写同目录（契约命名），并保留 workDir 副本供上传
function placeOutput(buf, srcAbs, name, ctx) {
  const side = path.join(path.dirname(srcAbs), name);
  try { fs.writeFileSync(side, buf); } catch (e) { if (ctx.log) ctx.log('同目录落盘失败(忽略)：' + e.message); }
  const tmp = path.join(ctx.workDir, name);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

// ---------- transcode：wav → mp3(320k libmp3lame) + peaks.json(400 点) ----------
async function runTranscode(job, ctx) {
  const p = job.payload || {};
  await needFfmpeg(ctx.cfg);
  const srcAbs = await resolveSrc(p.src, ctx);
  if (!srcAbs) throw laneErr('SRC_MISSING', '转码源文件不存在');
  const targets = (Array.isArray(p.targets) && p.targets.length) ? p.targets : ['mp3', 'peaks'];
  const base = path.basename(srcAbs, path.extname(srcAbs)).replace(/[^\w.\-]/g, '_').slice(0, 64) || 'audio';
  const files = [];
  const result = { files: {} };

  await ctx.progress(20, '正在转码');
  if (targets.indexOf('mp3') !== -1) {
    const mp3Tmp = path.join(ctx.workDir, base + '.mp3');
    const r = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
      ['-v', 'error', '-y', '-i', srcAbs, '-codec:a', 'libmp3lame', '-b:a', '320k', mp3Tmp],
      { timeoutMs: TRANSCODE_TIMEOUT_MS });
    if (r.code !== 0 || !fs.existsSync(mp3Tmp) || fs.statSync(mp3Tmp).size < 1024) {
      throw laneErr('FFMPEG_FAILED', '转码失败：' + (r.stderr || '未知原因'));
    }
    const side = path.join(path.dirname(srcAbs), base + '.mp3');
    try { fs.copyFileSync(mp3Tmp, side); } catch (e) { ctx.log('同目录落盘失败(忽略)：' + e.message); }
    files.push({ field: 'mp3', filename: base + '.mp3', abs: mp3Tmp });
    result.files.mp3 = 'mp3';
  }

  await ctx.progress(60, '正在生成波形');
  if (targets.indexOf('peaks') !== -1) {
    const peaks = await decodePeaks(ctx.cfg, srcAbs);
    const json = JSON.stringify(peaks);
    const peaksTmp = placeOutput(Buffer.from(json, 'utf8'), srcAbs, base + '.peaks.json', ctx);
    files.push({ field: 'peaks', filename: base + '.peaks.json', abs: peaksTmp, data: Buffer.from(json, 'utf8') });
    result.files.peaks = 'peaks';
    result.peaks_points = peaks.length;
  }

  const dur = await probeDuration(ctx.cfg, srcAbs);
  if (dur) result.duration_sec = Math.round(dur * 100) / 100;
  await ctx.progress(95, '转码完成');
  return { result, files };
}

// ---------- DSP 六操作 ----------
function atempoChain(factor) {
  const parts = [];
  let rest = factor;
  if (rest >= 1) { while (rest > 2) { parts.push(2); rest /= 2; } parts.push(rest); }
  else { while (rest < 0.5) { parts.push(0.5); rest /= 0.5; } parts.push(rest); }
  return parts.map((x) => 'atempo=' + x.toFixed(6)).join(',');
}

async function buildDspArgs(op, params, srcAbs, srcsAbs, cfg, ctx) {
  const args = ['-v', 'error', '-y'];
  let filter = null;
  const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };

  if (op === 'trim') {
    const s = num(params.start_sec, NaN), e = num(params.end_sec, NaN);
    if (!(s >= 0 && e > s)) throw laneErr('BAD_PARAMS', '裁剪参数无效');
    args.push('-i', srcAbs, '-ss', String(s), '-to', String(e));
  } else if (op === 'slice') {
    const s = num(params.start_sec, NaN), d = num(params.duration, NaN);
    if (!(s >= 0 && d > 0)) throw laneErr('BAD_PARAMS', '截取参数无效');
    args.push('-i', srcAbs, '-ss', String(s), '-t', String(d));
  } else if (op === 'fade') {
    const iS = num(params.in_sec, 0), oS = num(params.out_sec, 0);
    if (iS < 0 || oS < 0 || (iS === 0 && oS === 0)) throw laneErr('BAD_PARAMS', '淡入淡出参数无效');
    const dur = await probeDuration(cfg, srcAbs);
    if (!dur) throw laneErr('FFMPEG_FAILED', '无法获取音频时长，淡入淡出失败');
    const parts = [];
    if (iS > 0) parts.push('afade=t=in:st=0:d=' + iS.toFixed(3));
    if (oS > 0) parts.push('afade=t=out:st=' + Math.max(0, dur - oS).toFixed(3) + ':d=' + oS.toFixed(3));
    filter = parts.join(',');
    args.push('-i', srcAbs);
  } else if (op === 'pitch') {
    // 变调不变速：asetrate + aresample + atempo 补偿
    const st = num(params.semitones, NaN);
    if (!Number.isFinite(st) || st < -24 || st > 24) throw laneErr('BAD_PARAMS', '变调幅度超出范围');
    const ratio = Math.pow(2, st / 12);
    filter = 'asetrate=44100*' + ratio.toFixed(6) + ',aresample=44100,' + atempoChain(1 / ratio);
    args.push('-i', srcAbs);
  } else if (op === 'tempo') {
    // 变速不变调：atempo（超范围链式叠加）
    const f = num(params.factor, NaN);
    if (!(f >= 0.25 && f <= 4)) throw laneErr('BAD_PARAMS', '变速倍率超出范围');
    filter = atempoChain(f);
    args.push('-i', srcAbs);
  } else if (op === 'concat') {
    if (!srcsAbs || srcsAbs.length < 1) throw laneErr('BAD_PARAMS', '拼接素材不足');
    for (const s of srcsAbs) args.push('-i', s);
    filter = srcsAbs.map((_, i) => '[' + i + ':a]').join('') + 'concat=n=' + srcsAbs.length + ':v=0:a=1';
  } else {
    throw laneErr('BAD_PARAMS', '不支持的音频操作：' + op);
  }
  if (filter) args.push('-af', filter);
  args.push('-c:a', 'pcm_s16le');
  return args;
}

const DSP_OPS = { trim: 1, fade: 1, pitch: 1, tempo: 1, concat: 1, slice: 1 };
async function runDsp(job, ctx) {
  const p = job.payload || {};
  const op = String(p.op || '');
  if (!DSP_OPS[op]) throw laneErr('BAD_PARAMS', '不支持的音频操作');
  await needFfmpeg(ctx.cfg);
  const params = p.params || {};

  let srcAbs = null, srcsAbs = null;
  if (op === 'concat') {
    const srcs = Array.isArray(params.srcs) ? params.srcs : (Array.isArray(p.srcs) ? p.srcs : null);
    if (!srcs || !srcs.length) throw laneErr('BAD_PARAMS', '拼接素材缺失');
    srcsAbs = [];
    for (const s of srcs) {
      const abs = await resolveSrc(s, ctx);
      if (!abs) throw laneErr('SRC_MISSING', '拼接素材不存在：' + String(s).slice(0, 40));
      srcsAbs.push(abs);
    }
    srcAbs = srcsAbs[0];
  } else {
    srcAbs = await resolveSrc(p.src, ctx);
    if (!srcAbs) throw laneErr('SRC_MISSING', '源文件不存在');
  }

  await ctx.progress(20, '音频处理中');
  const base = path.basename(srcAbs, path.extname(srcAbs)).replace(/[^\w.\-]/g, '_').slice(0, 64) || 'audio';
  const args = await buildDspArgs(op, params, srcAbs, srcsAbs, ctx.cfg, ctx);
  const outTmp = path.join(ctx.workDir, base + '_' + op + '.wav');
  args.push(outTmp);
  const r = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg', args, { timeoutMs: DSP_TIMEOUT_MS });
  if (r.missing) throw laneErr('FFMPEG_MISSING', '本机尚未安装音频处理组件，请检查执行机环境');
  if (r.code !== 0 || !fs.existsSync(outTmp) || fs.statSync(outTmp).size < 100) {
    throw laneErr('FFMPEG_FAILED', '音频处理失败：' + (r.stderr || '未知原因'));
  }
  // 同目录留一份（dev 同机可读），并登记上传
  try { fs.copyFileSync(outTmp, path.join(path.dirname(srcAbs), base + '_' + op + '.wav')); } catch (e) { ctx.log('同目录落盘失败(忽略)：' + e.message); }
  const dur = await probeDuration(ctx.cfg, outTmp);
  const result = {
    files: { out: 'out' },
    op,
    params,
    duration_sec: dur ? Math.round(dur * 100) / 100 : undefined,
  };
  await ctx.progress(95, '音频处理完成');
  return { result, files: [{ field: 'out', filename: base + '_' + op + '.wav', abs: outTmp }] };
}

module.exports = { runTranscode, runDsp, pcmToPeaks, probe, atempoChain };
