// MV lane —— mv_* runner 表（imgspark/vidspark/lipsync/align/ffmpeg 五分支）（2026-11-24）
// 契约：docs/musicbox-phase2-architecture-design.md §4.1/§4.3；EXECUTOR_MOCK=1 下产真实可播假产物：
//   有 ffmpeg → lavfi testsrc2+正弦音 mp4 / lavfi color+drawtext png（真实可播）；
//   无 ffmpeg → 内置最小合法 PNG 字节桩（node:zlib 合成）+ 容器级最小 mp4 字节桩（ftyp+moov+mdat），
//   两者均在 result.meta.stub 如实标注；绝不吊死、绝不假成功（真 mode 走 lib/comfy.js + 83xx workers）。
// 真 mode 错误码族：COMFY_UNREACHABLE / COMFY_HTTP / COMFY_TIMEOUT / COMFY_QUEUE /
//   FFMPEG_MISSING / FFMPEG_TIMEOUT / FFMPEG_FAILED / COMFY_REFERENCE_REQUIRED / BAD_PARAMS。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('../lib/net.js');
const { resolveSrc, resolvePublic } = require('../lib/paths.js');
const comfy = require('../lib/comfy.js');
const { probe } = require('./ffmpeg.js');

// ---------- 常量（架构 §3.2 lane 超时基线） ----------
const TMO = {
  imgspark: 900000,    // mv_cast_image / mv_storyboard
  vidspark: 3600000,   // mv_cast_video / mv_shot
  lipsync: 1800000,    // mv_lipsync
  align: 120000,       // mv_align
  ffmpeg: 600000,      // mv_preview / mv_compose
};
const CAST_IMG = { w: 864, h: 1536, n: 3 };     // 定妆照 3 候选
const CAST_VID = { w: 736, h: 1312, sec: 5, frames: 13 }; // 定妆视频 + 抽帧
const SHOT_VID = { w: 736, h: 1312, sec: 5 };
const COMPOSE = { w: 720, h: 1280, minSec: 5, maxSec: 45, fps: 24 }; // 冻结默认 9:16
const FRAME_STEP = 10; // 124f/10 ≈ 13 帧
const XF = { transition: 'fade', duration: 0.5 };
const TRANSITIONS = ['fade', 'slideleft', 'wipeleft', 'smoothleft'];
const TITLE_CARD = { sec: 2 };
const SUB_Y = "max(h*0.55,min(h*0.9,h-text_h-h*0.06))";
const BADGE_TEXT = 'AI 生成';
const BRAND_TEXT = 'MusicBox';
const ZOOM = "min(zoom+0.0015,1.3)";
const MAX_BOARD = 16;
const MAX_SUBS = 60;
const MAX_SUB_CHARS = 120;
const FACEGATE_GATE = 0.6;
const RENDER_VERSION = 3;

function laneErr(code, message) { const e = new Error(message); e.failCode = code; e.failMessage = message; return e; }
function clamp(n, lo, hi, fallback) { return Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Number(n))) : fallback; }
function envNum(name, fallback) { return clamp(Number(process.env[name]), 1, Number.MAX_SAFE_INTEGER, fallback); }
function seedFor(p, cfg, offset) { return clamp(Number(p.seed), 0, 0xffffffff, clamp(Number(cfg.mvSeed), 0, 0xffffffff, envNum('MB_MV_SEED', 424242)) + (offset || 0)) >>> 0; }
function renderSize(p, cfg) {
  const r = (p && p.render) || {};
  const ratio = String(p.aspect_ratio || p.aspectRatio || r.aspect_ratio || cfg.mvAspectRatio || process.env.MB_MV_ASPECT_RATIO || '9:16');
  const sizes = { '9:16': [720, 1280], '16:9': [1280, 720], '1:1': [720, 720] };
  const size = sizes[ratio];
  if (!size) throw laneErr('BAD_PARAMS', '仅支持 9:16、16:9、1:1 画幅');
  return { w: size[0], h: size[1], aspectRatio: ratio, fps: Math.round(clamp(r.fps, 12, 60, clamp(cfg.mvFps, 12, 60, COMPOSE.fps))) };
}
function engineSize(p, cfg, base) {
  const w = Math.round(clamp(p.width, 64, 2160, clamp(cfg.mvImageWidth, 64, 2160, base.w)) / 2) * 2;
  const h = Math.round(clamp(p.height, 64, 2160, clamp(cfg.mvImageHeight, 64, 2160, base.h)) / 2) * 2;
  return { w, h };
}
function safeText(v, max) {
  return String(v == null ? '' : v).normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
  return v;
}
function stableHash(v) { return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex'); }
async function fileHash(abs) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(abs)) h.update(chunk);
  return h.digest('hex');
}
function cacheDir(ctx) { return ctx.cacheDir || ctx.cfg.mvCacheDir || process.env.MB_MV_CACHE_DIR || path.join(ctx.workDir, '.mv-cache'); }
function stageKey(kind, value) { return kind + '-' + stableHash({ version: RENDER_VERSION, kind, value }).slice(0, 32); }
async function cachedStep(ctx, kind, value, suffix, produce) {
  const dir = cacheDir(ctx); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, stageKey(kind, value) + suffix);
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return { abs: out, reused: true };
  // 原子写：先写 partial 再 rename。partial 须把 .part-<pid> 放在扩展名之前（<hash>.part-<pid>.mp4），
  // 否则 ffmpeg 按输出扩展名自动识别 muxer 时会因 .part-<pid> 后缀无法识别格式而 FFMPEG_FAILED（见 #mv-compose）。
  const ext = path.extname(out);
  const partial = ext ? out.slice(0, out.length - ext.length) + '.part-' + process.pid + ext : out + '.part-' + process.pid;
  try {
    fs.rmSync(partial, { force: true });
    await produce(partial);
    if (!fs.existsSync(partial) || fs.statSync(partial).size <= 0) throw laneErr('FFMPEG_FAILED', kind + ' 未生成有效产物');
    fs.renameSync(partial, out);
    return { abs: out, reused: false };
  } catch (e) { fs.rmSync(partial, { force: true }); throw e; }
}
function createBudget(cfg, p, kind) {
  const env = process.env[kind === 'preview' ? 'MB_MV_PREVIEW_BUDGET_MS' : 'MB_MV_COMPOSE_BUDGET_MS'];
  const cap = clamp(Number(cfg[kind + 'BudgetMs']), 1000, TMO.ffmpeg, TMO.ffmpeg);
  const ms = clamp(Number(p.timeout_ms || p.timeoutMs || (p.render && p.render.timeout_ms)), 1000, cap,
    clamp(Number(env), 1000, TMO.ffmpeg, cap));
  const deadline = Date.now() + ms;
  return {
    timeoutMs(limit) {
      const left = deadline - Date.now();
      if (left <= 0) throw laneErr('FFMPEG_TIMEOUT', kind + ' 总渲染预算已耗尽');
      return Math.max(1, Math.min(left, limit || left));
    },
    check() { if (Date.now() >= deadline) throw laneErr('FFMPEG_TIMEOUT', kind + ' 总渲染预算已耗尽'); },
  };
}
function concatEntry(abs) { return "file '" + String(abs).replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/[\r\n]/g, '') + "'"; }

// ---------- ffmpeg 运行（与一期 ffmpeg lane 同款 spawn 语义） ----------
function runCmd(bin, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out = [], errb = [];
    let outSize = 0;
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, opts.timeoutMs || 120000);
    child.stdout.on('data', (c) => { out.push(c); outSize += c.length; if (outSize > 512 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } } });
    child.stderr.on('data', (c) => { if (errb.reduce((s, x) => s + x.length, 0) < 64 * 1024) errb.push(c); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(e.message || ''), missing: e.code === 'ENOENT', timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal, timedOut, stdout: Buffer.concat(out), stderr: Buffer.concat(errb).toString('utf8').slice(0, 800) }); });
  });
}
async function haveFfmpeg(cfg) {
  try { const av = await probe(cfg); return !!av.ffmpeg; } catch (e) { return false; }
}
// ffprobe 时长（无 ffprobe/失败返回 null，调用方兜底）
async function probeDur(cfg, abs, budget) {
  try {
    const av = await probe(cfg);
    if (!av.ffprobe) return null;
    const r = await runCmd(cfg.ffprobeBin || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { timeoutMs: budget ? budget.timeoutMs(30000) : 30000 });
    if (budget && r.timedOut) throw laneErr('FFMPEG_TIMEOUT', 'ffprobe 时长探测超时');
    if (r.code === 0) { const d = Number(String(r.stdout).trim()); if (Number.isFinite(d) && d > 0) return d; }
  } catch (e) { if (e.failCode === 'FFMPEG_TIMEOUT') throw e; }
  return null;
}

// ---------- filter 构建器（纯函数，自检不依赖 ffmpeg） ----------
function gradeVf() { return "eq=contrast=1.02:brightness=0.005:saturation=1.04,curves=all='0/0 0.25/0.24 0.75/0.76 1/1'"; }
function normVf(w, h, fps, graded) {
  return 'scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease,pad=' + w + ':' + h
    + ':(ow-iw)/2:(oh-ih)/2:color=black,fps=' + (fps || COMPOSE.fps) + ',setsar=1,settb=AVTB'
    + (graded === false ? '' : ',' + gradeVf()) + ',format=yuv420p';
}
function dtText(s) {
  const body = safeText(s, MAX_SUB_CHARS).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/'/g, "\\'");
  return "'" + body + "'";
}
function dtPath(s, max) {
  const body = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max || 1024)
    .replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/'/g, "\\'");
  return "'" + body + "'";
}
function fontArg(cfg) {
  const f = String((cfg && cfg.mvFontFile) || process.env.MB_MV_FONT || '').slice(0, 1024);
  return f ? 'fontfile=' + dtPath(f) + ':' : '';
}
function buildBadgeDrawtext(cfg, text) {
  return 'drawtext=' + fontArg(cfg) + 'text=' + dtText(text || BADGE_TEXT)
    + ':fontcolor=white@0.75:fontsize=h/32:borderw=1:bordercolor=black@0.5:box=1:boxcolor=black@0.25:boxborderw=h/160'
    + ':x=w-text_w-w*0.03:y=h*0.03:expansion=none';
}
function buildSubtitleDrawtext(cfg, sub, emphasis) {
  const lines = Math.max(1, String((sub && (sub.textFile ? sub.text : sub.text)) || '').split('\n').length);
  const base = emphasis ? 'h/20' : 'h/24';
  const fontSize = lines > 1 ? 'min(' + base + ',max(h/48,(h*0.4-' + lines + '*h/80)/' + lines + '))' : base;
  const color = emphasis ? 'yellow' : 'white';
  const bw = emphasis ? 3 : 2;
  const st = Number(sub && sub.start), en = Number(sub && sub.end);
  const enable = (Number.isFinite(st) && Number.isFinite(en))
    ? ":enable='between(t," + clamp(st, 0, COMPOSE.maxSec).toFixed(3) + ',' + clamp(en, 0, COMPOSE.maxSec).toFixed(3) + ")'" : '';
  const text = sub && sub.textFile ? 'textfile=' + dtPath(sub.textFile) : 'text=' + dtText(sub && sub.text);
  return 'drawtext=' + fontArg(cfg) + text + ':expansion=none:line_spacing=h/80'
    + ':fontcolor=' + color + ':fontsize=' + fontSize + ':borderw=' + bw + ':bordercolor=black@0.65'
    + ':box=1:boxcolor=black@0.35:boxborderw=h/180'
    + ':x=(w-text_w)/2:y=' + (lines > 1 ? 'max(h*0.4,min(h*0.9,h-text_h-h*0.06))' : SUB_Y) + enable;
}
function buildTitleDrawtext(cfg, title) {
  return 'drawtext=' + fontArg(cfg) + 'text=' + dtText(title)
    + ':expansion=none:fontcolor=white:fontsize=h/16:borderw=2:bordercolor=black@0.5:x=(w-text_w)/2:y=(h-text_h)/2';
}
function buildBrandDrawtext(cfg, brand, watermark) {
  return 'drawtext=' + fontArg(cfg) + 'text=' + dtText(brand)
    + ':expansion=none:fontcolor=white@0.7:fontsize=' + (watermark ? 'h/48' : 'h/36')
    + ':x=' + (watermark ? 'w*0.03' : '(w-text_w)/2') + ':y=' + (watermark ? 'h*0.03' : 'h*0.62');
}
function buildTitleCardArgs(cfg, opts) {
  const o = opts || {};
  const size = renderSize({ render: o, aspect_ratio: o.aspectRatio }, cfg);
  const sec = clamp(o.sec, 0.1, 5, TITLE_CARD.sec);
  return ['-hide_banner', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=' + size.w + 'x' + size.h + ':d=' + sec + ':r=' + size.fps,
    '-vf', gradeVf() + ',' + buildTitleDrawtext(cfg, o.title) + ',' + buildBrandDrawtext(cfg, o.brand || BRAND_TEXT)
      + ',fps=' + size.fps + ',setsar=1,settb=AVTB,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', String(o.abs)];
}
function motionFor(seq, options, render) {
  for (const value of [options, render]) {
    if (!value || typeof value !== 'object') { if (value != null) return value; continue; }
    if (Object.prototype.hasOwnProperty.call(value, seq)) return value[seq];
    if (value.motion != null) return value;
  }
  return undefined;
}
function motionSpec(seq, opts) {
  const o = opts || {};
  const modes = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'];
  const mode = String(o.motion || modes[Math.abs(Number(seq) || 0) % modes.length]);
  if (modes.indexOf(mode) < 0) throw laneErr('BAD_PARAMS', '不支持的静态图运镜：' + mode);
  return { mode, amount: clamp(o.amount, 0.01, 0.2, 0.12) };
}
function buildKenBurnsVf(w, h, seq, opts, fps, duration) {
  const spec = motionSpec(seq, opts), z = (1 + spec.amount).toFixed(4);
  const rate = Number(fps) || COMPOSE.fps, span = Math.max(1, rate * clamp(duration, 0.1, 120, 6));
  const step = (0.0015 * spec.amount / 0.12 * 144 / span).toFixed(6);
  let zoom = "z='min(zoom+" + step + ',' + z + ")'";
  let x = 'iw/2-(iw/zoom/2)', y = 'ih/2-(ih/zoom/2)';
  if (spec.mode === 'zoom-out') { zoom = "z='if(eq(on,0)," + z + ',max(zoom-' + step + ",1))'"; }
  if (spec.mode.indexOf('pan-') === 0) {
    zoom = "z='" + z + "'";
    x = spec.mode === 'pan-left' ? '(iw-iw/zoom)*(1-on/' + span.toFixed(0) + ')' : '(iw-iw/zoom)*on/' + span.toFixed(0);
  }
  return normVf(w, h, fps) + ',zoompan=' + zoom + ":d=1:x='" + x + "':y='" + y
    + "':s=" + w + 'x' + h + ':fps=' + rate + ',format=yuv420p';
}
function buildZoompanVf(w, h, seq, opts, fps, duration) { return buildKenBurnsVf(w, h, seq, opts, fps, duration); }
function transitionSpec(seq, opts) {
  const o = opts || {};
  const mode = String(o.transition || TRANSITIONS[Math.abs(Number(seq) || 0) % TRANSITIONS.length]);
  if (TRANSITIONS.indexOf(mode) < 0) throw laneErr('BAD_PARAMS', '不支持的转场：' + mode);
  return { transition: mode, duration: clamp(o.duration, 0.1, 1.2, XF.duration) };
}
function composeTimeline(durs, requested, opts) {
  const o = opts || {}, boundaries = [], transitions = [];
  let elapsed = 0;
  for (let i = 1; i < durs.length; i++) {
    if (!requested.has(i)) { elapsed += durs[i - 1]; continue; }
    const seq = Array.isArray(o.transitionSeq) ? o.transitionSeq[i - 1] : o.transitionSeq;
    const spec = transitionSpec(seq === undefined ? i : Number(seq), o);
    const duration = Math.min(spec.duration, durs[i - 1] / 2, durs[i] / 2);
    if (duration < 0.1) { elapsed += durs[i - 1]; continue; }
    boundaries.push(i); transitions.push({ at: elapsed + durs[i - 1] - duration, duration, transition: spec.transition });
    elapsed += durs[i - 1] - duration;
  }
  return { boundaries, transitions, total: elapsed + durs[durs.length - 1] };
}
function buildComposeGraph(cfg, opts) {
  const o = opts || {};
  const segDurs = (Array.isArray(o.segments) ? o.segments : []).map((s) => clamp(Number(s && s.dur), 0.1, 15, 3));
  if (!segDurs.length) throw laneErr('BAD_PARAMS', 'compose filter 图缺少视频段');
  const requested = new Set((Array.isArray(o.boundaries) ? o.boundaries : []).filter((i) => Number.isInteger(i) && i > 0 && i < segDurs.length));
  const timeline = composeTimeline(segDurs, requested, o);
  const boundaries = new Set(timeline.boundaries);
  const subs = (Array.isArray(o.subtitles) ? o.subtitles : []).slice(0, MAX_SUBS);
  const V = segDurs.length, fc = [], groups = [];
  let cur = [];
  segDurs.forEach((d, i) => { if (boundaries.has(i) && cur.length) { groups.push(cur); cur = []; } cur.push(i); });
  if (cur.length) groups.push(cur);
  let prev = null, ti = 0;
  groups.forEach((g, gi) => {
    let lab;
    if (g.length === 1) lab = '[' + g[0] + ':v]';
    else { lab = '[g' + gi + ']'; fc.push(g.map((i) => '[' + i + ':v]').join('') + 'concat=n=' + g.length + ':v=1:a=0' + lab); }
    if (!prev) prev = lab;
    else {
      const tr = timeline.transitions[ti++], out = '[x' + gi + ']';
      fc.push(prev + lab + 'xfade=transition=' + tr.transition + ':duration=' + tr.duration.toFixed(3) + ':offset=' + tr.at.toFixed(3) + out);
      prev = out;
    }
  });
  const dts = subs.map((s) => buildSubtitleDrawtext(cfg, s, !!s.emphasis));
  if (o.brandText) dts.push(buildBrandDrawtext(cfg, o.brandText, true));
  dts.push(buildBadgeDrawtext(cfg, o.badgeText));
  const wanted = Math.max(clamp(o.minDuration, 0, COMPOSE.maxSec, 0), timeline.total);
  const total = Math.min(COMPOSE.maxSec, wanted);
  if (total < timeline.total) dts.push('trim=duration=' + total.toFixed(3));
  else if (total > timeline.total) dts.push('tpad=stop_mode=clone:stop_duration=' + (total - timeline.total).toFixed(3));
  fc.push(prev + dts.join(',') + '[vout]');
  const shiftMs = Math.max(0, Math.round((Number(o.tShiftSec) || 0) * 1000));
  const adelay = shiftMs > 0 ? ',adelay=' + shiftMs + '|' + shiftMs : '';
  fc.push('[' + V + ':a]volume=1.0' + adelay + ',apad,atrim=duration=' + total.toFixed(3) + '[mbd]');
  fc.push('[' + (V + 1) + ':a]volume=0.0,atrim=duration=' + total.toFixed(3) + '[sbd]');
  fc.push('[mbd][sbd]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[aout]');
  return { fc: fc.join(';'), totalVideo: total, xfades: timeline.transitions.length, timeline, mapV: '[vout]', mapA: '[aout]' };
}
function buildPreviewArgs(listFile, masterAbs, duration) {
  const args = ['-hide_banner', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (masterAbs) args.push('-i', masterAbs, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-af', 'apad', '-t', String(duration));
  else args.push('-map', '0:v:0', '-c', 'copy');
  return args.concat('-movflags', '+faststart');
}
function silenceBedArgs(sec, rate) {
  return ['-f', 'lavfi', '-t', String(clamp(sec, 0.1, 120, 1)), '-i', 'anullsrc=r=' + (rate || 48000) + ':cl=stereo'];
}

function lyricsText(v) {
  if (Array.isArray(v)) return v.join('\n');
  return String(v || '');
}
// 歌词归一（mv-plan §4.7.2 支柱一 / mv_align 传输层）：NFKC 全角→半角、剥标点符号、小写
function normLine(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
// 分行：优先换行；无换行时按句读（中英文句号叹问号）分段
function splitLyricLines(v) {
  const raw = lyricsText(v);
  let lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((s) => !/^\[.*\]$/.test(s));
  if (lines.length <= 1) {
    lines = String(raw || '').normalize('NFKC').split(/[。．！？!?；;…]+/).map((s) => s.trim()).filter(Boolean);
  }
  return lines;
}
// 按归一字数加权的比例均分（ASR 不可用时的兜底 timings；形状固定 {line,start,end}）
function evenSplitTimings(lines, total) {
  const totalSec = Math.max(1, Number(total) || 30);
  const w = lines.map((l) => Math.max(1, normLine(l).length));
  const sum = w.reduce((a, b) => a + b, 0);
  let t = 0;
  return lines.map((line, i) => {
    const start = t;
    t += (totalSec * w[i]) / sum;
    const end = i === lines.length - 1 ? totalSec : t;
    return { line, start: Math.round(start * 100) / 100, end: Math.round(Math.max(start + 0.3, end) * 100) / 100 };
  });
}

// ---------- 字节桩（无 ffmpeg 兜底；与一期「诚实失败」方向一致：产物真实存在且标注 stub） ----------
// 最小合法 PNG：node:zlib 压缩扫描线 + 自实现 CRC32（真 PNG，任何图片查看器可开）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
// 合成可显示 PNG：对角渐变 + 左上角索引色块（帧间可区分）
function synthPngBuf(w, h, seedIdx) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  const tint = [40 + ((seedIdx * 67) % 180), 80 + ((seedIdx * 113) % 150), 120 + ((seedIdx * 37) % 135)];
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter none
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 3;
      const band = (x + y) % 64 < 32 ? 1 : 0;
      raw[o] = band ? tint[0] : (tint[0] + 60) & 0xff;
      raw[o + 1] = band ? tint[1] : (tint[1] + 60) & 0xff;
      raw[o + 2] = band ? tint[2] : (tint[2] + 60) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// 容器级最小 MP4：ftyp+moov(mvhd)+mdat —— 结构合法可被解析器接受，**无可解码帧**（stub 标注，勿当成片用）
function synthMp4Buf(seconds) {
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; };
  const box = (type, ...payload) => Buffer.concat([u32(8 + payload.reduce((s, x) => s + x.length, 0)), Buffer.from(type, 'ascii'), ...payload]);
  const ftyp = box('ftyp', Buffer.from('isom', 'ascii'), u32(512), Buffer.from('isomiso2mp41', 'ascii'));
  const matrix = Buffer.concat([u32(0x00010000), Buffer.alloc(8), Buffer.alloc(4), u32(0x00010000), Buffer.alloc(4), Buffer.alloc(8), u32(0x40000000)]);
  const mvhd = box('mvhd',
    Buffer.alloc(4),                       // version/flags
    u32(0), u32(0),                        // ctime/mtime
    u32(1000), u32(Math.max(1, Math.round(seconds)) * 1000), // timescale/duration
    u32(0x00010000),                       // rate 1.0
    Buffer.from([0x01, 0x00, 0x00, 0x00]), // volume 1.0 + reserved
    Buffer.alloc(8), matrix, Buffer.alloc(24), u32(1));
  const moov = box('moov', mvhd);
  const mdat = box('mdat');
  return Buffer.concat([ftyp, moov, mdat]);
}

// ---------- mock 产物合成器（ffmpeg 优先，字节桩兜底） ----------
// mp4：lavfi testsrc2 + sine（-hide_banner，真实可播 9:16）
async function mockMp4(cfg, ctx, abs, w, h, sec, label) {
  if (await haveFfmpeg(cfg)) {
    const args = ['-hide_banner', '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=' + w + 'x' + h + ':rate=24:duration=' + sec,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=' + sec,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', abs];
    const r = await runCmd(cfg.ffmpegBin || 'ffmpeg', args, { timeoutMs: 120000 });
    if (r.code === 0 && fs.existsSync(abs) && fs.statSync(abs).size > 1000) return { stub: null };
    ctx.log('mv mock：ffmpeg 编码失败，退回字节桩（' + (r.stderr || 'code ' + r.code) + '）');
  }
  fs.writeFileSync(abs, synthMp4Buf(sec));
  return { stub: 'mp4-container' };
}
// png：lavfi color + drawtext 静态帧；drawtext 不可用退回 color 裸帧；ffmpeg 缺失退字节桩
async function mockPng(cfg, ctx, abs, w, h, label) {
  if (await haveFfmpeg(cfg)) {
    const bg = '0x' + crypto.createHash('md5').update(String(label)).digest('hex').slice(0, 6);
    const vf = "drawtext=text='" + String(label).replace(/[^0-9A-Za-z_ .:-]/g, '_').slice(0, 28) + "':fontcolor=white:fontsize=h/16:x=(w-text_w)/2:y=(h-text_h)/2";
    let r = await runCmd(cfg.ffmpegBin || 'ffmpeg',
      ['-hide_banner', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=' + bg + ':size=' + w + 'x' + h + ':d=1', '-vf', vf, '-frames:v', '1', abs],
      { timeoutMs: 60000 });
    if (!(r.code === 0 && fs.existsSync(abs) && fs.statSync(abs).size > 200)) {
      r = await runCmd(cfg.ffmpegBin || 'ffmpeg',
        ['-hide_banner', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=' + bg + ':size=' + w + 'x' + h + ':d=1', '-frames:v', '1', abs],
        { timeoutMs: 60000 });
    }
    if (r.code === 0 && fs.existsSync(abs) && fs.statSync(abs).size > 200) return { stub: null };
    ctx.log('mv mock：ffmpeg 出图失败，退回字节桩 png');
  }
  // 降采样生成（桩帧不必原尺寸，快而小）
  const sw = Math.min(w, 240), sh = Math.min(h, 426);
  fs.writeFileSync(abs, synthPngBuf(sw, sh, (sw * sh + (label ? label.length : 0)) >>> 0));
  return { stub: 'png-synthetic' };
}

// worker 内部令牌（2026-11-26 抢救 P0-4）：worker 侧设置 MB_WORKER_TOKEN 后，推理口只认带令牌的调用
function workerHeaders(cfg) {
  const h = { 'content-type': 'application/json' };
  const t = (cfg && cfg.workerToken) || process.env.MB_WORKER_TOKEN || '';
  if (t) h['x-worker-token'] = t;
  return h;
}

// ---------- facegate 客户端（真 mode，观测失败不致命，但**必须如实带出失败原因**） ----------
// 返回 {score,pass,yaw,pitch,reason}；reason：null=真跑成了 / 'unreachable' / 'http_<status>'。
// 为什么要把 reason 抬出来：以前不可达只写一行 log + 评分缺省，job 照样 done，
// 于是"定妆三张都过了身份门控"是假的（用户挑的脸根本没对照过）。失败可以，装成没事不行。
async function facegateScore(cfg, ctx, imgAbs, refFile) {
  const url = String(cfg.facegateUrl || 'http://127.0.0.1:8395').replace(/\/+$/, '');
  try {
    const b64 = fs.readFileSync(imgAbs).toString('base64');
    const res = await net.request('POST', url + '/score', {
      headers: workerHeaders(cfg),
      body: JSON.stringify({ img_b64: b64, ref_file: refFile || undefined }),
      timeoutMs: 15000,
    });
    const j = res.json();
    if (res.status === 200 && j && Number.isFinite(Number(j.score))) return { score: Number(j.score), pass: !!j.pass, yaw: j.yaw, pitch: j.pitch, reason: null };
    ctx.log('facegate /score 返回 ' + res.status + '（评分缺省）');
    return { score: null, pass: false, reason: 'http_' + res.status };
  } catch (e) {
    ctx.log('facegate 不可达（评分缺省，不致命）：' + e.message);
    return { score: null, pass: false, reason: 'unreachable' };
  }
}
// inswapper 换脸兜底（mv-plan §4.7.1：分镜低分 → /swap ×2，非致命；不可达 → 透传）
// 返回 {bytes, score} | {unreachable:true} | null（协议级失败）
async function facegateSwap(cfg, ctx, imgAbs, refFile) {
  const url = String(cfg.facegateUrl || 'http://127.0.0.1:8395').replace(/\/+$/, '');
  try {
    const b64 = fs.readFileSync(imgAbs).toString('base64');
    const res = await net.request('POST', url + '/swap', {
      headers: workerHeaders(cfg),
      body: JSON.stringify({ img_b64: b64, ref_file: refFile || undefined }),
      timeoutMs: 30000,
    });
    const j = res.json();
    if (res.status === 200 && j && j.png_b64) {
      return { bytes: Buffer.from(String(j.png_b64), 'base64'), score: Number.isFinite(Number(j.score)) ? Number(j.score) : null };
    }
    ctx.log('facegate /swap 返回 ' + res.status + '（透传原图）');
  } catch (e) {
    ctx.log('facegate 不可达（/swap 透传，不致命）：' + e.message);
    return { unreachable: true };
  }
  return null;
}

// ---------- 真 mode ComfyUI 提交 + 抽帧 ----------
async function comfySubmit(cfg, ctx, templateName, values, timeoutMs) {
  return comfy.submitComfyJob({ cfg, templateName, values, timeoutMs, jobId: ctx.job && ctx.job.id, log: ctx.log });
}
async function extractFrames(cfg, ctx, videoAbs, dir, count) {
  const frames = [];
  if (await haveFfmpeg(cfg)) {
    const r = await runCmd(cfg.ffmpegBin || 'ffmpeg',
      ['-hide_banner', '-y', '-v', 'error', '-i', videoAbs, '-vf', 'select=not(mod(n\\,' + FRAME_STEP + '))', '-vsync', '0', path.join(dir, 'frame_%02d.png')],
      { timeoutMs: 180000 });
    if (r.code === 0) {
      for (const f of fs.readdirSync(dir).filter((x) => /^frame_\d+\.png$/.test(x)).sort().slice(0, count)) frames.push(path.join(dir, f));
    }
  }
  if (!frames.length) throw laneErr('FFMPEG_FAILED', '定妆视频抽帧失败，未用假图替代');
  return frames;
}

// ---------- mock 分支 ----------
async function mockCastImage(job, ctx) {
  const p = job.payload || {};
  const seedBase = seedFor(p, ctx.cfg, 0), size = engineSize(p, ctx.cfg, CAST_IMG);
  const files = [], scores = [], stubs = [];
  for (let i = 1; i <= CAST_IMG.n; i++) {
    await ctx.progress(Math.round((i / CAST_IMG.n) * 90), '定妆候选 ' + i + '/' + CAST_IMG.n);
    const abs = path.join(ctx.workDir, 'cast_image_' + i + '.png');
    stubs.push((await mockPng(ctx.cfg, ctx, abs, size.w, size.h, 'CAST ' + i)).stub);
    files.push({ field: 'cast_image_' + i, filename: 'cast_image_' + i + '.png', abs });
    scores.push(null); // mock 不评分
  }
  return {
    result: { files: { cast_image: 'cast_image_1' }, seed_base: seedBase, face_scores: scores, mock: true, meta: { stub: stubs[0] || null } },
    files,
  };
}
async function mockCastI2V(job, ctx) {
  await ctx.progress(10, '定妆视频生成中（方案一/mock）');
  const size = engineSize(job.payload || {}, ctx.cfg, CAST_VID);
  const abs = path.join(ctx.workDir, 'cast_video.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, size.w, size.h, CAST_VID.sec, 'cast_video');
  await ctx.progress(60, '抽帧中（mock）');
  const files = [{ field: 'cast_video', filename: 'cast_video.mp4', abs }];
  const frames = [];
  for (let i = 1; i <= CAST_VID.frames; i++) {
    const fp = path.join(ctx.workDir, 'frame_' + String(i).padStart(2, '0') + '.png');
    fs.writeFileSync(fp, synthPngBuf(184, 328, i * 104729));
    files.push({ field: 'frame_' + i, filename: 'frame_' + String(i).padStart(2, '0') + '.png', abs: fp });
    frames.push({ file: 'frame_' + i, score: null, pass: true });
  }
  return {
    result: { files: { cast_video: 'cast_video' }, duration_sec: CAST_VID.sec, frames, mock: true, meta: { stub: st.stub } },
    files,
  };
}
async function mockCastVideo(job, ctx) {
  await ctx.progress(10, '定妆视频生成中（mock）');
  const size = engineSize(job.payload || {}, ctx.cfg, CAST_VID);
  const abs = path.join(ctx.workDir, 'cast_video.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, size.w, size.h, CAST_VID.sec, 'cast_video');
  await ctx.progress(60, '抽帧中（mock）');
  const files = [{ field: 'cast_video', filename: 'cast_video.mp4', abs }];
  const frames = [];
  for (let i = 1; i <= CAST_VID.frames; i++) {
    const fp = path.join(ctx.workDir, 'frame_' + String(i).padStart(2, '0') + '.png');
    fs.writeFileSync(fp, synthPngBuf(184, 328, i * 104729));
    files.push({ field: 'frame_' + i, filename: 'frame_' + String(i).padStart(2, '0') + '.png', abs: fp });
    frames.push({ file: 'frame_' + i, score: null, pass: true });
  }
  return {
    result: { files: { cast_video: 'cast_video' }, duration_sec: CAST_VID.sec, frames, mock: true, meta: { stub: st.stub } },
    files,
  };
}
async function mockStoryboard(job, ctx) {
  const shots = Array.isArray((job.payload || {}).shots) ? (job.payload.shots) : [{ id: 'shot_1', desc: 'stub' }];
  const files = [], map = {}, stubs = [], p = job.payload || {}, size = engineSize(p, ctx.cfg, CAST_IMG);
  const n = Math.max(1, Math.min(MAX_BOARD, shots.length));
  for (let i = 0; i < n; i++) {
    await ctx.progress(Math.round(((i + 1) / n) * 90), '分镜关键帧 ' + (i + 1) + '/' + n);
    const id = String(shots[i].id || ('shot_' + (i + 1))).replace(/[^\w.\-]/g, '_').slice(0, 48);
    const abs = path.join(ctx.workDir, 'board_' + id + '.png');
    stubs.push((await mockPng(ctx.cfg, ctx, abs, size.w, size.h, 'BOARD ' + id)).stub);
    files.push({ field: 'board_' + id, filename: 'board_' + id + '.png', abs });
    map['board_' + id] = 'board_' + id;
  }
  return { result: { files: map, count: n, mock: true, meta: { stub: stubs[0] || null } }, files };
}
async function mockShot(job, ctx) {
  const shotId = String(((job.payload || {}).shot || {}).id || (job.payload || {}).shot_id || 'shot_1').replace(/[^\w.\-]/g, '_').slice(0, 48);
  await ctx.progress(30, '拍摄中（mock）');
  const abs = path.join(ctx.workDir, 'clip_' + shotId + '.mp4');
  const sec = Math.min(10, Math.max(3, Number((job.payload || {}).shot && (job.payload || {}).shot.sec) || SHOT_VID.sec));
  const size = engineSize(job.payload || {}, ctx.cfg, SHOT_VID);
  const st = await mockMp4(ctx.cfg, ctx, abs, size.w, size.h, sec, 'clip_' + shotId);
  return {
    result: { files: { clip: 'clip_' + shotId }, duration_sec: sec, tier: (job.payload || {}).tier || 'quality', mock: true, meta: { stub: st.stub } },
    files: [{ field: 'clip_' + shotId, filename: 'clip_' + shotId + '.mp4', abs }],
  };
}
async function mockLipsync(job, ctx) {
  await ctx.progress(40, '口型校准（mock：透传）');
  const p = job.payload || {};
  const out = path.join(ctx.workDir, 'synced.mp4');
  let stub = null;
  const srcAbs = await resolveSrc(p.video, ctx);
  if (srcAbs) { fs.copyFileSync(srcAbs, out); } // 透传输入片
  else { stub = (await mockMp4(ctx.cfg, ctx, out, SHOT_VID.w, SHOT_VID.h, SHOT_VID.sec, 'synced')).stub; }
  // 降级演练钩子（N2-5，架构 §11）：MB_MV_MOCK_FAIL_LIPSYNC=1 → 口型质量失败（score 低于阈值），
  // 逼出 server 侧「免费补样×2 → locked+flags.degraded=broll_subtitle」降级链（scripts/degradation_drill.mjs 场景 A）
  const forceFail = String(process.env.MB_MV_MOCK_FAIL_LIPSYNC || '') === '1';
  return {
    result: { files: { synced: 'synced' }, sync_score: forceFail ? 0.1 : 0.95, lipsynced: true, mock: true, meta: { stub, drill_fail: forceFail || undefined } },
    files: [{ field: 'synced', filename: 'synced.mp4', abs: out }],
  };
}
async function mockAlign(job, ctx) {
  await ctx.progress(50, '歌词对齐（mock：按归一字数比例均分）');
  const p = job.payload || {};
  const lines = splitLyricLines(p.lyrics);
  const total = Number(p.duration_sec) || 30;
  const timings = evenSplitTimings(lines, total);
  return { result: { files: {}, timings, align_engine: 'mock-even-split', mock: true }, files: [] };
}
const _drillComposeFirstSeen = new Set(); // 演练钩子按 job.id 记录首次尝试（进程内，executor 重启即复位）
async function mockCompose(job, ctx) {
  await ctx.progress(20, '合成中（mock）');
  // 降级演练钩子（N2-5，架构 §11）：MB_MV_MOCK_FAIL_COMPOSE_ONCE=1 → 每个 compose job 首次尝试 fail（二次成功），
  // 验 attempts 回队重试闭环 + 账本闭合（scripts/degradation_drill.mjs 场景 B）
  if (String(process.env.MB_MV_MOCK_FAIL_COMPOSE_ONCE || '') === '1' && !_drillComposeFirstSeen.has(job.id)) {
    _drillComposeFirstSeen.add(job.id);
    throw laneErr('MOCK_COMPOSE_FAIL', 'mock：compose 首次失败（降级演练注入）');
  }
  const p = job.payload || {};
  const takes = Array.isArray(p.takes) ? p.takes : [];
  let sec = COMPOSE.minSec + 10;
  if (takes.length) sec = takes.reduce((s, t) => s + (Number(t.dur_sec) || Number(t.sec) || 3), 0);
  sec = Math.max(COMPOSE.minSec, Math.min(COMPOSE.maxSec, Math.round(sec)));
  const size = renderSize(p, ctx.cfg), abs = path.join(ctx.workDir, 'mv_video.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, size.w, size.h, sec, 'mv_video');
  await ctx.progress(80, '封面（mock）');
  const cover = path.join(ctx.workDir, 'cover.png');
  fs.writeFileSync(cover, synthPngBuf(360, Math.round(360 * size.h / size.w), 777));
  return {
    result: {
      files: { mv_video: 'mv_video', cover: 'cover' },
      duration_sec: sec, width: size.w, height: size.h, ai_label: true,
      sidecar: { subtitles: Array.isArray(p.subtitles) ? p.subtitles.length : 0, music: String(p.audio_master || '').slice(0, 80), ai_label: true, degraded_shots: Array.isArray(p.degraded_shots) ? p.degraded_shots.map(String).slice(0, 64) : [] },
      mock: true, meta: { stub: st.stub },
    },
    files: [
      { field: 'mv_video', filename: 'mv_video.mp4', abs },
      { field: 'cover', filename: 'cover.png', abs: cover },
    ],
  };
}
async function mockPreview(job, ctx) {
  await ctx.progress(50, '样片轮播（mock）');
  const boards = Array.isArray((job.payload || {}).board_urls) ? (job.payload.board_urls) : [];
  const seg = Math.max(1.5, Math.min(6, Number((job.payload || {}).seg_sec) || 2));
  const sec = Math.max(COMPOSE.minSec, Math.min(COMPOSE.maxSec, Math.round(Math.max(1, boards.length) * seg)));
  const size = renderSize(job.payload || {}, ctx.cfg), abs = path.join(ctx.workDir, 'preview.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, size.w, size.h, sec, 'preview');
  return {
    result: { files: { preview: 'preview' }, duration_sec: sec, width: size.w, height: size.h, boards: boards.length, mock: true, meta: { stub: st.stub } },
    files: [{ field: 'preview', filename: 'preview.mp4', abs }],
  };
}

// ---------- 真 mode 分支（lib/comfy.js + 83xx workers；绝不在此发 mock 网络调用） ----------

// mv_cast_image：上传照垫图 → h3-image-cast ×3 seed → facegate 对照评分（失败缺省不致命）
async function realCastImage(job, ctx) {
  const p = job.payload || {};
  const seedBase = seedFor(p, ctx.cfg, 0), size = engineSize(p, ctx.cfg, CAST_IMG);
  const portraitAbs = await resolveSrc(p.portrait_path, ctx);
  if (!portraitAbs) throw laneErr('COMFY_REFERENCE_REQUIRED', '真路径定妆需要真实人像；mock 才允许无参考图');
  const refImage = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(portraitAbs), path.basename(portraitAbs));
  const desc = String(p.desc || (p.gender === 'm' ? 'young man, studio portrait' : 'young woman, studio portrait')).slice(0, 900);
  const files = [], faceScores = [], gateReasons = [];
  for (let i = 1; i <= CAST_IMG.n; i++) {
    await ctx.progress(Math.round((i / CAST_IMG.n) * 85), '定妆候选 ' + i + '/' + CAST_IMG.n + '（引擎）');
    const r = await comfySubmit(ctx.cfg, ctx, 'h3-image-cast', {
      PROMPT: desc, WIDTH: size.w, HEIGHT: size.h, SEED: (seedBase + i) >>> 0,
      REF_IMAGE_1: refImage, REF_IMAGE_2: refImage, REF_IMAGE_3: refImage,
    }, TMO.imgspark);
    const abs = path.join(ctx.workDir, 'cast_image_' + i + r.ext);
    fs.writeFileSync(abs, r.bytes);
    files.push({ field: 'cast_image_' + i, filename: 'cast_image_' + i + r.ext, abs });
    if (portraitAbs) {
      const s = await facegateScore(ctx.cfg, ctx, abs, p.portrait_path);
      faceScores.push(s.score);
      if (s.reason) gateReasons.push(s.reason);
    } else faceScores.push(null);
  }
  await ctx.progress(95, '定妆完成');
  const map = {}; for (let i = 1; i <= CAST_IMG.n; i++) map['cast_image_' + i] = 'cast_image_' + i;
  // 身份门控到底跑没跑，随结果一起交付（不再只是 executor 日志里一行字）：
  // 三张图是真出的，但没 gate 就是没验脸 —— 端上必须能据此告诉用户"这几张没验过"，
  // 判词 V43 也才有东西可断（缺它=静默降级）。
  const scored = faceScores.filter((x) => x !== null && Number.isFinite(Number(x))).length;
  const gate = {
    attempted: CAST_IMG.n, scored, ran: scored > 0,
    reason: scored > 0 ? null : (portraitAbs ? (gateReasons[0] || 'no_score') : 'no_reference_portrait'),
  };
  if (!gate.ran) ctx.log('身份门控未跑成（' + gate.reason + '）：定妆候选照常交付，但标注为未验脸');
  return { result: { files: map, seed_base: seedBase, face_scores: faceScores, meta: { comfy: true, facegate: gate } }, files };
}

// 定妆 I2V 核心（方案一 / 遗留分支共用）：首帧源 → h3-fl2va I2V → ffmpeg 抽 ~13 帧 → facegate 逐帧对照
//   firstSrcAbs = 首帧源文件（方案一=女主原图；遗留=定妆候选照）
//   refSrc      = facegate 对照脸（方案一=女主原图；遗留=定妆候选照）
//   motionPrompt= 转头/换景指令（方案一用 desc；遗留用 motion）
async function castI2VCore(firstSrcAbs, refSrc, job, ctx, motionPrompt) {
  const p = job.payload || {};
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件，定妆抽帧不可用');
  const size = engineSize(p, ctx.cfg, CAST_VID);
  const first = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(firstSrcAbs), path.basename(firstSrcAbs));
  await ctx.progress(15, '定妆视频生成中（引擎）');
  const r = await comfySubmit(ctx.cfg, ctx, 'h3-fl2va', {
    FIRST_FRAME: first, PROMPT: String(motionPrompt || 'natural head turn, subtle expression').slice(0, 900),
    WIDTH: size.w, HEIGHT: size.h, LENGTH: 124, STEPS: 4, SEED: seedFor(p, ctx.cfg, 0),
  }, TMO.vidspark);
  const vidAbs = path.join(ctx.workDir, 'cast_video' + r.ext);
  fs.writeFileSync(vidAbs, r.bytes);
  await ctx.progress(70, '抽帧与评分中');
  const framePaths = await extractFrames(ctx.cfg, ctx, vidAbs, ctx.workDir, CAST_VID.frames);
  const files = [{ field: 'cast_video', filename: 'cast_video' + r.ext, abs: vidAbs }];
  const frames = [];
  // 参考脸须为 var 下真实文件（facegate ROOTS 白名单）；URL 解析不到 var 时回退原值（仍会 403，但不崩）
  const refCast = resolvePublic(refSrc, ctx.cfg) || refSrc;
  const frameGateReasons = [];
  for (let i = 0; i < framePaths.length; i++) {
    files.push({ field: 'frame_' + (i + 1), filename: path.basename(framePaths[i]), abs: framePaths[i] });
    const s = await facegateScore(ctx.cfg, ctx, framePaths[i], refCast);
    frames.push({ file: 'frame_' + (i + 1), score: s.score, pass: s.pass, yaw: s.yaw, pitch: s.pitch });
    if (s.reason) frameGateReasons.push(s.reason);
  }
  await ctx.progress(95, '定妆视频完成');
  // 逐帧评分就是 viewrefs 的来源：facegate 不可达 → 帧分全 null → pass 全 false →
  // 服务端回填的 viewrefs 直接空掉，后续角色镜/拍摄拿不到参考脸却看不出为什么。
  // 所以这里同样把"跑没跑成"抬进 meta，别让它变成一处静默的空数组。
  const frameScored = frames.filter((f) => f.score !== null && Number.isFinite(Number(f.score))).length;
  const frameGate = {
    attempted: frames.length, scored: frameScored, ran: frameScored > 0,
    reason: frameScored > 0 ? null : (frameGateReasons[0] || 'no_score'),
  };
  if (!frameGate.ran) ctx.log('逐帧身份门控未跑成（' + frameGate.reason + '）：帧分置空并标注，viewrefs 将为空');
  return { result: { files: { cast_video: 'cast_video' }, duration_sec: CAST_VID.sec, frames, meta: { comfy: true, facegate_frames: frameGate } }, files };
}

// mv_cast（方案一默认）：女主原图 I2V 首帧直出定妆视频 + 抽帧 + 逐帧 facegate（SP6 方案一，首帧锁脸）
async function realCastI2V(job, ctx) {
  const p = job.payload || {};
  const portraitAbs = await resolveSrc(p.portrait_path, ctx);
  if (!portraitAbs) throw laneErr('COMFY_REFERENCE_REQUIRED', '方案一定妆需要真实人像（portrait_path）');
  // 首帧=女主原图（SP6 方法 A/B：首帧锁脸 + prompt 换景/转头，一条生成内保脸）
  return castI2VCore(portraitAbs, p.portrait_path, job, ctx, p.desc || '自然转头与表情，多角度展示');
}

// mv_cast_video（遗留分支）：定妆候选照 → h3-fl2va I2V → 抽帧 → facegate 逐帧
async function realCastVideo(job, ctx) {
  const p = job.payload || {};
  const castAbs = await resolveSrc(p.cast_image, ctx);
  if (!castAbs) throw laneErr('SRC_MISSING', '定妆照源文件不存在');
  return castI2VCore(castAbs, p.cast_image, job, ctx, p.motion || 'natural head turn, subtle expression');
}

// mv_storyboard（架构 §4.1/mv-plan §4.7.1）：
//   角色镜（cast_ids + viewRef 可用）→ h3-image-edit「人物完全不变…只替换背景」垫 viewRef 姿态帧；
//     facegate /score 对照 viewRef，低分（<0.6）→ /swap ×2 非致命降级（不可达 → 透传 + 如实注记）
//   空镜/剧情镜 → t2i（复用 h3-image-cast，纯 desc 无身份垫图）
//   产物 files{board_<shotId>} ×N
async function realStoryboard(job, ctx) {
  const p = job.payload || {};
  const shots = Array.isArray(p.shots) ? p.shots : [];
  if (!shots.length) throw laneErr('BAD_PARAMS', '分镜列表为空');
  const n = Math.min(MAX_BOARD, shots.length), size = engineSize(p, ctx.cfg, CAST_IMG);
  const gate = clamp(p.facegate_gate, 0, 1, clamp(ctx.cfg.mvFacegateGate, 0, 1, envNum('MB_MV_FACEGATE_GATE', FACEGATE_GATE)));
  const files = [], map = {};
  const notes = [];
  for (let i = 0; i < n; i++) {
    await ctx.progress(Math.round(((i + 1) / n) * 88), '关键帧 ' + (i + 1) + '/' + n + '（引擎）');
    const sh = shots[i] || {};
    const id = String(sh.id || ('shot_' + (i + 1))).replace(/[^\w.\-]/g, '_').slice(0, 48);
    const desc = String(sh.desc || '').slice(0, 900);
    const cam = String(sh.camera || '').slice(0, 120);
    const bg = String(sh.background || '').slice(0, 300);
    const castId = (sh.cast_ids || [])[0] || null;
    const vr = castId && p.viewrefs ? (p.viewrefs[castId] || [])[0] || null : null;
    const vrAbs = vr ? await resolveSrc(vr, ctx) : null;
    let abs;
    if (vrAbs) {
      // 角色镜：edit 只换背景壳（姿态帧垫图）
      const refImage = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(vrAbs), path.basename(vrAbs));
      const r = await comfySubmit(ctx.cfg, ctx, 'h3-image-edit', {
        PROMPT: ('人物完全不变，只替换背景与环境：' + desc + '。背景：' + (bg || desc) + '。景别运镜：' + cam).slice(0, 900),
        WIDTH: size.w, HEIGHT: size.h, SEED: seedFor({ seed: sh.seed != null ? sh.seed : p.seed }, ctx.cfg, i * 977),
        REF_IMAGE: refImage,
      }, TMO.imgspark);
      abs = path.join(ctx.workDir, 'board_' + id + r.ext);
      fs.writeFileSync(abs, r.bytes);
      // 身份门：对照 viewRef 打分，低分 → inswapper ×2（非致命；不可达透传注记）
      // viewRef 须为 var 下真实文件（facegate ROOTS 白名单），URL 解析不到才回退原值
      const refVr = resolvePublic(vr, ctx.cfg) || vr;
      let sc = (await facegateScore(ctx.cfg, ctx, abs, refVr)).score;
      let swaps = 0;
      while (sc !== null && sc < gate && swaps < 2) {
        const sw = await facegateSwap(ctx.cfg, ctx, abs, refVr);
        if (!sw || sw.unreachable) { notes.push('board_' + id + ':facegate_unreachable'); break; }
        fs.writeFileSync(abs, sw.bytes);
        swaps++;
        sc = sw.score !== null && sw.score !== undefined ? sw.score
          : (await facegateScore(ctx.cfg, ctx, abs, refVr)).score;
        ctx.log('board_' + id + ' 低分降级：inswapper 第 ' + swaps + ' 次（score=' + (sc === null ? 'n/a' : sc) + '）');
      }
      if (swaps > 0) notes.push('board_' + id + ':swapped×' + swaps);
      if (sc !== null && sc < gate && swaps === 0) notes.push('board_' + id + ':low_score=' + sc);
    } else if (castId) {
      throw laneErr('COMFY_REFERENCE_REQUIRED', '分镜 ' + id + ' 的角色参考帧不可达；真路径不降级为无身份图');
    } else {
      if (!desc) throw laneErr('BAD_PARAMS', '空镜 ' + id + ' 缺少画面描述');
      const r = await comfySubmit(ctx.cfg, ctx, 'h3-image-broll', {
        PROMPT: [desc, bg && ('环境：' + bg), cam && ('景别运镜：' + cam)].filter(Boolean).join('。').slice(0, 900),
        WIDTH: size.w, HEIGHT: size.h, SEED: seedFor({ seed: sh.seed != null ? sh.seed : p.seed }, ctx.cfg, i * 977),
      }, TMO.imgspark);
      abs = path.join(ctx.workDir, 'board_' + id + r.ext);
      fs.writeFileSync(abs, r.bytes);
    }
    files.push({ field: 'board_' + id, filename: 'board_' + id + path.extname(abs), abs });
    map['board_' + id] = 'board_' + id;
  }
  await ctx.progress(95, '分镜完成');
  return { result: { files: map, count: n, meta: { comfy: true, notes } }, files };
}

// mv_shot：角色镜/剧情镜 → h3-fl2va 首帧条件（ref2va 模板留待 SP-MV-3 登记）→ clip_<shotId>
async function realShot(job, ctx) {
  const p = job.payload || {};
  const shot = p.shot || {};
  const shotId = String(shot.id || p.shot_id || 'shot_1').replace(/[^\w.\-]/g, '_').slice(0, 48);
  const size = engineSize(p, ctx.cfg, SHOT_VID);
  const ffAbs = await resolveSrc(shot.first_frame, ctx);
  if (!ffAbs) throw laneErr('SRC_MISSING', '镜头首帧不存在');
  const first = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(ffAbs), path.basename(ffAbs));
  const sec = Math.max(2, Math.min(10, Number(shot.sec) || SHOT_VID.sec));
  await ctx.progress(10, '开拍（引擎，' + sec + 's）');
  const sings = String(shot.singing || '').trim();
  // sings IR 变体（架构 lib/h3ir.js §4「六段式 IR sings 变体=对镜歌唱表演」语义）：
  //   口型由 post-hoc mv_lipsync 指定音频驱动（ADR-MV-3），不要求模型唱准，只要求唇随旋律自然开合
  const prompt = (sings ? '对镜歌唱表演，唇随旋律自然开合。' : '') + String(shot.motion || '').slice(0, 700);
  const r = await comfySubmit(ctx.cfg, ctx, 'h3-fl2va', {
    FIRST_FRAME: first, PROMPT: prompt, WIDTH: size.w, HEIGHT: size.h,
    LENGTH: Math.min(362, Math.round(sec * 24)), STEPS: 4, SEED: seedFor(p, ctx.cfg, 0),
  }, TMO.vidspark);
  const abs = path.join(ctx.workDir, 'clip_' + shotId + r.ext);
  fs.writeFileSync(abs, r.bytes);
  await ctx.progress(95, '镜头完成（原生声画保留，compose 剥离）');
  return {
    result: {
      files: { clip: 'clip_' + shotId }, duration_sec: sec, tier: p.tier || 'quality',
      meta: {
        comfy: true,
        ir_variant: sings ? 'sings' : 'story', // sings=演唱镜（post-hoc 对口型前置拍演）；story=剧情镜
        engine_note: 'story/sings=fl2va 首帧条件；角色镜 ref2va（viewRefs≤3 + sings IR）模板待 SP-MV-3 登记',
      },
    },
    files: [{ field: 'clip_' + shotId, filename: 'clip_' + shotId + r.ext, abs }],
  };
}

// mv_lipsync：ffmpeg 切窗（±0.2s 余量）→ POST :8390 /lipsync → synced + sync_score
async function realLipsync(job, ctx) {
  const p = job.payload || {};
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装音频处理组件，切窗不可用');
  const videoAbs = await resolveSrc(p.video, ctx);
  const masterAbs = await resolveSrc(p.audio_master, ctx);
  if (!videoAbs) throw laneErr('SRC_MISSING', '口型源视频不存在');
  if (!masterAbs) throw laneErr('SRC_MISSING', '母带音频不存在');
  const win = p.win || {};
  const start = Math.max(0, Number(win.start_sec) || 0);
  const dur = Math.max(0.5, Math.min(15, Number(win.dur_sec) || Number(win.end_sec) - Number(win.start_sec) || 5));
  const audioWin = path.join(ctx.workDir, 'win.wav');
  const r0 = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
    ['-hide_banner', '-y', '-v', 'error', '-ss', String(Math.max(0, start - 0.2)), '-t', String(dur + 0.4), '-i', masterAbs,
      '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', audioWin], { timeoutMs: 120000 });
  if (r0.code !== 0 || !fs.existsSync(audioWin)) throw laneErr('FFMPEG_FAILED', '切窗失败：' + (r0.stderr || '未知原因'));
  const url = String(ctx.cfg.lipsyncUrl || 'http://127.0.0.1:8390').replace(/\/+$/, '');
  let health;
  try { health = await net.request('GET', url + '/health', { timeoutMs: 5000 }); }
  catch (e) { throw laneErr('LIPSYNC_UNREACHABLE', '口型引擎不可达：' + e.message); }
  if (health.status !== 200) throw laneErr('LIPSYNC_UNREACHABLE', '口型引擎 /health → ' + health.status);
  await ctx.progress(30, '口型校准中（引擎）');
  let res;
  try {
    res = await net.request('POST', url + '/lipsync', {
      headers: workerHeaders(ctx.cfg),
      body: JSON.stringify({ video: videoAbs, audio: audioWin }),
      timeoutMs: TMO.lipsync,
    });
  } catch (e) { throw laneErr('LIPSYNC_UNREACHABLE', '口型引擎不可达：' + e.message); }
  if (res.status !== 200) {
    const j = res.json();
    throw laneErr('LIPSYNC_FAILED', '口型引擎 ' + res.status + '：' + String((j && (j.error && j.error.message || j.message)) || res.body.toString('utf8')).slice(0, 200));
  }
  const j = res.json() || {};
  const outAbs = j.file && fs.existsSync(j.file) ? j.file : null;
  if (!outAbs) throw laneErr('LIPSYNC_FAILED', '口型引擎未返回产物文件');
  const out = path.join(ctx.workDir, 'synced' + path.extname(outAbs));
  fs.copyFileSync(outAbs, out);
  await ctx.progress(95, '口型完成');
  return {
    result: { files: { synced: path.basename(out).replace(/\.\w+$/, '') }, sync_score: Number.isFinite(Number(j.sync_score)) ? Number(j.sync_score) : null, meta: { lipsync: true } },
    files: [{ field: 'synced', filename: path.basename(out), abs: out }],
  };
}

// mv_align：:8391 /asr（时间戳）→ 归一化（NFKC/剥标点）逐句贪心匹配 → timings [{line,start,end}]
// 兜底纪律（契约 v2.3/架构 §4.1：真 align worker 归 server，本路 = 传输 + 归一 + timings 形状）：
//   失配句在前后命中点之间按归一字数加权均分；ASR 整体不可达 → 全表按字数加权均分并如实标注 degraded。
async function realAlign(job, ctx) {
  const p = job.payload || {};
  const masterAbs = await resolveSrc(p.audio_master, ctx);
  if (!masterAbs) throw laneErr('SRC_MISSING', '母带音频不存在');
  const lines = splitLyricLines(p.lyrics);
  if (!lines.length) return { result: { files: {}, timings: [], align_engine: 'none-empty-lyrics' }, files: [] };
  const url = String(ctx.cfg.mvAsrUrl || 'http://127.0.0.1:8391').replace(/\/+$/, '');
  let segs = [];
  let asrDegraded = null;
  try {
    const res = await net.request('POST', url + '/asr', {
      headers: workerHeaders(ctx.cfg),
      body: JSON.stringify({ path: masterAbs, timestamp: true }),
      timeoutMs: TMO.align,
    });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const j = res.json() || {};
    segs = Array.isArray(j.segments) ? j.segments : [];
    if (!segs.length) throw new Error('segments 为空');
  } catch (e) {
    // ASR 不可用 → 不吊死不假成功：整体退回按行加权均分（诚实标注）
    asrDegraded = 'asr-unreachable:' + String(e.message || '').slice(0, 120);
    ctx.log('mv_align：ASR 不可达，退回按字数加权均分（' + asrDegraded + '）');
    const timings = evenSplitTimings(lines, Number(p.duration_sec) || 30);
    return {
      result: { files: {}, timings, align_engine: 'proportional-even-split', degraded: true, note: '对齐转写暂不可用，已按歌词字数均匀排布（可稍后重跑对齐）', meta: { asr: asrDegraded } },
      files: [],
    };
  }
  // 逐句贪心匹配（归一化后包含判定，游标单调推进）
  const timings = [];
  let cursor = 0;
  for (const line of lines) {
    const nl = normLine(line);
    let hit = null;
    for (let i = cursor; i < Math.min(cursor + 6, segs.length); i++) {
      const ns = normLine(segs[i] && (segs[i].text || segs[i].line));
      if (ns && nl && (ns.includes(nl) || nl.includes(ns) || (ns.length > 1 && nl.includes(ns.slice(0, Math.min(6, ns.length)))))) { hit = segs[i]; cursor = i + 1; break; }
    }
    if (hit) timings.push({ line, start: Math.round((Number(hit.start) || 0) * 100) / 100, end: Math.round((Number(hit.end) || Number(hit.start) || 0) * 100) / 100 });
    else timings.push(null);
  }
  // 失配句：在前后命中点之间按归一字数加权均分
  const total = Number(p.duration_sec) || (segs.length ? Number(segs[segs.length - 1].end) || 30 : 30);
  for (let i = 0; i < timings.length; i++) {
    if (timings[i]) continue;
    const t0 = (i > 0 && timings[i - 1]) ? timings[i - 1].end : 0;
    let j = i + 1; while (j < timings.length && !timings[j]) j++;
    const t1 = j < timings.length ? timings[j].start : total;
    const run = lines.slice(i, j);
    const sub = evenSplitTimings(run, Math.max(0.5, t1 - t0)).map((x, k) => ({ line: run[k], start: t0 + x.start, end: Math.min(t1, t0 + x.end) }));
    for (let k = 0; k < run.length; k++) timings[i + k] = sub[k];
  }
  const missCount = timings.filter((x) => !x).length;
  return { result: { files: {}, timings, align_engine: 'asr-rule-greedy', degraded: missCount > 0 || undefined, meta: { segs: segs.length, missed: missCount } }, files: [] };
}

async function execChecked(ctx, budget, args, label, limit) {
  budget.check();
  const r = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg', args, { timeoutMs: budget.timeoutMs(limit || 180000) });
  if (r.missing) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件');
  if (r.timedOut) throw laneErr('FFMPEG_TIMEOUT', label + ' 超时，已终止 ffmpeg');
  if (r.code !== 0) throw laneErr('FFMPEG_FAILED', label + '：' + (r.stderr || '未知原因'));
  return r;
}
async function realPreview(job, ctx) {
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件，样片不可用');
  const p = job.payload || {}, size = renderSize(p, ctx.cfg), budget = createBudget(ctx.cfg, p, 'preview');
  const boards = Array.isArray(p.board_urls) ? p.board_urls.slice(0, MAX_BOARD) : [];
  if (!boards.length) throw laneErr('BAD_PARAMS', '分镜图列表为空');
  const n = Math.max(1, boards.length), seg = Math.max(1.5, Math.min(6, Number(p.seg_sec) || 2, COMPOSE.maxSec / n));
  const masterSrc = p.audio_master || p.audio || p.master;
  const masterAbs = masterSrc ? await resolveSrc(masterSrc, ctx) : null;
  if (masterSrc && !masterAbs) throw laneErr('SRC_MISSING', '样片母带音频不存在');
  const tmp = path.join(ctx.workDir, 'prev'); fs.mkdirSync(tmp, { recursive: true });
  const listFile = path.join(tmp, 'list.txt'), lines = [], rendered = [];
  let zoompanFellBack = false;
  for (let i = 0; i < n; i++) {
    await ctx.progress(Math.round(((i + 1) / n) * 70), '轮播段 ' + (i + 1) + '/' + n);
    const abs = await resolveSrc(boards[i], ctx); if (!abs) continue;
    const seq = boards[i].seq == null ? i : Number(boards[i].seq);
    const motion = motionFor(seq, p.motion, p.render && p.render.motion);
    const key = { input: await fileHash(abs), size, seg, seq, motion };
    let r;
    try {
      r = await cachedStep(ctx, 'preview-segment', key, '.mp4', async (dest) => {
        await execChecked(ctx, budget, ['-hide_banner', '-y', '-v', 'error', '-loop', '1', '-framerate', String(size.fps), '-t', String(seg), '-i', abs,
          '-vf', buildKenBurnsVf(size.w, size.h, seq, motion, size.fps, seg), '-map', '0:v',
          '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dest], '样片运镜');
      });
    } catch (e) {
      if (e.failCode !== 'FFMPEG_FAILED') throw e;
      zoompanFellBack = true;
      r = await cachedStep(ctx, 'preview-static', key, '.mp4', async (dest) => {
        await execChecked(ctx, budget, ['-hide_banner', '-y', '-v', 'error', '-loop', '1', '-framerate', String(size.fps), '-t', String(seg), '-i', abs,
          '-vf', normVf(size.w, size.h, size.fps), '-map', '0:v', '-an',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', dest], '样片静态帧');
      });
    }
    if (!r.abs) continue;
    lines.push(concatEntry(r.abs)); rendered.push(r.abs);
  }
  if (!lines.length) throw laneErr('SRC_MISSING', '分镜图全部不可达');
  fs.writeFileSync(listFile, lines.join('\n'));
  const out = path.join(ctx.workDir, 'preview.mp4'), segmentHashes = [], duration = lines.length * seg;
  for (const abs of rendered) segmentHashes.push(await fileHash(abs));
  const masterHash = masterAbs ? await fileHash(masterAbs) : null;
  const cached = await cachedStep(ctx, 'preview-final', { segments: segmentHashes, size, fps: size.fps, duration, master: masterHash }, '.mp4', async (dest) => {
    await execChecked(ctx, budget, buildPreviewArgs(listFile, masterAbs, duration).concat(dest), masterAbs ? '样片铺母带' : '样片拼接', 60000);
  });
  fs.copyFileSync(cached.abs, out);
  await ctx.progress(95, '样片完成');
  return {
    result: { files: { preview: 'preview' }, duration_sec: Math.round(duration * 100) / 100, width: size.w, height: size.h,
      boards: lines.length, meta: { zoompan: !zoompanFellBack, note: zoompanFellBack ? 'zoompan 不可用，已退回静态帧' : null,
        cache: cached.reused, audio_source: masterAbs ? 'master' : 'silent' } },
    files: [{ field: 'preview', filename: 'preview.mp4', abs: out }],
  };
}

// 字幕规格化（compose 叠层输入，形状宽容）：
//   p.subtitles = [string...] 均匀铺 | [{line|text,start|start_sec,end|end_sec}...]（timings 同源，ADR-MV-11 三分用之字幕）
//   tShiftSec = 片名卡偏移（master/字幕与镜头声画对齐）；takeWin 供 broll_subtitle 强调判定
function wrapSubtitle(text, width, height, emphasis) {
  const value = safeText(text, MAX_SUB_CHARS);
  const divisor = emphasis ? 20 : 24;
  const max = Math.max(4, Math.floor(Number(width) * 0.81 / (Number(height) / divisor) * 2));
  const chars = Array.from(value), lines = [];
  let line = '', units = 0;
  for (const ch of chars) {
    const weight = /[\u0300-\u036f\ufe0e\ufe0f]/u.test(ch) ? 0 : (/^[\u0000-\u00ff]$/.test(ch) ? 1 : 2);
    if (line && units + weight > max) { lines.push(line); line = ''; units = 0; }
    line += ch; units += weight;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
function normalizeSubtitles(p, contentSec, tShiftSec, takeWin, size) {
  const dims = size || { w: COMPOSE.w, h: COMPOSE.h };
  let raw = p.subtitles;
  if (typeof raw === 'string') raw = raw.split(/\r?\n/);
  if (!Array.isArray(raw) || !raw.length) return [];
  const shift = Math.max(0, Number(tShiftSec) || 0);
  const cSec = Math.max(1, Number(contentSec) || 30);
  const globalBroll = (Array.isArray(p.degraded_shots) ? p.degraded_shots : [])
    .some((x) => String(x || '').includes('broll_subtitle'));
  const out = [];
  const allStr = raw.every((x) => typeof x === 'string');
  if (allStr) {
    const step = cSec / Math.max(1, raw.length);
    raw.forEach((t, i) => {
      const start = shift + i * step;
      const end = shift + (i + 1) * step - 0.1;
      const emphasis = globalBroll || (takeWin || []).some((w) =>
        (w.degraded || []).some((d) => String(d || '').includes('broll_subtitle'))
        && Number.isFinite(start) && Number.isFinite(end) && start < w.end && end > w.start);
      const text = wrapSubtitle(t, dims.w, dims.h, emphasis);
      if (text) out.push({ text, start, end });
    });
  } else {
    for (const s of raw) {
      if (!s) continue;
      const st = Number(s.start != null ? s.start : s.start_sec);
      const en = Number(s.end != null ? s.end : s.end_sec);
      const emphasis = globalBroll || (takeWin || []).some((w) =>
        (w.degraded || []).some((d) => String(d || '').includes('broll_subtitle'))
        && Number.isFinite(st) && Number.isFinite(en) && st + shift < w.end && en + shift > w.start);
      const text = wrapSubtitle(s.text != null ? s.text : s.line || '', dims.w, dims.h, emphasis);
      if (!text) continue;
      out.push({ text, start: Number.isFinite(st) ? st + shift : NaN, end: Number.isFinite(en) ? en + shift : NaN });
    }
  }
  for (const s of out) {
    s.emphasis = globalBroll || (takeWin || []).some((w) =>
      (w.degraded || []).some((d) => String(d || '').includes('broll_subtitle'))
      && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start < w.end && s.end > w.start);
  }
  return out.slice(0, MAX_SUBS);
}

// mv_compose —— 架构 §4.2 filter 基线全链路（有 ffmpeg 时）：
//   逐 take：静态图确定性 Ken Burns，视频剥音归一 scale=W:H:forOAR=decrease,pad,fps,setsar=1（libx264 中间段）
//   片名卡/片尾：按画幅预渲染；段落界按镜序号选择 fade/slideleft/wipeleft/smoothleft，无 ffprobe 直拼
//   铺轨：master volume=1.0（片名卡后 adelay 对齐）+ 静音床 → amix inputs=2:normalize=0
//   叠层：逐句字幕 textfile 换行（安全位置；broll_subtitle → 强调档）+ 品牌水印 + AI 角标常驻
//   封面：job cover 优先，否则内容区代表帧；分阶段内容哈希缓存复用
//   sidecar{subtitles,music,ai_label,degraded_shots}；无 ffmpeg 真 mode → FFMPEG_MISSING（mock 走字节桩，见 mockCompose）
async function realCompose(job, ctx) {
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件，合成不可用');
  const p = job.payload || {}, takes = Array.isArray(p.takes) ? p.takes.slice(0, MAX_BOARD) : [];
  if (!takes.length) throw laneErr('BAD_PARAMS', '成片镜头列表为空');
  const size = renderSize(p, ctx.cfg), budget = createBudget(ctx.cfg, p, 'compose');
  const r = p.render || {}, title = safeText(p.title, 40), brand = safeText(r.brand || p.brand || BRAND_TEXT, 24);
  const titleSec = title ? clamp(r.title_sec, 0.1, 5, TITLE_CARD.sec) : 0;
  const endSec = clamp(r.endcard_sec, 0, 5, 2);
  const masterAbs = await resolveSrc(p.audio_master, ctx);
  if (!masterAbs) throw laneErr('SRC_MISSING', '母带音频不存在');
  const fontHash = ctx.cfg.mvFontFile ? await fileHash(ctx.cfg.mvFontFile).catch(() => null) : null;
  const cardKey = { size, titleSec, endSec, title, brand, badge: safeText(r.badge || p.badge || BADGE_TEXT, 24), fontHash };
  const tmp = path.join(ctx.workDir, 'cmp'); fs.mkdirSync(tmp, { recursive: true });
  const listFile = path.join(tmp, 'list.txt'), entries = [];
  let reused = 0;
  if (title) {
    const card = await cachedStep(ctx, 'compose-title', cardKey, '.mp4', (dest) => execChecked(ctx, budget,
      buildTitleCardArgs(ctx.cfg, { title, brand, abs: dest, w: size.w, h: size.h, sec: titleSec, aspectRatio: size.aspectRatio, fps: size.fps }), '片名卡', 120000));
    entries.push({ abs: card.abs, dur: titleSec }); if (card.reused) reused++;
  }
  const tShiftSec = titleSec, av = await probe(ctx.cfg), segs = [];
  let contentBudget = COMPOSE.maxSec - titleSec - endSec;
  for (let i = 0; i < takes.length && contentBudget >= 0.5; i++) {
    const take = takes[i] || {}, abs = await resolveSrc(take.video, ctx); if (!abs) continue;
    await ctx.progress(Math.round(((i + 1) / takes.length) * 50), '归一 ' + (i + 1) + '/' + takes.length);
    const seq = take.seq == null ? i : Number(take.seq), image = /\.(png|jpe?g|webp|gif)$/i.test(abs);
    const wanted = clamp(Number(take.dur_sec != null ? take.dur_sec : take.sec), 0.5, 30, 3);
    const dur = Math.min(wanted, contentBudget), start = clamp(Number(take.start_sec), 0, 86400, 0);
    const motion = motionFor(seq, r.motion, p.motion), imageSeq = image ? seq : 0;
    const key = { input: await fileHash(abs), size, start, dur, image, seq: imageSeq, motion };
    const step = await cachedStep(ctx, image ? 'compose-image' : 'compose-normal', key, '.mp4', async (dest) => {
      const args = ['-hide_banner', '-y', '-v', 'error'];
      if (start > 0) args.push('-ss', String(start));
      if (image) args.push('-loop', '1', '-framerate', String(size.fps));
      args.push('-t', String(dur), '-i', abs, '-an', '-vf', image
        ? buildKenBurnsVf(size.w, size.h, seq, key.motion, size.fps, dur) : normVf(size.w, size.h, size.fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest);
      await execChecked(ctx, budget, args, '镜头 ' + (i + 1) + ' 归一', 180000);
    });
    const measured = av.ffprobe ? await probeDur(ctx.cfg, step.abs, budget) : null;
    const shotDur = measured ? Math.min(measured, dur) : dur;
    const s = { abs: step.abs, dur: shotDur, probed: measured !== null, segment: take.segment !== undefined ? String(take.segment) : undefined,
      xfade: take.xfade === true, degraded: Array.isArray(take.degraded) ? take.degraded : [], seq };
    segs.push(s); entries.push(s); contentBudget -= dur; if (step.reused) reused++;
  }
  if (!segs.length) throw laneErr('SRC_MISSING', '成片镜头全部不可达');
  if (endSec > 0) {
    const card = await cachedStep(ctx, 'compose-endcard', cardKey, '.mp4', (dest) => execChecked(ctx, budget,
      buildTitleCardArgs(ctx.cfg, { title: title || '感谢聆听', brand: 'AI 生成 · ' + brand, abs: dest, w: size.w, h: size.h,
        sec: endSec, aspectRatio: size.aspectRatio, fps: size.fps }), '片尾卡', 120000));
    entries.push({ abs: card.abs, dur: endSec }); if (card.reused) reused++;
  }
  const boundaries = []; let prevSeg;
  segs.forEach((s) => {
    const idx = entries.indexOf(s);
    const boundary = idx > 0 && (s.segment !== undefined && prevSeg !== undefined && s.segment !== prevSeg || s.xfade === true);
    if (boundary) boundaries.push(idx);
    if (s.segment !== undefined) prevSeg = s.segment;
  });
  const hasProbe = av.ffprobe && segs.every((s) => s.probed);
  if (!hasProbe) boundaries.length = 0;
  const durs = entries.map((e) => e.dur);
  const preliminary = buildComposeGraph(ctx.cfg, { segments: durs.map((dur) => ({ dur })), boundaries, tShiftSec, minDuration: COMPOSE.minSec,
    transition: r.transition, duration: r.transition_sec, transitionSeq: segs.map((s) => s.seq) });
  const takeWin = []; let acc = tShiftSec;
  segs.forEach((s) => { takeWin.push({ start: acc, end: acc + s.dur, degraded: s.degraded }); acc += s.dur; });
  const contentSec = Math.max(0.5, segs.reduce((sum, s) => sum + s.dur, 0)
    - preliminary.timeline.transitions.reduce((sum, tr) => sum + tr.duration, 0));
  const subs = normalizeSubtitles(p, contentSec, tShiftSec, takeWin, size);
  for (let i = 0; i < subs.length; i++) {
    const step = await cachedStep(ctx, 'compose-subtitle', { text: subs[i].text, size }, '.txt',
      async (dest) => { fs.writeFileSync(dest, subs[i].text + '\n', 'utf8'); });
    subs[i].textFile = step.abs; if (step.reused) reused++;
  }
  const graph = buildComposeGraph(ctx.cfg, { segments: durs.map((dur) => ({ dur })), boundaries, subtitles: subs, tShiftSec,
    badgeText: r.badge || p.badge, brandText: brand, minDuration: COMPOSE.minSec, transition: r.transition, duration: r.transition_sec,
    transitionSeq: segs.map((s) => s.seq) });
  const segmentHashes = [];
  for (let i = 0; i < entries.length; i++) segmentHashes.push({ sha256: await fileHash(entries[i].abs), dur: durs[i] });
  const graphKey = buildComposeGraph(ctx.cfg, { segments: durs.map((dur) => ({ dur })), boundaries,
    subtitles: subs.map((s) => Object.assign({}, s, { textFile: '<subtitle>' })), tShiftSec,
    badgeText: r.badge || p.badge, brandText: brand, minDuration: COMPOSE.minSec, transition: r.transition, duration: r.transition_sec,
    transitionSeq: segs.map((s) => s.seq) });
  const finalKey = { segments: segmentHashes,
    master: await fileHash(masterAbs), graph: graphKey.fc,
    subtitles: subs.map((s) => ({ text: s.text, start: s.start, end: s.end, emphasis: s.emphasis })), size, titleSec, endSec };
  const out = path.join(ctx.workDir, 'mv_video.mp4');
  const assembled = await cachedStep(ctx, 'compose-final', finalKey, '.mp4', async (dest) => {
    const args = ['-hide_banner', '-y', '-v', 'error']; for (const e of entries) args.push('-i', e.abs);
    args.push('-i', masterAbs, ...silenceBedArgs(graph.totalVideo), '-filter_complex', graph.fc, '-map', graph.mapV, '-map', graph.mapA,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(graph.totalVideo), '-movflags', '+faststart', dest);
    await execChecked(ctx, budget, args, '成片合成', TMO.ffmpeg);
  });
  fs.copyFileSync(assembled.abs, out); if (assembled.reused) reused++;
  const cover = path.join(ctx.workDir, 'cover.png');
  const coverSrc = typeof p.cover === 'string' ? p.cover : p.cover && (p.cover.path || p.cover.url);
  const configuredCover = coverSrc ? await resolveSrc(coverSrc, ctx) : null;
  if (coverSrc && !configuredCover) throw laneErr('SRC_MISSING', '指定封面不存在');
  const contentStart = tShiftSec, contentDur = Math.max(0.5, contentSec);
  const coverKey = { video: await fileHash(out), configured: configuredCover ? await fileHash(configuredCover) : null, size, contentStart, contentDur };
  const coverStep = await cachedStep(ctx, 'compose-cover', coverKey, '.png', async (dest) => {
    const vf = 'scale=' + size.w + ':' + size.h + ':force_original_aspect_ratio=increase,crop=' + size.w + ':' + size.h + ',format=rgb24';
    if (configuredCover) {
      await execChecked(ctx, budget, ['-hide_banner', '-y', '-v', 'error', '-i', configuredCover, '-vf', vf, '-frames:v', '1', dest], '指定封面', 60000);
    } else {
      const args = ['-hide_banner', '-y', '-v', 'error', '-ss', String(contentStart), '-t', String(contentDur), '-i', out];
      try { await execChecked(ctx, budget, args.concat('-vf', 'thumbnail=100,' + vf, '-frames:v', '1', dest), '代表帧封面', 60000); }
      catch (e) {
        if (e.failCode !== 'FFMPEG_FAILED') throw e;
        await execChecked(ctx, budget, ['-hide_banner', '-y', '-v', 'error', '-ss', String(contentStart + contentDur * 0.6), '-i', out,
          '-vf', vf, '-frames:v', '1', dest], '封面中间帧', 60000);
      }
    }
  });
  fs.copyFileSync(coverStep.abs, cover); if (coverStep.reused) reused++;
  let degraded = Array.isArray(p.degraded_shots) ? p.degraded_shots.map(String).slice(0, 64) : [];
  for (const s of segs) for (const d of s.degraded) if (degraded.indexOf(String(d)) === -1) degraded.push(String(d));
  budget.check(); fs.rmSync(tmp, { recursive: true, force: true }); await ctx.progress(95, '成片完成');
  return { result: { files: { mv_video: 'mv_video', cover: 'cover' }, duration_sec: Math.round(graph.totalVideo * 100) / 100,
    width: size.w, height: size.h, ai_label: true,
    sidecar: { subtitles: subs.length, music: String(p.audio_master || '').slice(0, 80), ai_label: true, degraded_shots: degraded },
    meta: { compose: true, title_applied: !!title, endcard_applied: endSec > 0, color_grade: 'eq+curves', ken_burns: true,
      cover_source: configuredCover ? 'job' : 'representative-frame', subtitle_lines: subs.reduce((n, s) => n + s.text.split('\n').length, 0),
      xfades: graph.xfades, xfade_disabled: hasProbe ? undefined : 'ffprobe_unavailable', cache_reused: reused } },
  files: [{ field: 'mv_video', filename: 'mv_video.mp4', abs: out }, { field: 'cover', filename: 'cover.png', abs: cover }] };
}

// ---------- 统一入口 ----------
const BRANCH = {
  mv_cast: 'vidspark',              // 方案一：女主原图 I2V 首帧定妆（2026-11-26）
  mv_cast_image: 'imgspark', mv_storyboard: 'imgspark',
  mv_cast_video: 'vidspark', mv_shot: 'vidspark',
  mv_lipsync: 'lipsync',
  mv_align: 'align',
  mv_preview: 'ffmpeg', mv_compose: 'ffmpeg',
};

async function runMvJob(job, ctx, helpers) {
  const type = String((job && job.type) || '');
  const branch = BRANCH[type];
  if (!branch) throw laneErr('UNSUPPORTED_JOB_TYPE', 'MV lane 不支持的任务类型：' + type);
  const mock = !!(ctx.cfg && ctx.cfg.mock);
  const h = helpers || {};
  // 真 mode 预检：只读观测 comfty 水位/位次（观测失败不阻塞，真提交时快速失败）
  if (!mock) {
    try {
      const [ram, q] = await Promise.all([comfy.observeRamFree(ctx.cfg), comfy.observeQueue(ctx.cfg)]);
      if (ctx.log) ctx.log('comfy 观测：ram_free=' + (ram ? ram.ram_free_gb.toFixed(1) + 'G' : 'n/a') + ' queue=' + (q ? q.queued + '待/' + q.processing + '运行' : 'n/a'));
      if (h.ramWaterlineGb && ram && ram.ram_free_gb < h.ramWaterlineGb) {
        // 水位挂起：等待期间靠心跳续租（index 层 60s 心跳已在跑）
        ctx.log('ram_free 低于水位线（' + ram.ram_free_gb.toFixed(1) + 'G），等待中（只观测不干预）');
        await new Promise((r) => setTimeout(r, 15000));
      }
    } catch (e) { /* 观测失败不致命 */ }
  }
  if (mock) {
    switch (type) {
      case 'mv_cast': return mockCastI2V(job, ctx);
      case 'mv_cast_image': return mockCastImage(job, ctx);
      case 'mv_cast_video': return mockCastVideo(job, ctx);
      case 'mv_storyboard': return mockStoryboard(job, ctx);
      case 'mv_shot': return mockShot(job, ctx);
      case 'mv_lipsync': return mockLipsync(job, ctx);
      case 'mv_align': return mockAlign(job, ctx);
      case 'mv_preview': return mockPreview(job, ctx);
      case 'mv_compose': return mockCompose(job, ctx);
    }
  }
  switch (type) {
    case 'mv_cast': return realCastI2V(job, ctx);
    case 'mv_cast_image': return realCastImage(job, ctx);
    case 'mv_cast_video': return realCastVideo(job, ctx);
    case 'mv_storyboard': return realStoryboard(job, ctx);
    case 'mv_shot': return realShot(job, ctx);
    case 'mv_lipsync': return realLipsync(job, ctx);
    case 'mv_align': return realAlign(job, ctx);
    case 'mv_preview': return realPreview(job, ctx);
    case 'mv_compose': return realCompose(job, ctx);
    default: throw laneErr('UNSUPPORTED_JOB_TYPE', '不支持的 MV 任务类型');
  }
}

module.exports = {
  runMvJob, BRANCH,
  // 导出字节桩供测试/自检复用
  synthPngBuf, synthMp4Buf, mockPng, mockMp4, extractFrames,
  normVf, gradeVf, dtText, dtPath, buildBadgeDrawtext, buildSubtitleDrawtext, buildTitleDrawtext, buildBrandDrawtext, buildTitleCardArgs,
  buildComposeGraph, buildPreviewArgs, buildZoompanVf, buildKenBurnsVf, motionSpec, motionFor, transitionSpec, composeTimeline, silenceBedArgs, normalizeSubtitles, wrapSubtitle,
  renderSize, engineSize, seedFor, canonical, stableHash, stageKey, fileHash, cachedStep, createBudget, concatEntry, runCmd, execChecked,
  lyricsText, normLine, splitLyricLines, evenSplitTimings,
  XF, TRANSITIONS, TITLE_CARD, SUB_Y, BADGE_TEXT, ZOOM, COMPOSE, MAX_SUBS, MAX_SUB_CHARS,
};
