// 声音人格：列表/录音登记（20-40s 实测）/从作品提取（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../config');
const store = require('../core/store');
const rules = require('../core/rules');
const auth = require('./auth');
const U = require('../core/util');
const intentApi = require('./intent');

const requireUser = auth.requireUser;
const UP = config.upload;

// 声纹存放位置用前缀区分，**不加新列、不动历史数据**：
//   'voices/<月>/<名>' → var/voices（本次加固后的新写入，私有）
//   '<月>/<名>'        → var/out（历史行，向后兼容仍可解析；新代码不再往这里写声纹）
const VOICE_PREFIX = 'voices/';

// clone_params 的唯一写法：强度取自 config.persona.defaultCoverStrength。
// 以前这里是两处 `cover_strength: 0.2` 硬编码（加上执行器第三处），改一处漏两处。
function defaultCloneParams() {
  return U.jstr({ clone_mode: 'fast', cover_strength: config.persona.defaultCoverStrength });
}
function resolveVoiceRef(ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  if (r.startsWith(VOICE_PREFIX)) return path.join(config.paths.voices, r.slice(VOICE_PREFIX.length));
  return path.join(config.paths.out, r); // 兼容旧行（曾误存公共 out 目录）
}
function isExecutorRequest(ctx) {
  const tok = (ctx.headers || {})['x-executor-token'] || '';
  return !!tok && U.timingSafeEq(tok, config.executorToken);
}
const VOICE_MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4' };

// GET /v1/personas/:id/voice —— 声纹取件口：**仅属主本人或持执行器令牌**。
// 公开人格（is_public=1）也只公开元数据：把别人的声纹发给第三方 = 未经同意的声纹扩散。
function voiceGet(ctx) {
  const p = store.get('SELECT * FROM personas WHERE id=?', ctx.params.id);
  if (!p) throw new U.ApiError('NOT_FOUND', '人格不存在');
  // 执行器持 X-Executor-Token（它没有用户令牌），两种身份各走各的门：
  // 先判执行器，再判属主 —— 顺序反了会把执行器一律 401，声线克隆永远静默失效。
  const exec = isExecutorRequest(ctx);
  let user = null;
  if (!exec) {
    user = auth.requireUser(ctx);
    if (p.user_id !== user.id) throw new U.ApiError('FORBIDDEN', '声纹样本仅属主可取用');
  }
  const abs = resolveVoiceRef(p.voice_ref);
  if (!abs || !fs.existsSync(abs)) throw new U.ApiError('NOT_FOUND', '声纹样本不存在或已清理');
  const ext = path.extname(abs).toLowerCase();
  const buf = fs.readFileSync(abs);
  ctx.res.writeHead(200, {
    'content-type': VOICE_MIME[ext] || 'application/octet-stream',
    'content-length': buf.length,
    'cache-control': 'private, no-store', // 声纹不得被任何中间缓存留存
  });
  ctx.res.end(buf);
  store.log('persona.voice_fetch', { by: exec ? 'executor' : user.id, persona_id: p.id, owner: exec ? null : (p.user_id === user.id) });
}

function personaShape(p) {
  return { id: p.id, name: p.name, is_public: !!p.is_public, use_count: p.use_count || 0, created_at: p.created_at };
}

// GET /v1/personas
function list(ctx) {
  const user = requireUser(ctx);
  const rows = store.all('SELECT * FROM personas WHERE user_id=? OR is_public=1 ORDER BY created_at DESC LIMIT 100', user.id);
  return { status: 200, body: { items: rows.map(personaShape) } };
}

// POST /v1/personas —— multipart(name, file; 20-40s 音频)
function create(ctx) {
  const user = requireUser(ctx);
  const ct = (ctx.headers || {})['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) throw new U.ApiError('BAD_REQUEST', '请以 multipart/form-data 上传');
  const mp = U.parseMultipart(ctx.raw, ct);
  const name = String(mp.fields.name || '').trim();
  if (!name || name.length > 30) throw new U.ApiError('BAD_REQUEST', '人格名称需为 1-30 个字符');
  rules.moderateFields([name]);
  const file = (mp.files || []).find(f => f.field === 'file') || (mp.files || [])[0];
  if (!file || !file.data || !file.data.length) throw new U.ApiError('BAD_REQUEST', '缺少音频文件（字段名 file）');
  if (file.data.length > 25 * 1024 * 1024) throw new U.ApiError('BAD_REQUEST', '音频文件过大');
  const ext = (path.extname(file.filename).slice(1) || '').toLowerCase();
  if (!['wav', 'm4a', 'mp3'].includes(ext)) throw new U.ApiError('BAD_REQUEST', '仅支持 wav/m4a/mp3 音频');
  const head = file.data.slice(0, 16);
  const magicOk = (ext === 'wav' && head.toString('ascii', 0, 4) === 'RIFF')
    || (ext === 'm4a' && head.toString('ascii', 4, 8) === 'ftyp')
    || (ext === 'mp3' && (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 || head.toString('ascii', 0, 3) === 'ID3'));
  if (!magicOk) throw new U.ApiError('BAD_REQUEST', '文件内容与格式不符');
  let dur = null;
  try { dur = intentApi.audioDurationSec(file.data, ext); } catch (e) { dur = null; }
  if (dur === null) throw new U.ApiError('BAD_REQUEST', '无法读取音频时长，文件可能已损坏');
  if (dur < UP.personaMinSec || dur > UP.personaMaxSec) {
    throw new U.ApiError('BAD_REQUEST', `声纹样本需 ${UP.personaMinSec}-${UP.personaMaxSec} 秒，当前约 ${Math.round(dur)} 秒`);
  }
  // 声纹属**敏感个人信息**：不得落进 /f/* 公共静态目录（任何持 URL 者都能下载他人声纹）。
  // 存进 var/voices（不在 /f/* 映射范围内），只能经 GET /v1/personas/:id/voice 由属主或执行器取件。
  const saved = U.saveToOut(config.paths.voices, file.data, file.filename);
  const id = U.uid('p_');
  store.run('INSERT INTO personas(id,user_id,name,is_public,voice_ref,clone_params,derived_from_work,use_count,created_at) VALUES(?,?,?,0,?,?,NULL,0,?)',
    id, user.id, name.slice(0, 30), VOICE_PREFIX + saved.rel, U.jstr({ clone_mode: 'fast', cover_strength: config.persona.defaultCoverStrength }), U.nowIso());
  store.log('persona.create', { user_id: user.id, persona_id: id, seconds: Math.round(dur) });
  return { status: 200, body: { persona: personaShape(store.get('SELECT * FROM personas WHERE id=?', id)) } };
}

// POST /v1/works/:id/to-persona {name?, start_sec?, seconds?} —— 从自己的作品里取一段当声纹参考。
//
// 2026-11-27 重写。旧实现是错的，而且是"看起来能用"的那种错：
//   1) 它把 `audio_master` **整条 240s** 写进 voice_ref —— 契约要求声纹样本 20-40s
//      （上传路径有校验，这条路径没有），引擎拿到 4 分钟的参考并不符合 cover 的用法；
//   2) 它把声纹指向 **公共 out 目录**（w.audio_master 没有 voices/ 前缀），
//      违反 v5.2.1「声纹样本属敏感个人信息，必须存私有 var/voices/，不在 /f/* 映射内」。
//   后果就是人格表一直是空的：这条路没人跑通过。
// 现在：服务端裁 [start_sec, start_sec+seconds]（默认落在中段人声最实处），
// **落进 var/voices 私有目录**；裁剪工具不可用 → NOT_READY 明确失败并指引用户走录音登记，
// 绝不静默退化成"整条作品当声纹"。
function fromWork(ctx) {
  const user = requireUser(ctx);
  const w = store.get('SELECT * FROM works WHERE id=?', ctx.params.id);
  if (!w || w.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '作品不存在');
  if (!w.audio_master) throw new U.ApiError('BAD_REQUEST', '该作品暂无音频源文件');
  const name = String((ctx.body || {}).name || '').trim() || (w.title || '声音人格');
  rules.moderateFields([name]);

  const srcAbs = path.isAbsolute(w.audio_master) ? w.audio_master : path.join(config.paths.out, w.audio_master);
  if (!fs.existsSync(srcAbs)) throw new U.ApiError('BAD_REQUEST', '该作品的音频文件已不在本机，无法取样');

  const MIN = config.upload.personaMinSec, MAX = config.upload.personaMaxSec;
  const bin = config.upload.ffmpegBin;
  const probe = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    // 诚实降级：不假装成功。旧实现"没有裁剪工具就把整条歌当声纹"是最坏的一种降级。
    throw new U.ApiError('NOT_READY',
      '这台服务器没有可用的音频裁剪工具，暂时不能从作品取样声纹；请改用「录音登记」上传 20-40 秒人声');
  }

  const srcBuf = fs.readFileSync(srcAbs);
  const srcDur = intentApi.audioDurationSec(srcBuf, path.extname(srcAbs).slice(1).toLowerCase());
  if (!(srcDur > 0)) throw new U.ApiError('BAD_REQUEST', '无法读取作品音频时长，可能已损坏');
  if (srcDur < MIN) {
    throw new U.ApiError('BAD_REQUEST', `这首作品只有 ${Math.round(srcDur)} 秒，不足 ${MIN} 秒，取不出可用的声纹样本`);
  }

  let seconds = Math.round(Number((ctx.body || {}).seconds) || 28);
  seconds = Math.max(MIN, Math.min(MAX, Math.min(seconds, Math.floor(srcDur))));
  let start = Number((ctx.body || {}).start_sec);
  if (!Number.isFinite(start) || start < 0) start = Math.max(0, (srcDur - seconds) / 2); // 默认取中段（前奏/尾奏多半是器乐）
  start = Math.max(0, Math.min(start, srcDur - seconds));

  const id = U.uid('p_');
  const tmpAbs = path.join(config.paths.voices, `.tmp_${id}.wav`);
  fs.mkdirSync(config.paths.voices, { recursive: true });
  const cut = spawnSync(bin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(start), '-t', String(seconds), '-i', srcAbs,
    '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', tmpAbs,
  ], { encoding: 'utf8' });
  if (cut.status !== 0 || !fs.existsSync(tmpAbs)) {
    try { if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs); } catch (e) { /* 清理尽力而为 */ }
    // 不把工具名/stderr 甩给用户（util 的脱敏纪律），细节进审计日志
    store.log('persona.from_work.failed', { user_id: user.id, work_id: w.id, stderr: String(cut.stderr || '').slice(0, 300) });
    throw new U.ApiError('NOT_READY', '声纹取样失败，请换个时间段重试，或改用「录音登记」');
  }

  const outBuf = fs.readFileSync(tmpAbs);
  fs.unlinkSync(tmpAbs);
  const gotDur = intentApi.audioDurationSec(outBuf, 'wav');
  // 临时文件已删，样本只在内存里：校验不过就直接抛，绝不落库（不落库就没有"半条声纹"）
  if (!(gotDur >= MIN && gotDur <= MAX)) {
    throw new U.ApiError('INTERNAL', '裁出的样本时长不符合契约，已放弃落库');
  }
  // **必须**经 saveToOut 落进 var/voices 并带 voices/ 前缀：公共 /f/* 目录里放声纹 =
  // 任何持 URL 者都能下载他人声纹（v5.2.1 明令禁止的扩散路径）
  const saved = U.saveToOut(config.paths.voices, outBuf, `persona_${id}.wav`);
  store.run('INSERT INTO personas(id,user_id,name,is_public,voice_ref,clone_params,derived_from_work,use_count,created_at) VALUES(?,?,?,0,?,?,?,0,?)',
    id, user.id, name.slice(0, 30), VOICE_PREFIX + saved.rel, U.jstr({ clone_mode: 'fast', cover_strength: config.persona.defaultCoverStrength }), w.id, U.nowIso());
  store.log('persona.from_work', {
    user_id: user.id, persona_id: id, work_id: w.id,
    start_sec: Math.round(start * 10) / 10, seconds: Math.round(gotDur * 10) / 10, bytes: saved.bytes,
  });
  return { status: 200, body: { persona: personaShape(store.get('SELECT * FROM personas WHERE id=?', id)) } };
}

module.exports = {
  routes: [
    { m: 'GET', p: '/v1/personas', h: list },
    { m: 'POST', p: '/v1/personas', h: create, raw: true, limitMb: 26 },
    { m: 'POST', p: '/v1/works/:id/to-persona', h: fromWork },
    { m: 'GET', p: '/v1/personas/:id/voice', h: voiceGet },
  ],
  resolveVoiceRef,
};
