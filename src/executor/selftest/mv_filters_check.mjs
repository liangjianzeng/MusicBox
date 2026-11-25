// src/executor/selftest/mv_filters_check.mjs —— §4.2 ffmpeg filter 基线断言（无需 ffmpeg，手动运行）
// 用法：node src/executor/selftest/mv_filters_check.mjs
// 覆盖：compose 全链路（归一/调色/多转场/音频/换行字幕/品牌水印/片尾/AI 角标/时长边界）、
//       preview Ken Burns、align 归一与比例均分、分阶段缓存/预算/错误码、模板锁（sha16 漂移检测）。
'use strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const mv = require('../lanes/mv.js');
const comfy = require('../lib/comfy.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  [' + String(detail).slice(0, 220) + ']' : '')); }
}
function contains(name, hay, ...needles) {
  const miss = needles.filter((n) => !String(hay).includes(n));
  ok(name, miss.length === 0, '缺: ' + miss.join(' | ') + ' :: ' + String(hay).slice(0, 300));
}
function order(name, hay, ...seq) {
  let last = -1, bad = null;
  for (const s of seq) {
    const i = String(hay).indexOf(s);
    if (i < 0) { bad = '缺 ' + s; break; }
    if (i <= last) { bad = '顺序错 ' + s; break; }
    last = i;
  }
  ok(name, !bad, bad + ' :: ' + String(hay).slice(0, 300));
}

const cfg = { mvFontFile: '' };

// ---------- ① 归一 vf（§4.2：scale=W:H:force_original_aspect_ratio=decrease,pad,fps=24,setsar=1） ----------
const nv = mv.normVf(720, 1280);
order('normVf 顺序 scale→pad→fps→setsar', nv,
  'scale=720:1280:force_original_aspect_ratio=decrease', 'pad=720:1280:', 'fps=24', 'setsar=1');
contains('normVf pad 居中黑底', nv, '(ow-iw)/2', '(oh-ih)/2', 'color=black');

// ---------- ② compose filter_complex（含片名卡 + 两个段落界） ----------
const segs = [{ dur: 2 }, { dur: 5 }, { dur: 5 }, { dur: 4 }, { dur: 4 }]; // 0=片名卡
const subs = [
  { text: '第一句 歌词, 带逗号:冒号', start: 2.5, end: 4.5 },
  { text: '副歌句', start: 7.0, end: 9.2, emphasis: true },
];
const g = mv.buildComposeGraph(cfg, { segments: segs, boundaries: [2, 3], subtitles: subs, tShiftSec: 2 });
contains('compose: concat v=1:a=0', g.fc, 'concat=n=2:v=1:a=0');
contains('compose: 按镜序稳定选择 wipeleft/smoothleft', g.fc, 'xfade=transition=wipeleft:duration=0.500:offset=', 'xfade=transition=smoothleft:duration=0.500:offset=');
contains('compose: amix inputs=2:normalize=0', g.fc, 'amix=inputs=2:normalize=0');
contains('compose: master volume 1.0', g.fc, 'volume=1.0');
contains('compose: 片名卡后 adelay 对齐', g.fc, 'adelay=2000|2000');
contains('compose: 字幕安全区/边距', g.fc, "y=max(h*0.55,min(h*0.9,h-text_h-h*0.06))", 'boxborderw=h/180', 'line_spacing=h/80');
contains('compose: 字幕 enable 窗', g.fc, "enable='between(t,2.500,4.500)'");
contains('compose: 字幕单引号包裹（,:;字面量安全）', g.fc, "text='第一句 歌词, 带逗号:冒号'");
contains('compose: 字幕强调档（broll_subtitle）', g.fc, 'fontsize=h/20', 'fontcolor=yellow');
contains('compose: 字幕常规档', g.fc, 'fontsize=h/24', 'fontcolor=white');
contains('compose: AI 角标常驻（无 enable）', g.fc, "drawtext=text='AI 生成'");
ok('compose: 角标常驻=其 drawtext 段无 enable', "drawtext=text='AI 生成'".length > 0 && !/AI 生成[^;]*enable/.test(g.fc), g.fc);
contains('compose: master/静音床输入号', g.fc, '[5:a]volume=1.0', '[6:a]volume=0.0');
order('compose 结构顺序 concat→xfade→drawtext→amix', g.fc,
  'concat=n=', 'xfade=transition=wipeleft', "drawtext=text='第一句", 'amix=inputs=2');
ok('compose: 段落界数=xfade 数', g.xfades === 2, g.xfades);
ok('compose: mapV/mapA', g.mapV === '[vout]' && g.mapA === '[aout]', g.mapV + '/' + g.mapA);
// 总时长 = Σ − 0.5×段落界数
ok('compose: 总时长收缩=xfade 重叠', Math.abs(g.totalVideo - (20 - 1.0)) < 1e-6, g.totalVideo);

// ---------- ③ xfade 仅段落界 ----------
const gNoB = mv.buildComposeGraph(cfg, { segments: [{ dur: 4 }, { dur: 4 }, { dur: 4 }], boundaries: [], subtitles: [] });
ok('compose: 无段落界 → 无 xfade', !gNoB.fc.includes('xfade'), gNoB.fc);
contains('compose: 无段落界 → 纯 concat n=3', gNoB.fc, 'concat=n=3:v=1:a=0');
ok('compose: 无角标缺省仍常驻（badge 恒在）', gNoB.fc.includes("drawtext=text='AI 生成'"), gNoB.fc);
const gOne = mv.buildComposeGraph(cfg, { segments: [{ dur: 5 }], boundaries: [1], subtitles: [] });
ok('compose: 单段无 xfade（边界越界剔除）', gOne.xfades === 0 && !gOne.fc.includes('xfade'), gOne.fc);

// ---------- ④ preview zoompan（§4.2：loop+zoompan z='min(zoom+0.0015,1.3)'） ----------
const zv = mv.buildZoompanVf(720, 1280);
contains('preview: zoompan 存在', zv, 'zoompan=', "z='min(zoom+0.001500,1.1200)'");
contains('preview: 轻量调色 eq+curves', zv, 'eq=contrast=1.02', "curves=all='0/0 0.25/0.24 0.75/0.76 1/1'");
order('preview: 归一后 zoompan', zv, 'scale=720:1280:force_original_aspect_ratio=decrease', 'pad=', 'fps=24', 'setsar=1', 'zoompan=');
contains('preview: zoompan 目标画幅/帧率', zv, 's=720x1280', 'fps=24', 'format=yuv420p');
const sb = mv.silenceBedArgs(30);
contains('preview: 静音音床 lavfi anullsrc', sb.join(' '), 'anullsrc=r=48000:cl=stereo', '-f lavfi');
const pvMaster = mv.buildPreviewArgs('list.txt', 'master.wav', 7.5).join(' ');
contains('preview: 母带映射/补音/精确时长', pvMaster, '-i master.wav', '-map 0:v:0', '-map 1:a:0', '-af apad', '-t 7.5');
contains('preview: 无母带保留无声直拼兼容', mv.buildPreviewArgs('list.txt', null, 7.5).join(' '), '-map 0:v:0', '-c copy');

// ---------- ⑤ 片名卡（2s 720×1280） ----------
const tc = mv.buildTitleCardArgs(cfg, { title: '我的歌: "测试"', abs: 'C:/x/title.mp4' }).join(' ');
contains('titlecard: 2s 720×1280 黑底', tc, 'color=c=black:s=720x1280:d=2:r=24');
contains('titlecard: 标题单引号包裹（冒号引号字面量）', tc, "drawtext=text='我的歌: \"测试\"'");
ok('titlecard: 剥音轨 -an', tc.includes('-an'), tc);

// ---------- ⑥ 字幕规格化（broll_subtitle honor + timings 窗平移） ----------
const subsStr = mv.normalizeSubtitles({ subtitles: ['A', 'B', 'C'] }, 9, 2, []);
ok('subs: 字符串均匀铺+片名卡平移', subsStr.length === 3 && subsStr[0].start === 2 && Math.abs(subsStr[2].end - 10.9) < 1e-9, JSON.stringify(subsStr));
const subsObj = mv.normalizeSubtitles({ subtitles: [{ line: '句一', start: 0, end: 1.5 }] }, 10, 2, []);
ok('subs: timings 形状 line/start/end + shift', subsObj[0].text === '句一' && subsObj[0].start === 2 && subsObj[0].end === 3.5, JSON.stringify(subsObj));
const subsBroll = mv.normalizeSubtitles({ subtitles: ['句'], degraded_shots: ['broll_subtitle'] }, 10, 0, []);
ok('subs: degraded_shots 含 broll_subtitle → 强调', subsBroll[0].emphasis === true, JSON.stringify(subsBroll));
const subsWin = mv.normalizeSubtitles({ subtitles: [{ line: '句', start: 4, end: 5 }] }, 10, 0, [{ start: 3, end: 6, degraded: ['broll_subtitle'] }]);
ok('subs: take 窗命中 broll_subtitle → 强调', subsWin[0].emphasis === true, JSON.stringify(subsWin));
const subsNo = mv.normalizeSubtitles({ subtitles: [{ line: '句', start: 8, end: 9 }] }, 10, 0, [{ start: 3, end: 6, degraded: ['broll_subtitle'] }]);
ok('subs: take 窗不命中 → 不强调', subsNo[0].emphasis === false, JSON.stringify(subsNo));

// ---------- ⑦ align 归一 + 比例均分 ----------
ok('align: 全角→半角 NFKC', mv.normLine('Ｈｅｌｌｏ，世界１２３') === 'hello世界123', mv.normLine('Ｈｅｌｌｏ，世界１２３'));
ok('align: 剥标点/空白', mv.normLine(' 你好，世界！~ ') === '你好世界', mv.normLine(' 你好，世界！~ '));
const ln = mv.splitLyricLines('第一句。第二句！第三句？');
ok('align: 单行按句读分段', ln.length === 3 && ln[0] === '第一句' && ln[2] === '第三句', JSON.stringify(ln));
const ln2 = mv.splitLyricLines('[Verse]\n行一\n行二\n');
ok('align: 换行分段+剥段标', ln2.length === 2 && ln2[0] === '行一', JSON.stringify(ln2));
const t = mv.evenSplitTimings(['短', '这是一个明显更长的歌词句子'], 10);
ok('align: timings 形状 {line,start,end}', t.every((x) => Object.keys(x).sort().join(',') === 'end,line,start'), JSON.stringify(t));
ok('align: 单调不降+首尾收口', t[0].start === 0 && t[t.length - 1].end === 10 && t.every((x, i) => i === 0 || x.start >= t[i - 1].start), JSON.stringify(t));
ok('align: 长句占比更大', (t[1].end - t[1].start) > (t[0].end - t[0].start) * 3, JSON.stringify(t));

// ---------- ⑧ 画幅、运镜、转场与时长边界 ----------
ok('size: 冻结默认 9:16', JSON.stringify(mv.renderSize({}, cfg)) === JSON.stringify({ w: 720, h: 1280, aspectRatio: '9:16', fps: 24 }));
ok('size: job 16:9 优先于 env/cfg', mv.renderSize({ aspect_ratio: '16:9' }, { mvAspectRatio: '1:1' }).w === 1280);
ok('size: job 1:1', mv.renderSize({ aspectRatio: '1:1' }, cfg).h === 720);
ok('size: fps job 优先且边界钳制', mv.renderSize({ render: { fps: 99 } }, { mvFps: 30 }).fps === 60);
try { mv.renderSize({ aspect_ratio: '4:3' }, cfg); ok('size: 非法画幅 BAD_PARAMS', false); }
catch (e) { ok('size: 非法画幅 BAD_PARAMS', e.failCode === 'BAD_PARAMS', e.failCode); }
const motions = [0, 1, 2, 3, 4].map((seq) => mv.buildKenBurnsVf(720, 1280, seq, {}, 24));
ok('motion: 镜序稳定选择 in/out/pan', motions[0].includes('min(zoom+') && motions[1].includes('max(zoom-') && motions[2].includes('(iw-iw/zoom)*(1-on/144)') && motions[3].includes('(iw-iw/zoom)*on/144'));
ok('motion: 同 seq 双跑稳定', motions[0] === mv.buildKenBurnsVf(720, 1280, 0, {}, 24));
ok('motion: 按镜配置缺项回退稳定默认', mv.motionSpec(7, mv.motionFor(7, { 0: { motion: 'pan-left' } }, {})).mode === 'pan-right');
ok('motion: 全局配置和 render 配置可用', mv.motionFor(0, { motion: 'pan-right' }, {}).motion === 'pan-right' && mv.motionFor(0, {}, { motion: 'zoom-out' }).motion === 'zoom-out');
contains('motion: 运镜速度随镜段时长', mv.buildKenBurnsVf(720, 1280, 2, {}, 24, 3), '(iw-iw/zoom)*(1-on/72)');
ok('motion: amount 安全上限', mv.motionSpec(0, { amount: 99 }).amount === 0.2);
try { mv.buildKenBurnsVf(720, 1280, 0, { motion: "x');evil" }, 24); ok('motion: 注入被拒', false); }
catch (e) { ok('motion: 注入被拒', e.failCode === 'BAD_PARAMS', e.failCode); }
const tr = mv.composeTimeline([4, 4, 4], new Set([1, 2]), {});
ok('transition: 四类稳定轮换', tr.transitions.map((x) => x.transition).join(',') === 'slideleft,wipeleft', JSON.stringify(tr));
ok('transition: fade/slide/wipe/smoothleft 均可用', mv.TRANSITIONS.join(',') === 'fade,slideleft,wipeleft,smoothleft');
const trShort = mv.composeTimeline([0.2, 5, 0.2], new Set([1, 2]), { duration: 5 });
ok('duration: 转场不超过相邻段一半', trShort.transitions.every((x) => x.duration <= 0.100001) && trShort.transitions.length === 2, JSON.stringify(trShort));
const trTooShort = mv.composeTimeline([0.1, 5], new Set([1]), {});
ok('duration: 过短边界直拼', trTooShort.transitions.length === 0 && trTooShort.total === 5.1, JSON.stringify(trTooShort));
const trCustom = mv.composeTimeline([4, 4], new Set([1]), { duration: 1 });
ok('duration: 自定义转场计入总时长', trCustom.transitions[0].duration === 1 && trCustom.total === 7, JSON.stringify(trCustom));
const gMin = mv.buildComposeGraph(cfg, { segments: [{ dur: 0.5 }], boundaries: [], subtitles: [], minDuration: 5 });
ok('duration: 成片最短 5s 补帧', gMin.totalVideo === 5 && gMin.fc.includes('tpad=stop_mode=clone:stop_duration=4.500'), gMin.totalVideo);
const gMax = mv.buildComposeGraph(cfg, { segments: Array.from({ length: 16 }, () => ({ dur: 15 })), boundaries: [], subtitles: [] });
ok('duration: 成片最长 45s 裁剪', gMax.totalVideo === 45 && gMax.fc.includes('trim=duration=45.000'), gMax.totalVideo);
const tcWide = mv.buildTitleCardArgs(cfg, { title: '横屏', abs: 'x.mp4', aspectRatio: '16:9', fps: 30 }).join(' ');
contains('titlecard: 输出尺寸随画幅', tcWide, 'color=c=black:s=1280x720:d=2:r=30', 'fps=30');
contains('titlecard: 片尾品牌', mv.buildBrandDrawtext(cfg, 'MusicBox'), "text='MusicBox'", 'y=h*0.62');
contains('compose: 品牌水印与 AI 角标分位', mv.buildComposeGraph(cfg, { segments: [{ dur: 5 }], boundaries: [], brandText: 'MusicBox' }).fc,
  "text='MusicBox'", 'fontsize=h/48:x=w*0.03:y=h*0.03', "text='AI 生成':fontcolor=white@0.75");

// ---------- ⑨ 字幕边界与缓存/错误码 ----------
const longSubs = mv.normalizeSubtitles({ subtitles: ['歌词'.repeat(100)] }, 10, 0, [], { w: 720, h: 1280 });
ok('subtitle: 长歌词换行且原句不超 120 字', longSubs[0].text.includes('\n') && Array.from(longSubs[0].text.replace(/\n/g, '')).length <= 120, JSON.stringify(longSubs).slice(0, 160));
ok('subtitle: 行宽受安全宽度约束', longSubs[0].text.split('\n').every((line) => Array.from(line).length <= 31), longSubs[0].text);
const emphasizedSubs = mv.wrapSubtitle('歌词'.repeat(100), 720, 1280, true);
ok('subtitle: 中文按强调字号安全宽度换行', emphasizedSubs.split('\n').every((line) => Array.from(line).length <= 9), emphasizedSubs);
const longSubDraw = mv.buildSubtitleDrawtext(cfg, Object.assign({}, longSubs[0], { emphasis: true }), true);
contains('subtitle: 多行自动缩小且上移安全区', longSubDraw, "y=max(h*0.4,min(h*0.9,h-text_h-h*0.06))", 'fontsize=min(h/20,');
ok('subtitle: 60 条上限', mv.normalizeSubtitles({ subtitles: Array.from({ length: 100 }, (_, i) => '句' + i) }, 10, 0, []).length === 60);
const subFile = mv.buildSubtitleDrawtext(cfg, { text: 'x', textFile: "C:/a'b.txt", start: 1, end: 2 }, false);
contains('subtitle: textfile 避免内联表达式', subFile, 'expansion=none', 'textfile=');
ok('subtitle: drawtext 百分比转义', mv.dtText('%{expr}').includes('\\%{expr}'), mv.dtText('%{expr}'));
ok('subtitle: textfile 保留路径连续空格', mv.dtPath('C:/a  b.txt') === "'C:/a  b.txt'", mv.dtPath('C:/a  b.txt'));
ok('concat: 单引号/换行安全转义', mv.concatEntry("C:/a'b\nc.mp4").includes("'\\''") && !mv.concatEntry("C:/a'b\nc.mp4").includes('\n'));
const keyA = mv.stageKey('compose-normal', { b: 2, a: { d: 4, c: 3 } });
const keyB = mv.stageKey('compose-normal', { a: { c: 3, d: 4 }, b: 2 });
ok('cache: 规范键顺序稳定', keyA === keyB, keyA + '/' + keyB);
ok('cache: 不同输入不同键', keyA !== mv.stageKey('compose-normal', { a: { c: 3, d: 4 }, b: 3 }));
const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-cache-check-'));
try {
  const cacheCtx = { cfg: {}, workDir: cacheRoot, cacheDir: path.join(cacheRoot, 'cache') };
  const first = await mv.cachedStep(cacheCtx, 'selftest', { input: 'a' }, '.txt', (dest) => fs.writeFileSync(dest, 'done'));
  const second = await mv.cachedStep(cacheCtx, 'selftest', { input: 'a' }, '.txt', () => { throw new Error('不应重跑'); });
  ok('cache: 同参数复用已完成步骤', !first.reused && second.reused && second.abs === first.abs && fs.readFileSync(first.abs, 'utf8') === 'done');
  let failed = null;
  try { await mv.cachedStep(cacheCtx, 'selftest-fail', { input: 'b' }, '.txt', () => { throw new Error('boom'); }); }
  catch (e) { failed = e; }
  ok('cache: 失败保留已完成步骤且清 partial', !!failed && fs.existsSync(first.abs) && !fs.readdirSync(cacheCtx.cacheDir).some((x) => x.includes('.part-')), failed && failed.message);
  const fa = path.join(cacheRoot, 'a.bin'), fb = path.join(cacheRoot, 'b.bin');
  fs.writeFileSync(fa, 'same'); fs.writeFileSync(fb, 'diff');
  ok('cache: 文件内容 hash 稳定/可区分', await mv.fileHash(fa) === await mv.fileHash(fa) && await mv.fileHash(fa) !== await mv.fileHash(fb));
} finally { fs.rmSync(cacheRoot, { recursive: true, force: true }); }
const budget = mv.createBudget(cfg, { timeout_ms: 1000 }, 'compose');
await new Promise((resolve) => setTimeout(resolve, 1010));
try { budget.timeoutMs(); ok('timeout: 总预算错误码', false); }
catch (e) { ok('timeout: 总预算 FFMPEG_TIMEOUT', e.failCode === 'FFMPEG_TIMEOUT', e.failCode); }
const killed = await mv.runCmd(process.execPath, ['-e', 'setTimeout(()=>{},1000)'], { timeoutMs: 20 });
ok('timeout: 超时子进程终止', killed.timedOut === true && killed.signal === 'SIGKILL', JSON.stringify(killed));
try { await mv.execChecked({ cfg: { ffmpegBin: 'ffmpeg_missing_selftest' } }, mv.createBudget(cfg, {}, 'compose'), ['-version'], 'missing'); ok('error: FFMPEG_MISSING', false); }
catch (e) { ok('error: FFMPEG_MISSING', e.failCode === 'FFMPEG_MISSING', e.failCode); }
try { await mv.runMvJob({ type: 'mv_unknown', payload: {} }, { cfg: { mock: true }, log() {} }, {}); ok('error: UNSUPPORTED_JOB_TYPE', false); }
catch (e) { ok('error: UNSUPPORTED_JOB_TYPE', e.failCode === 'UNSUPPORTED_JOB_TYPE', e.failCode); }

// ---------- ⑩ 模板锁（sha16 漂移即 FAIL —— 真跑前最后一道闸） ----------
for (const tname of ['h3-image-cast', 'h3-image-broll', 'h3-fl2va', 'h3-image-edit']) {
  try {
    const entry = comfy.loadManifest(tname);
    const wf = comfy.loadTemplate(tname, entry);
    ok('template 锁: ' + tname + ' sha16 一致', !!entry.tmpl_sha16 && Object.keys(wf).length > 3);
    const registered = !entry.placeholder && !!entry.comfy_commit;
    ok('template 登记诚实: ' + tname + ' 已登记或明确占位', registered || (entry.placeholder === true && entry.comfy_commit === null), JSON.stringify(entry).slice(0, 120));
  } catch (e) {
    ok('template 锁: ' + tname, false, e.message);
  }
}
ok('manifest: h3-image-edit 已登记', !!comfy.loadManifest('h3-image-edit'));
const broll = comfy.loadTemplate('h3-image-broll', comfy.loadManifest('h3-image-broll'));
ok('template: 空镜无身份垫图节点', !JSON.stringify(broll).includes('LoadImage') && !JSON.stringify(broll).includes('<REF_IMAGE'));
ok('template: 空镜未伪造真机证据', comfy.loadManifest('h3-image-broll').evidence === null);

let submitted = null, uploads = 0;
const fakeComfy = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/upload/image') uploads++;
    if (req.url === '/system_stats') return res.end(JSON.stringify({ system: { ram_free: 64 * 1024 ** 3, ram_total: 128 * 1024 ** 3 } }));
    if (req.url === '/queue') return res.end(JSON.stringify({ queue_pending: [], queue_running: [] }));
    if (req.url === '/prompt') {
      submitted = JSON.parse(body).prompt;
      return res.end(JSON.stringify({ prompt_id: 'selftest-broll' }));
    }
    if (req.url === '/history/selftest-broll') return res.end(JSON.stringify({ 'selftest-broll': {
      status: { completed: true }, outputs: { '8': { images: [{ filename: 'broll.png', subfolder: '', type: 'output' }] } },
    } }));
    if (req.url.startsWith('/view?')) {
      res.setHeader('content-type', 'image/png');
      return res.end(mv.synthPngBuf(32, 64, 7));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((resolve) => fakeComfy.listen(0, '127.0.0.1', resolve));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-broll-'));
try {
  const out = await mv.runMvJob({ id: 'selftest-broll', type: 'mv_storyboard', payload: {
    shots: [{ id: 'empty_1', desc: '雨夜空街道', camera: '缓慢推镜', cast_ids: [] }],
  } }, { cfg: { mock: false, comfyUrl: 'http://127.0.0.1:' + fakeComfy.address().port }, workDir, log() {}, async progress() {} }, {});
  ok('storyboard: 纯空镜走 t2i 模板', submitted && submitted['8'].inputs.filename_prefix === 'musicbox_h3_image_broll');
  ok('storyboard: 纯空镜不上传身份垫图', uploads === 0);
  ok('storyboard: 空镜真实落盘非假图', out.files.length === 1 && fs.statSync(out.files[0].abs).size > 100);
} catch (e) {
  ok('storyboard: 纯空镜走 t2i 模板', false, e.message);
} finally {
  await new Promise((resolve) => fakeComfy.close(resolve));
  fs.rmSync(workDir, { recursive: true, force: true });
}

console.log('\nmv_filters_check: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exit(1);
