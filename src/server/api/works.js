// 作品线：generate 派单/幂等/先扣分、jobs 查询、adopt、列表/详情/PATCH、extend/cover/variation/adjust/dsp/seed-pack/report（2026-11-23）
'use strict';
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const engine = require('../core/engine');
const rules = require('../core/rules');
const auth = require('./auth');
const credits = require('./credits');
const U = require('../core/util');
const dict = require('../prompts/dictionary');
const adjustPrompt = require('../prompts/adjust');
const M = require('../core/modelnodes');
const AC = require('../core/appconfig');

const requireUser = auth.requireUser;
const G = config.gen;

// —— 归一化生乐参数 + 派单（先扣分后派单，幂等命中不扣分）——
function buildMusicPayload(params) {
  const textForScan = [params.prompt, (params.tags || []).join(' '), params.mood, (params.lyrics || '').slice(0, 300)].join('\n');
  const scan = dict.scan(textForScan);
  const mood = String(params.mood || scan.moods[0] || '中性').slice(0, 20);
  const tags = U.unionArr(scan.tags, U.toArr(params.tags), 6);
  const sec = params.sec == null ? G.sec_default : U.clamp(Math.round(Number(params.sec)), G.sec_min, G.sec_max);
  const count = params.count == null ? G.count_default : U.clamp(Math.round(Number(params.count)), G.count_min, G.count_max);
  const bpm = params.bpm == null ? (scan.bpm || 100) : U.clamp(Math.round(Number(params.bpm)), 40, 200);
  const lyrics = String(params.lyrics || '').slice(0, 4000);
  const instrumental = params.instrumental !== undefined ? !!params.instrumental : (!lyrics.trim());
  const seed_base = Number.isFinite(Number(params.seed_base)) ? Number(params.seed_base) : U.randInt(900000) + 1000;
  let persona = null;
  if (params.persona_id) {
    const p = store.get('SELECT * FROM personas WHERE id=?', params.persona_id);
    if (!p) throw new U.ApiError('NOT_FOUND', '声音人格不存在');
    persona = {
      ref_abs_path: p.voice_ref ? path.join(config.paths.out, p.voice_ref) : null,
      cover_strength: params.cover_strength == null ? 0.2 : U.clamp(params.cover_strength, 0, 1),
      clone_mode: params.clone_mode === 'full' ? 'full' : 'fast',
    };
  }
  return {
    mood, tags, lyrics, bpm, sec, count, seed_base,
    instrumental, persona,
    src_audio: params.src_audio || null,
    prompt: String(params.prompt || '').slice(0, 500),
    candidates: Array.from({ length: count }, (_, i) => ({ seq: i + 1, seed_delta: i })),
  };
}

function normalizeForIdem(user, kind, params) {
  const p = { ...params };
  delete p.idempotency_key;
  return U.sha256hex([user.id, kind,
    String(p.prompt || '').trim(), String(p.lyrics || '').trim().slice(0, 2000),
    (U.toArr(p.tags) || []).sort().join(','), String(p.mood || '').trim(),
    p.bpm == null ? '' : p.bpm, p.sec == null ? '' : p.sec, p.count == null ? '' : p.count,
    p.persona_id || '', p.candidate_id || '', p.op || '', p.model || '',
    // seed/instrumental 必须进幂等键：否则改 seed 重试会被旧 job 吃掉（10 分钟窗口）
    p.seed_base == null ? '' : p.seed_base,
    p.instrumental == null ? '' : (p.instrumental ? '1' : '0'),
    U.jstr(p.params || null), U.jstr(p.delta || null),
  ].join(''));
}

// 派单核心：审核→幂等→扣分→enqueue
function dispatchMusic(user, kind, params, opts) {
  opts = opts || {};
  rules.moderateFields([params.prompt, params.lyrics, params.tags, params.mood, params.text]);
  const idemKey = normalizeForIdem(user, kind, params);
  const ex = store.get('SELECT * FROM jobs WHERE idem_key=?', idemKey);
  const activeOrRecent = ex && (['queued', 'leased', 'running', 'done'].includes(ex.status) || Date.parse(ex.created_at) > Date.now() - 10 * 60000);
  if (ex && activeOrRecent) {
    return { status: 202, body: { job_id: ex.id, credits_charged: 0, idempotent: true } };
  }
  const cost = opts.cost == null ? AC.credits().per_candidate * (params.count || G.count_default) : opts.cost;
  credits.charge(user.id, cost, opts.reason || 'gen', 'gen', kind);
  const payload = buildMusicPayload(params);
  // 模型选择（APK 未设置则后端默认；后台 locked 时强制默认，见 core/modelnodes.pickNodeForJob）
  const musicNode = M.pickNodeForJob('music', params.model);
  if (musicNode && musicNode.endpoint) { payload.music_endpoint = musicNode.endpoint; payload.music_engine = musicNode.engine; }
  if (opts.lineage) payload.lineage = opts.lineage; // {kind, parent_id}：adopt 时写入谱系
  let r;
  try {
    r = engine.enqueue({ type: 'music', payload, userId: user.id, idemKey, creditsCost: cost, parentJobId: opts.parentJobId || null });
  } catch (e) {
    credits.refund(user.id, cost, 'gen', kind); // 派单失败即时退回，账本平衡
    throw e;
  }
  if (r.idempotent) { // 并发同参竞态：后到者退款
    credits.refund(user.id, cost, 'gen', kind);
    return { status: 202, body: { job_id: r.job.id, credits_charged: 0, idempotent: true } };
  }
  store.log('works.dispatch', { user_id: user.id, job_id: r.job.id, kind, cost });
  return { status: 202, body: { job_id: r.job.id, credits_charged: cost, idempotent: false } };
}

// —— POST /v1/works/generate ——
function generate(ctx) {
  const user = requireUser(ctx);
  const body = ctx.body || {};
  const mode = String(body.mode || 'simple');
  if (!['simple', 'custom'].includes(mode)) throw new U.ApiError('BAD_REQUEST', 'mode 仅支持 simple 或 custom');
  const prompt = String(body.prompt || '').trim();
  const lyrics = String(body.lyrics || '').trim();
  if (mode === 'simple' && !prompt && !lyrics) throw new U.ApiError('BAD_REQUEST', '请描述你想要的音乐');
  if (body.sec !== undefined && body.sec !== null) {
    const s = Number(body.sec);
    if (!Number.isFinite(s) || s < G.sec_min || s > G.sec_max) throw new U.ApiError('BAD_REQUEST', `时长需在 ${G.sec_min}-${G.sec_max} 秒之间`);
  }
  if (body.count !== undefined && body.count !== null) {
    const c = Number(body.count);
    if (!Number.isInteger(c) || c < G.count_min || c > G.count_max) throw new U.ApiError('BAD_REQUEST', `候选数量需在 ${G.count_min}-${G.count_max} 之间`);
  }
  if (!U.allowRate('gen:' + user.id, 12, 60000)) throw new U.ApiError('RATE_LIMITED', '生成过于频繁，请稍后再试');
  // seed：复现基准（候选依次 +0/+1/+2…）；显式传入即锁定，留空随机
  const seedRaw = body.seed_base !== undefined && body.seed_base !== null ? body.seed_base : body.seed;
  let seedBase;
  if (seedRaw !== undefined && seedRaw !== null && seedRaw !== '') {
    const sv = Number(seedRaw);
    if (!Number.isInteger(sv) || sv < 0 || sv > 2147483647) {
      throw new U.ApiError('BAD_REQUEST', 'seed 需为 0-2147483647 的整数');
    }
    seedBase = sv;
  }
  // instrumental：显式表态优先于「留空歌词即纯音乐」的推断（人声+空歌词不再被误判纯音乐）
  let instrumental;
  if (body.instrumental !== undefined && body.instrumental !== null) {
    if (typeof body.instrumental === 'boolean') instrumental = body.instrumental;
    else if (body.instrumental === 'true' || body.instrumental === 1 || body.instrumental === '1') instrumental = true;
    else if (body.instrumental === 'false' || body.instrumental === 0 || body.instrumental === '0') instrumental = false;
    else throw new U.ApiError('BAD_REQUEST', 'instrumental 需为布尔值');
  }
  return dispatchMusic(user, 'generate', {
    prompt, lyrics, tags: U.toArr(body.tags), mood: body.mood, bpm: body.bpm,
    sec: body.sec, count: body.count, persona_id: body.persona_id, model: body.model,
    ...(seedBase === undefined ? {} : { seed_base: seedBase }),
    ...(instrumental === undefined ? {} : { instrumental }),
  }, { reason: 'gen' });
}

// —— GET /v1/jobs/:id ——
function getJob(ctx) {
  const user = requireUser(ctx);
  const job = engine.getJob(ctx.params.id);
  if (!job) throw new U.ApiError('NOT_FOUND', '任务不存在');
  if (job.user_id && job.user_id !== user.id) throw new U.ApiError('FORBIDDEN', '无权查看该任务');
  const cands = store.all('SELECT * FROM candidates WHERE job_id=? ORDER BY seq ASC', job.id).map(store.candidateOf);
  const result = U.jparse(job.result, {}) || {};
  const adoptedWork = store.get('SELECT work_id FROM candidates WHERE job_id=? AND work_id IS NOT NULL LIMIT 1', job.id);
  return {
    status: 200,
    body: {
      id: job.id, type: job.type, status: job.status,
      progress: job.progress || 0, note: job.note || '',
      candidates: cands.length ? cands : null,
      error: job.status === 'failed' ? { code: job.error_code || 'INTERNAL', message: job.error_message || '后台处理失败，请稍后重试' } : null,
      result_work_id: (adoptedWork && adoptedWork.work_id) || result.work_id || null,
    },
  };
}

// —— POST /v1/works/:id/adopt {candidate_id} ——
function adopt(ctx) {
  const user = requireUser(ctx);
  const candId = String((ctx.body || {}).candidate_id || '').trim();
  const cand = store.get('SELECT * FROM candidates WHERE id=?', candId);
  if (!cand) throw new U.ApiError('NOT_FOUND', '候选不存在');
  if (cand.adopted) throw new U.ApiError('BAD_REQUEST', '该候选已被采纳');
  const job = engine.getJob(cand.job_id);
  if (!job || (job.user_id && job.user_id !== user.id)) throw new U.ApiError('FORBIDDEN', '无权操作该候选');
  const payload = U.jparse(job.payload, {}) || {};
  const meta = U.jparse(cand.meta, {}) || {};
  const lin = (payload.lineage && ['origin', 'adjust', 'variation', 'extend', 'cover'].includes(payload.lineage.kind)) ? payload.lineage : { kind: 'origin' };
  const parent = lin.parent_id ? store.get('SELECT * FROM works WHERE id=?', lin.parent_id) : null;
  const workId = store.tx(() => {
    const w = U.uid('w_');
    store.run(
      `INSERT INTO works(id,user_id,title,status,audio_master,audio_playback,duration_sec,format,waveform_ref,mood,genres,bpm,language,lyrics,
        gen_engine,gen_seed,gen_params,lineage_kind,parent_id,lineage_depth,persona_id,ai_label,visibility,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,0),?,1,'private',?)`,
      w, user.id, String(cand.title || '未命名灵感').slice(0, 80), 'draft',
      cand.audio_master, cand.audio_playback, cand.duration_sec, cand.format || 'wav', cand.waveform_ref,
      payload.mood || '', (payload.tags || []).join(','), payload.bpm || null, 'zh', payload.lyrics || '',
      'music', meta.seed == null ? payload.seed_base : meta.seed,
      U.jstr({ prompt: payload.prompt, tags: payload.tags, sec: payload.sec, seed_base: payload.seed_base, instrumental: payload.instrumental, job_id: job.id }),
      lin.kind, parent ? parent.id : null, parent ? (parent.lineage_depth || 0) + 1 : null,
      payload.persona_id || null, U.nowIso());
    store.run('UPDATE candidates SET adopted=1, work_id=? WHERE id=?', w, cand.id);
    return w;
  });
  store.log('works.adopt', { user_id: user.id, work_id: workId, candidate_id: cand.id });
  return { status: 200, body: { work: store.workOf(store.get('SELECT * FROM works WHERE id=?', workId)) } };
}

// —— GET /v1/works?mine=1|public=1&genre&mood&bpm_min&bpm_max&q&cursor ——
function listWorks(ctx) {
  const q = ctx.query || {};
  const where = [];
  const args = [];
  if (q.public === '1') {
    where.push("visibility='public'");
  } else {
    const u = ctx.user || auth.requireUser(ctx); // 内部助手复用同一可见性检索，HTTP 仍走原鉴权
    where.push('user_id=?'); args.push(u.id);
  }
  if (q.genre) { where.push('genres LIKE ?'); args.push('%' + String(q.genre).slice(0, 30) + '%'); }
  if (q.mood) { where.push('mood LIKE ?'); args.push('%' + String(q.mood).slice(0, 30) + '%'); }
  if (q.bpm_min) { where.push('bpm>=?'); args.push(Number(q.bpm_min) || 0); }
  if (q.bpm_max) { where.push('bpm<=?'); args.push(Number(q.bpm_max) || 999); }
  if (q.q) {
    const kw = '%' + String(q.q).slice(0, 50) + '%';
    where.push('(title LIKE ? OR lyrics LIKE ? OR mood LIKE ? OR genres LIKE ?)');
    args.push(kw, kw, kw, kw);
  }
  const cursor = U.decodeCursor(q.cursor);
  if (cursor && cursor.t && cursor.id) {
    where.push('(created_at<? OR (created_at=? AND id<?))');
    args.push(cursor.t, cursor.t, cursor.id);
  }
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20)); // limit 可选（契约未强制；V4-⑤ 用其演练 cursor 路径）
  const rows = store.all(
    `SELECT * FROM works WHERE ${where.join(' AND ')||'1=1'} AND status<>'retired' ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...args, limit + 1);
  const items = rows.slice(0, limit).map(store.workOf);
  const last = rows.length > limit ? rows[limit - 1] : null;
  return { status: 200, body: { items, next_cursor: last ? U.encodeCursor({ t: last.created_at, id: last.id }) : null } };
}

function ownWork(ctx, id, { allowPublic } = {}) {
  const w = store.get('SELECT * FROM works WHERE id=?', id);
  if (!w || w.status === 'retired') throw new U.ApiError('NOT_FOUND', '作品不存在');
  if (w.user_id !== ctx.user.id) {
    if (allowPublic && w.visibility === 'public') return w;
    throw new U.ApiError('FORBIDDEN', '无权操作该作品');
  }
  return w;
}

// —— GET /v1/works/:id ——
function detail(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id, { allowPublic: true });
  const parents = [];
  let cur = w.parent_id ? store.get('SELECT * FROM works WHERE id=?', w.parent_id) : null;
  let guard = 0;
  while (cur && guard++ < 10) {
    parents.push(store.workOf(cur));
    cur = cur.parent_id ? store.get('SELECT * FROM works WHERE id=?', cur.parent_id) : null;
  }
  const children = store.get("SELECT COUNT(*) AS n FROM works WHERE parent_id=? AND status<>'retired'", w.id);
  return { status: 200, body: { work: store.workOf(w), lineage_parents: parents, children_count: (children && children.n) || 0 } };
}

// —— PATCH /v1/works/:id ——
function patchWork(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id);
  return patchWorkInternal(user, w, ctx.body || {});
}
// 作品点改内核：PATCH 与统一助手确认票共用，避免另起一套写库/审核/审计通道。
function patchWorkInternal(user, w, b) {
  const sets = []; const args = [];
  if (b.title !== undefined) { rules.moderateFields([b.title]); sets.push('title=?'); args.push(String(b.title).slice(0, 80)); }
  if (b.mood !== undefined) { rules.moderateFields([b.mood]); sets.push('mood=?'); args.push(String(b.mood).slice(0, 20)); }
  if (b.genres !== undefined) { rules.moderateFields([b.genres]); sets.push('genres=?'); args.push(U.toArr(b.genres).slice(0, 8).join(',')); }
  if (b.rating !== undefined) {
    const r = Number(b.rating);
    if (!Number.isFinite(r) || r < 1 || r > 5) throw new U.ApiError('BAD_REQUEST', '评分需在 1-5 之间');
    sets.push('rating=?'); args.push(Math.round(r));
  }
  if (b.visibility !== undefined) {
    const v = String(b.visibility);
    if (!['private', 'public'].includes(v)) throw new U.ApiError('BAD_REQUEST', 'visibility 仅支持 private 或 public');
    sets.push('visibility=?'); args.push(v);
  }
  if (b.status !== undefined) {
    const s = String(b.status);
    if (!['draft', 'published', 'retired'].includes(s)) throw new U.ApiError('BAD_REQUEST', 'status 无效');
    sets.push('status=?'); args.push(s);
  }
  if (!sets.length) throw new U.ApiError('BAD_REQUEST', '没有需要更新的字段');
  store.run(`UPDATE works SET ${sets.join(',')} WHERE id=?`, ...args, w.id);
  store.log('works.patch', { user_id: user.id, work_id: w.id, fields: Object.keys(b) });
  return { status: 200, body: { work: store.workOf(store.get('SELECT * FROM works WHERE id=?', w.id)) } };
}

// —— POST /v1/works/:id/extend {sec} ——
function extend(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id);
  const sec = Number((ctx.body || {}).sec);
  if (!Number.isFinite(sec) || sec < G.sec_min || sec > G.sec_max) throw new U.ApiError('BAD_REQUEST', `续写时长需在 ${G.sec_min}-${G.sec_max} 秒之间`);
  const payload = U.jparse(w.gen_params, {}) || {};
  return dispatchMusic(user, 'extend', {
    prompt: payload.prompt || w.title, tags: U.toArr(w.genres), mood: w.mood, bpm: w.bpm,
    sec, count: 1, lyrics: w.lyrics, instrumental: payload.instrumental,
    src_audio: w.audio_master ? path.join(config.paths.out, w.audio_master) : null,
  }, { cost: AC.credits().extend, reason: 'extend', lineage: { kind: 'extend', parent_id: w.id } });
}

// —— POST /v1/works/:id/cover {persona_id} ——
function cover(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id);
  const personaId = String((ctx.body || {}).persona_id || '').trim();
  if (!personaId) throw new U.ApiError('BAD_REQUEST', '请选择声音人格');
  const p = store.get('SELECT * FROM personas WHERE id=?', personaId);
  if (!p || (p.user_id !== user.id && !p.is_public)) throw new U.ApiError('NOT_FOUND', '声音人格不存在');
  const payload = U.jparse(w.gen_params, {}) || {};
  const r = dispatchMusic(user, 'cover', {
    prompt: payload.prompt || w.title, tags: U.toArr(w.genres), mood: w.mood, bpm: w.bpm,
    sec: w.duration_sec || G.sec_default, count: 1, lyrics: w.lyrics, instrumental: false,
    persona_id: personaId, src_audio: w.audio_master ? path.join(config.paths.out, w.audio_master) : null,
  }, { cost: AC.credits().cover, reason: 'cover', lineage: { kind: 'cover', parent_id: w.id } });
  store.run('UPDATE personas SET use_count=use_count+1 WHERE id=?', personaId);
  return r;
}

// —— POST /v1/works/:id/variation {delta:{tags?/mood?/bpm?/seed?}} ——
function variation(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id);
  const delta = (ctx.body || {}).delta || {};
  if (!delta || typeof delta !== 'object') throw new U.ApiError('BAD_REQUEST', '缺少调整参数');
  const base = variationBase(w);
  const merged = adjustPrompt.mergeDelta(base, {
    tags: U.toArr(delta.tags), mood: delta.mood, bpm: delta.bpm, seed: delta.seed, instrumental: delta.instrumental,
  });
  return dispatchMusic(user, 'variation', { ...merged, count: G.count_default }, { cost: AC.credits().adjust, reason: 'adjust', lineage: { kind: 'variation', parent_id: w.id } });
}

function variationBase(w) {
  const payload = U.jparse(w.gen_params, {}) || {};
  return {
    prompt: payload.prompt || w.title, tags: U.toArr(w.genres), mood: w.mood, bpm: w.bpm,
    sec: w.duration_sec || G.sec_default, lyrics: w.lyrics,
    instrumental: payload.instrumental === undefined ? !!String(w.lyrics || '').trim() : payload.instrumental,
    seed_base: payload.seed_base == null ? null : payload.seed_base,
  };
}

// —— POST /v1/works/:id/adjust {text} —— LLM/启发式解析为 delta → variation 派单 ——
async function adjust(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id);
  const text = String((ctx.body || {}).text || '').trim();
  if (!text) throw new U.ApiError('BAD_REQUEST', '请告诉我你想怎么调整');
  rules.moderateFields([text]);
  const base = variationBase(w);
  base.count = G.count_default;
  const r = await adjustPrompt.parseAdjust(text, base);
  if (!r.understood) return { status: 200, body: { understood: false, clarify: r.clarify || '没太理解，能换个说法吗？' } };
  const merged = adjustPrompt.mergeDelta(base, r.delta);
  const d = dispatchMusic(user, 'adjust', { ...merged, count: G.count_default }, { cost: AC.credits().adjust, reason: 'adjust', lineage: { kind: 'adjust', parent_id: w.id } });
  // 契约 §2：adjust 成功应答是 200 {understood:true, job_id}（区别于 generate 的 202 受理语义；V4-④/V8-⑤ 同步断言）
  if (d.status === 202) return { status: 200, body: Object.assign({ understood: true }, d.body) };
  return d;
}

// —— POST /v1/works/:id/dsp {op,params} ——
function dsp(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id);
  const b = ctx.body || {};
  const op = String(b.op || '');
  const OPS = ['trim', 'fade', 'pitch', 'tempo', 'concat', 'slice'];
  if (!OPS.includes(op)) throw new U.ApiError('BAD_REQUEST', `op 仅支持 ${OPS.join('/')}`);
  const params = (b.params && typeof b.params === 'object') ? b.params : {};
  if (!w.audio_master) throw new U.ApiError('BAD_REQUEST', '该作品暂无音频源文件');
  credits.charge(user.id, AC.credits().dsp, 'dsp', 'work', w.id);
  const srcs = [path.join(config.paths.out, w.audio_master)]
    .concat(U.toArr(params.srcs).map(s => /^[\w./-]+$/.test(s) ? path.join(config.paths.out, s) : s));
  const r = engine.enqueue({
    type: 'dsp', payload: { op, src: srcs[0], srcs, params, work_id: w.id }, userId: user.id,
    idemKey: normalizeForIdem(user, 'dsp', { op, params, candidate_id: w.id }), creditsCost: AC.credits().dsp,
  });
  if (!r.idempotent) { /* 已扣分 */ } else { credits.refund(user.id, AC.credits().dsp, 'dsp', 'work'); }
  return { status: 202, body: { job_id: r.job.id } };
}

// —— GET /v1/works/:id/seed-pack ——
function seedPack(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = ownWork(ctx, ctx.params.id, { allowPublic: true });
  const payload = U.jparse(w.gen_params, {}) || {};
  return {
    status: 200,
    body: {
      seed_pack: {
        prompt: payload.prompt || w.title || '',
        tags: U.toArr(w.genres),
        bpm: w.bpm || payload.bpm || null,
        sec: w.duration_sec || payload.sec || G.sec_default,
        seed: w.gen_seed == null ? payload.seed_base : w.gen_seed,
        engine: w.gen_engine || 'music',
      },
    },
  };
}

// —— POST /v1/works/:id/report {reason} —— M2 前仅落审计 ——
function report(ctx) {
  const user = auth.requireUser(ctx); ctx.user = user;
  const w = store.get('SELECT * FROM works WHERE id=?', ctx.params.id);
  if (!w) throw new U.ApiError('NOT_FOUND', '作品不存在');
  const reason = String((ctx.body || {}).reason || '').trim();
  if (!reason) throw new U.ApiError('BAD_REQUEST', '请填写举报理由');
  rules.moderateFields([reason]);
  const id = U.uid('rp_');
  store.run('INSERT INTO reports(id,user_id,work_id,reason,status,created_at) VALUES(?,?,?,?,?,?)', id, user.id, w.id, reason.slice(0, 500), 'open', U.nowIso());
  store.log('works.report', { user_id: user.id, work_id: w.id, report_id: id });
  return { status: 200, body: { ok: true } };
}

module.exports = {
  dispatchMusic, buildMusicPayload, normalizeForIdem, variationBase, listWorks, patchWorkInternal,
  routes: [
    { m: 'POST', p: '/v1/works/generate', h: generate },
    { m: 'GET', p: '/v1/jobs/:id', h: getJob },
    { m: 'POST', p: '/v1/works/:id/adopt', h: adopt },
    { m: 'GET', p: '/v1/works', h: listWorks },
    { m: 'GET', p: '/v1/works/:id', h: detail },
    { m: 'PATCH', p: '/v1/works/:id', h: patchWork },
    { m: 'POST', p: '/v1/works/:id/extend', h: extend },
    { m: 'POST', p: '/v1/works/:id/cover', h: cover },
    { m: 'POST', p: '/v1/works/:id/variation', h: variation },
    { m: 'POST', p: '/v1/works/:id/adjust', h: adjust },
    { m: 'POST', p: '/v1/works/:id/dsp', h: dsp },
    { m: 'GET', p: '/v1/works/:id/seed-pack', h: seedPack },
    { m: 'POST', p: '/v1/works/:id/report', h: report },
  ],
};
