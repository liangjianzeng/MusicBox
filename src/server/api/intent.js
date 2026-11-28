// 多模态意图线：语音/图片上传实测校验→登记 72h TTL→派单；answer 强制澄清纪律；generate 按卡派单（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const bus = require('../core/bus');
const engine = require('../core/engine');
const rules = require('../core/rules');
const auth = require('./auth');
const U = require('../core/util');
const AC = require('../core/appconfig');
const dict = require('../prompts/dictionary');
const intentPrompt = require('../prompts/intent');
const worksApi = require('./works');

const requireUser = auth.requireUser;
const UP = config.upload;

// —— 音频时长实测（无第三方依赖）——
// wav：扫 fmt/data 块；m4a/mp4：递归找 mvhd（timescale+duration）
function wavDurationSec(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12; let byteRate = null; let dataBytes = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 8 + 16 <= buf.length) byteRate = buf.readUInt32LE(pos + 8 + 8);
    if (id === 'data') { dataBytes = size; break; }
    pos += 8 + size + (size % 2);
  }
  if (!byteRate || dataBytes == null) return null;
  return dataBytes / byteRate;
}
function m4aDurationSec(buf) {
  const scanBox = (start, end) => {
    let pos = start;
    while (pos + 8 <= end) {
      let size = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      let body = pos + 8;
      if (size === 1 && pos + 16 <= end) { size = Number(buf.readBigUInt64BE(pos + 8)); body = pos + 16; }
      if (size < 8 || body + size - 8 > end) return null;
      if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl') {
        const r = scanBox(body, body + size - 8);
        if (r !== null) return r;
      } else if (type === 'mvhd') {
        const version = buf[body];
        if (version === 0 && body + 20 <= end) {
          const timescale = buf.readUInt32BE(body + 12);
          const duration = buf.readUInt32BE(body + 16);
          return timescale ? duration / timescale : null;
        }
        if (version === 1 && body + 28 <= end) {
          const timescale = buf.readUInt32BE(body + 20);
          const duration = Number(buf.readBigUInt64BE(body + 24));
          return timescale ? duration / timescale : null;
        }
      }
      pos += size;
    }
    return null;
  };
  try { return scanBox(0, buf.length); } catch (e) { return null; }
}
function audioDurationSec(buf, ext) {
  if (ext === 'wav') return wavDurationSec(buf);
  return m4aDurationSec(buf);
}

// multipart 取 file 部件
function takeFile(ctx, maxBytes) {
  const ct = (ctx.headers || {})['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) throw new U.ApiError('BAD_REQUEST', '请以 multipart/form-data 上传文件');
  const mp = U.parseMultipart(ctx.raw, ct);
  const file = (mp.files || []).find(f => f.field === 'file') || (mp.files || [])[0];
  if (!file || !file.data || !file.data.length) throw new U.ApiError('BAD_REQUEST', '缺少上传文件（字段名 file）');
  if (file.data.length > maxBytes) throw new U.ApiError('BAD_REQUEST', `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
  return { file, fields: mp.fields };
}
function saveUpload(buf, ext, kind) {
  const dir = config.paths.uploads;
  fs.mkdirSync(dir, { recursive: true });
  const rel = U.uid('up_') + '.' + ext;
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, buf);
  return { rel, abs };
}
function registerUpload(user, kind, saved, bytes, mime) {
  const id = U.uid('ul_');
  store.run('INSERT INTO uploads(id,user_id,kind,path,bytes,sha256,mime,expire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, user.id, kind, saved.abs, bytes, U.sha256hex(saved.abs ? fs.readFileSync(saved.abs) : Buffer.alloc(0)), mime,
    U.isoAfterMs(UP.ttlHours * 3600 * 1000), U.nowIso());
  return id;
}
// v5.5.8：开局问几题由**服务端**判，不接受客户端直传。
// 客户端能自己声明"我是伴创"就等于绕过了"开局别问太多"的体验约束；灰度没开时也必须是 2。
function askBudgetFor(user, body) {
  const b = body || {};
  const mode = String(b.surface || b.mode || '');
  const wantsAgent = mode === 'agent' || Number(b.create_tier) === 3;
  // 契约 v5.7.7（复刻）：mode='replica' 的卡同样按 3 题分档；flag 未开 = 未开放，fail-closed 回 2
  const wantsReplica = mode === 'replica';
  if (!wantsAgent && !wantsReplica) return 2;
  let on = false;
  try { on = AC.featureOn(wantsReplica ? 'replicaMode' : 'createAgentMode', user && user.id); } catch (e) { on = false; } // flag 未注册 = 未开放，fail-closed
  return on ? 3 : 2;
}
function cardBudget(intentId) {
  const r = store.get('SELECT ask_budget FROM intent_cards WHERE id=?', intentId);
  const n = r ? Number(r.ask_budget) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 3 ? Math.trunc(n) : 2;
}
function newDraftIntent(user, kind, uploadId, askBudget) {
  const id = U.uid('in_');
  const budget = Number.isFinite(askBudget) && askBudget >= 1 && askBudget <= 3 ? Math.trunc(askBudget) : 2;
  // 顺带修一处**存量错位**：原语句 7 个占位符只配 6 个参数，于是 genre_hypotheses 被绑成时间戳、
  // updated_at 一直是 NULL。草稿卡随即被 engine 覆盖，所以多年没人发现；我给这条 INSERT 加第 8 列后
  // 错位才顶到 ask_budget 的 NOT NULL 上暴露出来。这里把 genre_hypotheses 改为字面量 ''，
  // 让占位符与参数一一对应（草稿本来就没有流派猜测，空串才是它的真值）。
  store.run(
    `INSERT INTO intent_cards(id,user_id,source_kind,source_ref,mood,scene_desc,genre_hypotheses,vocal,duration_hint,
      confidence,questions,answers,rounds,status,gen_params,created_at,updated_at,ask_budget)
     VALUES(?,?,?,?,'','','','unknown','',0,'[]','[]',0,'clarifying',NULL,?,?,?)`,
    id, user.id, kind, uploadId, U.nowIso(), U.nowIso(), budget);
  return id;
}

// POST /v1/intent/voice —— m4a/wav ≤10MB ≤60s，大小与类型服务端实测
function intentVoice(ctx) {
  const user = requireUser(ctx);
  if (!U.allowRate('intent:' + user.id, 10, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const { file, fields } = takeFile(ctx, UP.voiceMaxMb * 1024 * 1024);
  const ext = (path.extname(file.filename).slice(1) || '').toLowerCase();
  if (!UP.voiceExts.includes(ext)) throw new U.ApiError('BAD_REQUEST', '仅支持 m4a 或 wav 音频');
  // 类型实测：魔数校验（RIFF/WAVE 或 ftyp/mp4 容器）
  const head = file.data.slice(0, 16);
  const okMagic = (ext === 'wav' && head.toString('ascii', 0, 4) === 'RIFF')
    || (['m4a'].includes(ext) && head.toString('ascii', 4, 8) === 'ftyp')
    || head.toString('ascii', 4, 8) === 'ftyp';
  if (!okMagic) throw new U.ApiError('BAD_REQUEST', '文件内容与格式不符');
  const dur = audioDurationSec(file.data, ext);
  if (dur === null) throw new U.ApiError('BAD_REQUEST', '无法读取音频时长，文件可能已损坏');
  if (dur > UP.voiceMaxSec + 1) throw new U.ApiError('BAD_REQUEST', `语音需不超过 ${UP.voiceMaxSec} 秒`);
  const saved = saveUpload(file.data, ext, 'voice');
  const uploadId = registerUpload(user, 'voice', saved, file.data.length, ext === 'wav' ? 'audio/wav' : 'audio/mp4');
  const intentId = newDraftIntent(user, 'voice', uploadId, askBudgetFor(user, fields));
  const hint = String(fields.hint || '').trim().slice(0, 300);
  if (hint) rules.moderateFields([hint]);
  engine.enqueue({ type: 'intent_voice', payload: { upload_path: saved.abs, intent_id: intentId, hint, ask_budget: cardBudget(intentId) }, userId: user.id });
  store.log('intent.upload', { user_id: user.id, kind: 'voice', intent_id: intentId, bytes: file.data.length });
  return { status: 202, body: { intent_id: intentId } };
}

// POST /v1/intent/image —— jpg/png ≤8MB
function intentImage(ctx) {
  const user = requireUser(ctx);
  if (!U.allowRate('intent:' + user.id, 10, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const { file, fields } = takeFile(ctx, UP.imageMaxMb * 1024 * 1024);
  const ext = (path.extname(file.filename).slice(1) || '').toLowerCase();
  if (!UP.imageExts.includes(ext)) throw new U.ApiError('BAD_REQUEST', '仅支持 jpg 或 png 图片');
  const head = file.data.slice(0, 8);
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isPng = head.toString('hex', 0, 8) === '89504e470d0a1a0a';
  if (!(isJpg || isPng)) throw new U.ApiError('BAD_REQUEST', '文件内容与格式不符');
  const saved = saveUpload(file.data, ext, 'image');
  const uploadId = registerUpload(user, 'image', saved, file.data.length, isPng ? 'image/png' : 'image/jpeg');
  const intentId = newDraftIntent(user, 'image', uploadId, askBudgetFor(user, fields));
  const hint = String(fields.hint || '').trim().slice(0, 300);
  if (hint) rules.moderateFields([hint]);
  engine.enqueue({ type: 'intent_image', payload: { upload_path: saved.abs, intent_id: intentId, hint, ask_budget: cardBudget(intentId) }, userId: user.id });
  store.log('intent.upload', { user_id: user.id, kind: 'image', intent_id: intentId, bytes: file.data.length });
  return { status: 202, body: { intent_id: intentId } };
}

// POST /v1/intent/text {text, hint?, intent_id?}
// 端侧识别出的逐字、或用户在「你说的话」确认页改过的字 → 直接进理解链（不再过 ASR）。
// 带 intent_id 时原地重编译（改字即重新理解，不用重录）；不带则新建草稿卡。
function intentText(ctx) {
  const user = requireUser(ctx);
  if (!U.allowRate('intent:' + user.id, 20, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const body = ctx.body || {};
  const text = String(body.text || '').trim().slice(0, 500);
  if (!text) throw new U.ApiError('BAD_REQUEST', '请填写内容');
  rules.moderateFields([text]);
  const hint = String(body.hint || '').trim().slice(0, 300);
  if (hint) rules.moderateFields([hint]);
  let intentId = null;
  const wantId = String(body.intent_id || '').trim();
  if (wantId) {
    const row = store.get('SELECT * FROM intent_cards WHERE id=?', wantId);
    if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
    if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '意图卡已使用');
    intentId = row.id;
    // 原话变了，之前对澄清题的回答就作废，避免「答的是上一句」
    // 复用旧卡时一并刷新问法档位：问几题描述的是「现在怎么问用户」，不是卡的历史属性
    store.run('UPDATE intent_cards SET source_text=?,degraded=0,answers=\'[]\',rounds=0,status=\'clarifying\',ask_budget=?,updated_at=? WHERE id=?',
      text, askBudgetFor(user, body), U.nowIso(), intentId);
  } else {
    intentId = newDraftIntent(user, 'text', null, askBudgetFor(user, body));
    store.run('UPDATE intent_cards SET source_text=? WHERE id=?', text, intentId);
  }
  engine.enqueue({ type: 'intent_text', payload: { text, intent_id: intentId, hint, ask_budget: cardBudget(intentId) }, userId: user.id });
  store.log('intent.text', { user_id: user.id, intent_id: intentId, bytes: text.length });
  return { status: 202, body: { intent_id: intentId } };
}

// GET /v1/health/speech —— 客户端「语音能力」自检用（公开，无需登录）。
// 诚实纪律：识别服务在不在、为什么不在，必须能如实告诉用户，不许假装可用。
// 探测结果缓存 15s，避免设置页反复打点把 worker 打烦。
let _speechProbe = null; // { at, body }
async function speechHealth(ctx) {
  const now = Date.now();
  if (_speechProbe && now - _speechProbe.at < 15000) {
    return { status: 200, body: _speechProbe.body };
  }
  const base = String(config.senseVoiceUrl || '').replace(/\/+$/, '');
  let asr;
  if (!base) {
    asr = { ok: false, reason: '服务端未配置识别服务地址' };
  } else {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await fetch(base + '/healthz', { signal: ctrl.signal });
      const j = r.ok ? await r.json().catch(() => ({})) : {};
      asr = r.ok
        ? { ok: true, reason: j && j.model_loaded ? '就绪' : '在线（模型待首次加载）', model_loaded: !!(j && j.model_loaded) } // 不外泄上游设备指纹/模型名
        : { ok: false, reason: '识别服务返回 HTTP ' + r.status };
    } catch (e) {
      const why = e && e.name === 'AbortError' ? '探测超时' : ((e && e.message) || '连不上');
      asr = { ok: false, reason: '识别服务没起来（' + why + '）' };
    } finally {
      clearTimeout(timer);
    }
  }
  const body = { asr, checked_at: U.nowIso() };
  _speechProbe = { at: now, body };
  return { status: 200, body };
}

// GET /v1/intent/:id
function getIntent(ctx) {
  const user = requireUser(ctx);
  const row = store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
  if (row.status === 'draft') return { status: 200, body: { ...store.intentOf(row), status: 'clarifying' } };
  return { status: 200, body: store.intentOf(row) };
}

// POST /v1/intent/:id/answer {answers:[{q_idx,option_idx}]}
// 契约 v5.5.8/9/10（2026-11-27 追加，伴创）。四条纪律都在这一段，每条都对应一个真实故障：
//  ① 题量按**卡**的 ask_budget 分档（伴创 3，其余 2）。全局硬编码 2 会让"开局一次问完"变成硬凑两轮；
//     而全局放宽到 3 又把存量三档一起改了 —— 所以是卡上带字段，不是常量。
//  ② 回填**优先用选项自带的 set**，dict.scan(label) 只在缺 set 时兜底。
//     靠猜标签字面回填正是真机「勾女声出男声」的根因：scan.tags 被 unionArr(cap=3, a 优先) 静默挤掉。
//  ③ set.tags_add 写 gen_params.tags，**绝不并入 genre_hypotheses**。后者是卡面展示位，
//     混进来会挤掉用户显式点选的流派；流派只认 genre_add 这一条显式通道。
//  ④ 整段走 BEGIN IMMEDIATE（对齐 v5.3.1）。此前是裸 read-modify-write：并发两次都从 rounds=0 起算，
//     结果是丢更新、轮次少计、半截答案；answers 另按 q_idx 去重，同一题重复提交只算一次，防止刷 confidence。
const VOICE_DIMS = ['gender', 'voice', 'language', 'accent'];

function applyOptionToCard(opt, card, gp) {
  const set = opt && opt.set && typeof opt.set === 'object' && !Array.isArray(opt.set) ? opt.set : null;
  if (set) {
    if (Array.isArray(set.tags_add) && set.tags_add.length) {
      gp.tags = U.unionArr(gp.tags || [], set.tags_add.map((t) => String(t).trim().slice(0, 24)).filter(Boolean), 5);
    }
    if (Array.isArray(set.genre_add) && set.genre_add.length) {
      card.genre_hypotheses = U.unionArr([], set.genre_add.map((t) => String(t).trim().slice(0, 24)).filter(Boolean), 3);
    }
    if (Array.isArray(set.mood_add) && set.mood_add.length) {
      card.mood = U.unionArr([], set.mood_add.map((t) => String(t).trim().slice(0, 20)).filter(Boolean), 3);
    }
    if (set.vocal !== undefined && set.vocal !== null) {
      const v = String(set.vocal);
      if (['song', 'instrumental', 'unknown'].includes(v)) { card.vocal = v; gp.instrumental = v === 'instrumental'; }
    }
    if (set.bpm !== undefined && set.bpm !== null) {
      const b = Math.round(Number(set.bpm));
      if (Number.isFinite(b) && b >= 40 && b <= 200) gp.bpm = b; // 越界静默丢弃：选项是服务端发的，越界说明发错了，不该污染卡
    }
    if (set.sec !== undefined && set.sec !== null) {
      const g = config.gen; const x = Math.round(Number(set.sec));
      if (Number.isFinite(x) && x >= g.sec_min && x <= g.sec_max) { gp.sec = x; card.duration_hint = x + 's'; }
    }
    if (set.dim !== undefined && set.dim !== null) {
      // dim 是**维度溯源**（这个选项在回答哪一维），不是生乐参数；gender/voice 维落到 voice 承载位
      const d = String(set.dim).trim().slice(0, 24);
      gp.dims = U.unionArr(gp.dims || [], [d], 6);
      if (VOICE_DIMS.includes(d)) card.voice = String(opt.label || '').trim().slice(0, 24) || null;
    }
    return;
  }
  // 兜底路径：存量卡没有 set，只能猜标签。**保持原行为不动** —— 新卡走 set，老卡行为不变，
  // 不把"修复"变成对存量的静默改版。
  const scan = dict.scan(opt.label);
  if (/纯音乐|无人声/.test(opt.label)) { card.vocal = 'instrumental'; }
  else if (/人声|演唱/.test(opt.label)) { card.vocal = 'song'; }
  if (scan.moods.length && !card.mood.includes(scan.moods[0])) card.mood = U.unionArr(card.mood, [scan.moods[0]], 3);
  if (scan.tags.length) card.genre_hypotheses = U.unionArr(card.genre_hypotheses, scan.tags.slice(0, 2), 3);
}

function answerIntent(ctx) {
  const user = requireUser(ctx);
  const head = store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id);
  if (!head || head.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
  if (head.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '意图卡已使用');
  if (head.status === 'ready') return { status: 200, body: store.intentOf(head) };
  const answers = Array.isArray((ctx.body || {}).answers) ? ctx.body.answers : [];
  if (!answers.length) throw new U.ApiError('BAD_REQUEST', '请至少回答一道题');
  const budget = store.intentOf(head).ask_budget;
  if (answers.length > budget) throw new U.ApiError('BAD_REQUEST', `每轮最多回答 ${budget} 题`);

  const out = store.tx(() => {
    // 事务内**重读**：BEGIN IMMEDIATE 之后才是可信写快照，事务外的 head 只用于快速失败与取 budget
    const row = store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id);
    if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
    if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '意图卡已使用');
    if (row.status === 'ready') return { done: true, body: store.intentOf(row) };
    if ((row.rounds || 0) >= 2) throw new U.ApiError('BAD_REQUEST', '澄清轮次已达上限');
    const questions = U.jparse(row.questions, []) || [];
    const prevAnswers = U.jparse(row.answers, []) || [];
    const answered = new Set(prevAnswers.map((a) => Number(a.q_idx)));
    const card = store.intentOf(row);
    const gp = U.jparse(row.gen_params, {}) || {};
    const applied = [];
    const seen = new Set();
    for (const a of answers) {
      const qIdx = Number(a.q_idx);
      const q = questions.find((x) => Number(x.q_idx) === qIdx);
      if (!q) continue;                  // 陈旧题（上一轮已收起）忽略
      if (seen.has(qIdx)) continue;      // 同轮重复提交：只算第一次
      if (answered.has(qIdx)) continue;  // 跨轮已答过：不得二次计分
      const opt = (q.options || []).find((o) => Number(o.idx) === Number(a.option_idx));
      if (!opt) throw new U.ApiError('BAD_REQUEST', '选项不存在');
      seen.add(qIdx);
      applied.push({ q_idx: q.q_idx, option_idx: opt.idx, label: opt.label });
      applyOptionToCard(opt, card, gp);
    }
    if (!applied.length) throw new U.ApiError('BAD_REQUEST', '没有匹配到待回答的题目');
    const totalQ = questions.length || 1;
    const newConf = Math.min(0.95, (row.confidence || 0) + 0.18 * (applied.length / totalQ) + 0.07 * applied.length);
    const next = { ...card, confidence: newConf };
    let status; let questionsOut;
    if (newConf >= 0.75) { status = 'ready'; questionsOut = []; }
    else {
      const qs = dict.defaultQuestions(next, budget); // 仍不充分 → 追加下轮题（按卡分档，必带 recommended_idx）
      const baseIdx = (U.jparse(row.questions, []) || []).length;
      qs.forEach((q, i) => { q.q_idx = baseIdx + i; });
      questionsOut = enforceQuestions(qs, budget);
      status = questionsOut.length ? 'clarifying' : 'ready';
      if (!questionsOut.length) next.confidence = Math.max(newConf, 0.75);
    }
    const answersMerged = prevAnswers.concat(applied.map((a) => ({ q_idx: a.q_idx, option_idx: a.option_idx })));
    // UPDATE 必须含 gen_params：此前只写卡面字段，用户选的 BPM/sec 永远落不了地（v5.5.10）
    store.run(
      'UPDATE intent_cards SET mood=?,genre_hypotheses=?,vocal=?,voice=?,confidence=?,questions=?,answers=?,rounds=?,status=?,gen_params=?,updated_at=? WHERE id=?',
      card.mood.join(','), card.genre_hypotheses.join(','), next.vocal, card.voice == null ? null : card.voice,
      next.confidence, U.jstr(questionsOut), U.jstr(answersMerged), (row.rounds || 0) + 1, status,
      U.jstr(gp), U.nowIso(), row.id);
    store.log('intent.answer', { user_id: user.id, intent_id: row.id, applied: applied.length, status, set_used: applied.length });
    return { done: false, id: row.id, status };
  });
  if (out.done) return { status: 200, body: out.body };
  bus.intentCard(user.id, out.id, out.status); // 通知放事务外：提交成功再广播，回滚不发假事件
  return { status: 200, body: store.intentOf(store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id)) };
}

function enforceQuestions(qs, budget) {
  const cap = Number.isFinite(budget) && budget >= 1 && budget <= 3 ? Math.trunc(budget) : 2;
  const out = [];
  for (const q of (qs || []).slice(0, cap)) {
    if (!q.q || !Array.isArray(q.options) || q.options.length < 2) continue;
    // 原实现 Math.min(recommended_idx, 1) 把推荐位**永久钳死在第 0/1 项**：
    // 4 选项的题里，正确答案排在 2/3 时永远拿不到高亮。按实际选项数钳。
    const last = Math.max(0, Math.min(4, q.options.length) - 1);
    if (q.recommended_idx == null || !(Number(q.recommended_idx) >= 0) || Number(q.recommended_idx) > last) q.recommended_idx = 0;
    else q.recommended_idx = Math.trunc(Number(q.recommended_idx));
    out.push(q);
  }
  return out;
}

// PATCH /v1/intent/:id —— 卡面「点改」唯一落库通道（契约 v2.19）
// mood/genre_hypotheses/vocal/scene_desc 改卡面；sec/bpm/count 改 gen_params。
// 编辑与澄清纪律解耦：不推进 status/rounds/confidence；consumed 拒改。
function patchIntent(ctx) {
  const user = requireUser(ctx);
  const row = store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
  if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '意图卡已使用，不能再修改');
  // 限流已内移到 patchIntentInternal（v5.5.11）；这里不再重复扣桶，否则一次请求计两次。
  return patchIntentInternal(user, row, ctx.body || {});
}
// 内部 kernel：供 PATCH 端点与音乐助手 set_card 复用（行须已按属主加载并校验状态）
function patchIntentInternal(user, row, body) {
  // v5.5.11：限流必须在**内核内部**。三个调用方汇聚到这里 —— HTTP PATCH、l2assistant 轻量写
  // （facade.js 的 patchIntentInternal）、l2music set_card（execute.js:59）—— 只在 HTTP 端点校验，
  // 等于给助手通道留了一个不限流的刷卡口；智能体会把它放大成脚本刷改卡。
  if (!U.allowRate('intent:' + user.id, 10, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const G = config.gen;
  const card = store.intentOf(row);
  const gp = U.jparse(row.gen_params, {}) || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const fields = [];

  if (has('mood')) {
    const arr = U.toArr(body.mood).map((e) => String(e).trim()).filter(Boolean);
    if (arr.length > 3) throw new U.ApiError('BAD_REQUEST', '心情最多选 3 项');
    card.mood = U.unionArr([], arr, 3).map((e) => String(e).slice(0, 20));
    fields.push('mood');
  }
  if (has('genre_hypotheses')) {
    const arr = U.toArr(body.genre_hypotheses).map((e) => String(e).trim()).filter(Boolean);
    if (arr.length > 3) throw new U.ApiError('BAD_REQUEST', '流派最多选 3 项');
    card.genre_hypotheses = U.unionArr([], arr, 3).map((e) => String(e).slice(0, 24));
    gp.tags = card.genre_hypotheses.slice(0, 5); // 用户点的流派直接成为生乐 tags，不被推测覆盖
    fields.push('genre_hypotheses');
  }
  if (has('vocal')) {
    const v = String(body.vocal || '');
    if (!['song', 'instrumental', 'unknown'].includes(v)) throw new U.ApiError('BAD_REQUEST', 'vocal 仅支持 song|instrumental|unknown');
    card.vocal = v;
    gp.instrumental = v === 'instrumental';
    fields.push('vocal');
  }
  if (has('voice')) {
    // v5.5.9「谁来唱」：独立承载位，不再靠把女声/男声塞进 genre_hypotheses 的 tags 里猜
    const v = String(body.voice || '').trim().slice(0, 24);
    if (!v) throw new U.ApiError('BAD_REQUEST', 'voice 不能为空');
    rules.moderateFields([v]);
    card.voice = v;
    fields.push('voice');
  }
  if (has('scene_desc')) {
    const d = String(body.scene_desc || '').trim().slice(0, 301);
    if (d.length > 300) throw new U.ApiError('BAD_REQUEST', '灵感描述不超过 300 字');
    rules.moderateFields([d]); // 命中词库 → MODERATION_BLOCK
    card.scene_desc = d;
    gp.prompt = d;
    fields.push('scene_desc');
  }
  if (has('sec')) {
    const s = Number(body.sec);
    if (!Number.isFinite(s) || s < G.sec_min || s > G.sec_max) throw new U.ApiError('BAD_REQUEST', `时长需在 ${G.sec_min}-${G.sec_max} 秒之间`);
    gp.sec = Math.round(s);
    card.duration_hint = gp.sec + 's';
    fields.push('sec');
  }
  if (has('bpm')) {
    const b = Number(body.bpm);
    if (!Number.isFinite(b) || b < 40 || b > 200) throw new U.ApiError('BAD_REQUEST', 'BPM 需在 40-200 之间');
    gp.bpm = Math.round(b);
    fields.push('bpm');
  }
  if (has('count')) {
    const c = Number(body.count);
    if (!Number.isInteger(c) || c < G.count_min || c > G.count_max) throw new U.ApiError('BAD_REQUEST', `候选数量需在 ${G.count_min}-${G.count_max} 之间`);
    gp.count = c;
    fields.push('count');
  }
  if (!fields.length) throw new U.ApiError('BAD_REQUEST', '没有可修改的字段');

  store.run(
    'UPDATE intent_cards SET mood=?,genre_hypotheses=?,vocal=?,voice=?,scene_desc=?,duration_hint=?,gen_params=?,updated_at=? WHERE id=?',
    card.mood.join(','), card.genre_hypotheses.join(','), card.vocal,
    has('voice') ? card.voice : (row.voice == null ? null : row.voice),
    card.scene_desc, card.duration_hint, U.jstr(gp), U.nowIso(), row.id);
  bus.intentCard(user.id, row.id, row.status);
  store.log('intent.patch', { user_id: user.id, intent_id: row.id, fields, status: row.status });
  return { status: 200, body: store.intentOf(store.get('SELECT * FROM intent_cards WHERE id=?', row.id)) };
}

// POST /v1/intent/:id/generate —— 仅 ready；卡变 consumed；按卡组 generate 参数派单
function generateFromIntent(ctx) {
  const user = requireUser(ctx);
  const row = store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
  return generateIntentInternal(user, row);
}
// 内部 kernel：供端点与音乐助手 regenerate-from-intent 复用（行须已按属主加载）
function generateIntentInternal(user, row) {
  if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '意图卡已使用，请重新生成');
  if (row.status !== 'ready') throw new U.ApiError('BAD_REQUEST', '意图尚未明确，请先完成澄清');
  const card = store.intentOf(row);
  // 契约 v2.19 参数优先级：gen_params（用户显式点改）> 卡面推导 > 服务端默认
  const gp = U.jparse(row.gen_params, {}) || {};
  const p = { ...intentPrompt.genParamsFromCard(card) };
  for (const k of ['mood', 'tags', 'bpm', 'sec', 'instrumental', 'prompt']) {
    if (gp[k] !== undefined && gp[k] !== null) p[k] = gp[k];
  }
  const r = worksApi.dispatchMusic(user, 'intent', {
    prompt: card.scene_desc || p.prompt || '', mood: card.mood[0] || p.mood || '',
    tags: (p.tags && p.tags.length ? p.tags : card.genre_hypotheses), bpm: p.bpm,
    sec: p.sec, instrumental: p.instrumental,
    // count 只在用户显式点改过才覆盖默认——用户选 1 首就不发 3 首（计费交付一致，对齐 DEV-LADDER-PAY）
    count: gp.count == null ? config.gen.count_default : gp.count,
    // 契约 v5.7.8（复刻）：溯源随 payload 进 job，adopt 时写 works.gen_params.replica + lineage='replica'
    ...(gp.replica && typeof gp.replica === 'object' && !Array.isArray(gp.replica) ? { replica: gp.replica } : {}),
  }, gp.replica ? { reason: 'gen', lineage: { kind: 'replica' } } : { reason: 'gen' });
  if (r.status === 202 && !r.body.idempotent) {
    store.run("UPDATE intent_cards SET status='consumed', updated_at=? WHERE id=?", U.nowIso(), row.id);
    bus.intentCard(user.id, row.id, 'consumed');
    store.log('intent.generate', { user_id: user.id, intent_id: row.id, job_id: r.body.job_id });
  }
  return r;
}

module.exports = {
  audioDurationSec,
  // 供复刻（api/replica.js）与智能体（api/agent.js 的建议票）复用：上传取件/建卡/首轮题整形。
  // 智能体那条必须有它：模型给的 intent_id 查不到时，服务端要能就地建一张**属主本人**的任务单，
  // 而不是拿一个幻觉编号去派单（复制一份 INSERT 就是第二份真源，早晚会和这张表打架）。
  takeFile, newDraftIntent, enforceQuestions,
  patchIntentInternal, generateIntentInternal, // 供音乐助手 set_card / regenerate-from-intent 复用
  routes: [
    { m: 'POST', p: '/v1/intent/voice', h: intentVoice, raw: true, limitMb: UP.voiceMaxMb + 2 },
    { m: 'POST', p: '/v1/intent/image', h: intentImage, raw: true, limitMb: UP.imageMaxMb + 2 },
    { m: 'POST', p: '/v1/intent/text', h: intentText },
    { m: 'GET', p: '/v1/health/speech', h: speechHealth },
    { m: 'GET', p: '/v1/intent/:id', h: getIntent },
    { m: 'POST', p: '/v1/intent/:id/answer', h: answerIntent },
    { m: 'PATCH', p: '/v1/intent/:id', h: patchIntent },
    { m: 'POST', p: '/v1/intent/:id/generate', h: generateFromIntent },
  ],
};
