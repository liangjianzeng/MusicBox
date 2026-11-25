// src/executor/selftest/mv_filters_check.mjs —— §4.2 ffmpeg filter 基线断言（无需 ffmpeg，手动运行）
// 用法：node src/executor/selftest/mv_filters_check.mjs
// 覆盖：compose 全链路（归一/concat/xfade 仅段落界/amix/volume/字幕 drawtext/片名卡/AI 角标常驻）、
//       preview zoompan、align 归一与比例均分、模板锁（sha16 漂移检测）。
'use strict';
import { createRequire } from 'node:module';
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
contains('compose: xfade §4.2', g.fc, 'xfade=transition=fade:duration=0.5:offset=');
contains('compose: amix inputs=2:normalize=0', g.fc, 'amix=inputs=2:normalize=0');
contains('compose: master volume 1.0', g.fc, 'volume=1.0');
contains('compose: 片名卡后 adelay 对齐', g.fc, 'adelay=2000|2000');
contains('compose: 字幕 y=h-text_h-h*0.08', g.fc, 'y=h-text_h-h*0.08');
contains('compose: 字幕 enable 窗', g.fc, "enable='between(t,2.500,4.500)'");
contains('compose: 字幕单引号包裹（,:;字面量安全）', g.fc, "text='第一句 歌词, 带逗号:冒号'");
contains('compose: 字幕强调档（broll_subtitle）', g.fc, 'fontsize=h/18', 'fontcolor=yellow');
contains('compose: 字幕常规档', g.fc, 'fontsize=h/24', 'fontcolor=white');
contains('compose: AI 角标常驻（无 enable）', g.fc, "drawtext=text='AI 生成'");
ok('compose: 角标常驻=其 drawtext 段无 enable', "drawtext=text='AI 生成'".length > 0 && !/AI 生成[^;]*enable/.test(g.fc), g.fc);
contains('compose: master/静音床输入号', g.fc, '[5:a]volume=1.0', '[6:a]volume=0.0');
order('compose 结构顺序 concat→xfade→drawtext→amix', g.fc,
  'concat=n=', 'xfade=transition=fade', "drawtext=text='第一句", 'amix=inputs=2');
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
contains('preview: zoompan 存在', zv, 'zoompan=', "z='min(zoom+0.0015,1.3)'");
order('preview: 归一后 zoompan', zv, 'scale=720:1280:force_original_aspect_ratio=decrease', 'pad=', 'fps=24', 'setsar=1', 'zoompan=');
contains('preview: zoompan 目标画幅/帧率', zv, 's=720x1280', 'fps=24', 'format=yuv420p');
const sb = mv.silenceBedArgs(30);
contains('preview: 静音音床 lavfi anullsrc', sb.join(' '), 'anullsrc=r=48000:cl=stereo', '-f lavfi');

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

// ---------- ⑧ 模板锁（sha16 漂移即 FAIL —— 真跑前最后一道闸） ----------
for (const tname of ['h3-image-cast', 'h3-fl2va', 'h3-image-edit']) {
  try {
    const entry = comfy.loadManifest(tname);
    const wf = comfy.loadTemplate(tname, entry);
    ok('template 锁: ' + tname + ' sha16 一致', !!entry.tmpl_sha16 && Object.keys(wf).length > 3);
    ok('template 占位诚实: ' + tname + ' placeholder+null commit', entry.placeholder === true && entry.comfy_commit === null, JSON.stringify(entry).slice(0, 120));
  } catch (e) {
    ok('template 锁: ' + tname, false, e.message);
  }
}
ok('manifest: h3-image-edit 已登记', !!comfy.loadManifest('h3-image-edit'));

console.log('\nmv_filters_check: ' + pass + '/' + (pass + fail) + ' 通过');
if (fail) process.exit(1);
