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
function newDraftIntent(user, kind, uploadId) {
  const id = U.uid('in_');
  store.run(
    `INSERT INTO intent_cards(id,user_id,source_kind,source_ref,mood,scene_desc,genre_hypotheses,vocal,duration_hint,
      confidence,questions,answers,rounds,status,gen_params,created_at,updated_at)
     VALUES(?,?,?,?,'','',?,'unknown','',0,'[]','[]',0,'clarifying',NULL,?,?)`,
    id, user.id, kind, uploadId, U.nowIso(), U.nowIso());
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
  const intentId = newDraftIntent(user, 'voice', uploadId);
  const hint = String(fields.hint || '').trim().slice(0, 300);
  if (hint) rules.moderateFields([hint]);
  engine.enqueue({ type: 'intent_voice', payload: { upload_path: saved.abs, intent_id: intentId, hint }, userId: user.id });
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
  const intentId = newDraftIntent(user, 'image', uploadId);
  const hint = String(fields.hint || '').trim().slice(0, 300);
  if (hint) rules.moderateFields([hint]);
  engine.enqueue({ type: 'intent_image', payload: { upload_path: saved.abs, intent_id: intentId, hint }, userId: user.id });
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
    store.run('UPDATE intent_cards SET source_text=?,degraded=0,answers=\'[]\',rounds=0,status=\'clarifying\',updated_at=? WHERE id=?',
      text, U.nowIso(), intentId);
  } else {
    intentId = newDraftIntent(user, 'text', null);
    store.run('UPDATE intent_cards SET source_text=? WHERE id=?', text, intentId);
  }
  engine.enqueue({ type: 'intent_text', payload: { text, intent_id: intentId, hint }, userId: user.id });
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
// 服务端强制：总轮次 ≤2、每轮 ≤2 题、每题必带 recommended_idx、confidence≥0.75 直接 ready
function answerIntent(ctx) {
  const user = requireUser(ctx);
  const row = store.get('SELECT * FROM intent_cards WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '意图卡不存在');
  if (row.status === 'consumed') throw new U.ApiError('BAD_REQUEST', '意图卡已使用');
  if (row.status === 'ready') return { status: 200, body: store.intentOf(row) };
  const answers = Array.isArray((ctx.body || {}).answers) ? ctx.body.answers : [];
  if (!answers.length) throw new U.ApiError('BAD_REQUEST', '请至少回答一道题');
  if (answers.length > 2) throw new U.ApiError('BAD_REQUEST', '每轮最多回答 2 题');
  if ((row.rounds || 0) >= 2) throw new U.ApiError('BAD_REQUEST', '澄清轮次已达上限');
  const questions = U.jparse(row.questions, []) || [];
  const prevAnswers = U.jparse(row.answers, []) || [];
  const card = store.intentOf(row);
  const applied = [];
  for (const a of answers) {
    const q = questions.find(x => x.q_idx === Number(a.q_idx));
    if (!q) continue; // 忽略陈旧题
    const opt = (q.options || []).find(o => o.idx === Number(a.option_idx));
    if (!opt) throw new U.ApiError('BAD_REQUEST', '选项不存在');
    applied.push({ q_idx: q.q_idx, option_idx: opt.idx, label: opt.label });
    // 依选项语义回填卡面
    const scan = dict.scan(opt.label);
    if (/纯音乐|无人声/.test(opt.label)) { card.vocal = 'instrumental'; }
    else if (/人声|演唱/.test(opt.label)) { card.vocal = 'song'; }
    if (scan.moods.length && !card.mood.includes(scan.moods[0])) card.mood = U.unionArr(card.mood, [scan.moods[0]], 3);
    if (scan.tags.length) card.genre_hypotheses = U.unionArr(card.genre_hypotheses, scan.tags.slice(0, 2), 3);
  }
  if (!applied.length) throw new U.ApiError('BAD_REQUEST', '没有匹配到待回答的题目');
  // 置信度推进：答完全部题 → 显著上升
  const totalQ = questions.length || 1;
  const newConf = Math.min(0.95, (row.confidence || 0) + 0.18 * (applied.length / totalQ) + 0.07 * applied.length);
  const next = { ...card, confidence: newConf };
  let status; let questionsOut;
  if (newConf >= 0.75) { status = 'ready'; questionsOut = []; }
  else {
    const qs = dict.defaultQuestions(next); // 仍不充分→追加下轮题（≤2 题，必带 recommended_idx）
    const baseIdx = (U.jparse(row.questions, []) || []).length;
    qs.forEach((q, i) => { q.q_idx = baseIdx + i; });
    questionsOut = enforceQuestions(qs);
    status = questionsOut.length ? 'clarifying' : 'ready';
    if (!questionsOut.length) next.confidence = Math.max(newConf, 0.75);
  }
  const answersMerged = prevAnswers.concat(applied.map(a => ({ q_idx: a.q_idx, option_idx: a.option_idx })));
  store.run(
    'UPDATE intent_cards SET mood=?,genre_hypotheses=?,vocal=?,confidence=?,questions=?,answers=?,rounds=?,status=?,updated_at=? WHERE id=?',
    card.mood.join(','), card.genre_hypotheses.join(','), next.vocal, next.confidence,
    U.jstr(questionsOut), U.jstr(answersMerged), (row.rounds || 0) + 1, status, U.nowIso(), row.id);
  bus.intentCard(user.id, row.id, status);
  store.log('intent.answer', { user_id: user.id, intent_id: row.id, applied: applied.length, status });
  return { status: 200, body: store.intentOf(store.get('SELECT * FROM intent_cards WHERE id=?', row.id)) };
}

function enforceQuestions(qs) {
  const out = [];
  for (const q of (qs || []).slice(0, 2)) {
    if (!q.q || !Array.isArray(q.options) || q.options.length < 2) continue;
    if (q.recommended_idx == null || q.recommended_idx < 0 || q.recommended_idx >= q.options.length) q.recommended_idx = 0;
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
  if (!U.allowRate('intent:' + user.id, 10, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  return patchIntentInternal(user, row, ctx.body || {});
}
// 内部 kernel：供 PATCH 端点与音乐助手 set_card 复用（行须已按属主加载并校验状态）
function patchIntentInternal(user, row, body) {
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
    'UPDATE intent_cards SET mood=?,genre_hypotheses=?,vocal=?,scene_desc=?,duration_hint=?,gen_params=?,updated_at=? WHERE id=?',
    card.mood.join(','), card.genre_hypotheses.join(','), card.vocal, card.scene_desc, card.duration_hint,
    U.jstr(gp), U.nowIso(), row.id);
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
  }, { reason: 'gen' });
  if (r.status === 202 && !r.body.idempotent) {
    store.run("UPDATE intent_cards SET status='consumed', updated_at=? WHERE id=?", U.nowIso(), row.id);
    bus.intentCard(user.id, row.id, 'consumed');
    store.log('intent.generate', { user_id: user.id, intent_id: row.id, job_id: r.body.job_id });
  }
  return r;
}

module.exports = {
  audioDurationSec,
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
