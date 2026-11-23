// 存储层：node:sqlite 封装，版本迁移/建表/事务/审计钩子/账本原语/形状序列化（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const U = require('./util');

let db = null;

// —— 迁移：schema_version 表驱动，追加新版本即可 ——
const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE users(
  id TEXT PRIMARY KEY, phone TEXT UNIQUE, guest_key TEXT UNIQUE,
  nickname TEXT, avatar TEXT, status TEXT DEFAULT 'active', created_at TEXT);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL, access_token_hash TEXT,
  access_expire_at TEXT, expire_at TEXT NOT NULL, created_at TEXT);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_access ON sessions(access_token_hash);
CREATE TABLE sms_codes(
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expire_at TEXT NOT NULL, tries INT DEFAULT 0, created_at TEXT);
CREATE TABLE credit_ledger(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, delta INT NOT NULL, balance_after INT NOT NULL,
  reason TEXT, ref_type TEXT, ref_id TEXT, created_at TEXT);
CREATE INDEX idx_ledger_user ON credit_ledger(user_id, created_at);
CREATE TABLE works(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'draft',
  audio_master TEXT, audio_playback TEXT, duration_sec REAL, format TEXT, waveform_ref TEXT,
  mood TEXT, genres TEXT, bpm REAL, key TEXT, language TEXT, lyrics TEXT, structure TEXT,
  gen_engine TEXT, gen_seed INTEGER, gen_params TEXT,
  lineage_kind TEXT DEFAULT 'origin', parent_id TEXT, lineage_depth INT DEFAULT 0,
  persona_id TEXT, license_model TEXT, license_usage TEXT,
  ai_label INT DEFAULT 1, visibility TEXT DEFAULT 'private',
  created_at TEXT);
CREATE INDEX idx_works_user ON works(user_id, created_at);
CREATE INDEX idx_works_vis ON works(visibility, created_at);
CREATE TABLE candidates(
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, work_id TEXT, seq INT, title TEXT,
  audio_master TEXT, audio_playback TEXT, duration_sec REAL, format TEXT,
  waveform_ref TEXT, meta TEXT, adopted INT DEFAULT 0, created_at TEXT);
CREATE INDEX idx_candidates_job ON candidates(job_id);
CREATE TABLE jobs(
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
  idem_key TEXT UNIQUE, executor_id TEXT, lease_expire_at TEXT, attempts INT DEFAULT 0,
  progress INT DEFAULT 0, note TEXT, error_code TEXT, error_message TEXT,
  result TEXT, credits_cost INT DEFAULT 0, user_id TEXT, parent_job_id TEXT,
  created_at TEXT, updated_at TEXT);
CREATE INDEX idx_jobs_poll ON jobs(status, type, created_at);
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at);
CREATE TABLE intent_cards(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source_kind TEXT, source_ref TEXT,
  mood TEXT, scene_desc TEXT, genre_hypotheses TEXT, vocal TEXT, duration_hint TEXT,
  confidence REAL, questions TEXT, answers TEXT, rounds INT DEFAULT 0,
  status TEXT DEFAULT 'clarifying', gen_params TEXT, error TEXT,
  created_at TEXT, updated_at TEXT);
CREATE INDEX idx_intent_user ON intent_cards(user_id, created_at);
CREATE TABLE personas(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, is_public INT DEFAULT 0,
  voice_ref TEXT, clone_params TEXT, derived_from_work TEXT, use_count INT DEFAULT 0, created_at TEXT);
CREATE INDEX idx_personas_user ON personas(user_id);
CREATE TABLE prefs(
  user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at TEXT,
  PRIMARY KEY(user_id, key));
CREATE TABLE uploads(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT, path TEXT, bytes INT,
  sha256 TEXT, mime TEXT, expire_at TEXT, created_at TEXT);
CREATE TABLE reports(
  id TEXT PRIMARY KEY, user_id TEXT, work_id TEXT, reason TEXT, status TEXT DEFAULT 'open', created_at TEXT);
CREATE TABLE audit(
  id TEXT PRIMARY KEY, kind TEXT, obj TEXT, created_at TEXT);
CREATE INDEX idx_audit_kind ON audit(kind, created_at);
CREATE TABLE executors(
  id TEXT PRIMARY KEY, lanes TEXT, version TEXT, last_seen TEXT, created_at TEXT);
`,
  },
  {
    version: 2, // work 形状含 rating（PATCH /v1/works/:id 评分 1-5）
    sql: `ALTER TABLE works ADD COLUMN rating INT DEFAULT 0;`,
  },
];

function init() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
  for (const d of ['out', 'uploads', 'config']) fs.mkdirSync(config.paths[d], { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(config.paths.db);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version(version INT)');
  const cur = db.prepare('SELECT version FROM schema_version LIMIT 1').get();
  let ver = cur ? cur.version : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= ver) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      if (ver === 0) db.prepare('INSERT INTO schema_version VALUES(?)').run(m.version);
      else db.prepare('UPDATE schema_version SET version=?').run(m.version);
      db.exec('COMMIT');
      ver = m.version;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

// —— 参数规范化：布尔→0/1，undefined→null（node:sqlite 不接受布尔）——
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
function run(sql, ...params) { return init().prepare(sql).run(...params.map(norm)); }
function get(sql, ...params) { return init().prepare(sql).get(...params.map(norm)) || null; }
function all(sql, ...params) { return init().prepare(sql).all(...params.map(norm)); }

// 事务：fn 内使用同一连接；异常自动回滚
let txDepth = 0;
function tx(fn) {
  init();
  if (txDepth > 0) return fn(); // 可重入
  txDepth++;
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
    throw e;
  } finally {
    txDepth--;
  }
}

// 审计钩子：所有写接口留痕（剧场 audit 范式）
function log(kind, obj) {
  try {
    run('INSERT INTO audit(id,kind,obj,created_at) VALUES(?,?,?,?)', U.uid('a_'), String(kind), U.jstr(obj), U.nowIso());
  } catch (e) { /* 审计失败不阻断业务 */ }
}

// —— 积分账本原语：复式记账，不变量 Σdelta == balance（= 末条 balance_after）——
function getBalance(userId) {
  const row = get('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', userId);
  return row ? row.balance_after : 0;
}
function lastLedger(userId) {
  return get('SELECT * FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', userId);
}
// 追加一条账目（须在 tx 内与业务写同事务），返回新 balance_after
function appendLedger(userId, delta, reason, refType, refId) {
  delta = Math.trunc(Number(delta) || 0);
  const bal = getBalance(userId) + delta;
  const id = U.uid('cl_');
  run('INSERT INTO credit_ledger(id,user_id,delta,balance_after,reason,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id, userId, delta, bal, String(reason || ''), String(refType || ''), String(refId || ''), U.nowIso());
  log('credit', { user_id: userId, delta, balance_after: bal, reason, ref_type: refType, ref_id: refId });
  return bal;
}

// —— prefs ——
function getPref(userId, key) {
  const r = get('SELECT value FROM prefs WHERE user_id=? AND key=?', userId, key);
  return r ? U.jparse(r.value) : null;
}
function setPref(userId, key, value) {
  run('INSERT INTO prefs(user_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    userId, key, U.jstr(value), U.nowIso());
}
function allPrefs(userId) {
  const out = {};
  for (const r of all('SELECT key,value FROM prefs WHERE user_id=?', userId)) out[r.key] = U.jparse(r.value);
  return out;
}

// —— 形状序列化（全接口一致，字段名对齐 CONTRACTS §2）——
function workOf(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title || '', status: r.status || 'draft',
    mood: r.mood || '', genres: U.toArr(r.genres), bpm: r.bpm == null ? null : r.bpm,
    duration_sec: r.duration_sec == null ? null : r.duration_sec,
    lyrics: r.lyrics || '', language: r.language || 'zh',
    gen: { engine: r.gen_engine || 'music', seed: r.gen_seed == null ? null : r.gen_seed },
    lineage: { kind: r.lineage_kind || 'origin', parent_id: r.parent_id || null, depth: r.lineage_depth || 0 },
    persona_id: r.persona_id || null,
    rating: r.rating == null ? 0 : r.rating,
    ai_label: !!r.ai_label, visibility: r.visibility || 'private',
    audio_url: r.audio_playback ? publicUrl(r.audio_playback) : (r.audio_master ? publicUrl(r.audio_master) : null),
    audio_master_url: r.audio_master ? publicUrl(r.audio_master) : null,
    waveform_url: r.waveform_ref ? publicUrl(r.waveform_ref) : null,
    created_at: r.created_at,
  };
}
function candidateOf(r) {
  if (!r) return null;
  const meta = U.jparse(r.meta, {});
  return {
    id: r.id, seq: r.seq, title: r.title || '',
    audio_url: r.audio_playback ? publicUrl(r.audio_playback) : (r.audio_master ? publicUrl(r.audio_master) : null),
    duration_sec: r.duration_sec == null ? null : r.duration_sec,
    format: r.format || 'wav',
    waveform_url: r.waveform_ref ? publicUrl(r.waveform_ref) : null,
    meta: meta || {},
  };
}
function intentOf(r) {
  if (!r) return null;
  return {
    id: r.id, source_kind: r.source_kind || 'text', status: r.status || 'clarifying',
    mood: U.toArr(r.mood), scene_desc: r.scene_desc || '',
    genre_hypotheses: U.toArr(r.genre_hypotheses),
    vocal: r.vocal || 'unknown', duration_hint: r.duration_hint || '',
    confidence: r.confidence == null ? 0 : r.confidence,
    questions: U.jparse(r.questions, []) || [],
    answers: U.jparse(r.answers, []) || [],
    created_at: r.created_at,
  };
}
function publicUrl(rel) {
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return config.publicBaseUrl.replace(/\/$/, '') + '/f/' + String(rel).replace(/^\/+/, '');
}

module.exports = {
  init, db: () => init(), run, get, all, tx, log, norm,
  getBalance, lastLedger, appendLedger,
  getPref, setPref, allPrefs,
  workOf, candidateOf, intentOf, publicUrl,
};
