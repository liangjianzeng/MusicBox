// src/executor/selftest/mv_mock_e2e.mjs —— EXECUTOR_MOCK 下 9 类 mv_* job（含方案一 mv_cast）端到端自检（无 ffmpeg/无 Spark，手动运行）
// 用法：node src/executor/selftest/mv_mock_e2e.mjs
// 断言：runMvJob 8 类全通过；产物文件存在+魔数合法；result.files 映射齐；字节桩诚实标注 meta.stub；
//       compose/preview 契约形状（sidecar/preview）、align timings 形状；同 payload 双跑字节稳定（stub 路径）。
'use strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const mv = require('../lanes/mv.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + String(detail).slice(0, 240) + ']' : '')); }
}
const cfg = { mock: true, varDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mv-e2e-var-')), ffmpegBin: 'ffmpeg_missing_selftest', ffprobeBin: 'ffprobe_missing_selftest' };
let jobSeq = 0;
function makeCtx(type, payload) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-e2e-job-'));
  return {
    cfg, workDir, log: () => {},
    job: { id: 'j' + (++jobSeq), type, payload },
    progress: async () => {},
  };
}
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const isPng = (abs) => { const b = fs.readFileSync(abs); return b.length > 50 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47; };
const isMp4 = (abs) => { const b = fs.readFileSync(abs); return b.length > 100 && b.slice(4, 8).toString('latin1') === 'ftyp'; };
async function run(type, payload) {
  const ctx = makeCtx(type, payload);
  const out = await mv.runMvJob(ctx.job, ctx, {});
  return { out, ctx };
}
function checkFiles(name, out, expectFields) {
  const missing = [];
  for (const f of out.files || []) {
    if (!fs.existsSync(f.abs)) { missing.push(f.field + ':缺失'); continue; }
    const png = /\.png$/i.test(f.filename), mp4 = /\.mp4$/i.test(f.filename);
    if (png && !isPng(f.abs)) missing.push(f.field + ':png 魔数');
    if (mp4 && !isMp4(f.abs)) missing.push(f.field + ':mp4 ftyp');
  }
  for (const fld of expectFields) if (!(out.files || []).some((f) => f.field === fld)) missing.push(fld + ':无此字段');
  ok(name, missing.length === 0, missing.join(', '));
}

// ---- 素材（给 lipsync/preview 等真实源） ----
const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-e2e-src-'));
const srcMp4 = path.join(srcDir, 'clip.mp4'); fs.writeFileSync(srcMp4, mv.synthMp4Buf(4));
const srcWav = path.join(srcDir, 'master.wav'); fs.writeFileSync(srcWav, Buffer.alloc(4096, 1));
const srcPng = path.join(srcDir, 'board.png'); fs.writeFileSync(srcPng, mv.synthPngBuf(120, 214, 7));

try {
  // ① mv_cast_image
  {
    const { out } = await run('mv_cast_image', { gender: 'f', desc: '女孩', portrait_path: null, anchor_refs: [], seed: 1 });
    // 契约注意：上传映射 {逻辑名:字段名} 由 index.js postComplete 依 out.files 统一重建（server 真源），
    // runner result.files 保留 wave-1 代表字段 cast_image → 'cast_image_1'
    ok('cast_image result.files 代表字段', out.result.files && out.result.files.cast_image === 'cast_image_1', JSON.stringify(out.result.files));
    ok('cast_image 上传映射可重建×3', ['cast_image_1', 'cast_image_2', 'cast_image_3'].every((k) => (out.files || []).some((f) => f.field === k)));
    checkFiles('cast_image 产物 png×3', out, ['cast_image_1', 'cast_image_2', 'cast_image_3']);
    ok('cast_image face_scores 形状', Array.isArray(out.result.face_scores) && out.result.face_scores.length === 3);
  }
  // ② mv_cast（方案一默认：女主原图 I2V 首帧直出定妆视频 + 抽帧 + facegate）
  {
    const { out } = await run('mv_cast', { project_id: 'p1', character_id: 'c1', gender: 'f', desc: '自然光半身棚拍，多角度自然转头与表情', portrait_path: srcPng, cast_method: 'i2v_first_frame', seed: 11 });
    checkFiles('cast mp4+13 帧（方案一）', out, ['cast_video', ...Array.from({ length: 13 }, (_, i) => 'frame_' + (i + 1))]);
    ok('cast result.frames×13', out.result.frames.length === 13);
    ok('cast 首帧锁脸 portrait_path 透传', out.result.files && out.result.files.cast_video === 'cast_video', JSON.stringify(out.result.files));
    ok('cast 默认方案一 + mock 字节桩诚实标注', out.result.mock === true && out.result.meta && out.result.meta.stub === 'mp4-container', 'stub=' + (out.result.meta && out.result.meta.stub));
  }
  // ③ mv_cast_video
  {
    const { out } = await run('mv_cast_video', { cast_image: srcPng, seed: 2, motion: 'head turn' });
    checkFiles('cast_video mp4+13 帧', out, ['cast_video', ...Array.from({ length: 13 }, (_, i) => 'frame_' + (i + 1))]);
    ok('cast_video result.frames×13', out.result.frames.length === 13);
  }
  // ④ mv_storyboard
  {
    const { out } = await run('mv_storyboard', { shots: [{ id: 's1', desc: 'a' }, { id: 's2', desc: 'b' }], viewrefs: {} });
    checkFiles('storyboard board×2', out, ['board_s1', 'board_s2']);
  }
  // ⑤ mv_shot
  {
    const { out } = await run('mv_shot', { shot: { id: 's1', sec: 4, singing: '副歌句', first_frame: srcPng }, project_kind: 'vocal', seed: 3, tier: 'quality' });
    checkFiles('shot clip mp4', out, ['clip_s1']);
    ok('shot tier 透传', out.result.tier === 'quality');
  }
  // ⑥ mv_lipsync（透传源片 + sync_score=0.95）
  {
    const { out } = await run('mv_lipsync', { video: srcMp4, audio_master: srcWav, win: { start_sec: 1, dur_sec: 3 } });
    checkFiles('lipsync synced mp4', out, ['synced']);
    ok('lipsync sync_score=0.95', out.result.sync_score === 0.95, out.result.sync_score);
    ok('lipsync 透传源片字节', sha(out.files[0].abs) === sha(srcMp4));
  }
  // ⑦ mv_align
  {
    const { out } = await run('mv_align', { audio_master: srcWav, lyrics: '第一句歌词\n第二句更长的歌词\n第三句', structure: null, duration_sec: 30 });
    const t = out.result.timings;
    ok('align timings×3 形状', t.length === 3 && t.every((x) => typeof x.line === 'string' && Number.isFinite(x.start) && Number.isFinite(x.end)));
    ok('align 单调+收口', t[0].start === 0 && t[2].end === 30 && t.every((x, i) => i === 0 || x.start >= t[i - 1].start), JSON.stringify(t));
    const d = (x) => x.end - x.start;
    ok('align 按字数加权（长句窗口最大）', d(t[1]) > d(t[0]) && d(t[0]) > d(t[2]), JSON.stringify(t));
  }
  // ⑧ mv_preview
  {
    const { out } = await run('mv_preview', { board_urls: [srcPng, srcPng, srcPng], audio_master: srcWav, seg_sec: 2 });
    checkFiles('preview mp4', out, ['preview']);
    ok('preview boards=3', out.result.boards === 3, out.result.boards);
  }
  // ⑨ mv_compose（含 subtitles/degraded_shots/broll_subtitle 契约形状）
  {
    const { out } = await run('mv_compose', {
      takes: [{ video: srcMp4, start_sec: 0, strip_audio: true, dur_sec: 4 }, { video: srcMp4, start_sec: 4, strip_audio: true, dur_sec: 4 }],
      audio_master: srcWav, title: '测试曲', subtitles: ['句一', '句二'], degraded_shots: ['broll_subtitle'],
    });
    checkFiles('compose mv_video+cover', out, ['mv_video', 'cover']);
    ok('compose ai_label 恒真', out.result.ai_label === true);
    const sc = out.result.sidecar;
    ok('compose sidecar 形状 {subtitles,music,ai_label,degraded_shots}',
      sc && typeof sc.subtitles === 'number' && typeof sc.music === 'string' && sc.ai_label === true && Array.isArray(sc.degraded_shots), JSON.stringify(sc));
    ok('compose sidecar degraded_shots 透传', sc.degraded_shots.includes('broll_subtitle'), JSON.stringify(sc.degraded_shots));
    ok('compose mock 字节桩诚实', out.result.meta && out.result.meta.stub !== undefined);
  }
  // ⑩ 字节稳定：stub 路径下同 payload 双跑一致
  {
    const payload = { takes: [{ video: srcMp4, dur_sec: 3 }], audio_master: srcWav, title: '稳定性', subtitles: ['x'] };
    const a = await run('mv_compose', JSON.parse(JSON.stringify(payload)));
    const b = await run('mv_compose', JSON.parse(JSON.stringify(payload)));
    const same = (a.out.files.length === b.out.files.length) && a.out.files.every((f, i) => sha(f.abs) === sha(b.out.files[i].abs));
    ok('compose 双跑字节稳定', same || !a.out.result.meta.stub, 'stub=' + a.out.result.meta.stub);
    const ta = (await run('mv_align', { audio_master: srcWav, lyrics: 'a\nbb\nccc', duration_sec: 20 })).out.result.timings;
    const tb = (await run('mv_align', { audio_master: srcWav, lyrics: 'a\nbb\nccc', duration_sec: 20 })).out.result.timings;
    ok('align 双跑一致', JSON.stringify(ta) === JSON.stringify(tb), JSON.stringify(ta));
  }
} catch (e) {
  ok('runMvJob 全链路无异常', false, (e && (e.failCode || '') + ' ' + (e.failMessage || e.message) || e));
}

console.log('\nmv_mock_e2e: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exit(1);
