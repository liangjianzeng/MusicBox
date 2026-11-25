// 全加载真引擎探针（DGX 单机，2026-11-25）—— 音乐/图像/视频 三发，**不卸载之间**，内存与耗时留档
// 用法: node src/executor/selftest/fullload_real.mjs <music|image|video|all> [--seed N]
// env（照 ~/MusicBox/etc/spark.env，先 `set -a; . etc/spark.env; set +a`）:
//   MB_MUSIC_URL(默认 :8190)  MB_COMFY_URL(默认 :8188)  MB_VAR_DIR
// 纪律：共宿主只发任务+只读观测（无 /free）；产物落 var/out/fullload/；输出 JSON 一行便于留档。
'use strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const net = require('../lib/net.js');
const comfy = require('../lib/comfy.js');

const VAR = process.env.MB_VAR_DIR || path.join(__dirname, '..', '..', '..', 'var');
const OUT = path.join(VAR, 'out', 'fullload');
const MUSIC_URL = String(process.env.MB_MUSIC_URL || 'http://127.0.0.1:8190').replace(/\/+$/, '');
const CFG = { comfyUrl: process.env.MB_COMFY_URL || 'http://127.0.0.1:8188' };
const IMG_PROMPT = 'young woman, studio portrait, soft key light, neutral backdrop, calm expression, upper body';
const VID_PROMPT = 'natural head turn, subtle smile, looking at camera, static camera';

fs.mkdirSync(OUT, { recursive: true });
const arg = process.argv[2] || 'all';
const seedIdx = process.argv.indexOf('--seed');
const SEED = seedIdx > -1 ? Number(process.argv[seedIdx + 1]) : 424242;
const log = (m) => console.error('[fullload] ' + m);

async function memSample() {
  const out = {};
  try {
    const s = await comfy.getSystemStats(CFG);
    if (s && s.system) {
      out.ram_free_gb = +(s.system.ram_free / 1024 ** 3).toFixed(1);
      out.ram_total_gb = +(s.system.ram_total / 1024 ** 3).toFixed(1);
      out.vram_free_gb = s.system.vram_free ? +(s.system.vram_free / 1024 ** 3).toFixed(1) : null;
      out.comfy_memory_used_to_recreate = s.system.memory_used_to_recreate ? Math.round(s.system.memory_used_to_recreate / 1024 ** 3) : null;
    }
  } catch (e) { out.comfy_stats_err = e.code || e.message; }
  try {
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const g = (k) => { const m = new RegExp('^' + k + ':\\s+([0-9]+) kB', 'm').exec(mi); return m ? Math.round(Number(m[1]) / 1024) : null; };
    out.host_total_gb = g('MemTotal'); out.host_available_gb = g('MemAvailable');
  } catch (e) { /* 非 Linux 留档跳过 */ }
  return out;
}

async function stepMusic() {
  const t0 = Date.now();
  const body = { mood: '温暖，给妈妈写首温馨的生日歌', seconds: 45, seed: SEED, tags: 'piano,strings,warm,gentle', lyrics: '', instrumental: false, prompt: 'warm birthday song, soft piano and strings' };
  const res = await net.request('POST', MUSIC_URL + '/music', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), timeoutMs: 300000 });
  if (res.status !== 200) throw new Error('music HTTP ' + res.status + ': ' + res.body.slice(0, 300).toString('utf8'));
  const j = res.json();
  const abs = path.join(OUT, Date.now() + '_music.wav');
  fs.copyFileSync(j.file, abs);
  return { step: 'music', file: abs, seconds: j.seconds, gen_seconds: j.gen_seconds, model_seconds: j.model_seconds, warmup_seconds: j.warmup_seconds, vram_peak_mb: j.vram_peak_mb, task_type: j.task_type, seed: j.seed, wall_ms: Date.now() - t0 };
}

async function stepImage() {
  const t0 = Date.now();
  const r = await comfy.submitComfyJob({
    cfg: CFG, templateName: 'h3-image-cast', jobId: 'fullload',
    values: { PROMPT: IMG_PROMPT, WIDTH: 864, HEIGHT: 1536, SEED: (SEED + 1) >>> 0, REF_IMAGE_1: 'placeholder.png', REF_IMAGE_2: 'placeholder.png', REF_IMAGE_3: 'placeholder.png' },
    timeoutMs: 600000, log,
  });
  const abs = path.join(OUT, Date.now() + '_cast' + r.ext);
  fs.writeFileSync(abs, r.bytes);
  return { step: 'image', file: abs, bytes: r.bytes.length, ext: r.ext, comfy_filename: r.filename, prompt_id: r.promptId, wall_ms: Date.now() - t0 };
}

async function stepVideo() {
  const t0 = Date.now();
  const cast = fs.readdirSync(OUT).filter((f) => /_cast\.(png|jpg)$/i.test(f)).sort();
  if (!cast.length) throw new Error('全加载链：先跑 image 步骤（定妆照首帧垫图缺）');
  const castAbs = path.join(OUT, cast[cast.length - 1]);
  const first = await comfy.uploadAsset(CFG, fs.readFileSync(castAbs), path.basename(castAbs));
  const r = await comfy.submitComfyJob({
    cfg: CFG, templateName: 'h3-fl2va', jobId: 'fullload',
    values: { FIRST_FRAME: first, PROMPT: VID_PROMPT, WIDTH: 736, HEIGHT: 1312, LENGTH: 124, STEPS: 4, SEED: (SEED + 2) >>> 0 },
    timeoutMs: 900000, log,
  });
  const abs = path.join(OUT, Date.now() + '_cast_video' + r.ext);
  fs.writeFileSync(abs, r.bytes);
  return { step: 'video', file: abs, bytes: r.bytes.length, ext: r.ext, comfy_filename: r.filename, prompt_id: r.promptId, first_frame: first, wall_ms: Date.now() - t0 };
}

(async () => {
  const steps = arg === 'all' ? ['music', 'image', 'video'] : [arg];
  for (const s of steps) {
    const before = await memSample();
    const t0 = Date.now();
    let r;
    try {
      r = s === 'music' ? await stepMusic() : s === 'image' ? await stepImage() : await stepVideo();
    } catch (e) {
      console.log(JSON.stringify({ step: s, fail: e.failCode || e.code || 'ERR', message: e.failMessage || e.message, wall_ms: Date.now() - t0 }));
      if (arg === 'all') break;
      process.exitCode = 1; return;
    }
    const after = await memSample();
    console.log(JSON.stringify(Object.assign(r, { mem_before: before, mem_after: after })));
  }
})().catch((e) => { console.error('[fullload] FATAL ' + (e.stack || e.message)); process.exit(1); });
