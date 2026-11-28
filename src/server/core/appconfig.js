// 运营配置中心（2026-11-24）：定价/版本策略/公告/审核开关 = app_config 快照（改即生效、可回滚）；
// 功能开关+灰度 = feature_flags。空表时以 config.js 为默认种子，保证零配置也能跑。
'use strict';
const config = require('../config');
const store = require('./store');
const U = require('./util');

// 功能开关键位（mv 灰度、dsp、persona、助手对话、音乐助手（契约 v3.1））
const FLAG_KEYS = ['mv', 'dsp', 'persona', 'assistant_chat', 'music_assistant', 'assistant_chat_music', 'assistant_core', 'assistant_actions',
  // 伴创（契约 v5.5）：默认全关，随 P7 灰度开。createAgentMode 关时第 4 档位整个隐藏且 /v1/agent/* 一律 404
  'createAgentMode', 'agentWebSearch',
  // 复刻（契约 v5.7）：风格画像档。默认关 gray 0，模式照 v5.5.2 —— 关时 /v1/replica/* 一律 404、创建页第 4 档不出现
  'replicaMode'];

// 默认快照：取自 config.js（现网实值），运营后台改后写入 app_config
function defaultBlob() {
  return {
    credits: {
      daily_free: config.credits.daily_free,
      per_candidate: config.credits.per_candidate,
      adjust: config.credits.adjust,
      extend: config.credits.extend,
      cover: config.credits.cover,
      dsp: config.credits.dsp,
      mv: Object.assign({}, config.mv.credits),
    },
    version_policy: {
      update_mode: 'none',            // none | recommended | required
      min_supported: null,            // 低于此版本：required 禁用核心功能 / recommended 提示
      recommended: null,              // 建议升级版本
      download_url: null,
      check_interval_sec: 3600,
    },
    announcement: { visible: false, text: '', style: 'notice' }, // notice | warn | maint
    moderation_enabled: true,
  };
}

let _cache = null; // {version, blob}

function currentVersion() {
  const r = store.get('SELECT MAX(version) v FROM app_config');
  return r && r.v ? Number(r.v) : 0;
}

// 读当前快照（内存缓存；save 后失效）
function current() {
  if (_cache) return _cache;
  const v = currentVersion();
  if (!v) {
    _cache = { version: 0, blob: defaultBlob() }; // 未落库：返回默认（不落库，首次保存才固化）
    return _cache;
  }
  const row = store.get('SELECT * FROM app_config WHERE version=?', v);
  _cache = { version: v, blob: Object.assign(defaultBlob(), U.jparse(row.blob, {}) || {}) };
  return _cache;
}

function credits() { return current().blob.credits; }
function versionPolicy() { return current().blob.version_policy; }
function announcement() { return current().blob.announcement; }
function moderationEnabled() { return current().blob.moderation_enabled !== false; }

// 保存为新版本快照（留 ops_events，可回滚）
function save(patch, actor, reason) {
  const before = current();
  const next = deepMerge(structuredCloneSafe(before.blob), patch || {});
  const nv = currentVersion() + 1;
  const now = U.nowIso();
  store.run('INSERT INTO app_config(version,blob,changed_by,reason,created_at) VALUES(?,?,?,?,?)',
    nv, U.jstr(next), String(actor || 'admin'), String(reason || ''), now);
  _cache = null;
  try {
    store.run('INSERT INTO ops_events(id,kind,actor,target,before,after,created_at) VALUES(?,?,?,?,?,?,?)',
      U.uid('oe_'), 'config.save', String(actor || 'admin'), 'app_config',
      U.jstr({ version: before.version, blob: before.blob }), U.jstr({ version: nv, blob: next }), now);
  } catch (e) { /* 事件失败不阻断 */ }
  store.log('appconfig.save', { version: nv, by: actor, reason });
  return { version: nv, blob: next };
}

// 回滚：把历史版本作为新版本再应用（历史链保留，可追溯）
function rollback(version, actor) {
  const row = store.get('SELECT * FROM app_config WHERE version=?', version);
  if (!row) throw new U.ApiError('NOT_FOUND', '配置版本不存在：' + version);  // 少写 new 会抛 TypeError → 被兜底成 500（契约要求 404）
  return save(U.jparse(row.blob, {}) || {}, actor, 'rollback to v' + version);
}

function history(limit) {
  return store.all('SELECT version,changed_by,reason,created_at FROM app_config ORDER BY version DESC LIMIT ?',
    U.clamp(Number(limit) || 20, 1, 200));
}

// —— 功能开关 + 灰度 ——
function initDefaults() {
  const now = U.nowIso();
  for (const k of FLAG_KEYS) {
    const ex = store.get('SELECT key FROM feature_flags WHERE key=?', k);
    if (ex) continue;
    let on = 0, gray = 0;
    if (k === 'mv') { on = config.mv.enabled ? 1 : 0; gray = 1; }
    if (k === 'assistant_chat') { on = config.mv.assistant.chat.enabled ? 1 : 0; gray = config.mv.assistant.chat.grayscale || 0; }
    if (k === 'dsp' || k === 'persona') { on = 1; gray = 1; }
    // 音乐助手（契约 v3.1）：总闸开关 music_assistant（默认关）；LLM 增强灰度 assistant_chat_music（默认关，灰度 0.2）
    if (k === 'music_assistant') { on = config.music.assistant.enabled ? 1 : 0; gray = 1; }
    if (k === 'assistant_chat_music') { on = config.music.assistant.chat.enabled ? 1 : 0; gray = config.music.assistant.chat.grayscale || 0; }
    // 统一助手（契约 v4.0）：核心默认全量开启，跨域付费动作默认关闭。
    if (k === 'assistant_core') { on = 1; gray = 1; }
    if (k === 'assistant_actions') { on = 0; gray = 0; }
    // 伴创两兄弟默认关：契约 v5.5 的灰度节奏是「先补闸门，再随伴创一起开」（D-7）
    if (k === 'createAgentMode' || k === 'agentWebSearch') { on = 0; gray = 0; }
    // 复刻（契约 v5.7.2）：同 fail-closed 模式，运营显式开了才出现在创建页
    if (k === 'replicaMode') { on = 0; gray = 0; }
    store.run('INSERT OR IGNORE INTO feature_flags(key,enabled,grayscale,created_at,updated_at) VALUES(?,?,?,?,?)', k, on, gray, now, now);
  }
}

function flag(key) {
  const r = store.get('SELECT * FROM feature_flags WHERE key=?', String(key));
  return r ? { key: String(key), enabled: !!r.enabled, grayscale: Number(r.grayscale) || 0 } : { key: String(key), enabled: false, grayscale: 0 };
}

function flagsAll() { return FLAG_KEYS.map(flag); }

// 灰度判定：enabled 且（userId 哈希桶 < grayscale）；无 userId 时按 grayscale>=1 才开
function featureOn(key, userId) {
  const f = flag(key);
  if (!f.enabled) return false;
  if (f.grayscale >= 1) return true;
  if (f.grayscale <= 0) return false;
  if (!userId) return false;
  const bucket = parseInt(U.sha256hex(String(userId) + ':' + key).slice(0, 8), 16) / 0xffffffff;
  return bucket < f.grayscale;
}

function setFlag(key, patch, actor) {
  if (!FLAG_KEYS.includes(String(key))) throw new U.ApiError('BAD_REQUEST', '未知功能开关：' + key);  // 同上：契约要求 400
  const before = flag(key);
  const now = U.nowIso();
  const enabled = patch.enabled === undefined ? store.norm(before.enabled) : store.norm(!!patch.enabled);
  const grayscale = patch.grayscale === undefined ? before.grayscale : U.clamp(Number(patch.grayscale), 0, 1);
  const ex = store.get('SELECT key FROM feature_flags WHERE key=?', String(key));
  if (ex) store.run('UPDATE feature_flags SET enabled=?, grayscale=?, updated_at=? WHERE key=?', enabled, grayscale, now, String(key));
  else store.run('INSERT INTO feature_flags(key,enabled,grayscale,created_at,updated_at) VALUES(?,?,?,?,?)', String(key), enabled, grayscale, now, now);
  try {
    store.run('INSERT INTO ops_events(id,kind,actor,target,before,after,created_at) VALUES(?,?,?,?,?,?,?)',
      U.uid('oe_'), 'feature.set', String(actor || 'admin'), String(key), U.jstr(before), U.jstr({ enabled: !!enabled, grayscale }), now);
  } catch (e) { /* ignore */ }
  store.log('feature.set', { key, enabled: !!enabled, grayscale, by: actor });
  return { key: String(key), enabled: !!enabled, grayscale };
}

function opsEvents(kind, limit) {
  let sql = 'SELECT * FROM ops_events WHERE 1=1'; const p = [];
  if (kind) { sql += ' AND kind=?'; p.push(String(kind)); }
  sql += ' ORDER BY rowid DESC LIMIT ?'; p.push(U.clamp(Number(limit) || 50, 1, 500));
  return store.all(sql, ...p);
}

// —— 工具 ——
function deepMerge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}
function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = {
  FLAG_KEYS, defaultBlob, current, currentVersion, save, rollback, history,
  credits, versionPolicy, announcement, moderationEnabled,
  initDefaults, flag, flagsAll, featureOn, setFlag, opsEvents,
};
