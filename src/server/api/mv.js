// MV 二期 API（CONTRACTS v2.1/v2.8/v2.13–v2.16，2026-11-24）：projects 创建/人像上传/cast/confirm/PATCH/列表/详情/report-stub/cancel
//   + jobs/preview/boot/shots-jobs/suggest(wave-2) + assistant/tickets 确认票与 jobs type align(wave-3)。
// 纪律：config.mv.enabled=false 时一律 404（v1 零影响）；人像 consent 前置+72h TTL（PIPL）；
//       先扣后派单/系统补拍免费等计费纪律见 v2.4；助手一切付费执行复用 chargeThenEnqueue 唯一落点（v2.14，不开新账）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const rules = require('../core/rules');
const engine = require('../core/engine');
const auth = require('./auth');
const credits = require('./credits');
const U = require('../core/util');
const AC = require('../core/appconfig');
const lex = require('../rules/mv_lexicon');
const budget = require('../rules/mv_budget');
const mvScript = require('../prompts/mv_script');
const mvAssist = require('../prompts/mv_assist');
const aireview = require('../core/mv_aireview');
const mvReport = require('../core/mv_report'); // 契约 v2.21：音画报告真聚合
const gov = require('../l2mv/governance');
const facade = require('../l2mv/facade');

const requireUser = auth.requireUser;
const UP = config.upload;
// MV 定价走运营配置中心（热生效）；其余字段沿用 config.mv
const MV = Object.create(config.mv, {
  credits: { get() { return AC.credits().mv || config.mv.credits; }, enumerable: true },
});
const STATUS_ORDER = ['drafting', 'casting', 'scripting', 'previewed', 'shooting', 'composing', 'ready'];
const SHOT_DONE = ['clipReady', 'synced', 'locked'];

// —— 机检字段防伪造（契约 v2.8.6）：只允许机检管线写入，PATCH 请求体一律静默剥除 ——
const MACHINE_KEYS = ['ai_review', 'sync_score', 'face_score', 'est_json', 'est_ver', 'timings',
  'paused', 'status', 'credits_cost', 'credits_refunded', 'ai_label', 'work_id', 'user_id', 'id',
  'preview_url', 'video_url', 'cover_url', 'suggest_json', 'created_at', 'updated_at'];
function stripMachineKeys(b) {
  const out = { ...(b || {}) };
  for (const k of MACHINE_KEYS) delete out[k];
  if (out.script_json && typeof out.script_json === 'object') {
    out.script_json = { ...out.script_json };
    delete out.script_json.ai_review; // 审读结论随剧本重生成，不接受用户伪造
    delete out.script_json.timings; // 对齐窗由 mv_align 写入
  }
  return out;
}

// 灰度总开关：环境变量总闸 或 后台功能开关（可按用户灰度）任一开启；都关 → 404（保留 v1 行为）
function requireEnabled(ctx) {
  if (MV.enabled) return;
  const u = ctx && auth.userFromRequest(ctx);
  if (AC.featureOn('mv', u && u.id)) return;
  throw new U.ApiError('NOT_FOUND', '接口不存在');
}

// —— 形状序列化（字段名对齐架构 §5 / CONTRACTS v2.1）——
function projectShape(r) {
  if (!r) return null;
  const est = U.jparse(r.est_json, {}) || {};
  return {
    id: r.id, work_id: r.work_id || null, title: r.title || '', kind: r.kind || 'instrumental',
    status: r.status || 'casting', brief: r.brief || '',
    script_ver: r.script_ver == null ? 1 : r.script_ver,
    est, est_ver: r.est_ver || null,
    budget_credits: r.budget_credits == null ? MV.budgetDefault : r.budget_credits,
    paused: !!r.paused,
    preview_url: r.preview_url ? store.publicUrl(r.preview_url) : null,
    video_url: r.video_url ? store.publicUrl(r.video_url) : null,
    cover_url: r.cover_url ? store.publicUrl(r.cover_url) : null,
    duration_sec: r.duration_sec == null ? null : r.duration_sec,
    credits_cost: r.credits_cost || 0, credits_refunded: r.credits_refunded || 0,
    ai_label: !!r.ai_label,
    license: { model: r.license_model || MV.mvModelLicense.model, usage: r.license_usage || MV.mvModelLicense.usage },
    queue_mode: r.queue_mode || 'normal',
    created_at: r.created_at, updated_at: r.updated_at,
  };
}
function characterShape(r) {
  if (!r) return null;
  return {
    id: r.id, project_id: r.project_id, gender: r.gender || 'f', name: r.name || '',
    source: r.source || 'ai', portrait_upload: r.portrait_upload || null,
    cast_image_url: r.cast_image_url ? store.publicUrl(r.cast_image_url) : null,
    cast_video_url: r.cast_video_url ? store.publicUrl(r.cast_video_url) : null,
    viewrefs: U.jparse(r.viewrefs_json, []) || [],
    cast_images: U.jparse(r.cast_images_json, []) || [], // 定妆 3 候选（机检写入，契约 v2.3）
    frames: U.jparse(r.frames_json, []) || [],           // 定妆视频抽帧评分（机检写入）
    confirmed_at: r.confirmed_at || null,
  };
}
function shotShape(r) {
  if (!r) return null;
  // v2.15.1 批注：degraded 归一为数组（flags.degraded 可能为字符串 'broll_subtitle'）；best_take_origin 供「自动返工」角标
  let degraded = [];
  const flags = U.jparse(r.flags_json, {}) || {};
  if (Array.isArray(flags.degraded)) degraded = flags.degraded;
  else if (flags.degraded) degraded = [String(flags.degraded)];
  let bestOrigin = null;
  if (r.best_take_id) {
    const t = store.get('SELECT origin FROM mv_takes WHERE id=?', r.best_take_id);
    bestOrigin = t ? (t.origin || 'auto') : null;
  }
  return {
    id: r.id, project_id: r.project_id, seq: r.seq, kind: r.kind || 'story',
    sec: r.sec == null ? null : r.sec,
    lyric_from: r.lyric_from == null ? null : r.lyric_from,
    lyric_to: r.lyric_to == null ? null : r.lyric_to,
    desc: r.desc || '', camera: r.camera || '',
    cast_ids: U.toArr(r.cast_ids),
    storyboard_url: r.storyboard_url ? store.publicUrl(r.storyboard_url) : null,
    first_frame_url: r.first_frame_url ? store.publicUrl(r.first_frame_url) : null,
    status: r.status || 'draft', best_take_id: r.best_take_id || null,
    degraded, best_take_origin: bestOrigin,
    rerolls: r.rerolls || 0,
  };
}
function mvShape(r) {
  // GET /v1/mvs 列表项（架构 §6 mv 形状）
  const p = projectShape(r);
  const chars = store.all('SELECT * FROM mv_characters WHERE project_id=? ORDER BY rowid ASC', r.id);
  const shots = store.get("SELECT COUNT(*) AS n FROM mv_shots WHERE project_id=?", r.id);
  p.poster_url = p.cover_url;
  p.cast = chars.map((c) => ({ gender: c.gender || 'f', name: c.name || '', thumb_url: characterShape(c).cast_image_url }));
  p.est = Object.assign({ shots: (shots && shots.n) || 0, minutes: 0, credits: p.credits_cost || 0 }, p.est || {});
  return p;
}
function ownProject(ctx, id) {
  const p = store.get('SELECT * FROM mv_projects WHERE id=?', id);
  if (!p) throw new U.ApiError('NOT_FOUND', 'MV 项目不存在');
  if (p.user_id !== ctx.user.id) throw new U.ApiError('FORBIDDEN', '无权操作该项目');
  return p;
}

// —— POST /v1/mv/projects {work_id, brief?, character:{gender,source,image_id?,name?}} ——
// 免积分；同 work 已有未结束项目 → 409（幂等靠唯一性约束，不静默复用）
function createProject(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  if (!U.allowRate('mv:new:' + user.id, 10, 3600000)) throw new U.ApiError('RATE_LIMITED', '创建 MV 过于频繁，请稍后再试');
  const b = ctx.body || {};
  const workId = String(b.work_id || '').trim();
  if (!workId) throw new U.ApiError('BAD_REQUEST', '缺少 work_id');
  const work = store.get('SELECT * FROM works WHERE id=?', workId);
  if (!work || work.user_id !== user.id || work.status === 'retired') throw new U.ApiError('NOT_FOUND', '作品不存在');
  const kind = String(work.lyrics || '').trim() ? 'vocal' : 'instrumental';
  const ch = (b.character && typeof b.character === 'object') ? b.character : {};
  if (!['m', 'f'].includes(ch.gender)) throw new U.ApiError('BAD_REQUEST', 'character.gender 仅支持 m 或 f');
  if (!['upload', 'ai'].includes(ch.source)) throw new U.ApiError('BAD_REQUEST', 'character.source 仅支持 upload 或 ai');
  let uploadRow = null;
  if (ch.source === 'upload') {
    const imageId = String(ch.image_id || '').trim();
    if (!imageId) throw new U.ApiError('BAD_REQUEST', 'upload 通道需先经 POST /v1/mv/image 上传人像（image_id）');
    uploadRow = store.get('SELECT * FROM uploads WHERE id=?', imageId);
    if (!uploadRow || uploadRow.user_id !== user.id || uploadRow.kind !== 'mv_portrait') throw new U.ApiError('NOT_FOUND', '人像不存在或已过期，请重新上传');
  }
  // 三层净化之首（ADR-MV-8/v2.15）：建项目即净化，杜绝脏词入库后从任何读面（列表/详情/WSS）外泄
  const brief = lex.sanitize(String(b.brief || '').trim()).slice(0, 2000);
  if (brief) rules.moderateFields([brief]);
  const dup = store.get("SELECT id FROM mv_projects WHERE work_id=? AND status NOT IN ('failed','canceled')", workId);
  if (dup) throw new U.ApiError('BAD_REQUEST', '该作品已有进行中的 MV 项目，请先取消或完成它', 409);
  const id = U.uid('mvp_');
  const now = U.nowIso();
  const lic = MV.mvModelLicense;
  store.tx(() => {
    store.run(
      `INSERT INTO mv_projects(id,user_id,work_id,title,kind,status,brief,cast_json,script_json,script_ver,
        budget_credits,paused,credits_cost,credits_refunded,ai_label,license_model,license_usage,queue_mode,created_at,updated_at)
       VALUES(?,?,?,?,?, 'casting', ?, '[]', NULL, 1, ?, 0, 0, 0, 1, ?, ?, 'normal', ?, ?)`,
      id, user.id, workId, String(work.title || '未命名 MV').slice(0, 80), kind, brief || null,
      MV.budgetDefault, lic.model, lic.usage, now, now);
    const cid = U.uid('mvc_');
    store.run(
      'INSERT INTO mv_characters(id,project_id,gender,name,source,portrait_upload,viewrefs_json) VALUES(?,?,?,?,?,?,?)',
      cid, id, ch.gender, String(ch.name || '').slice(0, 40) || (ch.gender === 'm' ? '男主角' : '女主角'),
      ch.source, uploadRow ? uploadRow.id : null, U.jstr([]));
    store.run('UPDATE mv_projects SET cast_json=? WHERE id=?', U.jstr([cid]), id);
  });
  store.log('mv.project.create', { user_id: user.id, project_id: id, work_id: workId, kind });
  return { status: 201, body: { project: projectShape(store.get('SELECT * FROM mv_projects WHERE id=?', id)) } };
}

// —— POST /v1/mv/image multipart(file; jpg/png ≤8MB; consent='true') ——
// 魔数实测（FFD8FF/89504E47）+ sha256 去重 + 72h TTL（kind='mv_portrait'，同 v1 uploads 生命周期）
function takeImageFile(ctx) {
  const ct = (ctx.headers || {})['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) throw new U.ApiError('BAD_REQUEST', '请以 multipart/form-data 上传文件');
  const mp = U.parseMultipart(ctx.raw, ct);
  return { fields: mp.fields || {}, files: mp.files || [] };
}
function mvImage(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  if (!U.allowRate('mv:image:' + user.id, 20, 3600000)) throw new U.ApiError('RATE_LIMITED', '上传过于频繁，请稍后再试');
  const { fields, files } = takeImageFile(ctx);
  // consent 前置（PIPL：仅用于本次角色生成、不用于训练）——缺失即 400
  if (String(fields.consent || '').toLowerCase() !== 'true') throw new U.ApiError('BAD_REQUEST', '请先勾选人像使用授权（consent=true）');
  const file = files.find((f) => f.field === 'file') || files[0];
  if (!file || !file.data || !file.data.length) throw new U.ApiError('BAD_REQUEST', '缺少上传文件（字段名 file）');
  if (file.data.length > UP.imageMaxMb * 1024 * 1024) throw new U.ApiError('BAD_REQUEST', `图片需不超过 ${UP.imageMaxMb}MB`);
  const ext = (path.extname(file.filename).slice(1) || '').toLowerCase();
  if (!UP.imageExts.includes(ext)) throw new U.ApiError('BAD_REQUEST', '仅支持 jpg 或 png 图片');
  const head = file.data.slice(0, 8);
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;           // JPEG FFD8FF
  const isPng = head.toString('hex', 0, 4) === '89504e47';                           // PNG 89504E47
  if (!(isJpg || isPng)) throw new U.ApiError('BAD_REQUEST', '文件内容与格式不符');
  const sha = U.sha256hex(file.data);
  const dup = store.get("SELECT * FROM uploads WHERE user_id=? AND kind='mv_portrait' AND sha256=? AND expire_at>?",
    user.id, sha, U.nowIso());
  if (dup) return { status: 200, body: { image_id: dup.id } }; // sha256 去重：复用未过期同一人像
  const dir = config.paths.uploads;
  fs.mkdirSync(dir, { recursive: true });
  const rel = U.uid('up_') + '.' + ext;
  fs.writeFileSync(path.join(dir, rel), file.data);
  const id = U.uid('ul_');
  store.run(
    'INSERT INTO uploads(id,user_id,kind,path,bytes,sha256,mime,expire_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    id, user.id, 'mv_portrait', path.join(dir, rel), file.data.length, sha,
    isPng ? 'image/png' : 'image/jpeg',
    U.isoAfterMs(UP.ttlHours * 3600 * 1000), U.nowIso());
  store.log('mv.portrait.upload', { user_id: user.id, upload_id: id, bytes: file.data.length });
  return { status: 200, body: { image_id: id } };
}

// —— POST /v1/mv/image/precheck {file} —— 契约 v2.22：人像预检 4 项人话反馈（辅助非门禁，PIPL 仅即时判定不留存）；
//    facegate(:8395) 不可达 → available:false、相关项 null、诚实降级、绝不 500、不阻断上传
const FACEGATE_URL = process.env.MB_MV_FACEGATE_URL || 'http://127.0.0.1:8395';
function imgDims(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return null;
}
async function mvImagePrecheck(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const { files } = takeImageFile(ctx);
  const file = files.find((f) => f.field === 'file') || files[0];
  if (!file || !file.data || !file.data.length) throw new U.ApiError('BAD_REQUEST', '缺少上传文件（字段名 file）');
  const checks = [];
  const dims = imgDims(file.data);
  const resOk = !!dims && dims.w >= 384 && dims.h >= 384;
  checks.push({ key: 'resolution', pass: resOk, msg: dims ? (`分辨率 ${dims.w}×${dims.h}${resOk ? '，足够清晰' : '，偏小，建议 ≥384×384'}`) : '无法解析分辨率' });
  let available = false;
  try {
    const r = await fetch(FACEGATE_URL + '/score', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ img_b64: file.data.toString('base64') }), signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const j = await r.json();
      available = true;
      const yaw = Number((j && j.yaw) || 0), pitch = Number((j && j.pitch) || 0), sc = Number((j && j.score) || 0);
      checks.push({ key: 'frontal', pass: Math.abs(yaw) < 30 && Math.abs(pitch) < 30, msg: (Math.abs(yaw) < 30 && Math.abs(pitch) < 30) ? '正脸良好' : `偏航 ${yaw}°/俯仰 ${pitch}°，尽量正对镜头` });
      checks.push({ key: 'lighting', pass: sc >= 0.5, msg: sc >= 0.5 ? '光照充足' : '光照偏暗，补光更佳' });
      checks.push({ key: 'occlusion', pass: !j || j.pass !== false, msg: (j && j.occlusion) ? '面部有遮挡' : '无明显遮挡' });
    }
  } catch (e) { /* facegate 不可达 → 诚实降级 */ }
  if (!available) for (const k of ['frontal', 'lighting', 'occlusion']) checks.push({ key: k, pass: null, msg: '人脸预检服务未就绪' });
  const passAll = checks.every((c) => c.pass !== false);
  return { status: 200, body: { available, pass: available ? passAll : null, checks, msg: available ? null : '人脸预检服务未就绪（不影响上传，仅辅助建议）' } };
}

// —— POST /v1/mv/projects/:id/cast/confirm {character_id, cast_image_url, frame_sel[]} ——
// 拍板固化 viewRefs（身份真源）；project status 推进到 scripting 显式延期至下一版契约（帧数据源依赖 executor）
function castConfirm(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  if (!['casting', 'scripting'].includes(p.status)) throw new U.ApiError('BAD_REQUEST', '当前状态不可确认定妆');
  const b = ctx.body || {};
  const chId = String(b.character_id || '').trim();
  const ch = store.get('SELECT * FROM mv_characters WHERE id=? AND project_id=?', chId, p.id);
  if (!ch) throw new U.ApiError('NOT_FOUND', '角色不存在或不属于该项目');
  const castImageUrl = String(b.cast_image_url || '').trim();
  if (!castImageUrl) throw new U.ApiError('BAD_REQUEST', '缺少 cast_image_url');
  const frameSel = Array.isArray(b.frame_sel) ? b.frame_sel : [];
  const viewrefs = frameSel.slice(0, 32).map((f) => ({
    url: String((f && f.url) || '').slice(0, 500),
    score: f && Number.isFinite(Number(f.score)) ? Number(f.score) : null,
    sel: f ? !!f.sel : true,
  })).filter((f) => f.url);
  store.tx(() => {
    store.run('UPDATE mv_characters SET cast_image_url=?, viewrefs_json=?, confirmed_at=? WHERE id=?',
      castImageUrl, U.jstr(viewrefs), U.nowIso(), ch.id);
  });
  store.log('mv.cast.confirm', { user_id: user.id, project_id: p.id, character_id: ch.id, viewrefs: viewrefs.length });
  return { status: 200, body: { character: characterShape(store.get('SELECT * FROM mv_characters WHERE id=?', ch.id)) } };
}

// —— PATCH /v1/mv/projects/:id {title?,brief?,script_json?,queue_mode?,ver} ——
// ver CAS：失配 → 409 STALE（契约 v2.1）；script_json 变更才 ver++
function patchProject(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  const b = stripMachineKeys(ctx.body || {}); // 机检字段防伪造（契约 v2.8.6）
  const ver = Number(b.ver);
  if (!Number.isInteger(ver) || ver < 1) throw new U.ApiError('BAD_REQUEST', '缺少 ver（剧本版本号，≥1）');
  if (ver !== (p.script_ver == null ? 1 : p.script_ver)) throw new U.ApiError('STALE', '剧本版本已过期，请获取最新版本后重试', 409);
  const sets = []; const args = [];
  if (b.title !== undefined) { rules.moderateFields([b.title]); sets.push('title=?'); args.push(lex.sanitize(String(b.title)).slice(0, 80)); }
  if (b.brief !== undefined) { rules.moderateFields([b.brief]); sets.push('brief=?'); args.push(lex.sanitize(String(b.brief)).slice(0, 2000)); }
  let verBump = false;
  if (b.script_json !== undefined) {
    if (b.script_json !== null && typeof b.script_json !== 'object') throw new U.ApiError('BAD_REQUEST', 'script_json 需为对象或 null');
    rules.moderateFields([U.jstr(b.script_json).slice(0, 4000)]);
    const clean = lex.sanitizeDeep(b.script_json);
    delete clean.ai_review; delete clean.timings; // 双保险（stripMachineKeys 已剥，纵深防御）
    sets.push('script_json=?'); args.push(U.jstr(clean));
    verBump = true;
  }
  if (b.budget_credits !== undefined) {
    // 人工恢复唯一通道（契约 v2.11）：调高预算 → paused=0 + 审计
    const nb = Number(b.budget_credits);
    if (!Number.isFinite(nb) || nb < 0 || nb > 1000000) throw new U.ApiError('BAD_REQUEST', 'budget_credits 需为 0-1000000 的数值');
    budget.manualRaise(p, nb);
    store.log('mv.project.patch.budget', { user_id: user.id, project_id: p.id, from: budget.budgetOf(p), to: nb });
  }
  if (b.queue_mode !== undefined) {
    const qm = String(b.queue_mode);
    if (!['normal', 'night'].includes(qm)) throw new U.ApiError('BAD_REQUEST', 'queue_mode 仅支持 normal 或 night');
    sets.push('queue_mode=?'); args.push(qm);
  }
  if (!sets.length && b.budget_credits === undefined) throw new U.ApiError('BAD_REQUEST', '没有需要更新的字段');
  if (verBump) { sets.push('script_ver=script_ver+1'); }
  sets.push('updated_at=?'); args.push(U.nowIso());
  store.run(`UPDATE mv_projects SET ${sets.join(',')} WHERE id=?`, ...args, p.id);
  if (verBump) {
    // v2.15.1 批注：剧本改动同步未成片镜（否则 boot/shoot 仍按旧 mv_shots 行拍摄——app 实测修复）
    syncShotsFromScript(user, p, b.script_json);
    engine.broadcastMvProgress(p.id, '剧本已更新，未成片镜已同步（成片镜不动）');
  }
  store.log('mv.project.patch', { user_id: user.id, project_id: p.id, fields: Object.keys(b), ver: p.script_ver });
  return { status: 200, body: { project: projectShape(store.get('SELECT * FROM mv_projects WHERE id=?', p.id)) } };
}

// —— GET /v1/mvs?mine=1&cursor —— 游标分页（仿 listWorks）
function listMvs(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const q = ctx.query || {};
  const where = ['user_id=?']; const args = [user.id];
  const cursor = U.decodeCursor(q.cursor);
  if (cursor && cursor.t && cursor.id) {
    where.push('(created_at<? OR (created_at=? AND id<?))');
    args.push(cursor.t, cursor.t, cursor.id);
  }
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
  const rows = store.all(
    `SELECT * FROM mv_projects WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...args, limit + 1);
  const items = rows.slice(0, limit).map(mvShape);
  const last = rows.length > limit ? rows[limit - 1] : null;
  return { status: 200, body: { items, next_cursor: last ? U.encodeCursor({ t: last.created_at, id: last.id }) : null } };
}

// —— GET /v1/mv/projects/:id → {project, characters[], shots[], tickets:[pending], assistant:{status,banner}} ——
// tickets=确认票 pending 清单（面板数据源，任意访问顺带清扫过期，契约 v2.14）；assistant=会话横幅（契约 v2.13.3）
function getProject(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  const characters = store.all('SELECT * FROM mv_characters WHERE project_id=? ORDER BY rowid ASC', p.id).map(characterShape);
  const shots = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', p.id).map(shotShape);
  const tickets = gov.fetchPendingTickets(p.id);
  const sess = store.get('SELECT * FROM mv_chat_sessions WHERE project_id=? AND user_id=? ORDER BY rowid DESC LIMIT 1', p.id, user.id);
  // 契约 v2.20：规则助手对 MV 可见用户常开（enabled=true）；对话版 LLM 增强按 assistant_chat 灰度（chat_enabled）
  const chatEnabled = !!AC.featureOn('assistant_chat', user.id);
  const assistant = Object.assign(
    sess
      ? { status: sess.status === 'broken' ? 'broken' : 'open', banner: sess.status === 'broken' ? lex.sanitize('AI 助手会话已被预算护栏暂停，请恢复预算或新开会话继续。') : null }
      : { status: 'none', banner: null },
    { enabled: true, chat_enabled: chatEnabled, mode_hint: chatEnabled ? 'chat' : 'rule' },
  );
  // 契约 v2.21：下发只读机检结论 ai_review（来源 script_json.ai_review，机检管线写入；PATCH 不可伪造）
  let ai_review = { engine: null, findings: [], llm_findings: null, assist: null, blocked: false, checked_at: null, has_script: false };
  try {
    const sj = p.script_json ? (typeof p.script_json === 'string' ? JSON.parse(p.script_json) : p.script_json) : null;
    const sanitizeList = (arr) => (Array.isArray(arr) ? arr.slice(0, 30).map((f) => {
      const o = { rule: String((f && f.rule) || '').slice(0, 40), level: (['high', 'warn'].includes(f && f.level) ? f.level : 'warn'), message: lex.sanitize(String((f && f.message) || '')).slice(0, 240) };
      if (f && f.shot_seq != null) o.shot_seq = Number(f.shot_seq);
      if (f && f.source) o.source = String(f.source).slice(0, 12);
      return o;
    }) : []);
    if (sj && sj.ai_review) {
      const ar = sj.ai_review;
      ai_review = {
        engine: ar.engine || '规则机检', findings: sanitizeList(ar.findings),
        llm_findings: ar.llm_findings ? sanitizeList(ar.llm_findings) : null,
        assist: ar.assist || null, blocked: !!ar.blocked,
        checked_at: (ar.assist && ar.assist.ts) || null, has_script: true,
      };
    } else if (sj && Array.isArray(sj.shots)) {
      ai_review.has_script = sj.shots.length > 0;
    }
  } catch (e) { /* 诚实空态，绝不伪造“通过” */ }
  return { status: 200, body: { project: projectShape(p), characters, shots, tickets, assistant, ai_review } };
}

// —— GET /v1/mv/projects/:id/report —— 真聚合（契约 v2.21，替换 STUB）：sync/timings/degraded 来源真实可得即真值，
//    来源缺失则对应项 0/[] 并如实；stub 仅在项目无任何 shot 时为 true（core/mv_report.js 承载聚合逻辑）
function getReport(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  ownProject(ctx, ctx.params.id);
  return { status: 200, body: mvReport.getReport(ctx.params.id) };
}

// —— POST /v1/mv/projects/:id/tone → 200 {tone_suggest, assist}（契约 v2.22：只读基调建议，system free，不改剧本；采纳走 PATCH）——
async function toneSuggest(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  const work = projectWork(p);
  const r = await mvAssist.buildToneSuggest({ work, brief: p.brief, kind: p.kind });
  return { status: 200, body: r };
}

// —— POST /v1/mv/projects/:id/cancel → 200 {refunded} ——
// 未拍镜（status=draft）reserved=credits.mv.shot/镜；实退按账本核算（ref_type='mv_project' 未退净额），恒 ≥0、不重复退
function cancelProject(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  if (['canceled', 'failed'].includes(p.status)) return { status: 200, body: { refunded: 0 } };
  const unshot = store.get("SELECT COUNT(*) AS n FROM mv_shots WHERE project_id=? AND status='draft'", p.id);
  const reserved = ((unshot && unshot.n) || 0) * (MV.credits.shot || 0);
  // 从账本核算本 project 已扣未退净额（不臆造退款；无扣费历史 → 0）
  const charged = store.get(
    "SELECT COALESCE(SUM(-delta),0) AS s FROM credit_ledger WHERE user_id=? AND ref_type='mv_project' AND ref_id=? AND delta<0",
    user.id, p.id);
  const refunded = store.get(
    "SELECT COALESCE(SUM(delta),0) AS s FROM credit_ledger WHERE user_id=? AND ref_type='mv_project' AND ref_id=? AND delta>0",
    user.id, p.id);
  const refundable = Math.max(0, ((charged && charged.s) || 0) - ((refunded && refunded.s) || 0));
  const amount = Math.max(0, Math.min(reserved, refundable));
  store.tx(() => {
    store.run("UPDATE mv_projects SET status='canceled', credits_refunded=credits_refunded+?, updated_at=? WHERE id=?", amount, U.nowIso(), p.id);
    if (amount > 0) {
      const bal = credits.refund(user.id, amount, 'mv_project', p.id);
      if (bal && bal.balance_after != null) { /* 余额已由 refund 落账 */ }
    }
  });
  store.log('mv.project.cancel', { user_id: user.id, project_id: p.id, unshot_shots: (unshot && unshot.n) || 0, refunded: amount });
  return { status: 200, body: { refunded: amount } };
}

// ———— wave-2 · 派单/报价/开机/建议（契约 v2.8，2026-11-24）————

const ACTIVE = ['queued', 'leased', 'running'];
const IDEM_RECENT_MS = 10 * 60000;

function activeOrRecent(idemKey) {
  if (!idemKey) return null;
  const ex = store.get('SELECT * FROM jobs WHERE idem_key=?', idemKey);
  if (ex && (ACTIVE.includes(ex.status) || Date.parse(ex.created_at) > Date.now() - IDEM_RECENT_MS)) return ex;
  return null;
}
function idemOf(user, project, type, extra) {
  return 'mvj_' + U.hash12([user.id, project.id, type, project.script_ver == null ? 1 : project.script_ver, U.jstr(extra || null)].join('|'));
}
function guardBudgetOrThrow(user, project, cost) {
  const chk = budget.checkBudget(project, cost);
  if (!chk.ok) throw new U.ApiError('BUDGET_EXCEEDED', '项目预算护栏已触发（超预算 120% 自动暂停），请调整后经人工提高预算恢复', 402);
}
function mainCharacter(projectId) {
  return store.get('SELECT * FROM mv_characters WHERE project_id=? ORDER BY rowid ASC', projectId);
}
function requireScript(project) {
  const sj = U.jparse(project.script_json, null);
  return sj && Array.isArray(sj.shots) && sj.shots.length ? sj : null;
}
function projectWork(project) {
  return project.work_id ? store.get('SELECT * FROM works WHERE id=?', project.work_id) : null;
}

// 先扣后派单（契约 v2.8.1/§1）：幂等命中→不扣分；扣分成功但 enqueue 抛/并发同键 → 即时全额 refund（账本配对）
function chargeThenEnqueue(user, project, { jobType, cost, reason, payload, idemKey }) {
  const ex = activeOrRecent(idemKey);
  if (ex) return { status: 202, body: { job_id: ex.id, credits_charged: 0, idempotent: true } };
  if (cost > 0) credits.charge(user.id, cost, reason, 'mv_project', project.id);
  let r;
  try {
    r = engine.enqueue({ type: jobType, payload, userId: user.id, idemKey, creditsCost: cost });
  } catch (e) {
    if (cost > 0) credits.refund(user.id, cost, 'mv_project', project.id);
    throw e;
  }
  if (r.idempotent) { // 并发同参竞态：后到者退款（一期 DEV-LADDER-PAY 同源纪律）
    if (cost > 0) credits.refund(user.id, cost, 'mv_project', project.id);
    return { status: 202, body: { job_id: r.job.id, credits_charged: 0, idempotent: true } };
  }
  if (cost > 0) store.run('UPDATE mv_projects SET credits_cost=credits_cost+? WHERE id=?', cost, project.id);
  store.log('mv.dispatch', { user_id: user.id, project_id: project.id, job_type: jobType, cost, initiated_by: 'user' });
  return { status: 202, body: { job_id: r.job.id, credits_charged: cost, idempotent: false } };
}

// 剧本就绪（免费，契约 v2.9）：无剧本 → LLM/兜底编译 + 校验/机审（system free）→ 落地并物化 mv_shots（draft）
async function ensureScript(user, project) {
  let sj = requireScript(project);
  if (!sj) {
    const ch = mainCharacter(project.id);
    const work = projectWork(project);
    const compiled = await mvScript.compileScript({ work: work || {}, character: ch, brief: project.brief, kind: project.kind });
    sj = compiled.script_json;
    rules.moderateFields([U.jstr(sj).slice(0, 4000)]);
    const review = await aireview.review({ script_json: sj, work: work || {}, kind: project.kind, characters: ch ? [ch] : [] });
    sj.ai_review = review; // 机检字段：仅本管线可写（契约 v2.8.6）
    store.run('UPDATE mv_projects SET script_json=?, status=?, updated_at=? WHERE id=?',
      U.jstr(sj), STATUS_ORDER.indexOf(project.status) < STATUS_ORDER.indexOf('scripting') ? 'scripting' : project.status, U.nowIso(), project.id);
    project.script_json = U.jstr(sj);
    store.log('mv.script.compiled', { user_id: user.id, project_id: project.id, mode: compiled.assist.mode, shots: sj.shots.length });
  }
  // 物化镜头（幂等：已有镜头不动——编辑权在人）
  const have = store.get('SELECT COUNT(*) AS n FROM mv_shots WHERE project_id=?', project.id);
  if (!have || !have.n) {
    store.tx(() => {
      sj.shots.forEach((s, i) => {
        store.run(
          'INSERT INTO mv_shots(id,project_id,seq,kind,sec,lyric_from,lyric_to,desc,camera,cast_ids,status,rerolls) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)',
          U.uid('mvs_'), project.id, s.seq || i + 1, s.kind, s.sec, s.lyric_from, s.lyric_to,
          s.desc, s.camera, U.jstr(s.cast_ids || []), 'draft');
      });
    });
  }
  return sj;
}

// 剧本→镜行同步物化（契约 v2.15.1 批注/wave-3，app 实测修复）：只动未成片镜（编辑权在人、成片稳定性）；
// 脚本移除行的未成片镜 → 删行（级联 mv_takes，审计 mv.shot.script_removed 留痕）；成片镜保留行不删（剧本不覆盖成片）。
// opts.resetToDraft：suggestApply 采纳路径把 stale 未成片镜拉回 draft（PATCH 直改路径保持原 status 语义）。
function syncShotsFromScript(user, project, sj, opts) {
  opts = opts || {};
  const rows = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC, rowid ASC', project.id);
  const shots = (sj && Array.isArray(sj.shots)) ? sj.shots : [];
  store.tx(() => {
    shots.forEach((s, i) => {
      const row = rows[i];
      if (!row) { // 剧本新增尾行 → 物化 draft 镜
        store.run(
          'INSERT INTO mv_shots(id,project_id,seq,kind,sec,lyric_from,lyric_to,desc,camera,cast_ids,status,rerolls) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)',
          U.uid('mvs_'), project.id, s.seq || i + 1, s.kind || 'story', s.sec == null ? 5 : s.sec,
          s.lyric_from == null ? null : s.lyric_from, s.lyric_to == null ? null : s.lyric_to,
          s.desc || '', s.camera || '', U.jstr(s.cast_ids || []), 'draft');
        return;
      }
      if (SHOT_DONE.includes(row.status)) return; // 成片镜（clipReady/synced/locked）绝不动
      store.run(
        'UPDATE mv_shots SET seq=?, kind=?, sec=?, lyric_from=?, lyric_to=?, desc=?, camera=?, cast_ids=?' + (opts.resetToDraft ? ", status='draft'" : '') + ' WHERE id=?',
        s.seq == null ? i + 1 : s.seq, s.kind || row.kind, s.sec == null ? row.sec : s.sec,
        s.lyric_from == null ? row.lyric_from : s.lyric_from, s.lyric_to == null ? row.lyric_to : s.lyric_to,
        s.desc == null ? row.desc : s.desc, s.camera == null ? row.camera : s.camera,
        U.jstr(s.cast_ids || U.toArr(row.cast_ids)), row.id);
    });
    for (let i = shots.length; i < rows.length; i++) { // 脚本移除的未成片行 → 删行（成片行保留）
      if (SHOT_DONE.includes(rows[i].status)) continue;
      store.run('DELETE FROM mv_takes WHERE shot_id=?', rows[i].id);
      store.run('DELETE FROM mv_shots WHERE id=?', rows[i].id);
      store.log('mv.shot.script_removed', { user_id: user ? user.id : null, project_id: project.id, shot_id: rows[i].id, seq: rows[i].seq });
    }
  });
}

// —— POST /v1/mv/projects/:id/jobs {type,params?} → 202 {job_id,credits_charged,idempotent} ——
async function mvJobs(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  if (['canceled', 'failed'].includes(p.status)) throw new U.ApiError('NOT_FOUND', '项目已结束，不能派单');
  if (!U.allowRate('mv:jobs:' + user.id, 30, 60000)) throw new U.ApiError('RATE_LIMITED', '派单过于频繁，请稍后再试');
  const b = ctx.body || {};
  const type = String(b.type || '');
  const params = (b.params && typeof b.params === 'object') ? b.params : {};
  const ch = mainCharacter(p.id);
  const work = projectWork(p);
  const shots = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', p.id);

  if (type === 'cast_image') {
    if (!ch) throw new U.ApiError('NOT_FOUND', '角色不存在');
    guardBudgetOrThrow(user, p, MV.credits.cast_image);
    return chargeThenEnqueue(user, p, {
      jobType: 'mv_cast_image', cost: MV.credits.cast_image, reason: 'mv_cast_image',
      payload: {
        project_id: p.id, character_id: ch.id, gender: ch.gender,
        desc: lex.sanitize([p.brief, ch.name].filter(Boolean).join('，') || '自然光半身棚拍'),
        portrait_path: ch.portrait_upload ? (store.get('SELECT path FROM uploads WHERE id=?', ch.portrait_upload) || {}).path || null : null,
        anchor_refs: [], seed: U.randInt(900000) + 1000,
      },
      idemKey: idemOf(user, p, 'cast_image', params),
    });
  }
  if (type === 'cast_video') {
    if (!ch) throw new U.ApiError('NOT_FOUND', '角色不存在');
    const castImage = String(params.cast_image_url || ch.cast_image_url || '').trim();
    if (!castImage) throw new U.ApiError('BAD_REQUEST', '请先派单 cast_image 并挑选定妆照（cast_image_url）');
    guardBudgetOrThrow(user, p, MV.credits.cast_video);
    return chargeThenEnqueue(user, p, {
      jobType: 'mv_cast_video', cost: MV.credits.cast_video, reason: 'mv_cast_video',
      payload: { project_id: p.id, character_id: ch.id, cast_image: castImage, seed: U.randInt(900000) + 1000, motion: '自然转头与表情，多角度展示' },
      idemKey: idemOf(user, p, 'cast_video', { u: castImage, ...params }),
    });
  }
  if (type === 'storyboard') {
    const sj = await ensureScript(user, p);
    const cur = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', p.id);
    if (!cur.length) throw new U.ApiError('NOT_FOUND', '镜头未就绪');
    const cost = Math.max(1, cur.length) * MV.credits.storyboard;
    guardBudgetOrThrow(user, p, cost);
    const viewrefs = {};
    if (ch) viewrefs[ch.id] = (U.jparse(ch.viewrefs_json, []) || []).map((f) => f.url).filter(Boolean).slice(0, 3);
    return chargeThenEnqueue(user, p, {
      jobType: 'mv_storyboard', cost, reason: 'mv_storyboard',
      payload: {
        project_id: p.id,
        shots: cur.map((s) => ({ id: s.id, desc: s.desc, camera: s.camera, cast_ids: U.toArr(s.cast_ids), background: (s.kind === 'broll' || s.kind === 'story') ? s.desc : '' })),
        viewrefs, script_ver: p.script_ver, assist: (sj && sj.assist) || null,
      },
      idemKey: idemOf(user, p, 'storyboard', { st: U.hash12(cur.map((s) => s.id + ':' + s.status).join('|')) }),
    });
  }
  if (type === 'align') {
    // 契约 v2.16（wave-3）：歌唱曲先行对齐（S8）；5⚡ 走 chargeThenEnqueue 唯一落点；timings 由 engine.completeMvAlign 回流
    if (p.kind !== 'vocal') throw new U.ApiError('BAD_REQUEST', '纯音乐项目没有歌词，无需对齐');
    const sj = requireScript(p);
    if (!sj) throw new U.ApiError('NOT_READY', '请先完成剧本（align 前置：剧本就绪）', 409);
    if (!String((work && work.lyrics) || '').trim()) throw new U.ApiError('NOT_READY', '母作品没有歌词，无法对齐', 409);
    guardBudgetOrThrow(user, p, MV.credits.align);
    return chargeThenEnqueue(user, p, {
      jobType: 'mv_align', cost: MV.credits.align, reason: 'mv_align',
      payload: {
        project_id: p.id, audio_master: (work && work.audio_master) || null,
        lyrics: String(work.lyrics || ''), structure: (work && work.structure) || null,
        duration_sec: (work && work.duration_sec) || null,
      },
      idemKey: 'mval_' + U.hash12([user.id, p.id, 'align', p.script_ver == null ? 1 : p.script_ver].join('|')),
    });
  }
  if (type === 'preview' || type === 'shoot' || type === 'compose') {
    return dispatchPreviewShootCompose(user, p, type, params, shots, work, ch);
  }
  throw new U.ApiError('BAD_REQUEST', 'type 仅支持 cast_image/cast_video/storyboard/preview/shoot/compose/align');
}

// preview / shoot / compose 派单（jobs 与专用端点共用）
async function dispatchPreviewShootCompose(user, p, type, params, shotsIn, workIn, chIn) {
  const shots = shotsIn || store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', p.id);
  const work = workIn || projectWork(p);
  const ch = chIn || mainCharacter(p.id);
  if (type === 'preview') {
    if (!shots.length) throw new U.ApiError('NOT_READY', '请先出分镜（无镜头不可出样片）', 409);
    const prior = store.get("SELECT COUNT(*) AS n FROM jobs WHERE type='mv_preview' AND user_id=? AND payload LIKE ?", user.id, '%"project_id":"' + p.id + '"%');
    const firstFree = !((prior && prior.n) || 0);
    const cost = firstFree ? 0 : MV.credits.preview; // D9：每项目首次免费，重出 5⚡
    if (!firstFree) guardBudgetOrThrow(user, p, cost);
    return chargeThenEnqueue(user, p, {
      jobType: 'mv_preview', cost, reason: 'mv_preview',
      payload: {
        project_id: p.id,
        board_urls: shots.filter((s) => s.storyboard_url).map((s) => store.publicUrl(s.storyboard_url)),
        audio_master: (work && work.audio_master) || null, seg_sec: 2.5,
      },
      idemKey: 'mvprev_' + U.hash12([user.id, p.id, (prior && prior.n) || 0].join('|')),
    });
  }
  if (type === 'shoot') {
    const shotId = String(params.shot_id || '').trim();
    if (!shotId) throw new U.ApiError('BAD_REQUEST', 'shoot 需 params.shot_id');
    const shot = store.get('SELECT * FROM mv_shots WHERE id=? AND project_id=?', shotId, p.id);
    if (!shot) throw new U.ApiError('NOT_FOUND', '镜头不存在');
    if (SHOT_DONE.includes(shot.status)) throw new U.ApiError('NOT_READY', '该镜已成片，请走重拍通道（shots/:id/jobs reshoot）', 409);
    if (STATUS_ORDER.indexOf(p.status) < STATUS_ORDER.indexOf('scripting')) throw new U.ApiError('NOT_READY', '请先完成剧本/分镜', 409);
    guardBudgetOrThrow(user, p, MV.credits.shot);
    const refs = ch ? (U.jparse(ch.viewrefs_json, []) || []).map((f) => f.url).filter(Boolean).slice(0, 3) : [];
    const lyrics = String((work && work.lyrics) || '').split(/\r?\n/);
    return chargeThenEnqueue(user, p, {
      jobType: 'mv_shot', cost: MV.credits.shot, reason: 'mv_shot',
      payload: {
        project_id: p.id, shot_id: shot.id,
        shot: {
          first_frame: shot.storyboard_url ? store.publicUrl(shot.storyboard_url) : null,
          refs, motion: lex.sanitize(shot.desc || ''),
          singing: shot.kind === 'singing' && p.kind === 'vocal',
          lyric: Number.isInteger(shot.lyric_from) ? lyrics.slice(shot.lyric_from, shot.lyric_to == null ? shot.lyric_from + 1 : shot.lyric_to).join('；') : '',
        },
        project_kind: p.kind, seed: U.randInt(900000) + 1000, tier: 'quality', initiated_by: 'user',
      },
      idemKey: 'mvb_' + U.hash12([user.id, p.id, shot.id, p.script_ver, 'pre', shot.rerolls || 0].join('|')),
    });
  }
  // compose（手动补触发；自动触发在 engine.maybeAutoCompose）
  if (!shots.length || !shots.every((s) => SHOT_DONE.includes(s.status))) throw new U.ApiError('NOT_READY', '尚有镜头未成片，不能合成', 409);
  guardBudgetOrThrow(user, p, MV.credits.compose);
  let cum = 0;
  const takes = [];
  for (const s of shots) {
    const take = s.best_take_id ? store.get('SELECT * FROM mv_takes WHERE id=?', s.best_take_id) : null;
    if (take && take.video_url) takes.push({ video: take.video_url, start_sec: Math.round(cum * 100) / 100, strip_audio: true });
    cum += Number(s.sec) || 0;
  }
  return chargeThenEnqueue(user, p, {
    jobType: 'mv_compose', cost: MV.credits.compose, reason: 'mv_compose',
    payload: { project_id: p.id, takes, audio_master: (work && work.audio_master) || null, title: lex.sanitize(p.title || 'MV') },
    idemKey: 'mvmc_' + U.hash12([user.id, p.id, shots.map((s) => s.id + ':' + s.status).join('|')].join('|')),
  });
}

// —— POST /v1/mv/projects/:id/preview（首免/重出 5⚡，D9）——
async function mvPreview(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  if (['canceled', 'failed'].includes(p.status)) throw new U.ApiError('NOT_FOUND', '项目已结束');
  return dispatchPreviewShootCompose(user, p, 'preview', {}, null, null, null);
}

// —— POST /v1/mv/projects/:id/boot {est_ver} → 202 {jobs:[...]}（C6：状态门+报价 CAS+预算+余额+enqueueOnce 逐镜）——
async function mvBoot(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  const b = ctx.body || {};
  if (['canceled', 'failed'].includes(p.status)) throw new U.ApiError('NOT_READY', '项目已结束，不能开机', 409);
  // ① 状态门：必须先出样片（S7 先看片再掏分）
  if (STATUS_ORDER.indexOf(p.status) < STATUS_ORDER.indexOf('previewed')) {
    throw new U.ApiError('NOT_READY', '请先出样片与报价（boot 前置：status≥previewed）', 409);
  }
  // ② 报价 CAS（est_ver=hash12，报价卡数据源=GET project.est/est_ver）
  const est = U.jparse(p.est_json, null);
  if (!est || !p.est_ver) throw new U.ApiError('NOT_READY', '报价尚未生成，请先出样片', 409);
  if (String(b.est_ver || '') !== String(p.est_ver)) throw new U.ApiError('EST_STALE', '报价已过期，请重新查看报价卡', 409);
  const shots = store.all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', p.id);
  const pending = shots.filter((s) => !SHOT_DONE.includes(s.status));
  if (!shots.length) throw new U.ApiError('NOT_READY', '没有可拍的镜头', 409);
  if (!pending.length) { // 全部已成片：幂等返回既有 shot jobs（boot 不重复扣分）
    const jobs = store.all("SELECT id FROM jobs WHERE user_id=? AND type='mv_shot' AND payload LIKE ? ORDER BY rowid ASC",
      user.id, '%"project_id":"' + p.id + '"%');
    return { status: 202, body: { jobs: jobs.map((j) => j.id), credits_charged: 0, idempotent: true } };
  }
  // ③ 预算护栏（cost+est > budget×1.2 → 402 + paused=1，S10/v2.11）
  const estTotal = Number(est.credits) || budget.estimate(p, shots).credits;
  guardBudgetOrThrow(user, p, estTotal);
  // ④ 余额核验（报价总额硬顶，先扣后派单的前置）
  const bal = store.getBalance(user.id);
  if (bal < estTotal) throw new U.ApiError('CREDITS_NOT_ENOUGH', `积分不足，开机需要约 ${estTotal} 积分（含后续口型/合成），当前余额 ${bal}`);
  // ⑤ enqueueOnce 逐镜（idem=hash(user+project+shot+ver)，已成片跳过；重复 boot 同批 job）
  const jobIds = [];
  let charged = 0;
  let anyNew = false;
  for (const s of pending) {
    const idemKey = 'mvb_' + U.hash12([user.id, p.id, s.id, p.script_ver, 'boot'].join('|'));
    const r = chargeThenEnqueue(user, p, {
      jobType: 'mv_shot', cost: MV.credits.shot, reason: 'mv_shot',
      payload: {
        project_id: p.id, shot_id: s.id,
        shot: { first_frame: s.storyboard_url ? store.publicUrl(s.storyboard_url) : null, refs: [], motion: lex.sanitize(s.desc || ''), singing: s.kind === 'singing' && p.kind === 'vocal', lyric: '' },
        project_kind: p.kind, seed: U.randInt(900000) + 1000, tier: 'quality', initiated_by: 'user',
      },
      idemKey,
    });
    jobIds.push(r.body.job_id);
    charged += r.body.credits_charged || 0;
    if (!r.body.idempotent) anyNew = true;
  }
  if (anyNew || STATUS_ORDER.indexOf(p.status) < STATUS_ORDER.indexOf('shooting')) {
    store.run("UPDATE mv_projects SET status='shooting', updated_at=? WHERE id=?", U.nowIso(), p.id);
    engine.broadcastMvProgress(p.id, '已开机开拍，剧组进场（' + pending.length + ' 镜）');
  }
  store.log('mv.boot', { user_id: user.id, project_id: p.id, shots: pending.length, charged, est_ver: p.est_ver });
  return { status: 202, body: { jobs: jobIds, credits_charged: charged, idempotent: !anyNew } };
}

// —— POST /v1/mv/shots/:id/jobs {type:"reshoot"|"resync", reason?, initiated_by?} ——
// user_reshoot=付费（40/20）；system=0 分+origin=system_auto+审计（契约 v2.8.1/v2.4）
async function shotJobs(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const shot = store.get('SELECT * FROM mv_shots WHERE id=?', ctx.params.id);
  if (!shot) throw new U.ApiError('NOT_FOUND', '镜头不存在');
  const p = ownProject(ctx, shot.project_id);
  if (['canceled', 'failed'].includes(p.status)) throw new U.ApiError('NOT_FOUND', '项目已结束');
  return shotJobsCore(user, p, shot, ctx.body || {});
}
// 内核（wave-3 抽取：确认票执行路径复用同一函数——扣费唯一落点 chargeThenEnqueue，不开新账）
async function shotJobsCore(user, p, shot, b) {
  const type = String(b.type || '');
  if (!['reshoot', 'resync'].includes(type)) throw new U.ApiError('BAD_REQUEST', 'type 仅支持 reshoot 或 resync');
  const system = String(b.initiated_by || 'user') === 'system';
  const reason = lex.sanitize(String(b.reason || '')).slice(0, 120);
  if (reason) rules.moderateFields([reason]);
  const work = projectWork(p);
  // 契约 v2.22：重拍「动作不对」→ 运动改写（LLM 优先、词典兜底；来源记入 reason_history，不开新列）
  let motionOut = lex.sanitize(shot.desc || '');
  let motionAssist = null;
  if (type === 'reshoot' && /动作/.test(reason)) {
    const rw = await mvAssist.rewriteMotion(shot.desc, b && b.note);
    motionOut = rw.motion; motionAssist = rw.mode;
  }
  const jobType = type === 'reshoot' ? 'mv_shot' : 'mv_lipsync';
  const cost = system ? 0 : (type === 'reshoot' ? MV.credits.shot : MV.credits.lipsync);
  if (!system) guardBudgetOrThrow(user, p, cost);
  const rerolls = (shot.rerolls || 0) + (system ? 0 : 1);
  // chips 诊断链（§5.3 单一真源：reason_history）
  const hist = U.jparse(shot.reason_history, []) || [];
  hist.push({ chip: reason || type, at: U.nowIso(), action: type, billed: cost > 0, initiated_by: system ? 'system' : 'user', ...(motionAssist ? { motion_assist: motionAssist } : {}) });
  const payload = type === 'reshoot'
    ? {
        project_id: p.id, shot_id: shot.id,
        shot: {
          first_frame: shot.storyboard_url ? store.publicUrl(shot.storyboard_url) : null,
          refs: (() => { const ch = mainCharacter(p.id); return ch ? (U.jparse(ch.viewrefs_json, []) || []).map((f) => f.url).filter(Boolean).slice(0, 3) : []; })(),
          motion: motionOut, singing: shot.kind === 'singing' && p.kind === 'vocal', lyric: '',
        },
        project_kind: p.kind, seed: U.randInt(900000) + 1000, tier: 'quality',
        origin: system ? 'system_auto' : 'user_reshoot', initiated_by: system ? 'system' : 'user',
      }
    : (() => {
        const take = shot.best_take_id ? store.get('SELECT * FROM mv_takes WHERE id=?', shot.best_take_id) : null;
        let win = { start_sec: 0, dur_sec: Math.max(0.5, Number(shot.sec) || 5), shot_id: shot.id };
        const sj = U.jparse(p.script_json, null);
        const timings = sj && Array.isArray(sj.timings) ? sj.timings : null;
        if (timings && Number.isInteger(shot.lyric_from) && timings[shot.lyric_from]) {
          const t = timings[shot.lyric_from];
          win = { start_sec: Math.max(0, Number(t.start) - 0.2), dur_sec: Math.max(0.5, Number(t.end) - Number(t.start) + 0.4), shot_id: shot.id };
        }
        return { project_id: p.id, shot_id: shot.id, take_id: shot.best_take_id, video: take ? take.video_url : null, audio_master: (work && work.audio_master) || null, win, reroll: 0, origin: system ? 'system_auto' : 'auto' };
      })();
  const idemKey = 'mvsj_' + U.hash12([user.id, p.id, shot.id, type, rerolls, system ? 'sys' : 'usr'].join('|'));
  if (!system) {
    if (type === 'reshoot') store.run("UPDATE mv_shots SET status='stale', rerolls=? WHERE id=?", rerolls, shot.id);
    else store.run('UPDATE mv_shots SET rerolls=? WHERE id=?', rerolls, shot.id);
  }
  store.run('UPDATE mv_shots SET reason_history=? WHERE id=?', U.jstr(hist.slice(-20)), shot.id);
  const r = chargeThenEnqueue(user, p, { jobType, cost, reason: type === 'reshoot' ? 'mv_shot' : 'mv_lipsync', payload, idemKey });
  if (system) store.log('mv.shot.system_action', { project_id: p.id, shot_id: shot.id, type, initiated_by: 'system', credits_cost: 0 });
  engine.broadcastMvProgress(p.id, system ? '系统自动返工中（不扣分）' : '已提交返工，剧组处理中');
  return { status: 202, body: { job_id: r.body.job_id, credits_charged: r.body.credits_charged, idempotent: r.body.idempotent } };
}

// —— POST /v1/mv/projects/:id/suggest {note} → 200 {suggest} | 409 NOT_READY（LLM 离线不装忙）——
async function suggestScript(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  const sj = requireScript(p);
  if (!sj) throw new U.ApiError('NOT_READY', '还没有剧本，无法给建议（请先出分镜）', 409);
  if (!U.allowRate('mv:suggest:' + user.id, 10, 60000)) throw new U.ApiError('RATE_LIMITED', '请求改稿过于频繁，请稍后再试');
  const b = ctx.body || {};
  const note = lex.sanitize(String(b.note || '')).slice(0, 500);
  if (!note) throw new U.ApiError('BAD_REQUEST', '请告诉编剧你想怎么改（note）');
  rules.moderateFields([note]);
  const r = await mvAssist.buildScriptSuggest({
    script_json: sj, note, work: projectWork(p) || {}, character: mainCharacter(p.id), kind: p.kind,
  });
  if (!r.ok) throw new U.ApiError('NOT_READY', 'AI 编剧暂不可用（后台未就绪），已退回手动编辑', 409);
  store.run('UPDATE mv_projects SET suggest_json=?, updated_at=? WHERE id=?', U.jstr(r.suggest), U.nowIso(), p.id); // 挂草稿不 ver++（suggest 纪律）
  store.log('mv.suggest', { user_id: user.id, project_id: p.id, suggest_id: r.suggest.id, mode: r.suggest.mode });
  return { status: 200, body: { suggest: r.suggest } };
}

// —— POST /v1/mv/projects/:id/suggest/apply {suggest_id, ver} → 200 {project}（采纳才 ver++ + 机审重跑）——
async function suggestApply(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = ownProject(ctx, ctx.params.id);
  const b = ctx.body || {};
  const ver = Number(b.ver);
  if (!Number.isInteger(ver) || ver < 1) throw new U.ApiError('BAD_REQUEST', '缺少 ver（剧本版本号）');
  if (ver !== (p.script_ver == null ? 1 : p.script_ver)) throw new U.ApiError('STALE', '剧本版本已过期，请获取最新版本后重试', 409);
  const stored = U.jparse(p.suggest_json, null);
  if (!stored || stored.id !== String(b.suggest_id || '')) throw new U.ApiError('NOT_FOUND', '建议不存在或已被采纳');
  const ch = mainCharacter(p.id);
  const work = projectWork(p) || {};
  const shots = mvScript.normalizeShots((stored.script && stored.script.shots) || [], work, ch, p.kind);
  if (!shots.length) throw new U.ApiError('NOT_READY', '建议内容不可用', 409);
  const sj = { shots, assist: { mode: 'llm+rule', ts: U.nowIso(), from: 'suggest' } };
  rules.moderateFields([U.jstr(sj).slice(0, 4000)]);
  const review = await aireview.review({ script_json: sj, work, kind: p.kind, characters: ch ? [ch] : [] }); // 机审重跑（v2.10）
  sj.ai_review = review;
  store.run('UPDATE mv_projects SET script_json=?, script_ver=script_ver+1, suggest_json=NULL, updated_at=? WHERE id=?',
    U.jstr(sj), U.nowIso(), p.id);
  // 未成片镜按新剧本刷新（已成片镜不动——拍板权在人）；v2.15.1：统一走同步物化（含新增/删行/seq 对齐，stale→draft）
  syncShotsFromScript(user, p, { shots }, { resetToDraft: true });
  store.log('mv.suggest.apply', { user_id: user.id, project_id: p.id, suggest_id: stored.id, ver: p.script_ver });
  engine.broadcastMvProgress(p.id, '已采纳编剧的新版剧本');
  return { status: 200, body: { project: projectShape(store.get('SELECT * FROM mv_projects WHERE id=?', p.id)) } };
}

// —— GET /v1/mvs/:id → {mv, parent_work}（谱系：母 work 简卡，契约 v2.8.2）——
function getMv(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const p = store.get('SELECT * FROM mv_projects WHERE id=?', ctx.params.id);
  if (!p || p.user_id !== user.id) throw new U.ApiError('NOT_FOUND', 'MV 不存在');
  const work = p.work_id ? store.get('SELECT * FROM works WHERE id=?', p.work_id) : null;
  return { status: 200, body: { mv: mvShape(p), parent_work: work ? store.workOf(work) : null } };
}

// ———— wave-3 · 对话助手 + 确认票（契约 v2.13–v2.16，2026-11-24）————

// 助手免费直执通道（set_title/set_brief/set_queue_mode）：复用 PATCH 同款净化/审核语义 + 审计 initiated_by='assistant'。
// 计费动作绝不走这里——付费执行只经 executeTicketAction → shotJobsCore/chargeThenEnqueue（扣费唯一落点，契约 v2.14）。
function applyAssistantTool(user, project, tool, args) {
  const now = U.nowIso();
  if (tool === 'mv.set_title') {
    rules.moderateFields([args.title]);
    store.run('UPDATE mv_projects SET title=?, updated_at=? WHERE id=?', lex.sanitize(String(args.title)).slice(0, 60), now, project.id);
    store.log('mv.project.patch', { user_id: user.id, project_id: project.id, fields: ['title'], initiated_by: 'assistant' });
    return { reply: '片名已改为「' + lex.sanitize(String(args.title)).slice(0, 60) + '」。' };
  }
  if (tool === 'mv.set_brief') {
    rules.moderateFields([args.brief]);
    store.run('UPDATE mv_projects SET brief=?, updated_at=? WHERE id=?', lex.sanitize(String(args.brief)).slice(0, 300), now, project.id);
    store.log('mv.project.patch', { user_id: user.id, project_id: project.id, fields: ['brief'], initiated_by: 'assistant' });
    return { reply: '故事基调简介已更新。' };
  }
  if (tool === 'mv.set_queue_mode') {
    store.run('UPDATE mv_projects SET queue_mode=?, updated_at=? WHERE id=?', args.queue_mode, now, project.id);
    store.log('mv.project.patch', { user_id: user.id, project_id: project.id, fields: ['queue_mode'], initiated_by: 'assistant', queue_mode: args.queue_mode });
    return { reply: args.queue_mode === 'night' ? '已切换到夜间档（深夜优先派发）。' : '已切回正常档。' };
  }
  throw new U.ApiError('BAD_REQUEST', '该操作需要走确认票');
}

// 确认票消费后的唯一执行器：只认白名单动作（boot 永不可票据执行——开机权在人，双保险硬拒）；
// 执行全部复用既有内部函数/PATCH 语义，付费动作（reshoot）经 shotJobsCore→chargeThenEnqueue 唯一扣费点。
async function executeTicketAction(user, project, action, args, ticket) {
  if (!gov.TOOLS[action] || !/^mv\.(set_title|set_brief|set_queue_mode|script_suggest_edit|shot_reorder|shot_delete|shot_reshoot)$/.test(String(action))) {
    store.log('mv.assistant.audit', { action: 'tool_not_whitelisted', tool: String(action).slice(0, 60), user_id: user.id, project_id: project.id, via: 'ticket' });
    throw new U.ApiError('FORBIDDEN', '该动作不允许通过确认票执行');
  }
  const audit = { user_id: user.id, project_id: project.id, action, ticket_id: ticket ? ticket.id : null, initiated_by: 'assistant' };
  if (action === 'mv.script_suggest_edit') {
    const sj = requireScript(project);
    if (!sj) throw new U.ApiError('NOT_READY', '还没有剧本，先出分镜再让编剧改稿', 409);
    const r = await mvAssist.buildScriptSuggest({ script_json: sj, note: String(args.instruction || ''), work: projectWork(project) || {}, character: mainCharacter(project.id), kind: project.kind });
    if (!r.ok) throw new U.ApiError('NOT_READY', 'AI 编剧暂不可用（后台未就绪），请稍后再批准，或改用手动编辑', 409);
    store.run('UPDATE mv_projects SET suggest_json=?, updated_at=? WHERE id=?', U.jstr(r.suggest), U.nowIso(), project.id); // 挂草稿不 ver++（suggest 纪律）
    store.log('mv.suggest', { user_id: user.id, project_id: project.id, suggest_id: r.suggest.id, mode: r.suggest.mode, initiated_by: 'assistant' });
    store.log('mv.assistant.exec', Object.assign({}, audit, { result: 'suggest_drafted' }));
    return { reply: '编剧的新版建议已挂出，采纳后才会替换现行剧本。', suggest_id: r.suggest.id };
  }
  if (action === 'mv.shot_reorder') {
    const rows = store.all('SELECT id FROM mv_shots WHERE project_id=? ORDER BY seq ASC', project.id);
    const allIds = rows.map((r) => r.id);
    const set = new Set(args.order);
    if (args.order.length !== allIds.length || !allIds.every((id) => set.has(id))) {
      throw new U.ApiError('BAD_REQUEST', '调序需包含当前全部镜头（' + allIds.length + ' 个），请重新勾选后发起');
    }
    store.tx(() => {
      args.order.forEach((id, i) => store.run('UPDATE mv_shots SET seq=? WHERE id=? AND project_id=?', i + 1, id, project.id));
    });
    store.log('mv.shot.reorder', Object.assign({}, audit, { count: args.order.length }));
    engine.broadcastMvProgress(project.id, '镜头顺序已按你的确认更新');
    return { reply: '镜头顺序已更新。' };
  }
  if (action === 'mv.shot_delete') {
    const shot = store.get('SELECT * FROM mv_shots WHERE id=? AND project_id=?', args.shot_id, project.id);
    if (!shot) throw new U.ApiError('NOT_FOUND', '镜头不存在');
    if (SHOT_DONE.includes(shot.status)) throw new U.ApiError('NOT_READY', '成片镜不可删除（成片保护），如不满意请走重拍', 409);
    store.tx(() => {
      store.run('DELETE FROM mv_takes WHERE shot_id=?', shot.id);
      store.run('DELETE FROM mv_shots WHERE id=?', shot.id);
    });
    store.log('mv.shot.delete', Object.assign({}, audit, { shot_id: shot.id }));
    engine.broadcastMvProgress(project.id, '镜头已按你的确认删除');
    return { reply: '镜头已删除（未成片镜，不产生退款项）。' };
  }
  if (action === 'mv.shot_reshoot') {
    const shot = store.get('SELECT * FROM mv_shots WHERE id=? AND project_id=?', args.shot_id, project.id);
    if (!shot) throw new U.ApiError('NOT_FOUND', '镜头不存在');
    // 复用 shots/:id/jobs 内核（40⚡ 先扣后派单 / 预算护栏 / 幂等 / reason_history chips 链全同语义）
    const r = await shotJobsCore(user, project, shot, { type: 'reshoot', reason: args.reason || '助手代提交返工', initiated_by: 'user' });
    store.log('mv.assistant.exec', Object.assign({}, audit, { result: 'reshoot_enqueued', job_id: r.body.job_id, credits_charged: r.body.credits_charged }));
    return { reply: '已提交重拍，剧组进场（本次扣 ' + r.body.credits_charged + ' 积分）。', job_id: r.body.job_id, credits_charged: r.body.credits_charged };
  }
  return applyAssistantTool(user, project, action, args); // 理论上到不了（昂贵项已在上面），防御位
}

// —— POST /v1/mv/assistant/messages（契约 v2.13.1；治理管线在 l2mv/facade）——
async function assistantMessages(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  return facade.handleMessages(ctx);
}

// —— POST /v1/mv/tickets/:id/confirm {ver, hash} → 200 {executed:true,...}（五连校验→既有内部函数执行，契约 v2.14）——
async function ticketConfirm(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  const b = ctx.body || {};
  const consumed = gov.verifyAndConsumeTicket(ctx.params.id, { ver: b.ver, hash: b.hash }, user);
  const p = ownProject(ctx, consumed.project_id); // 归属再校验（项目转让/取消后票自然失效于执行期）
  if (['canceled', 'failed'].includes(p.status)) throw new U.ApiError('NOT_READY', '项目已结束，确认未执行', 409);
  const out = await executeTicketAction(user, p, consumed.action, consumed.args, consumed);
  return { status: 200, body: Object.assign({ executed: true }, out) };
}

// —— POST /v1/mv/tickets/:id/deny → 200 {ok:true}（仅票主；pending→denied）——
function ticketDeny(ctx) {
  requireEnabled(ctx); const user = requireUser(ctx); ctx.user = user;
  gov.denyTicket(ctx.params.id, user);
  return { status: 200, body: { ok: true } };
}

module.exports = {
  projectShape, characterShape, shotShape, mvShape,
  applyAssistantTool, executeTicketAction, // wave-3：facade 延迟加载调用（避免循环依赖）
  routes: [
    { m: 'POST', p: '/v1/mv/projects', h: createProject },
    { m: 'POST', p: '/v1/mv/image', h: mvImage, raw: true, limitMb: UP.imageMaxMb + 2 },
    { m: 'POST', p: '/v1/mv/image/precheck', h: mvImagePrecheck, raw: true, limitMb: UP.imageMaxMb + 2 },
    { m: 'POST', p: '/v1/mv/projects/:id/cast/confirm', h: castConfirm },
    { m: 'PATCH', p: '/v1/mv/projects/:id', h: patchProject },
    { m: 'GET', p: '/v1/mvs', h: listMvs },
    { m: 'GET', p: '/v1/mvs/:id', h: getMv },
    { m: 'GET', p: '/v1/mv/projects/:id', h: getProject },
    { m: 'GET', p: '/v1/mv/projects/:id/report', h: getReport },
    { m: 'POST', p: '/v1/mv/projects/:id/tone', h: toneSuggest },
    { m: 'POST', p: '/v1/mv/projects/:id/cancel', h: cancelProject },
    // —— wave-2（契约 v2.8）——
    { m: 'POST', p: '/v1/mv/projects/:id/jobs', h: mvJobs },
    { m: 'POST', p: '/v1/mv/projects/:id/preview', h: mvPreview },
    { m: 'POST', p: '/v1/mv/projects/:id/boot', h: mvBoot },
    { m: 'POST', p: '/v1/mv/shots/:id/jobs', h: shotJobs },
    { m: 'POST', p: '/v1/mv/projects/:id/suggest', h: suggestScript },
    { m: 'POST', p: '/v1/mv/projects/:id/suggest/apply', h: suggestApply },
    // —— wave-3（契约 v2.13–v2.16）：助手对话 + 确认票 ——
    { m: 'POST', p: '/v1/mv/assistant/messages', h: assistantMessages },
    { m: 'POST', p: '/v1/mv/tickets/:id/confirm', h: ticketConfirm },
    { m: 'POST', p: '/v1/mv/tickets/:id/deny', h: ticketDeny },
  ],
};
