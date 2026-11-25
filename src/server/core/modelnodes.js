// 模型节点管理（2026-11-24）：节点由后台配置，不再写死 config.js。
// 职责：空表种子（回退到 config.js/执行器默认）→ 运行时按 priority/weight 解析 → 分发给执行器与 APK。
'use strict';
const http = require('node:http');
const config = require('../config');
const store = require('./store');
const U = require('./util');

// 节点种类 = 服务端与执行器实际消费的端点维度（与 executor cfg 键一致）
const KINDS = ['music', 'asr', 'llm', 'comfy', 'lipsync', 'facegate', 'mv_asr'];

// 真实部署档案（来源：src/server/config.js、src/executor/index.js、deploy/spark/*）
// label/note 供运营后台辨识"这是哪个真服务"，engine 为节点标识名（不对 APK 暴露）
const NODE_META = {
  music: { engine: 'ace-step-1.5', label: '音乐生成 · ACE-Step 1.5', note: 'Spark 本机独显（5060 Ti）常驻，:8190；环境变量 MB_MUSIC_URL' },
  asr: { engine: 'sensevoice', label: '语音识别 · SenseVoice', note: '一期既有服务，同机保持 :8191；环境变量 MB_ASR_URL' },
  llm: { engine: 'qwen38-fp4', label: 'LLM/VLM · 剧场托管 vLLM', note: 'OpenAI 兼容 /v1，只读复用零改动；模型名以 /models 返回为准（MB_LLM_VLM_URL / MB_LLM_VLM_MODEL）' },
  comfy: { engine: 'comfyui', label: '图像/视频 · 剧场 ComfyUI', note: '共宿主队列，只提交任务+只读观测（ADR-MV-4）；:8188，互扰超标切逃生口 :8288；MB_COMFY_URL' },
  lipsync: { engine: 'echomimicv3-flash', label: '口型重绘 · EchoMimicV3-Flash', note: 'MusicBox 自有 worker，懒加载 + 空闲 10min 释放；83xx 仅回环监听；MB_LIPSYNC_URL' },
  facegate: { engine: 'arcface-insightface', label: '身份门禁 · ArcFace', note: 'insightface onnx，CPU 常驻 ~2G；83xx 仅回环监听；MB_FACEGATE_URL' },
  mv_asr: { engine: 'sensevoice-ts', label: 'MV 时间戳对齐 · SenseVoice', note: 'funasr 独立进程（与 :8191 零改动并存），CPU 常驻 ~2G；MB_MV_ASR_URL' },
};

// 端点解析：优先环境变量（与执行器同源），保证真机按 /etc/musicbox/spark.env 播种真值；
// 无环境变量时用 config.js 开发默认，保证本机空库也能跑。
function envOr(name, fallback) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : fallback;
}

// 空表/失效时的回退默认（来自 config.js 与执行器环境变量默认），保证不重启也能跑
function defaults() {
  return {
    music: { engine: NODE_META.music.engine, endpoint: envOr('MB_MUSIC_URL', config.musicUrl) },
    asr: { engine: NODE_META.asr.engine, endpoint: envOr('MB_ASR_URL', config.senseVoiceUrl) },
    llm: { engine: envOr('MB_LLM_VLM_MODEL', config.llmVlmModel || NODE_META.llm.engine), endpoint: envOr('MB_LLM_VLM_URL', config.llmVlmUrl) },
    comfy: { engine: NODE_META.comfy.engine, endpoint: envOr('MB_COMFY_URL', config.mv.comfyBaseUrl) },
    lipsync: { engine: NODE_META.lipsync.engine, endpoint: envOr('MB_LIPSYNC_URL', 'http://127.0.0.1:8390') },
    facegate: { engine: NODE_META.facegate.engine, endpoint: envOr('MB_FACEGATE_URL', 'http://127.0.0.1:8395') },
    mv_asr: { engine: NODE_META.mv_asr.engine, endpoint: envOr('MB_MV_ASR_URL', 'http://127.0.0.1:8391') },
  };
}

// 空表时写入种子（幂等）：每个 kind 一条，node_id 按 kind 确定性命名（重启不重复），model_defaults 指向它、不锁定
let _seeded = false;
function initDefaultNodes() {
  if (_seeded) return;
  _seeded = true;
  const d = defaults();
  for (const kind of KINDS) {
    const id = 'mn_' + kind; // 确定性 id：重启不会重复插表
    const now = U.nowIso();
    const meta = NODE_META[kind];
    store.run(
      'INSERT OR IGNORE INTO model_nodes(id,kind,engine,endpoint,label,note,source,priority,weight,enabled,status,created_at,updated_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, kind, d[kind].engine, d[kind].endpoint, meta.label, meta.note, 'seed', 100, 1, 1, 'unknown', now, now, now);
    // 已存在的播种节点（按确定性 id 认定）：刷新档案（名称/说明/模型名），但保留运营改过的端点、优先级、权重、启停
    const cur = store.get('SELECT engine FROM model_nodes WHERE id=?', id);
    const placeholder = !cur || !cur.engine || cur.engine === kind || cur.engine === d[kind].engine;
    store.run(
      placeholder
        ? 'UPDATE model_nodes SET label=?, note=?, engine=?, source=?, updated_at=? WHERE id=?'
        : 'UPDATE model_nodes SET label=?, note=?, source=?, updated_at=? WHERE id=?',
      ...(placeholder ? [meta.label, meta.note, d[kind].engine, 'seed', now, id] : [meta.label, meta.note, 'seed', now, id]));
    // model_defaults 仅在该 kind 尚无默认时指向种子节点（保留运营已自定义的默认）
    const existingDef = store.get('SELECT node_id FROM model_defaults WHERE kind=?', kind);
    if (!existingDef || !existingDef.node_id) {
      store.run('INSERT OR IGNORE INTO model_defaults(kind,node_id,locked,created_at,updated_at) VALUES(?,?,0,?,?)', kind, id, now, now);
    }
  }
}

// 解析：优先返回默认节点（model_defaults）；默认节点不可用时，按 priority/weight 从可用节点中选；
// 仍无则回退 config 默认。保证"默认走向"被尊重，仅在故障/禁用时降级。
function resolveNode(kind) {
  const def = store.get('SELECT * FROM model_defaults WHERE kind=?', kind);
  if (def && def.node_id) {
    const n = store.get('SELECT * FROM model_nodes WHERE id=?', def.node_id);
    if (n && n.enabled && n.status !== 'unreachable') return n;
  }
  const rows = store.all("SELECT * FROM model_nodes WHERE kind=? AND enabled=1 AND status<>'unreachable' ORDER BY priority ASC", kind);
  if (rows.length) {
    const top = rows[0].priority;
    const group = rows.filter((r) => r.priority === top);
    if (group.length === 1) return group[0];
    const total = group.reduce((s, r) => s + (Number(r.weight) || 1), 0) || 1;
    let pick = Math.random() * total;
    for (const r of group) { pick -= (Number(r.weight) || 1); if (pick <= 0) return r; }
    return group[0];
  }
  const dd = defaults()[kind];
  return dd ? { id: null, kind, engine: dd.engine, endpoint: dd.endpoint, priority: 100, weight: 1, enabled: 1, status: 'fallback', is_default: 1 } : null;
}

// APK 自选模型 → 节点解析：selector 为 node_id 或 engine 名。
// 规则（"未设置则后端指定"）：默认走向 locked → 忽略 selector 强制默认；selector 空/非法 → 默认；否则取该可用节点。
function pickNodeForJob(kind, selector) {
  const def = defaultFor(kind);
  if (!selector || def.locked) return resolveNode(kind);
  let node = store.get("SELECT * FROM model_nodes WHERE id=? AND kind=? AND enabled=1 AND status<>'unreachable'", String(selector), kind);
  if (!node) node = store.get("SELECT * FROM model_nodes WHERE engine=? AND kind=? AND enabled=1 AND status<>'unreachable'", String(selector), kind);
  return node || resolveNode(kind);
}

// 给执行器的节点配置：{ music:{engine,endpoint,status}, ... }（供 executor 覆盖 cfg）
function nodesForExecutor() {
  const out = {};
  for (const kind of KINDS) {
    const r = resolveNode(kind);
    if (r && r.endpoint) out[kind] = { engine: r.engine, endpoint: r.endpoint, status: r.status || 'unknown' };
  }
  return out;
}

// 给 APK 的默认走向：仅暴露 APK 生成会用的维度（music/llm/mv(comfy)），含 locked
function routingForApp() {
  const out = {};
  const map = { music: 'music', llm: 'llm', mv: 'comfy' };
  for (const appKey of Object.keys(map)) {
    const kind = map[appKey];
    const def = defaultFor(kind);
    out[appKey] = { engine: def.engine, locked: !!def.locked, node_id: def.node_id || null };
  }
  return out;
}

// 某 kind 的默认走向详情（node_id → engine，含 locked）
function defaultFor(kind) {
  const row = store.get('SELECT * FROM model_defaults WHERE kind=?', kind);
  if (row && row.node_id) {
    const node = store.get('SELECT * FROM model_nodes WHERE id=?', row.node_id);
    if (node) return { kind, node_id: node.id, engine: node.engine, endpoint: node.endpoint, locked: !!row.locked };
  }
  const def = defaults()[kind];
  return { kind, node_id: null, engine: def ? def.engine : kind, endpoint: def ? def.endpoint : null, locked: false };
}

// 探测节点健康：引擎服务多不服务 "/"（ACE-Step/uvicorn 根路径常为 404），故按候选路径探测并三态判读
const PROBE_PATHS = ['/health', '/healthz', '/models', '/'];
async function probeNode(id) {
  const node = store.get('SELECT * FROM model_nodes WHERE id=?', id);
  if (!node) return { found: false };
  const r = await httpProbe(node.endpoint);
  store.run('UPDATE model_nodes SET status=?, last_probe_at=?, last_probe_msg=?, updated_at=? WHERE id=?',
    r.status, U.nowIso(), r.msg, U.nowIso(), id);
  return { found: true, id: node.id, engine: node.engine, endpoint: node.endpoint, healthy: r.status === 'healthy', status: r.status, msg: r.msg, probed_at: U.nowIso() };
}

// 全量探测（后台"全部探测"按钮）：返回每个节点的结论，便于一次看清真机拓扑是否通
async function probeAll() {
  const rows = store.all('SELECT id FROM model_nodes ORDER BY kind ASC, priority ASC');
  const items = [];
  for (const r of rows) items.push(await probeNode(r.id));
  return { total: items.length, healthy: items.filter(i => i.status === 'healthy').length, reachable: items.filter(i => i.status !== 'unreachable').length, items };
}

// 全量健康快照（含是否过期：>30s 未更新视为 stale）
function healthSnapshot() {
  const now = Date.now();
  return KINDS.map((kind) => {
    const row = store.get('SELECT * FROM model_nodes WHERE kind=? ORDER BY priority ASC, rowid ASC', kind);
    const def = defaultFor(kind);
    let status = 'unknown', lastProbe = null;
    if (row) { status = row.status || 'unknown'; lastProbe = row.last_probe_at; }
    let stale = false;
    if (lastProbe) stale = !Number.isFinite(Date.parse(lastProbe)) || (now - Date.parse(lastProbe)) > 30000;
    return { kind, node: row ? {
      id: row.id, engine: row.engine, endpoint: row.endpoint, label: row.label || null, note: row.note || null,
      source: row.source || 'manual', priority: row.priority, weight: row.weight, enabled: !!row.enabled,
      status: row.status, last_probe_at: row.last_probe_at || null, last_probe_msg: row.last_probe_msg || null,
    } : null, default: { node_id: def.node_id, engine: def.engine, locked: def.locked }, stale };
  });
}

// 单次 GET：{kind:'ok'|'http'|'net', code, body}。只读少量 JSON，禁止把健康探测变成大数据下载。
function httpOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const once = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes <= 65536) chunks.push(c);
          else res.destroy();
        });
        res.on('error', () => once({ kind: 'net', code: '健康响应读取失败' }));
        res.on('end', () => once({
          kind: res.statusCode >= 200 && res.statusCode < 400 ? 'ok' : 'http',
          code: res.statusCode, body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => once({ kind: 'net', code: (e && (e.code || e.message)) || '网络错误' }));
    } catch (e) { once({ kind: 'net', code: (e && e.message) || '探测异常' }); }
  });
}

// 健康 JSON 的诚实判读：scaffold 或任一权重/参考模型未就绪均为 degraded，不能冒充 healthy。
function readinessOf(body) {
  let json = null;
  try { json = JSON.parse(body); } catch (e) { return { valid: false, ready: true, reason: '' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { valid: false, ready: true, reason: '' };
  const fields = ['model_loaded', 'weights_ready', 'ref_loaded'];
  const bad = [];
  if (json.scaffold === true || json.scaffold === 1 || json.scaffold === '1') bad.push('scaffold');
  for (const k of fields) {
    if (Object.prototype.hasOwnProperty.call(json, k) && (json[k] === false || json[k] === 0 || json[k] === '0' || json[k] === 'false')) bad.push(k);
  }
  return { valid: true, ready: bad.length === 0, reason: bad.join(',') };
}

// 三态：healthy（有效健康 JSON 或模型清单就绪）/ degraded（端口通但健康未就绪/无健康路由）/ unreachable。
// 保留既有兼容语义：仅业务端口可达、无健康路由时判 degraded，而非 unreachable。
async function httpProbe(base) {
  let root = String(base || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) return { status: 'unreachable', msg: '非法地址：' + (base || '(空)') };
  let sawHttp = null, sawNet = null;
  for (const p of PROBE_PATHS) {
    const r = await httpOnce(root + p, 3000);
    if (r.kind === 'ok') {
      if (p === '/models') {
        let json = null; try { json = JSON.parse(r.body); } catch (e) { /* 非 JSON 不算就绪 */ }
        if (json && Array.isArray(json.data) && json.data.length > 0) return { status: 'healthy', msg: 'HTTP ' + r.code + ' /models' };
      } else {
        const ready = readinessOf(r.body);
        if (ready.valid && ready.ready) return { status: 'healthy', msg: 'HTTP ' + r.code + ' ' + p };
        // 明确的健康 JSON 未就绪是硬结论，不能被后续 /models 清单覆盖成 healthy。
        if (ready.valid && !ready.ready) return { status: 'degraded', msg: '模型尚未就绪：' + ready.reason };
      }
      sawHttp = sawHttp || ('HTTP ' + r.code + ' ' + p);
    }
    if (r.kind === 'http' && !sawHttp) sawHttp = 'HTTP ' + r.code + ' ' + p;
    if (r.kind === 'net' && !sawNet) sawNet = String(r.code);
  }
  if (sawHttp) return { status: 'degraded', msg: sawHttp + '（端口可达，无有效健康路由）' };
  return { status: 'unreachable', msg: sawNet || '无应答' };
}

function httpGetOk(base) { return httpProbe(base).then(r => r.status === 'healthy'); }

module.exports = { KINDS, NODE_META, defaults, initDefaultNodes, resolveNode, pickNodeForJob, nodesForExecutor, routingForApp, defaultFor, probeNode, probeAll, healthSnapshot };
