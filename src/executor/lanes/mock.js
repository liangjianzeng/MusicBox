// mock lane —— EXECUTOR_MOCK=1 时的无 GPU 替身：正弦 wav / 示例意图卡，形状与真 lane 完全一致（2026-11-23）
'use strict';
const path = require('node:path');
const { writeSineWav } = require('../lib/wav.js');

// music：每候选 30s 正弦 wav（440Hz/44100/16bit/单声道，真实可播放）
async function runMusic(job, ctx) {
  const p = job.payload || {};
  const count = Math.max(1, Math.min(4, Number(p.count) || 3));
  const candidates = (Array.isArray(p.candidates) && p.candidates.length)
    ? p.candidates
    : Array.from({ length: count }, (_, i) => ({ seq: i + 1, seed_delta: i }));
  const seedBase = Number.isFinite(Number(p.seed_base)) ? Number(p.seed_base) : 424242;
  const n = candidates.length;
  const files = [];
  const resultCandidates = [];
  await ctx.progress(3, n + ' 个候选排队中');
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const seq = Number(c.seq) || (i + 1);
    const field = 'master_' + seq;
    const abs = path.join(ctx.workDir, field + '.wav');
    // 候选间频率错开，便于人耳区分
    writeSineWav(abs, { seconds: 30, freq: 440 + seq * 40, sampleRate: 44100, channels: 1, bits: 16 });
    files.push({ field, filename: field + '.wav', abs });
    resultCandidates.push({
      seq, seed: seedBase + (Number(c.seed_delta) || 0), seconds: 30, duration_sec: 30,
      file: field, title: '',
      meta: { clone: { applied: false, stage2_failed: false }, mock: true },
    });
    await ctx.progress(Math.round(((i + 1) / n) * 99), '已完成第 ' + (i + 1) + '/' + n + ' 个候选');
  }
  return {
    result: { files: {}, candidates: resultCandidates, persona_applied: false, mock: true },
    files,
  };
}

// intent_voice：内置示例卡（1 题澄清）
async function runVoice(job, ctx) {
  await ctx.progress(50, '正在理解意图');
  const card = {
    mood: ['温暖'],
    scene_desc: '为朋友庆生写歌',
    genre_hypotheses: ['pop', 'folk', 'chinese traditional'],
    vocal: 'song',
    duration_hint: '适中',
    confidence: 0.6,
    questions: [{
      q_idx: 0,
      q: '这首生日歌想要哪种感觉？',
      options: [{ idx: 0, label: '轻快活泼' }, { idx: 1, label: '温馨舒缓' }, { idx: 2, label: '古风雅致' }],
      recommended_idx: 0,
    }],
    answers: [],
    // ASR 观测字段（服务端 compileIntent 消费，词典可命中"庆生/生日"）
    text: '我想为朋友写一首庆生的歌，热闹一点',
    emotion: 'happy',
    events: [],
    duration: 8,
    mock: true,
  };
  await ctx.progress(90, '意图卡已生成');
  return { result: card, files: [] };
}

// intent_image：另一示例卡
async function runImage(job, ctx) {
  await ctx.progress(55, '正在理解意图');
  const card = {
    mood: ['宁静'],
    scene_desc: '雨后的山间小路，晨光穿过薄雾',
    genre_hypotheses: ['ambient', 'chinese traditional', 'folk'],
    vocal: 'instrumental',
    duration_hint: '偏长',
    confidence: 0.6,
    questions: [{
      q_idx: 0,
      q: '希望画面里的哪种情绪占主导？',
      options: [{ idx: 0, label: '清新治愈' }, { idx: 1, label: '空灵悠远' }, { idx: 2, label: '微微感伤' }],
      recommended_idx: 1,
    }],
    answers: [],
    mock: true,
  };
  await ctx.progress(90, '意图卡已生成');
  return { result: card, files: [] };
}

// replica_analyze（契约 v5.7.4 mock 先行）：确定性假观测 —— 有文本/情绪/事件，
// 让 v38 套件在无 GPU、无 ASR 的机器上全绿；服务端规则画像能从文本里命中词典词
async function runReplicaAnalyze(job, ctx) {
  await ctx.progress(50, 'mock 识别完成');
  return {
    result: {
      asr: {
        emotion: 'happy',
        events: ['BGM'],
        duration: 45,
        text: 'mock 参考曲转写：轻快的电子节拍，温暖的钢琴与弦乐铺底，女声气声唱法',
      },
      fallback: false,
      mock: true,
    },
    files: [],
  };
}

module.exports = { runMusic, runVoice, runImage, runReplicaAnalyze };
