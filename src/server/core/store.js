// 存储层：node:sqlite 封装，版本迁移/建表/事务/审计钩子/账本原语/形状序列化（2026-11-23）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const U = require('./util');

let db = null;

// —— MV 定脸方案白名单（契约：方案一默认 i2v_first_frame；新增方案只追加、不改默认）——
const CAST_METHODS = ['i2v_first_frame', 'h3_image_cast', 'ref2va', 'likeness_lora'];
const CAST_METHOD_DEFAULT = 'i2v_first_frame'; // 方案一：女主原图 I2V 首帧（SP6 实测定档）

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
  {
    // v3 · MV 二期表（架构 design §5 DDL，2026-11-24）：projects/characters/shots/takes/tickets/chat
    // IF NOT EXISTS 保证重跑幂等；不改动 v1 表与数据
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS mv_projects(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, work_id TEXT,
  title TEXT, kind TEXT,                                        -- vocal|instrumental（lyrics 判定）
  status TEXT,                                                  -- drafting|casting|scripting|previewed|shooting|composing|ready|failed|canceled
  brief TEXT, cast_json TEXT, script_json TEXT, script_ver INT DEFAULT 1, suggest_json TEXT,
  est_json TEXT, est_ver TEXT,
  budget_credits INT DEFAULT 1200, paused INT DEFAULT 0,
  preview_url TEXT, video_url TEXT, cover_url TEXT, duration_sec REAL,
  credits_cost INT DEFAULT 0, credits_refunded INT DEFAULT 0,
  ai_label INT DEFAULT 1, license_model TEXT, license_usage TEXT,
  queue_mode TEXT DEFAULT 'normal',                             -- normal|night
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS mv_characters(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, gender TEXT, name TEXT,
  source TEXT,                                                  -- upload|ai|reuse
  portrait_upload TEXT,                                         -- uploads.kind='mv_portrait' 72h TTL
  cast_image_url TEXT, cast_video_url TEXT,
  viewrefs_json TEXT,                                           -- 拍板固化帧库 [{url,score,sel}]
  confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS mv_shots(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, seq INT, kind TEXT, sec REAL,
  lyric_from INT, lyric_to INT,
  desc TEXT, camera TEXT, cast_ids TEXT,
  storyboard_url TEXT, first_frame_url TEXT,
  status TEXT,                                                  -- draft|boardReady|clipReady|synced|locked|stale
  best_take_id TEXT, rerolls INT DEFAULT 0,
  reason_history TEXT, flags_json TEXT);
CREATE TABLE IF NOT EXISTS mv_takes(
  id TEXT PRIMARY KEY, shot_id TEXT NOT NULL, job_id TEXT,
  engine_tier TEXT DEFAULT 'quality', video_url TEXT,
  lipsynced INT DEFAULT 0, sync_score REAL, face_score REAL,
  origin TEXT DEFAULT 'auto',                                    -- auto|system_auto|user_reshoot
  ai_label INT DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS mv_tickets(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT, action TEXT, args_json TEXT,
  est_credits INT, est_minutes INT, hash TEXT, ver TEXT,
  status TEXT DEFAULT 'pending',                                 -- pending|consumed|expired|denied
  ttl_expire_at TEXT, created_at TEXT, consumed_at TEXT);
CREATE TABLE IF NOT EXISTS mv_chat_sessions(
  id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT,
  status TEXT DEFAULT 'open',                                   -- open|broken（预算熔断）
  ctx_json TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS mv_chat_messages(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT, content TEXT,
  meta_json TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_mv_shots_project ON mv_shots(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_mv_takes_shot ON mv_takes(shot_id);
CREATE INDEX IF NOT EXISTS idx_mv_tickets_status ON mv_tickets(status, ttl_expire_at);
CREATE INDEX IF NOT EXISTS idx_mv_projects_user ON mv_projects(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mv_characters_project ON mv_characters(project_id);
`,
  },
  {
    // v4 · MV wave-2（契约 v2.8/v2.3）：定妆候选与抽帧落角色（cast/confirm 前的候选面，机检写入）
    version: 4,
    sql: `
ALTER TABLE mv_characters ADD COLUMN cast_images_json TEXT;
ALTER TABLE mv_characters ADD COLUMN frames_json TEXT;
`,
  },
  {
    // v5 · 模型节点后台管理（2026-11-24）：节点可后台配置，不再写死 config.js
    // model_nodes：音乐/图像/视频/MV/LLM/ASR 等生成端点；model_defaults：各类型默认走向+locked
    version: 5,
    sql: `
CREATE TABLE IF NOT EXISTS model_nodes(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- music|asr|llm|comfy|lipsync|facegate|mv_asr
  engine TEXT NOT NULL,            -- ace-step-1.5 / qwen38-fp4 / sensevoice / comfy ...
  endpoint TEXT NOT NULL,
  priority INT DEFAULT 100,        -- 越小越优先
  weight REAL DEFAULT 1,           -- 同优先级内负载均衡权重
  enabled INT DEFAULT 1,
  status TEXT DEFAULT 'unknown',   -- healthy|unhealthy|unknown（心跳/探测刷新）
  last_seen TEXT, updated_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_model_nodes_kind ON model_nodes(kind, enabled);
CREATE TABLE IF NOT EXISTS model_defaults(
  kind TEXT PRIMARY KEY,          -- music|asr|llm|comfy|lipsync|facegate|mv_asr
  node_id TEXT NOT NULL,          -- 默认指向 model_nodes.node_id
  locked INT DEFAULT 0,           -- 1=锁定，APK 不可自行覆盖
  updated_at TEXT, created_at TEXT);
`,
  },
  {
    // v6 · 运营后台管理员（2026-11-24）：独立于用户体系
    version: 6,
    sql: `
CREATE TABLE IF NOT EXISTS admins(
  id TEXT PRIMARY KEY, username TEXT UNIQUE,
  password_hash TEXT, status TEXT DEFAULT 'active',
  last_seen TEXT, created_at TEXT);
`,
  },
  {
    // v7 · 管理员登录令牌（2026-11-24）：登录时写入随机 token，请求按 token 校验
    version: 7,
    sql: `ALTER TABLE admins ADD COLUMN token TEXT;`,
  },
  {
    // v8 · 运营配置中心（2026-11-24）：定价/版本策略/公告热生效 + 功能开关灰度 + 运营事件可回滚
    version: 8,
    sql: `
CREATE TABLE IF NOT EXISTS app_config(
  version INTEGER PRIMARY KEY,
  blob TEXT NOT NULL,                    -- 整份运营配置快照（定价/版本策略/公告/审核开关）
  changed_by TEXT, reason TEXT,
  created_at TEXT);
CREATE TABLE IF NOT EXISTS feature_flags(
  key TEXT PRIMARY KEY,
  enabled INT DEFAULT 0,
  grayscale REAL DEFAULT 0,              -- 0..1 放量比例（enabled=1 时生效）
  updated_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_feature_flags_key ON feature_flags(key);
CREATE TABLE IF NOT EXISTS ops_events(
  id TEXT PRIMARY KEY, kind TEXT, actor TEXT,
  target TEXT, before TEXT, after TEXT,
  created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_ops_events_kind ON ops_events(kind, created_at);
`,
  },
  {
    // v9 · 模型节点真实元数据（2026-11-24）：可读名称/说明/来源 + 探测时间与原因，后台一眼看出是不是真节点
    version: 9,
    sql: `
ALTER TABLE model_nodes ADD COLUMN label TEXT;          -- 运营可读名称，如「口型重绘 · EchoMimicV3-Flash」
ALTER TABLE model_nodes ADD COLUMN note TEXT;           -- 归属与用途说明（宿主/进程/端口纪律）
ALTER TABLE model_nodes ADD COLUMN source TEXT DEFAULT 'manual'; -- seed=按部署默认播种 / manual=后台新增
ALTER TABLE model_nodes ADD COLUMN last_probe_at TEXT;  -- 最后一次探测时间
ALTER TABLE model_nodes ADD COLUMN last_probe_msg TEXT; -- 最后一次探测结果原因（HTTP 200 / ECONNREFUSED / timeout）
`,
  },
  {
    // v10 · 跨模块助手门面（契约 v3.1 / 架构 l2，2026-11-24）：scope 化通用会话/消息/确认票，
    //      供音乐助手等新 scope 使用；MV 沿用既有 mv_chat_*/mv_tickets，本迁移不触碰 MV 表（V13/V16 零回归）。
    version: 10,
    sql: `
CREATE TABLE IF NOT EXISTS chat_sessions(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                    -- 'music'（mv 未来可收敛；当前 mv 仍用 mv_chat_sessions）
  subject_type TEXT NOT NULL,             -- 'work' | 'intent'
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open',    -- open | broken（熔断）
  ctx_json TEXT,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_scope ON chat_sessions(scope,subject_id,user_id);
CREATE TABLE IF NOT EXISTS chat_messages(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                     -- result（只记已执行结果摘要，不记原始指令全文）
  content TEXT, meta_json TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sess ON chat_messages(session_id);
CREATE TABLE IF NOT EXISTS chat_tickets(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL, args_json TEXT NOT NULL,
  est_credits INT DEFAULT 0, est_minutes INT DEFAULT 0,
  hash TEXT NOT NULL, ver TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | executed | expired | denied
  ttl_expire_at TEXT, created_at TEXT NOT NULL, consumed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_chat_tickets_scope ON chat_tickets(scope,subject_type,subject_id,status,ttl_expire_at);
`,
  },
  {
    // v11 · 意图卡诚实化（2026-11-24）：转写逐字与「是否兜底」必须可回溯。
    //      此前 ASR 挂了也照样报「意图卡已生成」（result.fallback=true 但库里无痕），
    //      用户看到的是「不理解，然后什么都没了」。现在：
    //      · source_text：语音=转写逐字；文本=用户原文；图片=图片理解摘要；
    //      · degraded：1=识别没起来、走本地词典兜底（前端必须显式告诉用户）。
    version: 11,
    sql: `
ALTER TABLE intent_cards ADD COLUMN source_text TEXT;
ALTER TABLE intent_cards ADD COLUMN degraded INT DEFAULT 0;
`,
  },
  {
    // v12 · 统一创作助手（契约 v4.0）：只增量扩展 chat_*，不触碰 mv_chat_*/mv_tickets。
    version: 12,
    sql: `
ALTER TABLE chat_sessions ADD COLUMN title TEXT;
ALTER TABLE chat_sessions ADD COLUMN surface TEXT DEFAULT 'global';
ALTER TABLE chat_sessions ADD COLUMN updated_at TEXT;
ALTER TABLE chat_messages ADD COLUMN seq INTEGER;
ALTER TABLE chat_messages ADD COLUMN client_msg_id TEXT;
ALTER TABLE chat_tickets ADD COLUMN session_id TEXT;
ALTER TABLE chat_tickets ADD COLUMN meta_json TEXT;
ALTER TABLE chat_tickets ADD COLUMN job_id TEXT;
ALTER TABLE chat_tickets ADD COLUMN reply TEXT;
ALTER TABLE chat_tickets ADD COLUMN expires_at TEXT;
ALTER TABLE chat_tickets ADD COLUMN started_at TEXT;
ALTER TABLE chat_tickets ADD COLUMN finished_at TEXT;
ALTER TABLE chat_tickets ADD COLUMN failure_code TEXT;
CREATE TABLE assistant_events(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX idx_assistant_events_user_seq ON assistant_events(user_id,seq);
CREATE TABLE assistant_metrics(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT,
  surface TEXT, tool TEXT, mode TEXT, status TEXT, kind TEXT,
  latency_ms INTEGER, credits INTEGER DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_assistant_metrics_created ON assistant_metrics(created_at);
CREATE INDEX idx_assistant_metrics_tool ON assistant_metrics(tool,created_at);
-- 历史消息按会话创建顺序回填连续 seq；result 角色与内容原样保留。
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at,rowid) AS seq
  FROM chat_messages
)
UPDATE chat_messages SET seq=(SELECT seq FROM ordered WHERE ordered.id=chat_messages.id)
WHERE seq IS NULL;
UPDATE chat_sessions SET updated_at=created_at WHERE updated_at IS NULL;
UPDATE chat_tickets SET expires_at=ttl_expire_at WHERE expires_at IS NULL;
CREATE UNIQUE INDEX idx_chat_messages_session_seq ON chat_messages(session_id,seq);
CREATE UNIQUE INDEX idx_chat_messages_client_idem ON chat_messages(session_id,client_msg_id)
WHERE client_msg_id IS NOT NULL;
CREATE INDEX idx_chat_tickets_assistant_user ON chat_tickets(user_id,scope,created_at);
`,
  },
  {
    // v13 · MV 助手票据关联会话与任务，支持预算预留/失败释放的精确账本
    version: 13,
    sql: `
ALTER TABLE mv_tickets ADD COLUMN session_id TEXT;
ALTER TABLE mv_tickets ADD COLUMN job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_mv_tickets_session ON mv_tickets(session_id, status);
CREATE INDEX IF NOT EXISTS idx_mv_tickets_job ON mv_tickets(job_id);
`,
  },
  {
    // v14 · 定脸方案点（方案一 I2V 首帧为默认，2026-11-26）：
    //   mv_characters.cast_method（每角色独立）+ mv_projects.cast_method（项目级覆盖/继承基线）
    version: 14,
    sql: `
ALTER TABLE mv_projects ADD COLUMN cast_method TEXT DEFAULT 'i2v_first_frame';
ALTER TABLE mv_characters ADD COLUMN cast_method TEXT DEFAULT 'i2v_first_frame';
`,
  },
  {
    // v15 · 抢救 P0-3（2026-11-26）：管理员令牌加过期（此前 admin token 明文单列且永不过期）
    version: 15,
    sql: `
ALTER TABLE admins ADD COLUMN token_expire_at TEXT;
`,
  },
];

// 迁移容忍执行（抢救计划 P1-5「幂等 ALTER」）：历史库/半成品库升级到最新时，表或列常常**已经存在**
// （旧实现直接抛 duplicate column / already exists，整套升级卡死，也就没人敢从旧库升）。
// 策略：快路径整段执行；只有整段失败时才逐条重试，跳过"重复"类错误，其余错误照抛。
let migrationSkips = 0;
function getMigrationSkips() { return migrationSkips; }
function execMigrationSql(conn, sql) {
  try { conn.exec(sql); return; }
  catch (e) {
    for (const frag of String(sql).split(/;\s*(?:\n|$)/)) {
      const one = frag.trim();
      if (!one) continue;
      try { conn.exec(one + ';'); }
      catch (e2) {
        const msg = String((e2 && e2.message) || e2);
        if (/duplicate column name|already exists/i.test(msg)) { migrationSkips++; continue; }
        throw new Error('迁移语句失败：' + one.slice(0, 70) + ' … ' + msg);
      }
    }
  }
}

// 只升到指定版本（升级演练用：先造历史库，再用正常 init() 升到最新）
function initTo(maxVersion) {
  if (db) return db;
  return openDb(maxVersion);
}
// 正常入口：升到最新
function init() { return openDb(); }
function openDb(maxVersion) {
  if (db) return db; // 守卫必须在 openDb 内：init() 被每个请求调用，绝不能每次新建连接
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
    if (maxVersion != null && m.version > maxVersion) break; // 演练用：只升到历史版本
    db.exec('BEGIN');
    try {
      execMigrationSql(db, m.sql);
      if (ver === 0) db.prepare('INSERT INTO schema_version VALUES(?)').run(m.version);
      else db.prepare('UPDATE schema_version SET version=?').run(m.version);
      db.exec('COMMIT');
      ver = m.version;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
      throw new Error('迁移 v' + m.version + ' 失败：' + ((e && e.message) || e));
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
// 提交后副作用队列（outbox）：WSS 推送、通知等**必须在 COMMIT 之后**才发生。
// 旧写法把 bus.creditDelta 直接写在事务里 —— 事务里任何一步崩了，客户端已经收到"扣了钱"的推送，
// 账本却没写（或反之）。这正是"客户端显示扣款成功但余额没变"这类投诉的结构性成因。
const outbox = [];
function flushOutbox() {
  while (outbox.length) {
    const f = outbox.shift();
    try { f(); } catch (e) { logAuditFailure('outbox', e); }
  }
}
// 事务内注册"提交后再做"；不在事务内则立即执行。回滚时按层丢弃，绝不把已回滚的变更推出去。
function onCommit(fn) {
  if (typeof fn !== 'function') return;
  if (txDepth > 0) outbox.push(fn);
  else { try { fn(); } catch (e) { logAuditFailure('outbox', e); } }
}
function assertNotThenable(r) {
  if (r && typeof r.then === 'function') {
    throw new Error('store.tx() 回调不得返回 Promise：COMMIT 会早于异步业务写，账本将失去原子性（改用同步回调）');
  }
}
function tx(fn) {
  init();
  if (txDepth > 0) { const r = fn(); assertNotThenable(r); return r; } // 可重入
  txDepth++;
  const outboxBase = outbox.length;
  db.exec('BEGIN');
  try {
    const r = fn();
    assertNotThenable(r);
    db.exec('COMMIT');
    flushOutbox();
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已回滚 */ }
    outbox.length = outboxBase; // 回滚层内注册的提交后副作用一并丢弃
    throw e;
  } finally {
    txDepth--;
  }
}

// 审计钩子：所有写接口留痕（剧场 audit 范式）
// 旧写法 catch(e){} 静默吞异常 —— 审计可以无声全丢而无人知晓（抢救计划 P1「审计可无声丢失」）。
// 现在：计数 + 落盘兜底 + /healthz 暴露，运维至少能看见「审计在掉」。
let auditFailures = 0;
let auditFallbackPath = null;
function logAuditFailure(kind, e) {
  auditFailures++;
  try {
    if (!auditFallbackPath) {
      const dir = path.join(path.dirname(config.paths.db), 'logs'); // 与 DB 同目录，崩溃现场好找
      fs.mkdirSync(dir, { recursive: true });
      auditFallbackPath = path.join(dir, 'audit-fallback.log');
    }
    fs.appendFileSync(auditFallbackPath, U.nowIso() + ' ' + kind + ' ' + U.jstr({ err: (e && e.message) || String(e) }) + '\n');
  } catch (e2) { /* 兜底也写不进时只能靠计数 */ }
}
function getAuditFailures() { return auditFailures; }
function log(kind, obj) {
  try {
    run('INSERT INTO audit(id,kind,obj,created_at) VALUES(?,?,?,?)', U.uid('a_'), String(kind), U.jstr(obj), U.nowIso());
  } catch (e) { logAuditFailure('audit:' + kind, e); }
}

// —— 积分账本原语：复式记账，不变量 Σdelta == balance（= 末条 balance_after）——
function getBalance(userId) {
  const row = get('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', userId);
  return row ? row.balance_after : 0;
}
function lastLedger(userId) {
  return get('SELECT * FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', userId);
}
// 账目是否已存在（退款查重）。旧写法把幂等责任推给调用方（credits.refund 注释「幂等由调用方保证」），
// 而 cancel 与 job fail 两条通道各自"以为自己只退一次" —— 双退就是这么来的。
function hasLedgerEntry(userId, reason, refType, refId) {
  if (!refId) return false;
  return !!get('SELECT id FROM credit_ledger WHERE user_id=? AND reason=? AND ref_type=? AND ref_id=? LIMIT 1',
    userId, String(reason || ''), String(refType || ''), String(refId));
}
// 幂等退款：已退过返回 null（调用方据此不再推余额），否则返回新 balance_after。应在 tx 内调用。
function refundOnce(userId, amount, refType, refId) {
  const amt = Math.max(0, Math.trunc(Number(amount) || 0));
  if (!amt) return null;
  const last = lastLedger(userId); // 快路径：最常见的是同一条退款被立刻重放
  if (last && last.reason === 'refund' && String(last.ref_type) === String(refType || '') && String(last.ref_id) === String(refId || '')) return null;
  if (hasLedgerEntry(userId, 'refund', refType, refId)) return null;
  return appendLedger(userId, amt, 'refund', refType, refId);
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
    // 诚实化（v11）：用户到底说了什么 / 这次理解是不是词典兜底出来的。
    // 语音=转写逐字，文本=用户原文，图片=画面理解摘要；拿不到就 null，前端不许编。
    source_text: r.source_text == null ? null : String(r.source_text),
    degraded: r.degraded ? 1 : 0,
    created_at: r.created_at,
  };
}
function publicUrl(rel) {
  if (!rel) return null;
  if (/^https?:\/\//i.test(rel)) return rel;
  return config.publicBaseUrl.replace(/\/$/, '') + '/f/' + String(rel).replace(/^\/+/, '');
}

module.exports = {
  init, initTo, db: () => init(), run, get, all, tx, log, norm, getMigrationSkips,
  getBalance, lastLedger, appendLedger, hasLedgerEntry, refundOnce, onCommit, getAuditFailures,
  getPref, setPref, allPrefs,
  workOf, candidateOf, intentOf, publicUrl,
  CAST_METHODS, CAST_METHOD_DEFAULT,
};
