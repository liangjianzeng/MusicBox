// 任务引擎：enqueue 幂等/lanes long-poll 租约/progress/complete 链式转码/fail 回队退款/心跳/清扫（2026-11-23）
'use strict';
const fs = require('node:fs');
const config = require('../config');
const store = require('./store');
const bus = require('./bus');
const U = require('./util');
const lanes = require('../lanes');

const ACTIVE = ['queued', 'leased', 'running'];
const IDEM_RECENT_MS = 10 * 60000; // 幂等复用活跃窗口

// long-poll 唤醒器：enqueue/状态变化时通知挂起的 poll
const waiters = new Set();
function notify() { for (const w of [...waiters]) { try { w(); } catch (e) {} } }

// —— 入队（idem_key 幂等去重：命中活跃/近期同参任务返回原 job）——
function enqueue({ type, payload, userId, idemKey, creditsCost, parentJobId }) {
  store.init();
  if (idemKey) {
    const ex = store.get('SELECT * FROM jobs WHERE idem_key=?', idemKey);
    if (ex && (ACTIVE.includes(ex.status) || Date.parse(ex.created_at) > Date.now() - IDEM_RECENT_MS)) {
      return { job: ex, idempotent: true };
    }
    if (ex) idemKey = idemKey + '_' + U.uid('n_'); // 历史同参：换键重排
  }
  const id = U.uid('j_');
  const now = U.nowIso();
  try {
    store.run(
      'INSERT INTO jobs(id,type,payload,status,idem_key,attempts,progress,credits_cost,user_id,parent_job_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?,?,?,?)',
      id, type, U.jstr(payload || {}), 'queued', idemKey || null, creditsCost || 0, userId || null, parentJobId || null, now, now);
  } catch (e) {
    // 并发唯一键冲突 → 返回既有 job
    if (/UNIQUE/i.test(String(e && e.message)) && idemKey) {
      const ex = store.get('SELECT * FROM jobs WHERE idem_key=?', idemKey);
      if (ex) return { job: ex, idempotent: true };
    }
    throw e;
  }
  store.log('job.enqueue', { job_id: id, type, user_id: userId, idem_key: idemKey });
  notify();
  return { job: store.get('SELECT * FROM jobs WHERE id=?', id), idempotent: false };
}

function getJob(id) { return store.get('SELECT * FROM jobs WHERE id=?', id); }

// —— lanes long-poll：领单并续租 10min ——
async function poll(lanesWanted, executorId) {
  store.init();
  const wanted = new Set(lanes.allLanes().flatMap(l => lanes.LANES[l].types).filter(Boolean));
  const want = U.toArr(lanesWanted);
  let types = null;
  if (want.length) {
    types = new Set();
    for (const l of want) {
      const lane = lanes.lane(String(l).trim());
      if (lane) for (const t of lane.types) types.add(t);
      if (wanted.has(String(l).trim())) types.add(String(l).trim()); // 允许直接传类型名
    }
  }
  if (types && types.size === 0) return null;
  const deadline = Date.now() + config.engine.pollHoldMs;
  for (;;) {
    const rows = types
      ? store.all("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 20")
          .filter(j => types.has(j.type))
      : store.all("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 20");
    for (const j of rows) {
      const r = store.run("UPDATE jobs SET status='leased', executor_id=?, lease_expire_at=?, updated_at=? WHERE id=? AND status='queued'",
        executorId || null, U.isoAfterMs(config.engine.leaseMs), U.nowIso(), j.id);
      if (r.changes === 1) {
        store.log('job.lease', { job_id: j.id, executor_id: executorId });
        return store.get('SELECT * FROM jobs WHERE id=?', j.id);
      }
    }
    const remain = deadline - Date.now();
    if (remain <= 0) return null;
    await new Promise(res => {
      const done = () => { waiters.delete(done); res(); };
      waiters.add(done);
      setTimeout(done, Math.min(remain, 2000)); // 2s 安全轮询兜底
    });
  }
}

function assertOwned(job, executorId) {
  if (!ACTIVE.includes(job.status)) throw new U.ApiError('BAD_REQUEST', '任务状态不允许该操作');
  if (executorId && job.executor_id && job.executor_id !== executorId) {
    throw new U.ApiError('FORBIDDEN', '任务租约不属于当前执行器');
  }
}

function setProgress(job, progress, note) {
  const p = U.clamp(progress, 0, 100);
  store.run("UPDATE jobs SET status='running', progress=?, note=?, updated_at=? WHERE id=?",
    p, String(note || '').slice(0, 200), U.nowIso(), job.id);
  if (job.user_id) bus.jobProgress(job.user_id, job.id, p, note);
}

function progress(jobId, executorId, { progress: p, note }) {
  const job = getJob(jobId);
  if (!job) throw new U.ApiError('NOT_FOUND', '任务不存在');
  assertOwned(job, executorId);
  setProgress(job, p, note);
  return true;
}

function finishDone(job, result) {
  store.run("UPDATE jobs SET status='done', progress=100, result=?, lease_expire_at=NULL, updated_at=? WHERE id=?",
    U.jstr(result || {}), U.nowIso(), job.id);
  store.log('job.done', { job_id: job.id, type: job.type });
  if (job.user_id) bus.jobDone(job.user_id, job.id, result);
}

// 落盘 multipart 文件 → Map<field, {rel,abs,bytes}>
function saveFiles(files) {
  const map = new Map();
  for (const f of files || []) {
    const saved = U.saveToOut(config.paths.out, f.data, f.filename);
    map.set(f.field, saved);
  }
  return map;
}
// result.files={logical_name: 上传字段名} → 回填 result[*_url]，并返回 {logical: rel}
function backfillFileUrls(result, savedMap) {
  const rels = {};
  const files = result && result.files;
  if (files && typeof files === 'object') {
    for (const [logical, field] of Object.entries(files)) {
      const saved = savedMap.get(String(field)) || savedMap.get(String(logical));
      if (!saved) continue;
      const key = /_url$/i.test(logical) ? logical : logical + '_url';
      result[key] = store.publicUrl(saved.rel);
      rels[logical] = saved.rel;
    }
  }
  return rels;
}

// —— complete：按类型分流；一切事件过 bus ——
async function complete(jobId, executorId, result, files) {
  const job = getJob(jobId);
  if (!job) throw new U.ApiError('NOT_FOUND', '任务不存在');
  assertOwned(job, executorId);
  result = result && typeof result === 'object' ? result : {};
  const savedMap = saveFiles(files);

  if (job.type === 'music') return completeMusic(job, result, savedMap);
  if (job.type === 'transcode') return completeTranscode(job, result, savedMap);
  if (job.type === 'intent_voice' || job.type === 'intent_image') return completeIntent(job, result);
  if (job.type === 'dsp') return completeDsp(job, result, savedMap);
  finishDone(job, result);
  return { ok: true };
}

function defaultTitle(payload, seq) {
  const mood = String(payload.mood || '').trim();
  const tags = U.toArr(payload.tags);
  const base = mood || tags[0] || '灵感片段';
  return `${base} · 候选${seq}`;
}

// music 完成：预建 candidates → 链 transcode（mp3+peaks 回填后父 job 才 done 并广播）
function completeMusic(job, result, savedMap) {
  const payload = U.jparse(job.payload, {}) || {};
  const incoming = Array.isArray(result.candidates) && result.candidates.length
    ? result.candidates
    : Array.from(savedMap.entries()).map(([field], i) => ({ seq: i + 1, file: field }));
  if (!incoming.length) throw new U.ApiError('INTERNAL', '生成结果为空，请重试');
  const candIds = [];
  store.tx(() => {
    for (let i = 0; i < incoming.length; i++) {
      const c = incoming[i] || {};
      const seq = Number(c.seq) || (i + 1);
      const saved = savedMap.get(String(c.file || c.audio || c.field || ''))
        || savedMap.get('audio_' + seq) || savedMap.get('candidate_' + seq)
        || (i === 0 ? savedMap.get('audio') : null);
      const id = U.uid('c_');
      store.run(
        'INSERT INTO candidates(id,job_id,seq,title,audio_master,duration_sec,format,meta,adopted,created_at) VALUES(?,?,?,?,?,?,?,?,0,?)',
        id, job.id, seq, String(c.title || defaultTitle(payload, seq)).slice(0, 80),
        saved ? saved.rel : null, c.duration_sec == null ? payload.sec : Number(c.duration_sec) || payload.sec,
        'wav', U.jstr({ seed: c.seed == null ? null : c.seed, gen: result.meta || null, raw: c }), U.nowIso());
      candIds.push(id);
    }
    store.run("UPDATE jobs SET status='running', progress=90, note='转码中', updated_at=? WHERE id=?", U.nowIso(), job.id);
  });
  // 链式转码（同 user、记父 job）；父 job 转入"等待转码"：延长租约，由清扫器看护
  const masters = candIds.map(cid => store.get('SELECT id,audio_master FROM candidates WHERE id=?', cid)).filter(r => r && r.audio_master);
  store.run('UPDATE jobs SET lease_expire_at=? WHERE id=?', U.isoAfterMs(2 * config.engine.leaseMs), job.id);
  for (const m of masters) {
    enqueue({
      type: 'transcode',
      payload: { src: m.audio_master, targets: ['mp3', 'peaks'], candidate_id: m.id, parent_job_id: job.id, from: 'music' },
      userId: job.user_id, parentJobId: job.id,
    });
  }
  if (job.user_id) bus.jobProgress(job.user_id, job.id, 90, '转码中');
  store.log('job.music.complete_chain', { job_id: job.id, candidates: candIds.length });
  return { ok: true, candidates: candIds.length };
}

// transcode 完成：回填 candidate/work 的 *_url；父 job（music）此时才算 done 并广播
function completeTranscode(job, result, savedMap) {
  const payload = U.jparse(job.payload, {}) || {};
  const rels = backfillFileUrls(result, savedMap);
  const mp3Rel = rels.mp3 || rels.audio_playback || (savedMap.get('mp3') && savedMap.get('mp3').rel) || null;
  const peaksRel = rels.peaks || rels.waveform || (savedMap.get('peaks') && savedMap.get('peaks').rel) || null;
  if (payload.candidate_id) {
    store.run('UPDATE candidates SET audio_playback=COALESCE(?,audio_playback), waveform_ref=COALESCE(?,waveform_ref), format=? WHERE id=?',
      mp3Rel, peaksRel, mp3Rel ? 'mp3' : 'wav', payload.candidate_id);
  }
  if (payload.work_id) {
    store.run('UPDATE works SET audio_playback=COALESCE(?,audio_playback), waveform_ref=COALESCE(?,waveform_ref), format=? WHERE id=?',
      mp3Rel, peaksRel, mp3Rel ? 'mp3' : 'wav', payload.work_id);
  }
  store.run("UPDATE jobs SET status='done', progress=100, result=?, updated_at=? WHERE id=?", U.jstr(result), U.nowIso(), job.id);
  if (job.user_id) bus.jobDone(job.user_id, job.id, result);
  // 父 job：全部 transcode 子任务到达终态即定稿（含失败——降级 wav master 交付）
  if (payload.parent_job_id) finalizeMusicParent(payload.parent_job_id);
  return { ok: true };
}

// 父 music job 定稿：全部 transcode 子任务终态后 done；
// 部分/全部转码失败时候选保持 wav master（candidateOf 回退 audio_master_url，format 如实='wav'），不阻塞交付、不退款（产物真实可播）。
function finalizeMusicParent(parentId) {
  const parent = getJob(parentId);
  if (!parent || parent.type !== 'music' || !ACTIVE.includes(parent.status)) return true;
  const pending = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", parent.id);
  if (pending.length) return false;
  const cands = store.all('SELECT * FROM candidates WHERE job_id=? ORDER BY seq ASC', parent.id).map(store.candidateOf);
  if (!cands.length) { requeueOrFail(parent, 'INTERNAL', '生成结果为空，请重试'); return true; }
  const degraded = cands.some(c => c.format !== 'mp3');
  const prevMeta = U.jparse(parent.result, {}) || {};
  finishDone(parent, { candidates: cands, meta: degraded ? { ...prevMeta, degraded: true } : prevMeta });
  if (degraded) store.log('job.music.degraded_wav', { job_id: parent.id, candidates: cands.length });
  return true;
}

// intent 完成：LLM 编译 IntentCard（不可达→词典兜底），落 intent_cards，广播 intent.card
async function completeIntent(job, result) {
  const promptsIntent = require('../prompts/intent');
  const payload = U.jparse(job.payload, {}) || {};
  const kind = job.type === 'intent_voice' ? 'voice' : 'image';
  // 图像：从暂存文件即时转 base64 data URL（qwen38-fp4 单端点多模态）
  let imageDataUrl = payload.image_data_url || null;
  if (kind === 'image' && !imageDataUrl && payload.upload_path) {
    try {
      if (fs.existsSync(payload.upload_path)) {
        const b = fs.readFileSync(payload.upload_path);
        if (b.length <= 8 * 1024 * 1024) {
          const mime = /^89504e47/i.test(b.slice(0, 8).toString('hex')) ? 'image/png' : 'image/jpeg';
          imageDataUrl = 'data:' + mime + ';base64,' + b.toString('base64');
        }
      }
    } catch (e) { /* 交由兜底 */ }
  }
  let card;
  // DEV-CARD 收口（2026-11-23）：契约 §4 规定执行器编译 IntentCard——有效结果卡原样尊重，不再二次调用 LLM（省时省算力）
  const execCard = promptsIntent.normalizeCard(result);
  const execUsable = execCard && execCard.confidence > 0 &&
    ((execCard.mood || []).length || execCard.scene_desc) &&
    ((execCard.genre_hypotheses || []).length || execCard.scene_desc);
  if (execUsable) {
    card = execCard;
    store.log('intent.card.respected', { job_id: job.id, source: 'executor' });
  } else {
    try {
      card = await promptsIntent.compileIntent({ kind, input: result, payload: { ...payload, image_data_url: imageDataUrl } });
    } catch (e) {
      card = promptsIntent.fallbackCompile({ kind, input: result, payload });
    }
  }
  card = promptsIntent.enforce(card); // 服务端强制澄清纪律
  const status = (card.confidence >= 0.75 || !(card.questions || []).length) ? 'ready' : 'clarifying';
  const questions = status === 'ready' ? [] : card.questions;
  // 复用预建草稿卡（api/intent 已 INSERT），否则新建
  let id = payload.intent_id && store.get('SELECT id FROM intent_cards WHERE id=?', payload.intent_id) ? payload.intent_id : null;
  if (id) {
    store.run(
      `UPDATE intent_cards SET mood=?,scene_desc=?,genre_hypotheses=?,vocal=?,duration_hint=?,confidence=?,
        questions=?,status=?,gen_params=?,updated_at=? WHERE id=?`,
      card.mood.join(','), card.scene_desc, card.genre_hypotheses.join(','), card.vocal, card.duration_hint,
      card.confidence, U.jstr(questions), status, U.jstr(card.gen_params || null), U.nowIso(), id);
  } else {
    id = U.uid('in_');
    store.run(
      'INSERT INTO intent_cards(id,user_id,source_kind,source_ref,mood,scene_desc,genre_hypotheses,vocal,duration_hint,confidence,questions,answers,rounds,status,gen_params,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'[]\',0,?,?,?,?)',
      id, job.user_id, kind, payload.upload_path || null,
      card.mood.join(','), card.scene_desc, card.genre_hypotheses.join(','), card.vocal, card.duration_hint,
      card.confidence, U.jstr(questions), status, U.jstr(card.gen_params || null), U.nowIso(), U.nowIso());
  }
  store.run("UPDATE jobs SET status='done', progress=100, result=?, updated_at=? WHERE id=?", U.jstr({ intent_id: id, ...result }), U.nowIso(), job.id);
  if (job.user_id) {
    bus.jobDone(job.user_id, job.id, { intent_id: id });
    bus.intentCard(job.user_id, id, status);
  }
  store.log('intent.created', { intent_id: id, job_id: job.id, kind, status });
  return { ok: true, intent_id: id };
}

// dsp 完成：产物落 work 子代
function completeDsp(job, result, savedMap) {
  const payload = U.jparse(job.payload, {}) || {};
  const rels = backfillFileUrls(result, savedMap);
  const src = payload.work_id ? store.get('SELECT * FROM works WHERE id=?', payload.work_id) : null;
  const audioRel = rels.audio || rels.output || rels.audio_playback || (savedMap.size ? savedMap.values().next().value.rel : null);
  let workId = null;
  if (audioRel) {
    const w = U.uid('w_');
    workId = w;
    const depth = (src ? src.lineage_depth || 0 : 0) + 1;
    store.run(
      'INSERT INTO works(id,user_id,title,status,audio_master,audio_playback,duration_sec,format,waveform_ref,mood,genres,bpm,language,lyrics,gen_engine,gen_params,lineage_kind,parent_id,lineage_depth,ai_label,visibility,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)',
      w, job.user_id, (src ? (src.title || '作品') : '作品') + ' · ' + (payload.op || '处理'), 'draft',
      audioRel, null, result.duration_sec || (src ? src.duration_sec : null), 'wav', rels.peaks || null,
      src ? src.mood : '', src ? src.genres : '', src ? src.bpm : null, src ? src.language : 'zh',
      src ? src.lyrics : '', 'music',
      U.jstr({ op: payload.op, params: payload.params, via: 'dsp' }), 'adjust', payload.work_id || null, depth,
      'private', U.nowIso());
  }
  result = { ...result, work_id: workId };
  finishDone(job, result);
  return { ok: true, work_id: workId };
}

// —— fail：attempts<3 回队（降档），否则 failed+refund ——
function fail(jobId, executorId, { code, message } = {}) {
  const job = getJob(jobId);
  if (!job) throw new U.ApiError('NOT_FOUND', '任务不存在');
  assertOwned(job, executorId);
  requeueOrFail(job, String(code || 'INTERNAL'), U.sanitizeEngineNames(message || '后台处理失败，请稍后重试'));
  return { ok: true };
}

function requeueOrFail(job, code, message) {
  const attempts = (job.attempts || 0) + 1;
  if (attempts < config.engine.maxAttempts) {
    const newPayload = lanes.ladderNext(job.type, U.jparse(job.payload, {}) || {}, attempts);
    store.run("UPDATE jobs SET status='queued', attempts=?, payload=?, executor_id=NULL, lease_expire_at=NULL, error_code=?, error_message=?, updated_at=? WHERE id=?",
      attempts, U.jstr(newPayload), code, message, U.nowIso(), job.id);
    store.log('job.requeue', { job_id: job.id, attempts, code });
    if (job.user_id) bus.jobProgress(job.user_id, job.id, job.progress || 0, '正在重试');
    notify();
    return;
  }
  store.run("UPDATE jobs SET status='failed', error_code=?, error_message=?, attempts=?, lease_expire_at=NULL, updated_at=? WHERE id=?",
    code, message, attempts, U.nowIso(), job.id);
  // 失败自动全额退款（credits_cost 置 0 防重复退）
  if ((job.credits_cost || 0) > 0 && job.user_id) {
    const bal = store.tx(() => store.appendLedger(job.user_id, job.credits_cost, 'refund', 'job', job.id));
    store.run('UPDATE jobs SET credits_cost=0 WHERE id=?', job.id);
    bus.creditDelta(job.user_id, job.credits_cost, bal);
  }
  if (job.user_id) {
    bus.jobError(job.user_id, job.id, { code: code === 'MODERATION_BLOCK' ? code : 'INTERNAL', message });
  }
  store.log('job.failed', { job_id: job.id, code, attempts });
  // 子 job 连带取消
  for (const c of store.all("SELECT * FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id)) {
    store.run("UPDATE jobs SET status='canceled', updated_at=? WHERE id=?", U.nowIso(), c.id);
  }
  // transcode 子任务永久失败：立即定稿父 music job（降级 wav 交付），不再等租约过期——修复 B 方跨方发现
  if (job.type === 'transcode') {
    const pl = U.jparse(job.payload, {}) || {};
    if (pl.parent_job_id) finalizeMusicParent(pl.parent_job_id);
  }
}

// —— 心跳续租 ——
function heartbeat(executorId, jobId) {
  store.init();
  let extended = false;
  if (jobId) {
    const job = getJob(jobId);
    if (job && ACTIVE.includes(job.status) && (!executorId || !job.executor_id || job.executor_id === executorId)) {
      store.run('UPDATE jobs SET lease_expire_at=?, updated_at=? WHERE id=?', U.isoAfterMs(config.engine.leaseMs), U.nowIso(), job.id);
      extended = true;
    }
  } else if (executorId) {
    const r = store.run("UPDATE jobs SET lease_expire_at=?, updated_at=? WHERE executor_id=? AND status IN ('leased','running')",
      U.isoAfterMs(config.engine.leaseMs), U.nowIso(), executorId);
    extended = r.changes > 0;
  }
  return { ok: true, lease_extended: extended };
}

// —— 租约过期清扫（30s 定时）——
function sweep() {
  store.init();
  const nowIso = U.nowIso();
  const expired = store.all("SELECT * FROM jobs WHERE status IN ('leased','running') AND lease_expire_at IS NOT NULL AND lease_expire_at<=?", nowIso);
  for (const job of expired) {
    // 等待子任务（如 music 等转码）→ 续租继续看护，不判失败；子任务全终态→立即定稿（不重跑生成）
    if (job.type === 'music') {
      const pendingChildren = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id);
      if (pendingChildren.length) {
        store.run('UPDATE jobs SET lease_expire_at=? WHERE id=?', U.isoAfterMs(2 * config.engine.leaseMs), job.id);
        continue;
      }
      if (finalizeMusicParent(job.id)) continue;
    }
    store.log('job.lease_expired', { job_id: job.id, attempts: job.attempts });
    requeueOrFail(job, 'INTERNAL', '后台处理超时，正在重试');
  }
  // uploads 72h TTL 清理（PIPL 最小化）
  const due = store.all('SELECT * FROM uploads WHERE expire_at<=?', nowIso);
  for (const up of due) {
    try { if (up.path && fs.existsSync(up.path)) fs.unlinkSync(up.path); } catch (e) {}
    store.run('DELETE FROM uploads WHERE id=?', up.id);
  }
  if (due.length) store.log('uploads.cleanup', { removed: due.length });
}

let sweepTimer = null;
function start() {
  store.init();
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { try { sweep(); } catch (e) {} }, config.engine.sweepMs);
  sweepTimer.unref && sweepTimer.unref();
}
function stop() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } }

module.exports = {
  enqueue, getJob, poll, progress, complete, fail, heartbeat, sweep, start, stop, notify,
  finishDone, requeueOrFail,
};
