// MV lane —— mv_* runner 表（imgspark/vidspark/lipsync/align/ffmpeg 五分支）（2026-11-24）
// 契约：docs/musicbox-phase2-architecture-design.md §4.1/§4.3；EXECUTOR_MOCK=1 下产真实可播假产物：
//   有 ffmpeg → lavfi testsrc2+正弦音 mp4 / lavfi color+drawtext png（真实可播）；
//   无 ffmpeg → 内置最小合法 PNG 字节桩（node:zlib 合成）+ 容器级最小 mp4 字节桩（ftyp+moov+mdat），
//   两者均在 result.meta.stub 如实标注；绝不吊死、绝不假成功（真 mode 走 lib/comfy.js + 83xx workers）。
// 真 mode 错误码族：COMFY_UNREACHABLE / COMFY_HTTP / COMFY_TIMEOUT / COMFY_QUEUE /
//   LIPSYNC_UNREACHABLE / ASR_UNREACHABLE / FFMPEG_MISSING / BAD_PARAMS。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('../lib/net.js');
const { resolveSrc } = require('../lib/paths.js');
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
const COMPOSE = { w: 720, h: 1280, minSec: 5, maxSec: 45 }; // 成片 9:16
const FRAME_STEP = 10; // 124f/10 ≈ 13 帧
// ---- 架构 §4.2 ffmpeg 视频基线常量表（lanes/mv.js 内 filter 常量表） ----
const XF = { transition: 'fade', duration: 0.5 };          // 段落转场：仅段落界
const TITLE_CARD = { sec: 2, w: 720, h: 1280 };            // 片名卡 2s 720×1280
const SUB_Y = 'h-text_h-h*0.08';                            // 字幕逐句 drawtext 纵位
const BADGE_TEXT = 'AI 生成';                                // AI 角标常驻（契约 v2.3 ai_label）
const ZOOM = "z='min(zoom+0.0015,1.3)'";                    // 轮播 zoompan（§4.2）
const MAX_BOARD = 16;                                       // 单次 compose/storyboard 素材上限
const MAX_SUBS = 60;                                        // 单次字幕 drawtext 上限
const FACEGATE_GATE = 0.6;                                  // 分镜低分门（mv-plan §4.7.1 gate 0.6）

function laneErr(code, message) { const e = new Error(message); e.failCode = code; e.failMessage = message; return e; }

// ---------- ffmpeg 运行（与一期 ffmpeg lane 同款 spawn 语义） ----------
function runCmd(bin, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    const out = [], errb = [];
    let outSize = 0;
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, opts.timeoutMs || 120000);
    child.stdout.on('data', (c) => { out.push(c); outSize += c.length; if (outSize > 512 * 1024 * 1024) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } } });
    child.stderr.on('data', (c) => { if (errb.reduce((s, x) => s + x.length, 0) < 64 * 1024) errb.push(c); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: null, stdout: Buffer.alloc(0), stderr: String(e.message || ''), missing: e.code === 'ENOENT' }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(errb).toString('utf8').slice(0, 800) }); });
  });
}
async function haveFfmpeg(cfg) {
  try { const av = await probe(cfg); return !!av.ffmpeg; } catch (e) { return false; }
}
// ffprobe 时长（无 ffprobe/失败返回 null，调用方兜底）
async function probeDur(cfg, abs) {
  try {
    const av = await probe(cfg);
    if (!av.ffprobe) return null;
    const r = await runCmd(cfg.ffprobeBin || 'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', abs], { timeoutMs: 30000 });
    if (r.code === 0) { const d = Number(String(r.stdout).trim()); if (Number.isFinite(d) && d > 0) return d; }
  } catch (e) { /* ignore */ }
  return null;
}

// ---------- §4.2 filter 图构建器（纯函数，可脱离 ffmpeg 断言；selftest/mv_filters_check.mjs 消费） ----------
// 归一（§4.2）：scale=W:H:force_original_aspect_ratio=decrease,pad,fps=24,setsar=1
function normVf(w, h) {
  return 'scale=' + w + ':' + h + ':force_original_aspect_ratio=decrease,pad=' + w + ':' + h
    + ':(ow-iw)/2:(oh-ih)/2:color=black,fps=24,setsar=1';
}
// drawtext 文本转义：filter 参数级（argv 直传无 shell），转 \ : ' ,，剥控制符
function dtText(s) {
  const body = String(s == null ? '' : s)
    .replace(/\s+/g, ' ').trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return "'" + body.slice(0, 120) + "'"; // 单引号包裹：内联 : ; , [ ] = 均为字面量（ffmpeg filter 引号规则）
}
function fontArg(cfg) {
  const f = (cfg && cfg.mvFontFile) || process.env.MB_MV_FONT || '';
  return f ? 'fontfile=' + dtText(f) + ':' : '';
}
// AI 角标常驻（无 enable → 全程可见）
function buildBadgeDrawtext(cfg, text) {
  return 'drawtext=' + fontArg(cfg) + 'text=' + dtText(text || BADGE_TEXT)
    + ':fontcolor=white@0.7:fontsize=h/28:x=w-text_w-w*0.03:y=h*0.03';
}
// 字幕逐句 drawtext（y=h-text_h-h*0.08；broll_subtitle 降级 → 强调档：更大字号+黄字粗描边）
function buildSubtitleDrawtext(cfg, sub, emphasis) {
  const fs = emphasis ? 'h/18' : 'h/24';
  const color = emphasis ? 'yellow' : 'white';
  const bw = emphasis ? 3 : 2;
  const st = Number(sub && sub.start), en = Number(sub && sub.end);
  const enable = (Number.isFinite(st) && Number.isFinite(en))
    ? ":enable='between(t," + st.toFixed(3) + ',' + en.toFixed(3) + ")'" : '';
  return 'drawtext=' + fontArg(cfg) + 'text=' + dtText(sub && sub.text)
    + ':fontcolor=' + color + ':fontsize=' + fs + ':borderw=' + bw + ':bordercolor=black@0.6'
    + ':x=(w-text_w)/2:y=' + SUB_Y + enable;
}
// 片名卡（2s 720×1280 黑底居中标题，独立 lavfi 预渲染）
function buildTitleCardArgs(cfg, opts) {
  const o = opts || {};
  const w = Number(o.w) || TITLE_CARD.w, h = Number(o.h) || TITLE_CARD.h, sec = Number(o.sec) || TITLE_CARD.sec;
  return ['-hide_banner', '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=' + w + 'x' + h + ':d=' + sec + ':r=24',
    '-vf', buildTitleDrawtext(cfg, o.title) + ',fps=24,setsar=1,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', String(o.abs)];
}
function buildTitleDrawtext(cfg, title) {
  return 'drawtext=' + fontArg(cfg) + 'text=' + dtText(title)
    + ':fontcolor=white:fontsize=h/16:borderw=2:bordercolor=black@0.5:x=(w-text_w)/2:y=(h-text_h)/2';
}
// compose 全链路 filter_complex（§4.2）：
//   输入约定：0..V-1=视频段（含可选片名卡第 0 段），V=master 音频，V+1=anullsrc 静音床
//   段落界（boundaries）才 xfade=transition=fade:duration=0.5；段内/无界 concat=n=N:v=1:a=0
//   铺轨 amix inputs=2:normalize=0 + volume 主 1.0（片名卡后 master 以 adelay 对齐镜头声画）
//   叠层：字幕逐句（enable 窗）+ AI 角标常驻
function buildComposeGraph(cfg, opts) {
  const o = opts || {};
  const segDurs = (Array.isArray(o.segments) ? o.segments : []).map((s) => Math.max(0.1, Number(s && s.dur) || 3));
  if (!segDurs.length) throw laneErr('BAD_PARAMS', 'compose filter 图缺少视频段');
  const boundaries = new Set((Array.isArray(o.boundaries) ? o.boundaries : []).filter((i) => i > 0 && i < segDurs.length));
  const subs = Array.isArray(o.subtitles) ? o.subtitles : [];
  const V = segDurs.length;
  const fc = [];
  const groups = []; let cur = [];
  segDurs.forEach((d, i) => { if (boundaries.has(i) && cur.length) { groups.push(cur); cur = []; } cur.push(i); });
  if (cur.length) groups.push(cur);
  let prev = null, tEnd = 0, xfades = 0;
  groups.forEach((g, gi) => {
    let lab;
    if (g.length === 1) lab = '[' + g[0] + ':v]';
    else {
      lab = '[g' + gi + ']';
      fc.push(g.map((i) => '[' + i + ':v]').join('') + 'concat=n=' + g.length + ':v=1:a=0' + lab);
    }
    const gDur = g.reduce((s, i) => s + segDurs[i], 0);
    if (!prev) { prev = lab; tEnd = gDur; }
    else {
      const out = '[x' + gi + ']';
      const off = Math.max(0, tEnd - XF.duration);
      fc.push(prev + lab + 'xfade=transition=' + XF.transition + ':duration=' + XF.duration + ':offset=' + off.toFixed(3) + out);
      tEnd = tEnd + gDur - XF.duration;
      prev = out; xfades++;
    }
  });
  const dts = [];
  for (const s of subs) dts.push(buildSubtitleDrawtext(cfg, s, !!s.emphasis));
  dts.push(buildBadgeDrawtext(cfg, o.badgeText)); // AI 角标常驻
  fc.push(prev + dts.join(',') + '[vout]');
  const shiftMs = Math.max(0, Math.round((Number(o.tShiftSec) || 0) * 1000));
  const adelay = shiftMs > 0 ? ',adelay=' + shiftMs + '|' + shiftMs : '';
  fc.push('[' + V + ':a]volume=1.0' + adelay + '[mbd]');
  fc.push('[' + (V + 1) + ':a]volume=0.0[sbd]');
  fc.push('[mbd][sbd]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[aout]');
  return { fc: fc.join(';'), totalVideo: tEnd, xfades, mapV: '[vout]', mapA: '[aout]' };
}
// 轮播 zoompan（§4.2）：先归一后 zoompan，输入 -loop 1 -framerate 24 -t sec
function buildZoompanVf(w, h) {
  return normVf(w, h) + ',zoompan=' + ZOOM
    + ":d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=" + w + 'x' + h + ':fps=24,format=yuv420p';
}
// 静音音床输入（preview 铺轨）
function silenceBedArgs(sec) {
  return ['-f', 'lavfi', '-t', String(Math.max(0.1, Number(sec) || 1)), '-i', 'anullsrc=r=48000:cl=stereo'];
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

// ---------- facegate 客户端（真 mode，观测失败不致命） ----------
async function facegateScore(cfg, ctx, imgAbs, refFile) {
  const url = String(cfg.facegateUrl || 'http://127.0.0.1:8395').replace(/\/+$/, '');
  try {
    const b64 = fs.readFileSync(imgAbs).toString('base64');
    const res = await net.request('POST', url + '/score', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ img_b64: b64, ref_file: refFile || undefined }),
      timeoutMs: 15000,
    });
    const j = res.json();
    if (res.status === 200 && j && Number.isFinite(Number(j.score))) return { score: Number(j.score), pass: !!j.pass, yaw: j.yaw, pitch: j.pitch };
    ctx.log('facegate /score 返回 ' + res.status + '（评分缺省）');
  } catch (e) {
    ctx.log('facegate 不可达（评分缺省，不致命）：' + e.message);
  }
  return { score: null, pass: false };
}
// inswapper 换脸兜底（mv-plan §4.7.1：分镜低分 → /swap ×2，非致命；不可达 → 透传）
// 返回 {bytes, score} | {unreachable:true} | null（协议级失败）
async function facegateSwap(cfg, ctx, imgAbs, refFile) {
  const url = String(cfg.facegateUrl || 'http://127.0.0.1:8395').replace(/\/+$/, '');
  try {
    const b64 = fs.readFileSync(imgAbs).toString('base64');
    const res = await net.request('POST', url + '/swap', {
      headers: { 'content-type': 'application/json' },
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
  if (!frames.length) { // 兜底桩帧（不吊死）
    for (let i = 1; i <= count; i++) {
      const p = path.join(dir, 'frame_' + String(i).padStart(2, '0') + '.png');
      fs.writeFileSync(p, synthPngBuf(184, 328, i * 7919));
      frames.push(p);
    }
  }
  return frames;
}

// ---------- mock 分支 ----------
async function mockCastImage(job, ctx) {
  const p = job.payload || {};
  const seedBase = Number(p.seed) || 424242;
  const files = [], scores = [], stubs = [];
  for (let i = 1; i <= CAST_IMG.n; i++) {
    await ctx.progress(Math.round((i / CAST_IMG.n) * 90), '定妆候选 ' + i + '/' + CAST_IMG.n);
    const abs = path.join(ctx.workDir, 'cast_image_' + i + '.png');
    stubs.push((await mockPng(ctx.cfg, ctx, abs, CAST_IMG.w, CAST_IMG.h, 'CAST ' + i)).stub);
    files.push({ field: 'cast_image_' + i, filename: 'cast_image_' + i + '.png', abs });
    scores.push(null); // mock 不评分
  }
  return {
    result: { files: { cast_image: 'cast_image_1' }, seed_base: seedBase, face_scores: scores, mock: true, meta: { stub: stubs[0] || null } },
    files,
  };
}
async function mockCastVideo(job, ctx) {
  await ctx.progress(10, '定妆视频生成中（mock）');
  const abs = path.join(ctx.workDir, 'cast_video.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, CAST_VID.w, CAST_VID.h, CAST_VID.sec, 'cast_video');
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
  const files = [], map = {}, stubs = [];
  const n = Math.max(1, Math.min(16, shots.length));
  for (let i = 0; i < n; i++) {
    await ctx.progress(Math.round(((i + 1) / n) * 90), '分镜关键帧 ' + (i + 1) + '/' + n);
    const id = String(shots[i].id || ('shot_' + (i + 1))).replace(/[^\w.\-]/g, '_').slice(0, 48);
    const abs = path.join(ctx.workDir, 'board_' + id + '.png');
    stubs.push((await mockPng(ctx.cfg, ctx, abs, CAST_IMG.w, CAST_IMG.h, 'BOARD ' + id)).stub);
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
  const st = await mockMp4(ctx.cfg, ctx, abs, SHOT_VID.w, SHOT_VID.h, sec, 'clip_' + shotId);
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
  const abs = path.join(ctx.workDir, 'mv_video.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, COMPOSE.w, COMPOSE.h, sec, 'mv_video');
  await ctx.progress(80, '封面（mock）');
  const cover = path.join(ctx.workDir, 'cover.png');
  fs.writeFileSync(cover, synthPngBuf(360, 640, 777));
  return {
    result: {
      files: { mv_video: 'mv_video', cover: 'cover' },
      duration_sec: sec, ai_label: true,
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
  const abs = path.join(ctx.workDir, 'preview.mp4');
  const st = await mockMp4(ctx.cfg, ctx, abs, COMPOSE.w, COMPOSE.h, sec, 'preview');
  return {
    result: { files: { preview: 'preview' }, duration_sec: sec, boards: boards.length, mock: true, meta: { stub: st.stub } },
    files: [{ field: 'preview', filename: 'preview.mp4', abs }],
  };
}

// ---------- 真 mode 分支（lib/comfy.js + 83xx workers；绝不在此发 mock 网络调用） ----------

// mv_cast_image：上传照垫图 → h3-image-cast ×3 seed → facegate 对照评分（失败缺省不致命）
async function realCastImage(job, ctx) {
  const p = job.payload || {};
  const seedBase = Number(p.seed) || 424242;
  let refImage = 'placeholder.png';
  const portraitAbs = await resolveSrc(p.portrait_path, ctx);
  if (portraitAbs) refImage = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(portraitAbs), path.basename(portraitAbs));
  const desc = String(p.desc || (p.gender === 'm' ? 'young man, studio portrait' : 'young woman, studio portrait')).slice(0, 900);
  const files = [], faceScores = [];
  for (let i = 1; i <= CAST_IMG.n; i++) {
    await ctx.progress(Math.round((i / CAST_IMG.n) * 85), '定妆候选 ' + i + '/' + CAST_IMG.n + '（引擎）');
    const r = await comfySubmit(ctx.cfg, ctx, 'h3-image-cast', {
      PROMPT: desc, WIDTH: CAST_IMG.w, HEIGHT: CAST_IMG.h, SEED: (seedBase + i) >>> 0,
      REF_IMAGE_1: refImage, REF_IMAGE_2: refImage, REF_IMAGE_3: refImage,
    }, TMO.imgspark);
    const abs = path.join(ctx.workDir, 'cast_image_' + i + r.ext);
    fs.writeFileSync(abs, r.bytes);
    files.push({ field: 'cast_image_' + i, filename: 'cast_image_' + i + r.ext, abs });
    if (portraitAbs) { const s = await facegateScore(ctx.cfg, ctx, abs, p.portrait_path); faceScores.push(s.score); } else faceScores.push(null);
  }
  await ctx.progress(95, '定妆完成');
  const map = {}; for (let i = 1; i <= CAST_IMG.n; i++) map['cast_image_' + i] = 'cast_image_' + i;
  return { result: { files: map, seed_base: seedBase, face_scores: faceScores, meta: { comfy: true } }, files };
}

// mv_cast_video：h3-fl2va 定妆视频（736×1312·124f·turbo4）→ ffmpeg 抽 ~13 帧 → facegate 逐帧
async function realCastVideo(job, ctx) {
  const p = job.payload || {};
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件，定妆抽帧不可用');
  let first = 'placeholder.png';
  const castAbs = await resolveSrc(p.cast_image, ctx);
  if (castAbs) first = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(castAbs), path.basename(castAbs));
  else throw laneErr('SRC_MISSING', '定妆照源文件不存在');
  await ctx.progress(15, '定妆视频生成中（引擎）');
  const r = await comfySubmit(ctx.cfg, ctx, 'h3-fl2va', {
    FIRST_FRAME: first, PROMPT: String(p.motion || 'natural head turn, subtle expression').slice(0, 900),
    WIDTH: CAST_VID.w, HEIGHT: CAST_VID.h, LENGTH: 124, STEPS: 4, SEED: (Number(p.seed) || 424242) >>> 0,
  }, TMO.vidspark);
  const vidAbs = path.join(ctx.workDir, 'cast_video' + r.ext);
  fs.writeFileSync(vidAbs, r.bytes);
  await ctx.progress(70, '抽帧与评分中');
  const framePaths = await extractFrames(ctx.cfg, ctx, vidAbs, ctx.workDir, CAST_VID.frames);
  const files = [{ field: 'cast_video', filename: 'cast_video' + r.ext, abs: vidAbs }];
  const frames = [];
  for (let i = 0; i < framePaths.length; i++) {
    files.push({ field: 'frame_' + (i + 1), filename: path.basename(framePaths[i]), abs: framePaths[i] });
    const s = await facegateScore(ctx.cfg, ctx, framePaths[i], p.cast_image);
    frames.push({ file: 'frame_' + (i + 1), score: s.score, pass: s.pass, yaw: s.yaw, pitch: s.pitch });
  }
  await ctx.progress(95, '定妆视频完成');
  return { result: { files: { cast_video: 'cast_video' }, duration_sec: CAST_VID.sec, frames, meta: { comfy: true } }, files };
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
  const n = Math.min(MAX_BOARD, shots.length);
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
        WIDTH: CAST_IMG.w, HEIGHT: CAST_IMG.h, SEED: (424242 + i * 977) >>> 0,
        REF_IMAGE: refImage,
      }, TMO.imgspark);
      abs = path.join(ctx.workDir, 'board_' + id + r.ext);
      fs.writeFileSync(abs, r.bytes);
      // 身份门：对照 viewRef 打分，低分 → inswapper ×2（非致命；不可达透传注记）
      let sc = (await facegateScore(ctx.cfg, ctx, abs, vr)).score;
      let swaps = 0;
      while (sc !== null && sc < FACEGATE_GATE && swaps < 2) {
        const sw = await facegateSwap(ctx.cfg, ctx, abs, vr);
        if (!sw || sw.unreachable) { notes.push('board_' + id + ':facegate_unreachable'); break; }
        fs.writeFileSync(abs, sw.bytes);
        swaps++;
        sc = sw.score !== null && sw.score !== undefined ? sw.score
          : (await facegateScore(ctx.cfg, ctx, abs, vr)).score;
        ctx.log('board_' + id + ' 低分降级：inswapper 第 ' + swaps + ' 次（score=' + (sc === null ? 'n/a' : sc) + '）');
      }
      if (swaps > 0) notes.push('board_' + id + ':swapped×' + swaps);
      if (sc !== null && sc < FACEGATE_GATE && swaps === 0) notes.push('board_' + id + ':low_score=' + sc);
    } else {
      // 空镜/剧情镜：t2i（纯描述，无身份约束）
      const r = await comfySubmit(ctx.cfg, ctx, 'h3-image-cast', {
        PROMPT: (desc + ' ' + cam).slice(0, 900),
        WIDTH: CAST_IMG.w, HEIGHT: CAST_IMG.h, SEED: (424242 + i * 977) >>> 0,
        REF_IMAGE_1: 'placeholder.png', REF_IMAGE_2: 'placeholder.png', REF_IMAGE_3: 'placeholder.png',
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
  let first = 'placeholder.png';
  const ffAbs = await resolveSrc(shot.first_frame, ctx);
  if (ffAbs) first = await comfy.uploadAsset(ctx.cfg, fs.readFileSync(ffAbs), path.basename(ffAbs));
  else throw laneErr('SRC_MISSING', '镜头首帧不存在');
  const sec = Math.max(2, Math.min(10, Number(shot.sec) || 5));
  await ctx.progress(10, '开拍（引擎，' + sec + 's）');
  const sings = String(shot.singing || '').trim();
  // sings IR 变体（架构 lib/h3ir.js §4「六段式 IR sings 变体=对镜歌唱表演」语义）：
  //   口型由 post-hoc mv_lipsync 指定音频驱动（ADR-MV-3），不要求模型唱准，只要求唇随旋律自然开合
  const prompt = (sings ? '对镜歌唱表演，唇随旋律自然开合。' : '') + String(shot.motion || '').slice(0, 700);
  const r = await comfySubmit(ctx.cfg, ctx, 'h3-fl2va', {
    FIRST_FRAME: first, PROMPT: prompt, WIDTH: SHOT_VID.w, HEIGHT: SHOT_VID.h,
    LENGTH: Math.min(362, Math.round(sec * 24)), STEPS: 4, SEED: (Number(p.seed) || 424242) >>> 0,
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
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

// mv_preview（§4.2）：分镜图 loop+zoompan 轮播（1.5–6s/图，z='min(zoom+0.0015,1.3)'）+ 静音音床 → preview.mp4
// zoompan 失败（老版本 ffmpeg）→ 退回静态归一帧（如实注记，非致命）
async function realPreview(job, ctx) {
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件，样片不可用');
  const p = job.payload || {};
  const boards = Array.isArray(p.board_urls) ? p.board_urls : [];
  if (!boards.length) throw laneErr('BAD_PARAMS', '分镜图列表为空');
  const seg = Math.max(1.5, Math.min(6, Number(p.seg_sec) || 2)); // §4.1：1.5–6s/图
  const n = Math.min(MAX_BOARD, boards.length);
  const tmp = path.join(ctx.workDir, 'prev');
  fs.mkdirSync(tmp, { recursive: true });
  const listFile = path.join(tmp, 'list.txt');
  const lines = [];
  let zoompanFellBack = false;
  for (let i = 0; i < n; i++) {
    await ctx.progress(Math.round(((i + 1) / n) * 70), '轮播段 ' + (i + 1) + '/' + n);
    const abs = await resolveSrc(boards[i], ctx);
    if (!abs) continue;
    const segAbs = path.join(tmp, 'seg_' + i + '.mp4');
    const vfy = buildZoompanVf(COMPOSE.w, COMPOSE.h);
    let r = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
      ['-hide_banner', '-y', '-v', 'error', '-loop', '1', '-framerate', '24', '-t', String(seg), '-i', abs,
        ...silenceBedArgs(seg),
        '-vf', vfy, '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', segAbs], { timeoutMs: 180000 });
    if (!(r.code === 0 && fs.existsSync(segAbs) && fs.statSync(segAbs).size > 200)) {
      // 退回静态归一（无 zoompan）
      const r2 = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
        ['-hide_banner', '-y', '-v', 'error', '-loop', '1', '-framerate', '24', '-t', String(seg), '-i', abs,
          ...silenceBedArgs(seg),
          '-vf', normVf(COMPOSE.w, COMPOSE.h) + ',format=yuv420p', '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', segAbs], { timeoutMs: 180000 });
      if (!(r2.code === 0 && fs.existsSync(segAbs) && fs.statSync(segAbs).size > 200)) continue;
      zoompanFellBack = true;
    }
    lines.push("file '" + segAbs.replace(/\\/g, '/') + "'");
  }
  if (!lines.length) throw laneErr('SRC_MISSING', '分镜图全部不可达');
  fs.writeFileSync(listFile, lines.join('\n'));
  const out = path.join(ctx.workDir, 'preview.mp4');
  const rc = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
    ['-hide_banner', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out], { timeoutMs: TMO.ffmpeg });
  if (rc.code !== 0 || !fs.existsSync(out)) throw laneErr('FFMPEG_FAILED', '样片拼接失败：' + (rc.stderr || '未知原因'));
  await ctx.progress(95, '样片完成');
  return {
    result: { files: { preview: 'preview' }, duration_sec: Math.round(lines.length * seg * 100) / 100, boards: lines.length, meta: { zoompan: !zoompanFellBack, note: zoompanFellBack ? 'zoompan 不可用，已退回静态帧' : null } },
    files: [{ field: 'preview', filename: 'preview.mp4', abs: out }],
  };
}

// 字幕规格化（compose 叠层输入，形状宽容）：
//   p.subtitles = [string...] 均匀铺 | [{line|text,start|start_sec,end|end_sec}...]（timings 同源，ADR-MV-11 三分用之字幕）
//   tShiftSec = 片名卡偏移（master/字幕与镜头声画对齐）；takeWin 供 broll_subtitle 强调判定
function normalizeSubtitles(p, contentSec, tShiftSec, takeWin) {
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
      const text = String(t || '').trim();
      if (text) out.push({ text, start: shift + i * step, end: shift + (i + 1) * step - 0.1 });
    });
  } else {
    for (const s of raw) {
      if (!s) continue;
      const text = String(s.text != null ? s.text : s.line || '').trim();
      if (!text) continue;
      const st = Number(s.start != null ? s.start : s.start_sec);
      const en = Number(s.end != null ? s.end : s.end_sec);
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
//   逐 take：-an 剥音 → 归一 scale=W:H:forOAR=decrease,pad,fps=24,setsar=1（libx264 中间段）
//   片名卡：2s 720×1280 lavfi 预渲染，前置
//   拼接：段内/无界 concat=n=N:v=1:a=0；段落界（takes[i].segment 变化或 xfade=true）才 xfade=fade:0.5
//   铺轨：master volume=1.0（片名卡后 adelay 对齐）+ 静音床 → amix inputs=2:normalize=0
//   叠层：逐句字幕 drawtext（y=h-text_h-h*0.08；broll_subtitle → 强调档）+ AI 角标常驻
//   封面：成片首帧（有片名卡则跳过卡取首个镜头帧）
//   sidecar{subtitles,music,ai_label,degraded_shots}；无 ffmpeg 真 mode → FFMPEG_MISSING（mock 走字节桩，见 mockCompose）
async function realCompose(job, ctx) {
  if (!(await haveFfmpeg(ctx.cfg))) throw laneErr('FFMPEG_MISSING', '本机尚未安装视频处理组件，合成不可用');
  const p = job.payload || {};
  const takes = Array.isArray(p.takes) ? p.takes : [];
  if (!takes.length) throw laneErr('BAD_PARAMS', '成片镜头列表为空');
  const tmp = path.join(ctx.workDir, 'cmp');
  fs.mkdirSync(tmp, { recursive: true });
  // ① 逐 take：-an 剥音 → 归一
  const segs = []; // {abs, dur, degraded[], segment}
  for (let i = 0; i < Math.min(MAX_BOARD, takes.length); i++) {
    await ctx.progress(Math.round(((i + 1) / Math.min(MAX_BOARD, takes.length)) * 55), '归一 ' + (i + 1) + '/' + Math.min(MAX_BOARD, takes.length));
    const abs = await resolveSrc(takes[i].video, ctx);
    if (!abs) continue;
    const segAbs = path.join(tmp, 'norm_' + i + '.mp4');
    const r = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
      ['-hide_banner', '-y', '-v', 'error', '-i', abs, '-an',
        '-vf', normVf(COMPOSE.w, COMPOSE.h) + ',format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', segAbs], { timeoutMs: TMO.ffmpeg });
    if (r.code !== 0 || !fs.existsSync(segAbs)) continue;
    segs.push({
      abs: segAbs,
      dur: await probeDur(ctx.cfg, segAbs),
      degraded: Array.isArray(takes[i].degraded) ? takes[i].degraded : [],
      segment: takes[i].segment !== undefined ? String(takes[i].segment) : undefined,
      xfade: takes[i].xfade === true,
    });
  }
  if (!segs.length) throw laneErr('SRC_MISSING', '成片镜头全部不可达');
  // ② 片名卡（2s 720×1280，§4.2）
  const title = String(p.title || '').slice(0, 40).trim(); // scrubbing/escaping unified in dtText
  const segFiles = []; const segDurs = []; const boundaries = [];
  let tShiftSec = 0;
  if (title) {
    const titleAbs = path.join(tmp, 'title.mp4');
    const rt = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
      buildTitleCardArgs(ctx.cfg, { title, abs: titleAbs, w: TITLE_CARD.w, h: TITLE_CARD.h, sec: TITLE_CARD.sec }),
      { timeoutMs: 120000 });
    if (rt.code === 0 && fs.existsSync(titleAbs)) {
      segFiles.push(titleAbs);
      segDurs.push(await probeDur(ctx.cfg, titleAbs) || TITLE_CARD.sec);
      tShiftSec = segDurs[0]; // master/字幕延后片名卡时长，声画对位
    }
  }
  // ③ 段落界识别（仅段落界 xfade；segment 变化或显式 xfade 标记）
  let prevSeg;
  segs.forEach((s, i) => {
    segFiles.push(s.abs);
    segDurs.push(s.dur || Math.max(0.5, Number(takes[i].dur_sec) || Number(takes[i].sec) || 3));
    const isBoundary = (s.segment !== undefined && prevSeg !== undefined && s.segment !== prevSeg) || s.xfade === true;
    if (isBoundary && (segFiles.length > 1)) boundaries.push(segFiles.length - 1); // 相对最终输入序（含片名卡偏移）
    if (s.segment !== undefined) prevSeg = s.segment;
  });
  // 片名卡是否真的在段序列里（渲染失败则无卡，索引/封面偏移都以 hasTitle 为准，不以 title 字符串为准）
  const hasTitle = segFiles.length - segs.length === 1;
  // ④ ffprobe 缺位 → 无法算 xfade offset：退回纯 concat（如实注记，不失败）
  let xfadeDisabledByProbe = false;
  if (boundaries.length && segDurs.some((d) => !Number.isFinite(d))) {
    boundaries.length = 0; xfadeDisabledByProbe = true;
  }
  // ⑤ 字幕 + 强调（take 时间窗近似：累加时长 − xfade 收缩）
  const contentSec = segDurs.reduce((a, b) => a + b, 0) - boundaries.length * XF.duration;
  const takeWin = [];
  {
    let acc = tShiftSec;
    segs.forEach((s, i) => {
      const idx = i + (hasTitle ? 1 : 0);
      const d = segDurs[idx] || 3;
      takeWin.push({ start: acc, end: acc + d, degraded: s.degraded });
      acc += d - (boundaries.includes(idx) ? XF.duration : 0);
    });
  }
  const subs = normalizeSubtitles(p, contentSec - tShiftSec, tShiftSec, takeWin);
  // ⑥ master 唯一音轨 + 静音床 + filter_complex
  const masterAbs = await resolveSrc(p.audio_master, ctx);
  if (!masterAbs) throw laneErr('SRC_MISSING', '母带音频不存在');
  const graph = buildComposeGraph(ctx.cfg, {
    segments: segDurs.map((d) => ({ dur: d })),
    boundaries, subtitles: subs, tShiftSec,
  });
  const inArgs = [];
  for (const f of segFiles) inArgs.push('-i', f);
  inArgs.push('-i', masterAbs);
  inArgs.push(...silenceBedArgs(graph.totalVideo + 5));
  const out = path.join(ctx.workDir, 'mv_video.mp4');
  const r2 = await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
    ['-hide_banner', '-y', '-v', 'error', ...inArgs,
      '-filter_complex', graph.fc, '-map', graph.mapV, '-map', graph.mapA,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest',
      out], { timeoutMs: TMO.ffmpeg });
  if (r2.code !== 0 || !fs.existsSync(out)) throw laneErr('FFMPEG_FAILED', '合成失败：' + (r2.stderr || '未知原因'));
  // ⑦ 封面 = 首帧（有片名卡则跳过卡，取首个镜头帧）
  const cover = path.join(ctx.workDir, 'cover.png');
  await runCmd(ctx.cfg.ffmpegBin || 'ffmpeg',
    ['-hide_banner', '-y', '-v', 'error', ...(hasTitle ? ['-ss', String((segDurs[0] || TITLE_CARD.sec) + 0.08)] : []),
      '-i', out, '-frames:v', '1', cover], { timeoutMs: 60000 });
  // ⑧ sidecar（degraded_shots：payload 真源 + take 内标记并集，透传供 report/音画报告）
  let degraded = Array.isArray(p.degraded_shots) ? p.degraded_shots.map(String).slice(0, 64) : [];
  for (const s of segs) for (const d of (s.degraded || [])) if (degraded.indexOf(String(d)) === -1) degraded.push(String(d));
  await ctx.progress(95, '成片完成');
  const files = [{ field: 'mv_video', filename: 'mv_video.mp4', abs: out }];
  const result = {
    files: { mv_video: 'mv_video' },
    ai_label: true,
    sidecar: {
      subtitles: subs.length,
      music: String(p.audio_master || '').slice(0, 80),
      ai_label: true,
      degraded_shots: degraded,
    },
    meta: {
      compose: true, title_applied: hasTitle, subtitle_emphasis: subs.some((s) => s.emphasis) || undefined,
      xfades: graph.xfades, xfade_disabled: xfadeDisabledByProbe ? 'ffprobe_unavailable' : undefined,
      filter_baseline: '§4.2',
    },
  };
  if (fs.existsSync(cover) && fs.statSync(cover).size > 200) { files.push({ field: 'cover', filename: 'cover.png', abs: cover }); result.files.cover = 'cover'; }
  return { result, files };
}

// ---------- 统一入口 ----------
const BRANCH = {
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
  // §4.2 filter 图构建器（纯函数，无 ffmpeg 亦可断言 —— selftest/mv_filters_check.mjs 消费）
  normVf, dtText, buildBadgeDrawtext, buildSubtitleDrawtext, buildTitleDrawtext, buildTitleCardArgs,
  buildComposeGraph, buildZoompanVf, silenceBedArgs, normalizeSubtitles,
  // mv_align 归一/兜底（纯函数）
  lyricsText, normLine, splitLyricLines, evenSplitTimings,
  // 常量表（自测试断言 §4.2 口径）
  XF, TITLE_CARD, SUB_Y, BADGE_TEXT, ZOOM, COMPOSE,
};
