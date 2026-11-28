// 任务引擎：enqueue 幂等/lanes long-poll 租约/progress/complete 链式转码/fail 回队退款/心跳/清扫（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('./store');
const bus = require('./bus');
const U = require('./util');
const AC = require('./appconfig');
const lanes = require('../lanes');

const ACTIVE = ['queued', 'leased', 'running'];
const IDEM_RECENT_MS = 10 * 60000; // 幂等复用活跃窗口
const POLL_SCAN_LIMIT = 200;       // N1-5：夜间过滤需要越过挂起的 night 队头看后续 normal，扫描窗口放宽（20 会队头饿死）
const TAKES_TTL_MS = 72 * 3600000; // takes/无主产物 72h TTL（架构 §8/§11，N1-5）

// —— 夜间档（N1-5，架构 §8）：server 派发侧单点过滤 ——
// queue_mode='night' 项目的 mv_* jobs 在窗口（config.mv.queueNightMode.window，本机钟）外不出队；
// 窗口内 night 优先于 normal（poll 侧稳定排序）。测试钩子：MB_MV_FORCE_NIGHT=1 / MB_MV_FORCE_DAY=1。
function nightWindowOpen() {
  if (process.env.MB_MV_FORCE_NIGHT === '1') return true;
  if (process.env.MB_MV_FORCE_DAY === '1') return false;
  const nm = (config.mv && config.mv.queueNightMode) || {};
  if (nm.enabled === false) return true; // 开关关闭 = 不门控（night 随时可派）
  const w = Array.isArray(nm.window) ? nm.window : [0, 8];
  const a = Number(w[0]) || 0, b = Number(w[1]) || 0;
  const h = new Date().getHours();
  return h >= a && h < b;
}

// 领单候选扫描：类型过滤 + 夜间档门控 + night 优先出队。
// 防 starvation：night 挂起用 continue（非 break），后续 normal 照常出队；扫描 LIMIT 放宽防 night 队头遮蔽。
function queuedDispatchable(types) {
  const rows = store.all("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT " + POLL_SCAN_LIMIT)
    .filter((j) => !types || types.has(j.type));
  const open = nightWindowOpen();
  const qmCache = new Map();
  const isNightJob = (j) => {
    if (!String(j.type).startsWith('mv_')) return false;
    const pl = U.jparse(j.payload, {}) || {};
    const pid = pl.project_id;
    if (!pid) return false;
    if (!qmCache.has(pid)) {
      const p = store.get('SELECT queue_mode FROM mv_projects WHERE id=?', pid);
      qmCache.set(pid, !!(p && String(p.queue_mode) === 'night'));
    }
    return qmCache.get(pid);
  };
  const out = [];
  for (const j of rows) {
    const n = isNightJob(j);
    if (n && !open) continue; // 窗口外：night 挂起等待，绝不阻塞其后的 normal 出队
    out.push({ j, n });
  }
  out.sort((a, b) => (a.n === b.n ? 0 : (a.n ? -1 : 1))); // 稳定排序：窗口内 night 优先于 normal
  return out.map((x) => x.j);
}

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
// isAlive()（可选）：长挂期间执行器连接已断（进程被杀/断网）时放弃派发——
// 否则被唤醒的"幽灵 poll"会把 job 租给死执行器，白等一个 10min 租约（N2-5 演练实测驱动）。
async function poll(lanesWanted, executorId, isAlive) {
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
    if (isAlive && !isAlive()) return null; // 幽灵 poll：连接已断，不再领单
    const rows = queuedDispatchable(types); // N1-5：含夜间档过滤 + night 优先
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

// detail：调用点传入本次上报的摘要（progress 的 note / fail 的 code+message / complete 的结果键）。
// 教训（V25-④ 抓到）：曾经只替换了 if 块却忘了加这个形参，ReferenceError 被下面的 catch{} 吞掉，
// 于是"保留真错误"的审计其实一条都没落 —— 观测代码也必须有自己的失败留痕。
function safeField(o, k) {
  try { return o && o[k] !== undefined ? o[k] : null; } catch (e) { return null; }
}

function assertOwned(job, executorId, detail) {
  if (!ACTIVE.includes(job.status)) throw new U.ApiError('BAD_REQUEST', '任务状态不允许该操作');
  // 抢救 P0-4：租约归属必须强制比对。旧写法 `if (executorId && job.executor_id && ...)`
  // 让调用方「不带 X-Executor-Id」即可绕过，配合默认令牌可对任意 job 发 progress/complete/fail。
  if (!executorId || !job.executor_id || job.executor_id !== executorId) {
    // 拒收本身是对的（抢救 P0-4 的 fail-closed），但**真错误不能丢**：租约到期被回队后，慢执行器的
    // fail 会以 403 静默丢弃 —— 任务反复回队直到 attempts 用尽，运维却看不到任何原因
    // （2026-11-27 真机全链实测踩到：引擎已出歌、执行器报「产物缺失」，上报被 403 吞掉）。
    // 记审计事件不改状态机，归属判定依旧严格。
    // 归属拒收时把真错误留在审计里（列名必须用真实列 lease_expire_at；node:sqlite 行对象访问缺失列
    // 在不同版本上可能抛异常，故统一走 safeField，且审计失败本身再记一笔，绝不静默吞）。
    try {
      store.log('job.stale_report', {
        job_id: safeField(job, 'id'), status: safeField(job, 'status'),
        claimed_executor: safeField(job, 'executor_id'), reporter: executorId || null,
        attempts: safeField(job, 'attempts'), lease_expire_at: safeField(job, 'lease_expire_at'),
        detail: String(detail || '').slice(0, 300),
      });
    } catch (e) {
      try { store.log('job.stale_report.error', { job_id: safeField(job, 'id'), err: String((e && e.message) || e).slice(0, 200) }); }
      catch (e2) { /* 观测彻底不可用时不阻断归属判定 */ }
    }
    throw new U.ApiError('FORBIDDEN', '任务租约不属于当前执行器');
  }
}

function notifyAssistantJob(job, status) {
  try { require('../l2assistant/core').notifyJob(Object.assign({}, job, { status }), status); } catch (e) { /* 观测不阻断任务 */ }
}

function setProgress(job, progress, note) {
  const p = U.clamp(progress, 0, 100);
  store.run("UPDATE jobs SET status='running', progress=?, note=?, updated_at=? WHERE id=?",
    p, String(note || '').slice(0, 200), U.nowIso(), job.id);
  notifyAssistantJob(job, 'running');
  if (job.user_id) bus.jobProgress(job.user_id, job.id, p, note);
}

function progress(jobId, executorId, { progress: p, note }) {
  const job = getJob(jobId);
  if (!job) throw new U.ApiError('NOT_FOUND', '任务不存在');
  assertOwned(job, executorId, 'progress ' + String(note || '').slice(0, 160));
  setProgress(job, p, note);
  return true;
}

function finishDone(job, result) {
  store.run("UPDATE jobs SET status='done', progress=100, result=?, lease_expire_at=NULL, updated_at=? WHERE id=?",
    U.jstr(result || {}), U.nowIso(), job.id);
  store.log('job.done', { job_id: job.id, type: job.type });
  notifyAssistantJob(job, 'done');
  // lane 指标（N1-5，架构 §11 最小集）：per-type 完成耗时直方（created→done 总时长）
  try { require('./metrics').recordDone(job.type, Date.now() - (Date.parse(job.created_at) || Date.now())); } catch (e) { /* 观测不阻断 */ }
  if (job.user_id) bus.jobDone(job.user_id, job.id, result);
  reconcileMvFailure(job);
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
  assertOwned(job, executorId, 'complete ' + Object.keys(result || {}).slice(0, 8).join(','));
  result = result && typeof result === 'object' ? result : {};
  const savedMap = saveFiles(files);

  if (job.type === 'music') return completeMusic(job, result, savedMap);
  if (job.type === 'transcode') return completeTranscode(job, result, savedMap);
  if (job.type === 'intent_voice' || job.type === 'intent_image' || job.type === 'intent_text') return completeIntent(job, result);
  if (job.type === 'dsp') return completeDsp(job, result, savedMap);
  if (String(job.type).startsWith('mv_')) return completeMv(job, result, savedMap);
  if (job.type === 'replica_analyze') return completeReplicaAnalyze(job, result); // 契约 v5.7.4（复刻）
  finishDone(job, result);
  return { ok: true };
}

// —— 复刻分析完成（契约 v5.7.4/5/10）：LLM 归纳 → 词表封闭 → 建谱。三条硬纪律都在这里：
//  ① ASR 转写只作归纳入参；**落库的 job.result 必须是净化版（无文本字段）** —— finishDone 会把
//     result 写进 jobs.result 持久化，转写原文进去就是复制歌词（v5.7.5 合规锚）。
//  ② LLM 不可达或归纳为空 → 规则画像（degraded=1）；连规则也归纳不出 → **不建谱**，
//     job note 带明确原因（v5.7.10：绝不空数组假装分析过）。
//  ③ 词表封闭靠 closeToCatalog 机械校验（prompts/replica.js），LLM 只是提词器不是闸门。
async function completeReplicaAnalyze(job, result) {
  const promptsReplica = require('../prompts/replica');
  const payload = U.jparse(job.payload, {}) || {};
  const meta = payload.meta || {};
  const asr = result && typeof result === 'object' ? result.asr : null;
  const fallback = !!(result && result.fallback) || !asr;

  let factsText = '';
  let ruleMoods = []; let ruleGenres = []; let ruleBpm = null;
  if (meta.kind === 'work') {
    // work 源：歌词语境只在内存里临时读（不落任何新表），输出被 SYSTEM 禁止含歌词原文
    const w = store.get('SELECT * FROM works WHERE id=?', meta.ref);
    if (w) {
      ruleGenres = String(w.genres || '').split(',').map((s) => s.trim()).filter(Boolean);
      ruleMoods = String(w.mood || '').split(',').map((s) => s.trim()).filter(Boolean);
      ruleBpm = w.bpm;
      factsText += '曲名：' + w.title + '\n元数据曲风：' + (w.genres || '未知') + '；氛围：' + (w.mood || '未知') + '；BPM：' + (w.bpm || '未知') + '\n';
      if (w.lyrics) factsText += '歌词（只许用于归纳听感，输出绝不得包含歌词原文或片段）：\n' + String(w.lyrics).slice(0, 800) + '\n';
    }
  } else {
    factsText += '来源：用户上传的参考曲「' + String(payload.title || '参考曲').slice(0, 60) + '」\n';
  }
  if (asr) {
    factsText += '音频识别观测：情绪=' + (asr.emotion || '未知') + '；事件='
      + (Array.isArray(asr.events) && asr.events.length ? asr.events.join('/') : '无')
      + '；时长=' + (asr.duration || '未知') + 's\n';
    if (asr.text) factsText += '语音内容（只许用于归纳听感，输出绝不得包含原文片段）：\n' + String(asr.text).slice(0, 1200) + '\n';
  }

  let closed = null;
  try { closed = await promptsReplica.synthProfile(factsText); } catch (e) { closed = null; }
  // 统一信封形状 {features, bpm_est}：closed 是 closeToCatalog 的返回（特征在 .features 里），规则兜底直接给同形
  let env = closed ? { features: closed.features, bpm_est: closed.bpm_est } : null;
  let summary = closed && closed.summary;
  let confidence = closed && closed.confidence;
  let degraded = 0;
  const hasAny = (e) => !!e && !!(e.features.moods.length || e.features.genres.length
    || e.features.style_words.length || e.features.voice.length || e.bpm_est);
  if (!hasAny(env)) {
    const rule = promptsReplica.ruleProfile({ text: factsText, moods: ruleMoods, genres: ruleGenres, bpm: ruleBpm });
    env = { features: rule.features, bpm_est: rule.bpm_est };
    summary = rule.summary; confidence = rule.confidence; degraded = 1;
  }
  if (!hasAny(env)) {
    const reason = fallback
      ? '未能从参考内容归纳出风格特征：识别服务不可用，且没有可用的元数据'
      : '未能从参考内容归纳出可映射进创作词表的特征';
    finishDone(job, { ok: false, reason, fallback }); // 不建谱：空谱=假装分析过（v5.7.10）
    store.run('UPDATE jobs SET note=? WHERE id=?', reason, job.id);
    store.log('replica.analyze.empty', { job_id: job.id, user_id: job.user_id, source_kind: String(meta.kind || '') });
    return { ok: false };
  }
  const id = U.uid('rp_');
  // 列清单与 api/replica.js createProfile 保持逐字一致（v22 DDL）
  store.run(
    'INSERT INTO replica_profiles(id,user_id,source_kind,source_ref,title,features_json,bpm_est,summary,confidence,degraded,job_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, job.user_id, String(meta.kind || 'work'), meta.ref || null, String(payload.title || '').slice(0, 80),
    U.jstr(env.features), env.bpm_est == null ? null : Math.round(Number(env.bpm_est)),
    String(summary || '').slice(0, 200), Number(confidence) || 0.4, degraded, job.id, U.nowIso());
  // 落库净化：转写不进 jobs.result；只留观测摘要（has_text 不带内容）
  finishDone(job, {
    ok: true, profile_id: id, degraded: !!degraded, fallback,
    asr_observed: asr ? { emotion: asr.emotion || null, events: Array.isArray(asr.events) ? asr.events : [], duration: asr.duration || null, has_text: !!(asr.text && String(asr.text).trim()) } : null,
  });
  store.log('replica.profile.create', { user_id: job.user_id, profile_id: id, job_id: job.id, source_kind: String(meta.kind || ''), degraded });
  return { ok: true, profile_id: id };
}

// mv_* 通用完成：契约 §4 的 files→*_url 回填 + done 广播（未知 mv_* 兜底，V13 不崩）
function completeMvGeneric(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  store.log('job.mv.complete', { job_id: job.id, type: job.type });
  return { ok: true };
}

// —— MV 二期完成分流（契约 v2.8 / 架构 §3.1：parent-child 链，仿 finalizeMusicParent）——
function completeMv(job, result, savedMap) {
  switch (job.type) {
    case 'mv_cast': return completeMvCast(job, result, savedMap);
    case 'mv_cast_image': return completeMvCastImage(job, result, savedMap);
    case 'mv_cast_video': return completeMvCastVideo(job, result, savedMap);
    case 'mv_storyboard': return completeMvStoryboard(job, result, savedMap);
    case 'mv_shot': return completeMvClip(job, result, savedMap);
    case 'mv_lipsync': return completeMvLipsync(job, result, savedMap);
    case 'mv_align': return completeMvAlign(job, result, savedMap);
    case 'mv_preview': return completeMvPreview(job, result, savedMap);
    case 'mv_compose': return completeMvCompose(job, result, savedMap);
    default: return completeMvGeneric(job, result, savedMap);
  }
}

// WSS mv.progress（契约 v2.8.5）：shot/project 状态变更即广播（note 过禁词净化）
function broadcastMvProgress(projectId, note) {
  try {
    const p = store.get('SELECT * FROM mv_projects WHERE id=?', projectId);
    if (!p) return;
    const shots = store.all('SELECT id,status FROM mv_shots WHERE project_id=? ORDER BY seq ASC', projectId);
    const lex = require('../rules/mv_lexicon');
    const done = shots.filter((s) => ['clipReady', 'synced', 'locked'].includes(s.status)).length;
    const progress = shots.length ? Math.round((done / shots.length) * 100) : (p.status === 'ready' ? 100 : 0);
    bus.mvProgress(p.user_id, {
      project_id: p.id, status: p.status || '', progress,
      note: lex.sanitize(String(note || '')), shots: shots.map((s) => ({ id: s.id, status: s.status })),
    });
  } catch (e) { /* 广播失败不阻断业务 */ }
}

function mvProjectOf(job, payload) {
  const pid = payload.project_id || null;
  return pid ? store.get('SELECT * FROM mv_projects WHERE id=?', pid) : null;
}
// 每个镜头/合成只认最新根任务；lipsync 子任务失败仍走降级，不据此判整片失败
function reconcileMvFailure(job) {
  const payload = U.jparse(job.payload, {}) || {};
  const project = mvProjectOf(job, payload);
  if (!project || !['shooting', 'composing'].includes(project.status)) return false;
  const like = '%"project_id":"' + project.id + '"%';
  const active = store.get("SELECT COUNT(*) AS n FROM jobs WHERE payload LIKE ? AND status IN ('queued','leased','running')", like);
  if ((active && active.n) > 0) return false;
  const jobs = store.all("SELECT * FROM jobs WHERE type IN ('mv_shot','mv_compose') AND payload LIKE ? ORDER BY created_at ASC, rowid ASC", like);
  const latest = new Map();
  for (const row of jobs) {
    const pl = U.jparse(row.payload, {}) || {};
    if (row.type === 'mv_shot' && pl.shot_id && !store.get('SELECT id FROM mv_shots WHERE id=?', pl.shot_id)) continue;
    latest.set(row.type + ':' + (pl.shot_id || ''), row);
  }
  if (![...latest.values()].some((row) => row.status === 'failed')) return false;
  const changed = store.run("UPDATE mv_projects SET status='failed', updated_at=? WHERE id=? AND status IN ('shooting','composing')", U.nowIso(), project.id);
  if (changed.changes === 1) {
    store.log('mv.project.failed', { project_id: project.id, user_id: project.user_id, job_id: job.id });
    broadcastMvProgress(project.id, '拍摄未成功，可重拍恢复');
  }
  return changed.changes === 1;
}
function sanitizeSid(v) { return String(v || 'shot_x').replace(/[^\w.-]/g, '_'); }
// 镜时间窗（累计 sec；有 timings 时按歌词行索引取对齐窗 ±0.2s，契约 v2.3 mv_lipsync win）
function shotWindow(projectId, shot) {
  let cum = 0;
  for (const s of store.all('SELECT seq,sec FROM mv_shots WHERE project_id=? ORDER BY seq ASC', projectId)) {
    if (s.id === shot.id) break;
    cum += Number(s.sec) || 0;
  }
  const p = store.get('SELECT script_json FROM mv_projects WHERE id=?', projectId);
  const sj = p ? U.jparse(p.script_json, null) : null;
  const timings = sj && Array.isArray(sj.timings) ? sj.timings : null;
  if (timings && Number.isInteger(shot.lyric_from) && timings[shot.lyric_from]) {
    const t = timings[shot.lyric_from];
    const tEnd = timings[(shot.lyric_to || shot.lyric_from + 1) - 1] || t;
    return {
      start_sec: Math.max(0, Math.round((Number(t.start) - 0.2) * 100) / 100),
      dur_sec: Math.max(0.5, Math.round(((Number(tEnd.end) - Number(t.start)) + 0.4) * 100) / 100),
      shot_id: shot.id,
    };
  }
  return { start_sec: Math.round(cum * 100) / 100, dur_sec: Math.max(0.5, Math.round((Number(shot.sec) || 5) * 100) / 100), shot_id: shot.id };
}

// mv_cast_image：3 候选 url 挂角色（机检写入；拍板仍走 cast/confirm）
function completeMvCastImage(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  if (payload.character_id && store.get('SELECT id FROM mv_characters WHERE id=?', payload.character_id)) {
    // 候选连同**身份门控状态**一起落库：只存 URL 的话，"这三张到底验没验过脸"在交付后
    // 就成了悬案 —— 端上只能摆图，用户分不清"没过门"和"根本没门控"。
    // 形状 [{url,score,gate}]；老数据是裸 URL 字符串，端上一并兼容（mv_models.dart）。
    const gate = (result.meta && result.meta.facegate) || null;
    const fscores = Array.isArray(result.face_scores) ? result.face_scores : [];
    // cast_mode / denoise 也要落库：真人通道的三张候选是"同一张原片的三档轻度处理"，
    // 端上必须说清这一点并显示每档实测相似度，不能把它们说成三张 AI 定妆照。
    const castMode = (result.meta && result.meta.cast_mode) || null;
    const denoiseArr = (result.meta && Array.isArray(result.meta.denoise)) ? result.meta.denoise : [];
    const cands = [1, 2, 3]
      .map((i) => {
        const url = result['cast_image_' + i + '_url'];
        if (!url) return null;
        const s = fscores[i - 1];
        const d = denoiseArr[i - 1];
        return {
          url,
          score: s === null || s === undefined || !Number.isFinite(Number(s)) ? null : Number(s),
          gate,
          mode: castMode,
          denoise: d === null || d === undefined || !Number.isFinite(Number(d)) ? null : Number(d),
        };
      })
      .filter(Boolean);
    if (cands.length) store.run('UPDATE mv_characters SET cast_images_json=? WHERE id=?', U.jstr(cands), payload.character_id);
  }
  store.log('job.mv.cast_image', { job_id: job.id, character_id: payload.character_id || null });
  if (payload.project_id) broadcastMvProgress(payload.project_id, '定妆照已出，请挑选');
  return { ok: true };
}

// mv_cast_video：定妆视频 + 抽帧评分落角色
// mv_cast（方案一）：定妆视频 + 抽帧评分落角色（与 cast_video 同构；拍板仍走 cast/confirm）
function completeMvCast(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  if (payload.character_id && store.get('SELECT id FROM mv_characters WHERE id=?', payload.character_id)) {
    const rels = {};
    const cv = String(result.cast_video_url || '').split('/f/')[1] || null;
    const frames = Array.isArray(result.frames) ? result.frames : [];
    rels.frames = frames.map((f, i) => ({
      url: result['frame_' + (f.idx || i + 1) + '_url'] || f.url || null,
      score: f.score == null ? null : f.score,
      pass: !!f.pass,
      yaw: f.yaw || null,
      pitch: f.pitch || null,
    }));
    // 方案一抽帧回填 viewrefs（拍板帧库 [{url,score,sel}]），供 storyboard 角色镜 ref / shoot 取用（补全 SP6 漏写链路）
    rels.viewrefs = rels.frames
      .map((f) => ({ url: f.url, score: f.score, sel: !!f.pass }))
      .filter((f) => f.url)
      .slice(0, 3);
    store.run('UPDATE mv_characters SET cast_video_url=?, frames_json=?, viewrefs_json=? WHERE id=?',
      cv, U.jstr(rels.frames), U.jstr(rels.viewrefs), payload.character_id);
  }
  store.log('job.mv.cast', { job_id: job.id, character_id: payload.character_id || null, cast_method: payload.cast_method || 'i2v_first_frame' });
  if (payload.project_id) broadcastMvProgress(payload.project_id, '定妆视频已出，请在帧格中挑角度并拍板');
  return { ok: true };
}
function completeMvCastVideo(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  if (payload.character_id && store.get('SELECT id FROM mv_characters WHERE id=?', payload.character_id)) {
    const rels = {};
    // cast_video_url 回填：result 已是绝对 url，落库存 rel（characterShape 统一 publicUrl）
    const cv = String(result.cast_video_url || '').split('/f/')[1] || null;
    const frames = Array.isArray(result.frames) ? result.frames : [];
    rels.frames = frames.map((f, i) => ({ url: result['frame_' + (f.idx || i + 1) + '_url'] || f.url || null, score: f.score == null ? null : f.score, pass: !!f.pass }));
    store.run('UPDATE mv_characters SET cast_video_url=?, frames_json=? WHERE id=?', cv, U.jstr(rels.frames), payload.character_id);
  }
  store.log('job.mv.cast_video', { job_id: job.id, character_id: payload.character_id || null });
  if (payload.project_id) broadcastMvProgress(payload.project_id, '定妆视频已出，请在帧格中挑角度并拍板');
  return { ok: true };
}

// mv_storyboard：逐镜关键帧落 storyboard_url；draft→boardReady
function completeMvStoryboard(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  let updated = 0;
  for (const s of (Array.isArray(payload.shots) ? payload.shots : [])) {
    const sid = sanitizeSid(s.id);
    const url = result['board_' + sid + '_url'];
    if (!url) continue;
    const rel = String(url).split('/f/')[1] || null;
    const r = store.run("UPDATE mv_shots SET storyboard_url=?, status='boardReady' WHERE id=? AND status IN ('draft','boardReady')", rel, s.id);
    updated += r.changes || 0;
  }
  store.log('job.mv.storyboard', { job_id: job.id, shots_updated: updated });
  if (payload.project_id) broadcastMvProgress(payload.project_id, '分镜图已出 ' + updated + ' 镜');
  return { ok: true };
}

// mv_shot 完成：take 落库→clipReady；歌唱曲演唱镜 → 派生 mv_lipsync 子任务（父租约延长看护，仿 music→transcode）
function completeMvClip(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  const payload = U.jparse(job.payload, {}) || {};
  const shot = payload.shot_id ? store.get('SELECT * FROM mv_shots WHERE id=?', payload.shot_id) : null;
  const project = mvProjectOf(job, payload) || (shot ? store.get('SELECT * FROM mv_projects WHERE id=?', shot.project_id) : null);
  const videoRel = (result['clip_' + sanitizeSid(payload.shot_id) + '_url'] || '').split('/f/')[1]
    || (savedMap.size ? savedMap.values().next().value.rel : null);
  let takeId = null;
  if (shot && videoRel) {
    takeId = U.uid('mvt_');
    store.run(
      'INSERT INTO mv_takes(id,shot_id,job_id,engine_tier,video_url,lipsynced,origin,ai_label,created_at) VALUES(?,?,?,?,?,0,?,?,?)',
      takeId, shot.id, job.id, payload.tier || 'quality', videoRel,
      payload.initiated_by === 'system' ? 'system_auto' : (payload.origin || 'auto'), 1, U.nowIso());
    store.run("UPDATE mv_shots SET status='clipReady', best_take_id=? WHERE id=?", takeId, shot.id);
  }
  store.log('job.mv.clip', { job_id: job.id, shot_id: shot ? shot.id : null, take_id: takeId });
  // 歌唱曲演唱镜 → 对口型子任务（先扣后派单；余额不足→保持 clipReady 交付，不失败）
  if (shot && project && shot.kind === 'singing' && project.kind === 'vocal' && takeId && !payload.skip_lipsync) {
    const work = project.work_id ? store.get('SELECT audio_master FROM works WHERE id=?', project.work_id) : null;
    const credits = require('../api/credits');
    const cost = (AC.credits().mv || {}).lipsync || 0;
    let charged = false;
    try {
      if (cost > 0) { credits.charge(job.user_id, cost, 'mv_lipsync', 'mv_project', project.id); charged = true; }
      store.run('UPDATE mv_projects SET credits_cost=credits_cost+? WHERE id=?', charged ? cost : 0, project.id);
      const win = shotWindow(project.id, shot);
      enqueue({
        type: 'mv_lipsync',
        payload: { project_id: project.id, shot_id: shot.id, take_id: takeId, video: videoRel, audio_master: (work && work.audio_master) || null, win, reroll: 0 },
        userId: job.user_id,
        idemKey: 'mvl_' + U.hash12(job.user_id + '|' + project.id + '|' + shot.id + '|' + takeId),
        creditsCost: charged ? cost : 0,
        parentJobId: job.id,
      });
      // 父任务转入"等待对口型"：延长租约，由清扫器看护（同 music→transcode 语义）
      store.run('UPDATE jobs SET status=?, progress=?, lease_expire_at=? WHERE id=?', 'running', 90, U.isoAfterMs(2 * config.engine.leaseMs), job.id);
      if (job.user_id) bus.jobProgress(job.user_id, job.id, 90, '对口型中');
      if (project) broadcastMvProgress(project.id, '镜头演唱画面完成，进入口型校准');
      return { ok: true, take_id: takeId, lipsync: true };
    } catch (e) {
      if (charged) { try { credits.refund(job.user_id, cost, 'mv_project', project.id); store.run('UPDATE mv_projects SET credits_cost=MAX(0,credits_cost-?) WHERE id=?', cost, project.id); } catch (e2) {} }
      store.log('job.mv.lipsync_skip', { job_id: job.id, shot_id: shot.id, reason: String((e && e.code) || e && e.message).slice(0, 80) });
      // 余额不足/派单异常 → 不阻塞成片（clip 已交付），走普通收口
    }
  }
  finishDone(job, result);
  if (project) { broadcastMvProgress(project.id, '镜头画面完成'); maybeAutoCompose(project.id); }
  return { ok: true, take_id: takeId };
}

// mv_lipsync 完成：synced take + sync_score；质量门（契约 v2.8.4 / 架构 S8）：
// sync_score<阈值 → 系统免费补样（creditsCost=0，≤2 次）；仍不过 → shot.locked + flags.degraded=broll_subtitle（compose 尊重）
function completeMvLipsync(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  const payload = U.jparse(job.payload, {}) || {};
  const shot = payload.shot_id ? store.get('SELECT * FROM mv_shots WHERE id=?', payload.shot_id) : null;
  const project = mvProjectOf(job, payload);
  const syncedRel = (result['synced_' + sanitizeSid(payload.shot_id) + '_url'] || '').split('/f/')[1]
    || (savedMap.size ? savedMap.values().next().value.rel : null);
  const score = Number.isFinite(Number(result.sync_score)) ? Number(result.sync_score) : null;
  const threshold = config.mv.syncThreshold;
  const isReroll = payload.reroll > 0 || payload.origin === 'system_auto';
  let takeId = null;
  if (shot && syncedRel) {
    takeId = U.uid('mvt_');
    store.run(
      // v2.15.2 勘误（D 路 V15 探针发现）：原 10 列 11 值必 500；lipsynced/ai_label 用字面量，8 ? 对 8 参
      'INSERT INTO mv_takes(id,shot_id,job_id,engine_tier,video_url,lipsynced,sync_score,origin,ai_label,created_at) VALUES(?,?,?,?,?,1,?,?,1,?)',
      takeId, shot.id, job.id, 'quality', syncedRel, score,
      isReroll ? 'system_auto' : (payload.origin || 'auto'), U.nowIso());
  }
  const passed = score != null && score >= threshold;
  if (shot) {
    if (passed) {
      store.run("UPDATE mv_shots SET status='synced', best_take_id=? WHERE id=?", takeId, shot.id);
    } else {
      const tries = store.get("SELECT COUNT(*) AS n FROM mv_takes WHERE shot_id=? AND lipsynced=1", shot.id);
      const rerollsUsed = Math.max(0, ((tries && tries.n) || 1) - 1);
      if (rerollsUsed < 2) {
        // 系统免费补样（明示：initiated_by=system / origin=system_auto / 不扣分）
        const parent = job.parent_job_id || job.id;
        const win = shotWindow(project ? project.id : shot.project_id, shot);
        enqueue({
          type: 'mv_lipsync',
          payload: { project_id: project ? project.id : shot.project_id, shot_id: shot.id, take_id: payload.take_id, video: syncedRel, audio_master: payload.audio_master, win, reroll: rerollsUsed + 1, origin: 'system_auto' },
          userId: job.user_id,
          idemKey: 'mvlr_' + U.hash12(job.user_id + '|' + shot.id + '|' + (rerollsUsed + 1) + '|' + (result.sync_score == null ? 'n' : String(result.sync_score))),
          creditsCost: 0,
          parentJobId: parent,
        });
        store.run('UPDATE mv_shots SET rerolls=rerolls+1 WHERE id=?', shot.id);
        store.log('job.mv.lipsync_reroll', { job_id: job.id, shot_id: shot.id, score, rerolls_used: rerollsUsed + 1, initiated_by: 'system' });
        if (project) broadcastMvProgress(project.id, '口型未达标，系统免费补样中（不扣分）');
      } else {
        // 两次补样仍不过 → B-roll+字幕降级（明示），locked 收口（compose 尊重 flags.degraded）
        const flags = U.jparse(shot.flags_json, {}) || {};
        flags.degraded = 'broll_subtitle';
        store.run("UPDATE mv_shots SET status='locked', flags_json=? WHERE id=?", U.jstr(flags), shot.id);
        store.log('job.mv.lipsync_degraded', { job_id: job.id, shot_id: shot.id, score });
        if (project) broadcastMvProgress(project.id, '口型两次未达标，该镜已转空镜+字幕（明示）');
      }
    }
  }
  finishDone(job, result);
  store.log('job.mv.lipsync', { job_id: job.id, shot_id: shot ? shot.id : null, score });
  if (job.parent_job_id) finalizeMvClipParent(job.parent_job_id);
  else if (project) { broadcastMvProgress(project.id, '口型校准完成'); maybeAutoCompose(project.id); }
  return { ok: true, take_id: takeId };
}

// 父 mv_shot 收口（仿 finalizeMusicParent）：全部 lipsync 子任务终态才 done+广播
function finalizeMvClipParent(parentId) {
  const parent = getJob(parentId);
  if (!parent || parent.type !== 'mv_shot' || !ACTIVE.includes(parent.status)) return true;
  const pending = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", parent.id);
  if (pending.length) return false;
  const payload = U.jparse(parent.payload, {}) || {};
  const prev = U.jparse(parent.result, {}) || {};
  finishDone(parent, { ...prev, lipsync_final: true });
  const project = mvProjectOf(parent, payload);
  if (project) { broadcastMvProgress(project.id, '镜头全部工序完成'); maybeAutoCompose(project.id); }
  store.log('job.mv.clip_parent_done', { job_id: parent.id });
  return true;
}

// mv_align：timings 落 script_json + 演唱镜唱段窗分配（timings 三分用之一，ADR-MV-11）
function completeMvAlign(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  const timings = Array.isArray(result.timings) ? result.timings : null;
  if (payload.project_id && timings) {
    const p = store.get('SELECT * FROM mv_projects WHERE id=?', payload.project_id);
    if (p) {
      const sj = U.jparse(p.script_json, null) || {};
      sj.timings = timings;
      if (Array.isArray(sj.shots)) {
        for (const s of sj.shots) {
          if (s.kind === 'singing' && Number.isInteger(s.lyric_from) && timings[s.lyric_from]) {
            s.window = { start: timings[s.lyric_from].start, end: (timings[(s.lyric_to || s.lyric_from + 1) - 1] || timings[s.lyric_from]).end };
          }
        }
      }
      store.run('UPDATE mv_projects SET script_json=?, updated_at=? WHERE id=?', U.jstr(sj), U.nowIso(), p.id);
      broadcastMvProgress(p.id, '歌词对齐完成（' + timings.length + ' 句）');
    }
  }
  store.log('job.mv.align', { job_id: job.id, lines: timings ? timings.length : 0 });
  return { ok: true };
}

// mv_preview：样片落 project.preview_url + 报价快照（est_json/est_ver，S7「先看片再掏分」）
function completeMvPreview(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  const p = mvProjectOf(job, payload);
  if (p) {
    const rel = (result.preview_url || '').split('/f/')[1] || null;
    const shots = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', p.id);
    const budget = require('../rules/mv_budget');
    const est = budget.estimate(p, shots);
    const ORDER = ['drafting', 'casting', 'scripting', 'previewed', 'shooting', 'composing', 'ready'];
    const idx = ORDER.indexOf(p.status);
    const newStatus = (idx >= 0 && idx <= ORDER.indexOf('previewed')) ? 'previewed' : p.status;
    store.run('UPDATE mv_projects SET preview_url=?, est_json=?, est_ver=?, status=?, updated_at=? WHERE id=?',
      rel, U.jstr(est), budget.estVer(est), newStatus, U.nowIso(), p.id);
    store.log('job.mv.preview', { job_id: job.id, project_id: p.id, est_credits: est.credits });
    broadcastMvProgress(p.id, '样片已出，请查看报价卡后决定开机');
  }
  return { ok: true };
}

// mv_compose：成片+封面落 project→ready + WSS mv.progress + done 广播（首映礼数据源）
function completeMvCompose(job, result, savedMap) {
  backfillFileUrls(result, savedMap);
  result.ai_label = 1; // 成片 ai_label 恒 1（契约 §0/v2.4）
  finishDone(job, result);
  const payload = U.jparse(job.payload, {}) || {};
  const p = mvProjectOf(job, payload);
  if (p) {
    const videoRel = (result.mv_video_url || '').split('/f/')[1] || null;
    const coverRel = (result.cover_url || '').split('/f/')[1] || null;
    store.run("UPDATE mv_projects SET video_url=?, cover_url=?, status='ready', updated_at=? WHERE id=?", videoRel, coverRel, U.nowIso(), p.id);
    store.log('job.mv.compose', { job_id: job.id, project_id: p.id, degraded_shots: (result.degraded_shots || []).length });
    broadcastMvProgress(p.id, '成片完成');
  }
  return { ok: true };
}

// 项目自动合成（架构 §3.1）：全部镜 clipReady/synced/locked → 先扣后派单 mv_compose（idem 含镜状态哈希）；
// 余额不足 → 不自动合成（项目保持 shooting，用户可手动 compose），绝不失败全片
function maybeAutoCompose(projectId) {
  try {
    const p = store.get('SELECT * FROM mv_projects WHERE id=?', projectId);
    if (!p || p.status !== 'shooting') return false;
    const shots = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', projectId);
    if (!shots.length || !shots.every((s) => ['clipReady', 'synced', 'locked'].includes(s.status))) return false;
    const budget = require('../rules/mv_budget');
    const lex = require('../rules/mv_lexicon');
    const statusHash = U.hash12(shots.map((s) => s.id + ':' + s.status).join('|'));
    const idemKey = 'mvac_' + U.hash12(p.user_id + '|' + p.id + '|' + statusHash);
    const cost = (AC.credits().mv || {}).compose || 0;
    const takes = [];
    for (const s of shots) {
      const take = s.best_take_id ? store.get('SELECT * FROM mv_takes WHERE id=?', s.best_take_id) : null;
      if (!take || !take.video_url) return false;
      takes.push({ video: take.video_url, start_sec: 0, dur_sec: Math.max(0.5, Math.min(30, Number(s.sec) || 5)), seq: s.seq, strip_audio: true });
    }
    if (!budget.checkBudget(p, cost).ok) { store.log('mv.autocompose.budget', { project_id: p.id }); return false; }
    const credits = require('../api/credits');
    try { credits.charge(p.user_id, cost, 'mv_compose', 'mv_project', p.id); }
    catch (e) { store.log('mv.autocompose.skip', { project_id: p.id, reason: String((e && e.code) || e) }); return false; }
    const work = p.work_id ? store.get('SELECT audio_master,title FROM works WHERE id=?', p.work_id) : null;
    store.run("UPDATE mv_projects SET credits_cost=credits_cost+?, status='composing', updated_at=? WHERE id=?", cost, U.nowIso(), p.id);
    try {
      enqueue({
        type: 'mv_compose',
        payload: { project_id: p.id, takes, audio_master: (work && work.audio_master) || null, title: lex.sanitize(p.title || (work && work.title) || 'MV') },
        userId: p.user_id, idemKey, creditsCost: cost,
      });
    } catch (e) {
      credits.refund(p.user_id, cost, 'mv_project', p.id);
      store.run('UPDATE mv_projects SET credits_cost=MAX(0,credits_cost-?), status=?, updated_at=? WHERE id=?', cost, 'shooting', U.nowIso(), p.id);
      throw e;
    }
    store.log('mv.autocompose', { project_id: p.id, cost, takes: takes.length });
    broadcastMvProgress(p.id, '全部镜头就绪，自动合成成片中');
    return true;
  } catch (e) {
    store.log('mv.autocompose.error', { project_id: projectId, err: String(e && e.message).slice(0, 120) });
    return false;
  }
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
  notifyAssistantJob(job, 'done');
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
  const kind = job.type === 'intent_voice' ? 'voice'
    : (job.type === 'intent_text' ? 'text' : 'image');
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
  // 诚实化（v11）：逐字来源与「是否兜底」必须落库可回溯。历史上 ASR 挂了也照报
  // 「意图卡已生成」，用户看到的是「只说不理解，然后什么都没了」。
  const asrText = typeof result.text === 'string' ? result.text.trim() : '';
  const sourceText = kind === 'text'
    ? String(payload.text || '').trim()
    : (asrText || String(payload.transcript || '').trim());
  const degraded = result.fallback === true || (kind !== 'image' && !sourceText);
  const note = degraded
    ? (kind === 'voice' ? '没听清：识别服务没起来，已用本地词典兜底' : '理解服务没走通，已用本地词典兜底')
    : '意图卡已生成';
  // 复用预建草稿卡（api/intent 已 INSERT），否则新建
  let id = payload.intent_id && store.get('SELECT id FROM intent_cards WHERE id=?', payload.intent_id) ? payload.intent_id : null;
  if (id) {
    store.run(
      `UPDATE intent_cards SET mood=?,scene_desc=?,genre_hypotheses=?,vocal=?,duration_hint=?,confidence=?,
        questions=?,status=?,gen_params=?,source_text=?,degraded=?,updated_at=? WHERE id=?`,
      card.mood.join(','), card.scene_desc, card.genre_hypotheses.join(','), card.vocal, card.duration_hint,
      card.confidence, U.jstr(questions), status, U.jstr(card.gen_params || null),
      sourceText || null, degraded ? 1 : 0, U.nowIso(), id);
  } else {
    id = U.uid('in_');
    store.run(
      'INSERT INTO intent_cards(id,user_id,source_kind,source_ref,mood,scene_desc,genre_hypotheses,vocal,duration_hint,confidence,questions,answers,rounds,status,gen_params,created_at,updated_at,source_text,degraded) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'[]\',0,?,?,?,?,?,?)',
      id, job.user_id, kind, payload.upload_path || null,
      card.mood.join(','), card.scene_desc, card.genre_hypotheses.join(','), card.vocal, card.duration_hint,
      card.confidence, U.jstr(questions), status, U.jstr(card.gen_params || null), U.nowIso(), U.nowIso(),
      sourceText || null, degraded ? 1 : 0);
  }
  store.run("UPDATE jobs SET status='done', progress=100, note=?, result=?, updated_at=? WHERE id=?", note, U.jstr({ intent_id: id, ...result }), U.nowIso(), job.id);
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
  assertOwned(job, executorId, 'fail ' + String(code || '') + ' ' + String(message || '').slice(0, 200));
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
    notifyAssistantJob(job, 'queued');
    if (job.user_id) bus.jobProgress(job.user_id, job.id, job.progress || 0, '正在重试');
    notify();
    return;
  }
  // 资损总闸门（抢救计划 P1-2）：定失败 + 费用清零 + 退款入账必须**同一事务**，且每一步都是 CAS。
  // 旧写法是「UPDATE failed → tx(退款) → UPDATE credits_cost=0」三步分开：
  //   · 两步之间崩溃 = 任务已 failed 但钱没退（用户亏）；
  //   · 两个并发 fail/cancel 都能读到 credits_cost>0 = 同一笔退两次（公司亏）；
  //   · 守卫 `credits_cost>0` 读的是进函数时的快照，形同虚设。
  // 现在：谁把 credits_cost 从 >0  CAS 成 0（changes===1），谁才负责退款；退款再过 store.refundOnce 逐事件查重。
  const refundEvt = store.tx(() => {
    const claimed = store.run("UPDATE jobs SET status='failed', error_code=?, error_message=?, attempts=?, lease_expire_at=NULL, updated_at=? WHERE id=? AND status IN ('queued','leased','running')",
      code, message, attempts, U.nowIso(), job.id);
    if (claimed.changes !== 1) return { skipped: '已被其他通道定稿或定失败', refunded: false };
    if (!(job.credits_cost > 0) || !job.user_id) return { refunded: false };
    const zeroed = store.run('UPDATE jobs SET credits_cost=0 WHERE id=? AND credits_cost>0', job.id);
    if (zeroed.changes !== 1) return { skipped: '费用已由他人清零（退款责任已认领）', refunded: false };
    const bal = store.refundOnce(job.user_id, job.credits_cost, 'job', job.id);
    if (bal === null) return { skipped: '该 job 的退款已存在（查重命中）', refunded: false };
    const fp = U.jparse(job.payload, {}) || {};
    if (fp.project_id) store.run('UPDATE mv_projects SET credits_cost=MAX(0,credits_cost-?), credits_refunded=credits_refunded+?, updated_at=? WHERE id=?',
      job.credits_cost, job.credits_cost, U.nowIso(), fp.project_id);
    store.onCommit(() => bus.creditDelta(job.user_id, job.credits_cost, bal)); // COMMIT 之后才推余额
    store.log('job.refund', { job_id: job.id, user_id: job.user_id, amount: job.credits_cost, balance_after: bal });
    return { refunded: true, balance_after: bal };
  });
  if (refundEvt && refundEvt.skipped) store.log('job.refund_skipped', { job_id: job.id, reason: refundEvt.skipped, attempts });
  if (job.user_id) {
    bus.jobError(job.user_id, job.id, { code: code === 'MODERATION_BLOCK' ? code : 'INTERNAL', message });
  }
  store.log('job.failed', { job_id: job.id, code, attempts });
  notifyAssistantJob(job, 'failed');
  // 子 job 连带取消
  for (const c of store.all("SELECT * FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id)) {
    store.run("UPDATE jobs SET status='canceled', updated_at=? WHERE id=?", U.nowIso(), c.id);
  }
  // transcode 子任务永久失败：立即定稿父 music job（降级 wav 交付），不再等租约过期——修复 B 方跨方发现
  if (job.type === 'transcode') {
    const pl = U.jparse(job.payload, {}) || {};
    if (pl.parent_job_id) finalizeMusicParent(pl.parent_job_id);
  }
  // mv_lipsync 子任务永久失败：定稿父 mv_shot（clip 交付、口型如实缺失），不阻塞全片
  if (job.type === 'mv_lipsync' && job.parent_job_id) {
    finalizeMvClipParent(job.parent_job_id);
  }
  reconcileMvFailure(job);
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
// 巡检最近有账动的用户：Σdelta 必须等于末条 balance_after。破损只记审计 + 计数，不自动"修账"。
function auditLedgerInvariant(sinceHours) {
  const since = new Date(Date.now() - (sinceHours || 24) * 3600000).toISOString();
  const users = store.all('SELECT DISTINCT user_id FROM credit_ledger WHERE created_at>=? LIMIT 500', since);
  let bad = 0;
  for (const u of users) {
    if (!u || !u.user_id) continue;
    const sum = store.get('SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger WHERE user_id=?', u.user_id);
    const last = store.lastLedger(u.user_id);
    const bal = last ? last.balance_after : 0;
    const s = sum ? sum.s : 0;
    if (s !== bal) {
      bad++; creditViolations++;
      store.log('credit.invariant_violation', { user_id: u.user_id, sum_delta: s, balance_after: bal, diff: bal - s });
    }
  }
  if (bad) console.warn(U.nowIso(), '[MusicBox] 账本不变量破损用户数 =', bad, '（累计', creditViolations, '）');
  return bad;
}
// 子任务看护上界（抢救计划 P1-2 资损收口）。旧写法是「有子任务就无上限续租」：子任务被 parked /
// 执行器永久掉线时，父 job 会**永远**停在 running（用户已扣的积分既不到「交付」也不到「退款」），
// 属于最难被发现的一类资损。现改为：超过 parentGuardMs 仍无终态的子任务判失败，
// 让父 job 走各自收口（music → 以已产出的 WAV 候选降级交付；mv_shot → 按已就绪镜头收口）。
function expireStuckChildren(parentId, parentType) {
  const guardMs = Math.max(1000, Number(config.engine.parentGuardMs) || 30 * 60 * 1000);
  const cutoff = new Date(Date.now() - guardMs).toISOString();
  const stuck = store.all(
    "SELECT * FROM jobs WHERE parent_job_id=? AND status IN ('queued','leased','running') AND created_at<=? ORDER BY created_at ASC LIMIT 20",
    parentId, cutoff);
  for (const c of stuck) {
    store.log('job.child_guard_timeout', {
      job_id: c.id, parent_job_id: parentId, parent_type: parentType, type: c.type,
      attempts: c.attempts === undefined ? null : c.attempts, created_at: c.created_at, guard_ms: guardMs,
    });
    requeueOrFail(c, 'CHILD_TIMEOUT', '子任务看护超时（超过 ' + Math.round(guardMs / 60000) + ' 分钟无进展），已放弃该项后处理');
  }
  return stuck.length;
}

let sweepTicks = 0;
let creditViolations = 0;
function getCreditViolations() { return creditViolations; }

function sweep() {
  store.init();
  const nowIso = U.nowIso();
  // 账本不变量巡检（抢救计划 P1-2「新增 sweep 校验 Σdelta==balance」）：
  // 只观测不改数据 —— 破损时宁可吵也不能静默，审计事件 credit.invariant_violation + /healthz 计数。
  sweepTicks++;
  const every = Math.max(1, Number(config.engine.creditAuditTicks) || 12);
  if (sweepTicks % every === 0) { try { auditLedgerInvariant(); } catch (e) { store.log('credit.audit.error', { err: String(e && e.message).slice(0, 160) }); } }
  const expired = store.all("SELECT * FROM jobs WHERE status IN ('leased','running') AND lease_expire_at IS NOT NULL AND lease_expire_at<=?", nowIso);
  for (const job of expired) {
    // 等待子任务（如 music 等转码）→ 续租继续看护，不判失败；子任务全终态→立即定稿（不重跑生成）
    if (job.type === 'music') {
      const pendingChildren = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id);
      if (pendingChildren.length) {
        expireStuckChildren(job.id, job.type); // 看护上界：卡死的后处理子任务判失败，父 job 才能收口
        const still = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id);
        if (still.length) {
          store.run('UPDATE jobs SET lease_expire_at=? WHERE id=?', U.isoAfterMs(2 * config.engine.leaseMs), job.id);
          continue;
        }
      }
      if (finalizeMusicParent(job.id)) continue;
    }
    // mv_shot 父任务等待 lipsync 子任务：续租看护；子任务全终态 → 立即收口（不重跑拍摄）
    if (job.type === 'mv_shot') {
      const pendingChildren = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id);
      if (pendingChildren.length) {
        expireStuckChildren(job.id, job.type); // 同 music：看护必须有上界
        const still = store.all("SELECT id FROM jobs WHERE parent_job_id=? AND status NOT IN ('done','failed','canceled')", job.id);
        if (still.length) {
          store.run('UPDATE jobs SET lease_expire_at=? WHERE id=?', U.isoAfterMs(2 * config.engine.leaseMs), job.id);
          continue;
        }
      }
      if (finalizeMvClipParent(job.id)) continue;
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
  // N1-5：takes TTL 清理并入一期 sweep（架构 §8「takes 72h 滚动」/§11 uploads TTL 不变量同族）
  try { sweepMvTakes(); } catch (e) { store.log('mv.takes.cleanup.error', { err: String(e && e.message).slice(0, 160) }); }
}

// —— takes TTL 清理（N1-5）：mv_takes 超 72h 且 非 best_take_id 引用 且 项目 ready 满 72h 才清（ready 前绝不动）；
//     清 DB 行+产物文件；顺带清 var/out 无主产物（无任何表/result 引用且文件 mtime 超 72h）；审计 mv.takes.cleanup 留痕。
//     ready 时长代理=project.updated_at（ready 后任何后续写都会顺延保护期——保守方向，绝不误删在途产物）。
function collectOutRefs() {
  // 全表 JSON 化后扫 `yyyy-mm/f_xxx` 引用（DB 存 rel、result/JSON 存 /f/rel，同一正则两类都抓）
  const refs = new Set();
  const RE = /[0-9]{4}-[0-9]{2}\/f_[A-Za-z0-9._-]+/g;
  const tables = ['works', 'candidates', 'jobs', 'mv_projects', 'mv_characters', 'mv_shots', 'mv_takes'];
  for (const t of tables) {
    let rows = [];
    try { rows = store.all('SELECT * FROM ' + t); } catch (e) { continue; }
    for (const r of rows) {
      const s = U.jstr(r);
      let m;
      RE.lastIndex = 0;
      while ((m = RE.exec(s))) refs.add(m[0]);
    }
  }
  return refs;
}
function listOutFiles(root, prefix, acc) {
  acc = acc || [];
  prefix = prefix || '';
  let names = [];
  try { names = fs.readdirSync(path.join(root, prefix)); } catch (e) { return acc; }
  for (const n of names) {
    const rel = prefix ? prefix + '/' + n : n;
    const abs = path.join(root, rel);
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (st.isDirectory()) listOutFiles(root, rel, acc);
    else if (st.isFile()) acc.push({ rel, abs, mtimeMs: st.mtimeMs });
  }
  return acc;
}
function outAbs(rel) {
  const root = path.resolve(config.paths.out);
  const abs = path.join(root, String(rel).replace(/^\/+/, ''));
  return abs.startsWith(root + path.sep) ? abs : null; // 防越界
}
function sweepMvTakes() {
  const now = Date.now();
  const cutoff = new Date(now - TAKES_TTL_MS).toISOString();
  const removed = { takes: 0, files: 0, orphans: 0 };
  const bestRefs = new Set(
    store.all('SELECT best_take_id AS id FROM mv_shots WHERE best_take_id IS NOT NULL').map((r) => r.id));
  const stale = store.all(
    'SELECT t.*, s.project_id AS _project_id FROM mv_takes t LEFT JOIN mv_shots s ON s.id=t.shot_id WHERE t.created_at<=?',
    cutoff);
  for (const t of stale) {
    if (bestRefs.has(t.id)) continue;                 // best_take 引用永不删（成片原料）
    if (!t._project_id) continue;                      // 无主行不臆删（架构 §11 不变量归人工处置）
    const p = store.get('SELECT status, updated_at FROM mv_projects WHERE id=?', t._project_id);
    if (!p || p.status !== 'ready') continue;          // ready 前绝不动
    if (!(p.updated_at && p.updated_at <= cutoff)) continue; // ready 未满 72h 不动
    if (t.video_url) {
      const abs = outAbs(t.video_url);
      try { if (abs && fs.existsSync(abs)) { fs.unlinkSync(abs); removed.files++; } } catch (e) { /* 文件缺失只删行 */ }
    }
    store.run('DELETE FROM mv_takes WHERE id=?', t.id);
    removed.takes++;
  }
  // 无主产物：var/out 中不被任何表/result 引用、且 mtime 超 72h 的文件（新产物受 mtime 保护，无竞态）
  const refs = collectOutRefs();
  for (const f of listOutFiles(config.paths.out)) {
    if (now - f.mtimeMs < TAKES_TTL_MS) continue;
    if (refs.has(f.rel)) continue;
    try { fs.unlinkSync(f.abs); removed.orphans++; } catch (e) { /* 下轮再试 */ }
  }
  if (removed.takes || removed.files || removed.orphans) store.log('mv.takes.cleanup', removed);
  return removed;
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
  auditLedgerInvariant, getCreditViolations,
  finishDone, requeueOrFail,
  broadcastMvProgress, finalizeMvClipParent, maybeAutoCompose, reconcileMvFailure, // MV 二期（契约 v2.8）
  nightWindowOpen, queuedDispatchable, sweepMvTakes, // N1-5 非计算收尾（白盒/演练可复用）
};
