// 复刻（风格画像）服务端接口（契约 v5.7，2026-11-27 追加）。
//
// 四条红线决定了这个文件的存在形式：
//  ① 声纹红线（v5.2.5/v5.7.1）：只产出 catalog 四域词表的**风格画像**，不做歌手声纹提取；
//     work 源仅 ownWork；web 源永不下载音频（检索只走 core/websearch.js 的文字通道）。
//  ② 词曲不抄（v5.7.5）：ASR 转写只作归纳入参用后即弃，任何表任何列不存歌词原文/转写全文。
//  ③ 灰度关 = 404（v5.7.2，照 v5.5.2 的 createAgentMode 口径）：没开放的能力不给探测面。
//  ④ 收敛复用意图卡全链（v5.7.7）：feedback 只负责"建卡+预填"，事务/限流/审核由既有内核零豁免执行。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const engine = require('../core/engine');
const rules = require('../core/rules');
const auth = require('./auth');
const U = require('../core/util');
const AC = require('../core/appconfig');
const dict = require('../prompts/dictionary');
const websearch = require('../core/websearch');
const intentApi = require('./intent');          // 复用 takeFile / audioDurationSec / newDraftIntent
const replicaPrompt = require('../prompts/replica');

const requireUser = auth.requireUser;
const UP = config.upload;

// 灰度门（v5.7.2）：与 requireAgent 同一 404 口径 —— 能力没开放就不该让人探到它存在
function requireReplica(ctx) {
  const user = auth.userFromRequest(ctx);
  if (!AC.featureOn('replicaMode', user && user.id)) throw new U.ApiError('NOT_FOUND', '接口不存在');
  if (!user) throw new U.ApiError('UNAUTHORIZED', '请先登录');
  return user;
}

function shapeProfile(r) {
  if (!r) return null;
  return {
    id: r.id,
    source_kind: r.source_kind,
    source_ref: r.source_ref,
    title: r.title,
    features: U.jparse(r.features_json, {}) || { moods: [], genres: [], style_words: [], voice: [] },
    bpm_est: r.bpm_est == null ? null : Number(r.bpm_est), // 用户面恒标「估」（v5.7.5）
    summary: r.summary,
    confidence: Number(r.confidence) || 0,
    degraded: !!r.degraded,
    job_id: r.job_id || null,
    created_at: r.created_at,
  };
}

// 建谱（web 通道同步路径使用；work/upload 通道的建谱在 engine.completeReplicaAnalyze，
// 列清单与此处保持逐字一致 —— 两处 INSERT 的列序是唯一需要人肉对齐的耦合点）
function createProfile(user, f) {
  const id = U.uid('rp_');
  store.run(
    'INSERT INTO replica_profiles(id,user_id,source_kind,source_ref,title,features_json,bpm_est,summary,confidence,degraded,job_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, user.id, f.source_kind, f.source_ref || null, String(f.title || '').slice(0, 80),
    U.jstr(f.features || { moods: [], genres: [], style_words: [], voice: [] }),
    f.bpm_est == null ? null : Math.round(Number(f.bpm_est)),
    String(f.summary || '').slice(0, 200),
    Number(f.confidence) || 0.4, f.degraded ? 1 : 0, f.job_id || null, U.nowIso());
  return store.get('SELECT * FROM replica_profiles WHERE id=?', id);
}

// —— POST /v1/replica/source/upload —— mp3/wav/m4a ≤20MB；魔数+sha256 去重+72h TTL（v5.7.3）
function replicaSourceUpload(ctx) {
  const user = requireReplica(ctx);
  if (!U.allowRate('replica:' + user.id, 6, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const { file } = intentApi.takeFile(ctx, UP.replicaMaxMb * 1024 * 1024);
  const ext = (path.extname(file.filename).slice(1) || '').toLowerCase();
  if (!UP.replicaExts.includes(ext)) throw new U.ApiError('BAD_REQUEST', '仅支持 mp3/wav/m4a 音频');
  const head = file.data.slice(0, 16);
  const isWav = ext === 'wav' && head.toString('ascii', 0, 4) === 'RIFF';
  const isM4a = ext === 'm4a' && head.toString('ascii', 4, 8) === 'ftyp';
  // mp3：ID3 头或 MPEG 帧同步（0xFFEx）—— 客户端最常给的格式，魔数别一刀切只认 wav/m4a
  const isMp3 = ext === 'mp3' && (head.toString('ascii', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0));
  if (!(isWav || isM4a || isMp3)) throw new U.ApiError('BAD_REQUEST', '文件内容与格式不符');
  const mime = isWav ? 'audio/wav' : isM4a ? 'audio/mp4' : 'audio/mpeg';
  let durSec = null;
  if (ext !== 'mp3') {
    durSec = intentApi.audioDurationSec(file.data, ext);
    if (durSec === null) throw new U.ApiError('BAD_REQUEST', '无法读取音频时长，文件可能已损坏');
    if (durSec > UP.replicaMaxSec + 1) throw new U.ApiError('BAD_REQUEST', `参考曲需不超过 ${UP.replicaMaxSec} 秒`);
  } // mp3 无服务端时长解析器：按大小粗限已在上面的 takeFile 完成，精确校验交分析侧（v5.7.3）
  const sha = U.sha256hex(file.data);
  const ex = store.get("SELECT id FROM uploads WHERE user_id=? AND kind='replica_source' AND sha256=? AND expire_at>?",
    user.id, sha, U.nowIso());
  if (ex) return { status: 200, body: { upload_id: ex.id, idempotent: true } };
  const dir = config.paths.uploads;
  fs.mkdirSync(dir, { recursive: true });
  const rel = U.uid('up_') + '.' + ext;
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, file.data);
  const uploadId = U.uid('ul_');
  store.run('INSERT INTO uploads(id,user_id,kind,path,bytes,sha256,mime,expire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    uploadId, user.id, 'replica_source', abs, file.data.length, sha, mime,
    U.isoAfterMs(UP.ttlHours * 3600 * 1000), U.nowIso());
  store.log('replica.upload', { user_id: user.id, kind: ext, bytes: file.data.length, duration_sec: durSec == null ? null : Math.round(durSec) });
  return { status: 200, body: { upload_id: uploadId } };
}

// —— POST /v1/replica/analyze {source:{kind:'work'|'upload'|'web', ref?, query?, title?}} ——
async function replicaAnalyze(ctx) {
  const user = requireReplica(ctx);
  if (!U.allowRate('replica:' + user.id, 6, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const src = (ctx.body || {}).source || {};
  const kind = String(src.kind || '');
  if (!['work', 'upload', 'web'].includes(kind)) throw new U.ApiError('BAD_REQUEST', 'source.kind 仅支持 work|upload|web');

  if (kind === 'work') {
    const ref = String(src.ref || '').trim();
    const w = ref ? store.get('SELECT * FROM works WHERE id=?', ref) : null;
    if (!w || w.user_id !== user.id || w.status === 'retired') throw new U.ApiError('NOT_FOUND', '作品不存在');
    if (!w.audio_master) throw new U.ApiError('BAD_REQUEST', '该作品还没有音频文件，无法分析');
    // 歌词不进 payload（v5.7.5：不在另一张表再复制一份词曲）；归纳时服务端从 works 行临时读
    const jobId = engine.enqueue({
      type: 'replica_analyze',
      payload: {
        src_path: path.join(config.paths.out, w.audio_master),
        title: w.title, meta: { kind: 'work', ref: w.id },
      },
      userId: user.id,
    }).job.id;
    store.log('replica.analyze', { user_id: user.id, source_kind: 'work', ref: w.id, job_id: jobId });
    return { status: 202, body: { job_id: jobId } };
  }

  if (kind === 'upload') {
    const ref = String(src.ref || '').trim();
    const up = ref ? store.get("SELECT * FROM uploads WHERE id=? AND kind='replica_source'", ref) : null;
    if (!up || up.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '上传件不存在');
    if (Date.parse(up.expire_at) < Date.now()) throw new U.ApiError('BAD_REQUEST', '上传件已过期（72h），请重新上传');
    const jobId = engine.enqueue({
      type: 'replica_analyze',
      payload: {
        src_path: up.path,
        title: String(src.title || '参考曲').trim().slice(0, 80), meta: { kind: 'upload', ref: up.id },
      },
      userId: user.id,
    }).job.id;
    store.log('replica.analyze', { user_id: user.id, source_kind: 'upload', ref: up.id, job_id: jobId });
    return { status: 202, body: { job_id: jobId } };
  }

  // web 源：服务端文字检索 + 同步归纳（无执行器参与 —— 检索不是执行器要连的引擎）。
  // 只取摘要文本，永不下载音频；映射与拦截全部复用 websearch.js（v5.5.6 同一实现）。
  const q = String(src.query || '').trim().slice(0, 120);
  if (!q) throw new U.ApiError('BAD_REQUEST', '请填写歌名或描述');
  rules.moderateFields([q]);
  const res = await websearch.searchWeb(q, { userId: user.id });
  if (res.artist_blocked) {
    return {
      status: 200,
      body: {
        ok: false, artist_blocked: true,
        reason: '我不能模仿具体歌手的声音，也不能提取任何人的声纹（需本人授权）；但可以做「这种风格」——描述一下你喜欢的听感（节奏/配器/情绪），或上传一首参考曲，我来做风格层面的画像',
      },
    };
  }
  if (!res.ok) return { status: 200, body: { ok: false, reason: res.reason } };
  if (!res.results.length) return { status: 200, body: { ok: false, reason: '没搜到这个歌名的公开资料，换个说法试试' } };
  const snippets = res.results.map((r) => r.title + ' ' + r.snippet).join('\n');
  let closed = null;
  try { closed = await replicaPrompt.synthProfile('检索词：' + q + '\n网页摘要：\n' + res.fenced); } catch (e) { closed = null; }
  let prof;
  if (closed && (closed.features.moods.length || closed.features.genres.length || closed.features.style_words.length || closed.features.voice.length || closed.bpm_est)) {
    prof = createProfile(user, {
      source_kind: 'web', source_ref: res.query_hash, title: q,
      features: closed.features, bpm_est: closed.bpm_est, summary: closed.summary,
      confidence: closed.confidence, degraded: 0,
    });
  } else {
    const rule = replicaPrompt.ruleProfile({ text: snippets, moods: [], genres: [], bpm: null });
    const has = rule.features.moods.length || rule.features.genres.length || rule.features.style_words.length || rule.features.voice.length;
    if (!has) {
      return {
        status: 200,
        body: { ok: false, reason: '公开资料里找不到能映射进创作词表的特征 —— 描述一下你喜欢的听感，或改用「上传参考曲」', dropped: rule.dropped },
      };
    }
    prof = createProfile(user, {
      source_kind: 'web', source_ref: res.query_hash, title: q,
      features: rule.features, bpm_est: rule.bpm_est, summary: rule.summary,
      confidence: rule.confidence, degraded: 1,
    });
  }
  store.log('replica.profile.create', { user_id: user.id, profile_id: prof.id, source_kind: 'web', degraded: !!prof.degraded });
  return { status: 200, body: { ok: true, profile: shapeProfile(prof) } };
}

// —— GET /v1/replica/profiles —— 本人列表（主权可见，v5.7.9）；?job_id= 按 job 反查（分析完成后端侧取谱：
// 查询串会先命中列表路由，所以 job_id 反查只能挂在这里，不能挂 /:id）
function listProfiles(ctx) {
  const user = requireReplica(ctx);
  const jobId = String((ctx.query || {}).job_id || '').trim();
  const rows = jobId
    ? store.all('SELECT * FROM replica_profiles WHERE user_id=? AND job_id=? ORDER BY created_at DESC LIMIT 5', user.id, jobId)
    : store.all('SELECT * FROM replica_profiles WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 50', user.id);
  return { status: 200, body: { items: rows.map(shapeProfile), next_cursor: null } };
}

// —— GET /v1/replica/profiles/:id ——（含按 job 查询：?job_id= 供分析完成后反查自己的谱）
function getProfile(ctx) {
  const user = requireReplica(ctx);
  const jobId = String((ctx.query || {}).job_id || '').trim();
  const row = jobId
    ? store.get('SELECT * FROM replica_profiles WHERE job_id=? AND user_id=?', jobId, user.id)
    : store.get('SELECT * FROM replica_profiles WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '复刻谱不存在');
  return { status: 200, body: { profile: shapeProfile(row) } };
}

// —— DELETE /v1/replica/profiles/:id —— 删谱不删作品（works.gen_params.replica 标注保留，v5.7.9）
function deleteProfile(ctx) {
  const user = requireReplica(ctx);
  const row = store.get('SELECT * FROM replica_profiles WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '复刻谱不存在');
  store.run('DELETE FROM replica_profiles WHERE id=?', row.id);
  store.log('replica.profile.delete', { user_id: user.id, profile_id: row.id });
  return { status: 200, body: { ok: true } };
}

// —— POST /v1/replica/profiles/:id/feedback {text} —— 自由反馈 → 预填意图卡（v5.7.7）
// 只负责「建卡 + 预填 + 首轮题」；后续收敛/点改/出歌全部走既有 answerIntent/patchIntentInternal/
// generateIntentInternal —— 事务、限流、审核零豁免（复刻不得成为绕过 v5.5.10/11 的旁路）。
function profileFeedback(ctx) {
  const user = requireReplica(ctx);
  if (!U.allowRate('replica:' + user.id, 6, 60000)) throw new U.ApiError('RATE_LIMITED', '操作过于频繁，请稍后再试');
  const row = store.get('SELECT * FROM replica_profiles WHERE id=?', ctx.params.id);
  if (!row || row.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '复刻谱不存在');
  const text = String((ctx.body || {}).text || '').trim().slice(0, 500);
  if (!text) throw new U.ApiError('BAD_REQUEST', '请写下你的反馈（哪里像、哪里要改）');
  rules.moderateFields([text]); // 命中词库 → MODERATION_BLOCK（复刻不是审核旁路）

  const feat = U.jparse(row.features_json, {}) || {};
  const cat = dict.catalog() || {};
  // zh 词 → wire 规范词（生成 tags 用英文规范词；gender 走 card.voice 承载位，v5.5.9 同款纪律）
  const zhToEn = (list, domain) => {
    const cat1 = cat[domain] || [];
    const out = [];
    for (const zh of (Array.isArray(list) ? list : [])) {
      const hit = cat1.find((x) => x && x.zh === zh);
      if (hit && hit.en && !out.includes(hit.en)) out.push(hit.en);
    }
    return out;
  };
  const genderZh = (feat.voice || []).find((v) => (cat.voice || []).some((x) => x.zh === v && x.dim === 'gender')) || null;
  const wireTags = [
    ...zhToEn(feat.voice || [], 'voice').filter((en) => en !== 'choir' || true), // delivery/layer/gender 全进 tags；gender 另落 voice 位
    ...zhToEn(feat.genres || [], 'genres'),
    ...zhToEn(feat.style_words || [], 'style_words'),
  ].slice(0, 12);
  const feedbackScan = dict.scan(text); // 反馈文本里的显式意图（"慢一点"→bpm、"女声"→gender）也进预填

  const budget = 3; // v5.7.7：复刻卡 ask_budget=3（askBudgetFor 对 mode='replica' 同样判 3，双保险）
  const intentId = intentApi.newDraftIntent(user, 'replica', row.id, budget);
  const card = {
    mood: (feat.moods || []).slice(0, 3),
    genre_hypotheses: (feat.genres || []).slice(0, 3),
    vocal: 'unknown',
    voice: genderZh,
    scene_desc: String(row.summary || '').slice(0, 200),
    confidence: 0,
  };
  const gp = {
    tags: wireTags,
    bpm: row.bpm_est == null ? (feedbackScan.bpm || null) : Math.round(Number(row.bpm_est)),
    prompt: String(row.summary || '').slice(0, 300),
    dims: genderZh ? ['gender'] : [],
    replica: { profile_id: row.id, source_kind: row.source_kind, source_ref: row.source_ref },
  };
  if (feedbackScan.moods.length && card.mood.length < 3) {
    for (const m of feedbackScan.moods) if (!card.mood.includes(m) && card.mood.length < 3) card.mood.push(m);
  }
  for (const t of feedbackScan.tags) if (!gp.tags.includes(t) && gp.tags.length < 12) gp.tags.push(t);
  // 反馈显式推翻 BPM 估计时以反馈为准
  if (feedbackScan.bpm != null) gp.bpm = Math.max(40, Math.min(200, feedbackScan.bpm));

  const conf0 = Math.min(0.7, 0.35 + 0.35 * (Number(row.confidence) || 0.5));
  const next = { ...card, confidence: conf0 };
  const qs = dict.defaultQuestions(next, budget);
  qs.forEach((q, i) => { q.q_idx = i; });
  const questionsOut = intentApi.enforceQuestions(qs, budget);
  const status = questionsOut.length ? 'clarifying' : 'ready';
  const finalConf = questionsOut.length ? conf0 : Math.max(conf0, 0.75);

  store.run(
    'UPDATE intent_cards SET source_text=?,mood=?,genre_hypotheses=?,voice=?,scene_desc=?,confidence=?,questions=?,status=?,gen_params=?,updated_at=? WHERE id=?',
    text, card.mood.join(','), card.genre_hypotheses.join(','), card.voice == null ? null : card.voice,
    card.scene_desc, finalConf, U.jstr(questionsOut), status, U.jstr(gp), U.nowIso(), intentId);
  store.log('replica.feedback', { user_id: user.id, profile_id: row.id, intent_id: intentId, status, text_len: text.length });
  bus_intent(intentId, user.id, status);
  return {
    status: 200,
    body: {
      intent_id: intentId, profile_id: row.id,
      intent: store.intentOf(store.get('SELECT * FROM intent_cards WHERE id=?', intentId)),
    },
  };
}
// 广播放函数尾避免顶部循环依赖（bus 只依赖 store）
function bus_intent(intentId, userId, status) {
  try { require('../core/bus').intentCard(userId, intentId, status); } catch (e) { /* 观测不阻断 */ }
}

module.exports = {
  shapeProfile,
  routes: [
    { m: 'POST', p: '/v1/replica/source/upload', h: replicaSourceUpload, raw: true, limitMb: UP.replicaMaxMb + 2 },
    { m: 'POST', p: '/v1/replica/analyze', h: replicaAnalyze },
    { m: 'GET', p: '/v1/replica/profiles', h: listProfiles },
    { m: 'GET', p: '/v1/replica/profiles/:id', h: getProfile },
    { m: 'DELETE', p: '/v1/replica/profiles/:id', h: deleteProfile },
    { m: 'POST', p: '/v1/replica/profiles/:id/feedback', h: profileFeedback },
  ],
};
