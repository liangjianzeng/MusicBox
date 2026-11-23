// 声音人格：列表/录音登记（20-40s 实测）/从作品提取（2026-11-23）
'use strict';
const path = require('node:path');
const config = require('../config');
const store = require('../core/store');
const rules = require('../core/rules');
const auth = require('./auth');
const U = require('../core/util');
const intentApi = require('./intent');

const requireUser = auth.requireUser;
const UP = config.upload;

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
  const saved = U.saveToOut(config.paths.out, file.data, file.filename);
  const id = U.uid('p_');
  store.run('INSERT INTO personas(id,user_id,name,is_public,voice_ref,clone_params,derived_from_work,use_count,created_at) VALUES(?,?,?,0,?,?,NULL,0,?)',
    id, user.id, name.slice(0, 30), saved.rel, U.jstr({ clone_mode: 'fast', cover_strength: 0.2 }), U.nowIso());
  store.log('persona.create', { user_id: user.id, persona_id: id, seconds: Math.round(dur) });
  return { status: 200, body: { persona: personaShape(store.get('SELECT * FROM personas WHERE id=?', id)) } };
}

// POST /v1/works/:id/to-persona {name}
function fromWork(ctx) {
  const user = requireUser(ctx);
  const w = store.get('SELECT * FROM works WHERE id=?', ctx.params.id);
  if (!w || w.user_id !== user.id) throw new U.ApiError('NOT_FOUND', '作品不存在');
  if (!w.audio_master) throw new U.ApiError('BAD_REQUEST', '该作品暂无音频源文件');
  const name = String((ctx.body || {}).name || '').trim() || (w.title || '声音人格');
  rules.moderateFields([name]);
  const id = U.uid('p_');
  store.run('INSERT INTO personas(id,user_id,name,is_public,voice_ref,clone_params,derived_from_work,use_count,created_at) VALUES(?,?,?,0,?,?,?,0,?)',
    id, user.id, name.slice(0, 30), w.audio_master, U.jstr({ clone_mode: 'fast', cover_strength: 0.2 }), w.id, U.nowIso());
  store.log('persona.from_work', { user_id: user.id, persona_id: id, work_id: w.id });
  return { status: 200, body: { persona: personaShape(store.get('SELECT * FROM personas WHERE id=?', id)) } };
}

module.exports = {
  routes: [
    { m: 'GET', p: '/v1/personas', h: list },
    { m: 'POST', p: '/v1/personas', h: create, raw: true, limitMb: 26 },
    { m: 'POST', p: '/v1/works/:id/to-persona', h: fromWork },
  ],
};
