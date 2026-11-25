// 模型节点运营后台（2026-11-24）：节点 CRUD / 默认走向+locked / 健康快照 / 手动探测。全部需管理员登录。
'use strict';
const store = require('../core/store');
const M = require('../core/modelnodes');
const auth = require('./admin');
const requireAdmin = auth.requireAdmin;
const U = require('../core/util');

const KINDS = M.KINDS;

function nodeView(r) {
  if (!r) return null;
  const def = store.get('SELECT * FROM model_defaults WHERE kind=?', r.kind);
  return {
    id: r.id, kind: r.kind, engine: r.engine, endpoint: r.endpoint,
    label: r.label || null, note: r.note || null, source: r.source || 'manual',
    priority: r.priority, weight: r.weight, enabled: !!r.enabled, status: r.status,
    last_probe_at: r.last_probe_at || null, last_probe_msg: r.last_probe_msg || null,
    last_seen: r.last_seen, created_at: r.created_at, updated_at: r.updated_at,
    is_default: def && def.node_id === r.id ? 1 : 0,
    locked: !!(def && def.locked),
  };
}

// GET /admin/model-nodes（列表，支持 ?kind=&enabled= 过滤 + limit/offset）
function list(ctx) {
  requireAdmin(ctx);
  let sql = 'SELECT * FROM model_nodes WHERE 1=1';
  const p = [];
  const k = ctx.query.kind; if (k) { sql += ' AND kind=?'; p.push(String(k)); }
  if (ctx.query.enabled !== undefined && ctx.query.enabled !== '') { sql += ' AND enabled=?'; p.push(store.norm(!!ctx.query.enabled)); }
  sql += ' ORDER BY kind ASC, priority ASC';
  const limit = U.clamp(Number(ctx.query.limit) || 100, 1, 1000);
  const offset = U.clamp(Number(ctx.query.offset) || 0, 0, 1 << 30);
  sql += ' LIMIT ? OFFSET ?'; p.push(limit, offset);
  const rows = store.all(sql, ...p).map(nodeView);
  const total = store.get('SELECT COUNT(*) c FROM model_nodes').c;
  return { status: 200, body: { items: rows, total } };
}

// POST /admin/model-nodes（新建）
function create(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  const kind = String(b.kind || '').trim();
  if (!KINDS.includes(kind)) throw new U.ApiError('BAD_REQUEST', `不支持的节点种类：${kind}（可选 ${KINDS.join(',')}）`);
  const endpoint = String(b.endpoint || '').trim();
  if (!/^https?:\/\//i.test(endpoint)) throw new U.ApiError('BAD_REQUEST', 'endpoint 需为 http(s) 地址');
  const engine = String(b.engine || kind).trim();
  const label = b.label ? String(b.label).trim().slice(0, 80) : null;
  const note = b.note ? String(b.note).trim().slice(0, 300) : null;
  const priority = U.clamp(Number(b.priority) || 100, 0, 100000);
  const weight = U.clamp(Number(b.weight) || 1, 0.01, 100000);
  const enabled = store.norm(b.enabled === undefined ? true : !!b.enabled);
  const id = U.uid('mn_');
  const now = U.nowIso();
  store.run('INSERT INTO model_nodes(id,kind,engine,endpoint,label,note,source,priority,weight,enabled,status,created_at,updated_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, kind, engine, endpoint, label, note, 'manual', priority, weight, enabled, 'unknown', now, now, now);
  // 若该 kind 尚无默认，则指向新建节点
  const existingDef = store.get('SELECT node_id FROM model_defaults WHERE kind=?', kind);
  if (!existingDef || !existingDef.node_id) {
    store.run('INSERT INTO model_defaults(kind,node_id,locked,created_at,updated_at) VALUES(?,?,0,?,?)', kind, id, now, now);
  }
  store.log('model_node.create', { id, kind, engine, endpoint });
  return { status: 201, body: nodeView(store.get('SELECT * FROM model_nodes WHERE id=?', id)) };
}

// PATCH /admin/model-nodes/:id（更新可写字段）
function update(ctx) {
  requireAdmin(ctx);
  const node = store.get('SELECT * FROM model_nodes WHERE id=?', ctx.params.id);
  if (!node) throw new U.ApiError('NOT_FOUND', '节点不存在');
  const b = ctx.body || {};
  const sets = []; const p = [];
  if (b.kind !== undefined) { const k = String(b.kind); if (!KINDS.includes(k)) throw new U.ApiError('BAD_REQUEST', `不支持的节点种类：${k}`); sets.push('kind=?'); p.push(k); }
  if (b.engine !== undefined) { sets.push('engine=?'); p.push(String(b.engine)); }
  if (b.endpoint !== undefined) { const e = String(b.endpoint); if (!/^https?:\/\//i.test(e)) throw new U.ApiError('BAD_REQUEST', 'endpoint 需为 http(s) 地址'); sets.push('endpoint=?'); p.push(e); }
  if (b.label !== undefined) { sets.push('label=?'); p.push(b.label == null ? null : String(b.label).trim().slice(0, 80)); }
  if (b.note !== undefined) { sets.push('note=?'); p.push(b.note == null ? null : String(b.note).trim().slice(0, 300)); }
  if (b.priority !== undefined) { sets.push('priority=?'); p.push(U.clamp(Number(b.priority), 0, 100000)); }
  if (b.weight !== undefined) { sets.push('weight=?'); p.push(U.clamp(Number(b.weight), 0.01, 100000)); }
  if (b.enabled !== undefined) { sets.push('enabled=?'); p.push(store.norm(!!b.enabled)); }
  if (!sets.length) throw new U.ApiError('BAD_REQUEST', '未提供任何可更新字段');
  sets.push('updated_at=?'); p.push(U.nowIso());
  p.push(ctx.params.id);
  store.run(`UPDATE model_nodes SET ${sets.join(',')} WHERE id=?`, ...p);
  store.log('model_node.update', { id: ctx.params.id, fields: sets.filter((s) => s.endsWith('?')).map((s) => s.replace('=?', '')) });
  return { status: 200, body: nodeView(store.get('SELECT * FROM model_nodes WHERE id=?', ctx.params.id)) };
}

// DELETE /admin/model-nodes/:id（删除后若默认指向它，则重绑到该 kind 首个可用节点）
function remove(ctx) {
  requireAdmin(ctx);
  const node = store.get('SELECT * FROM model_nodes WHERE id=?', ctx.params.id);
  if (!node) throw new U.ApiError('NOT_FOUND', '节点不存在');
  store.run('DELETE FROM model_nodes WHERE id=?', ctx.params.id);
  const def = store.get('SELECT * FROM model_defaults WHERE kind=? AND node_id=?', node.kind, ctx.params.id);
  if (def) {
    const repl = store.get('SELECT id FROM model_nodes WHERE kind=? AND enabled=1 ORDER BY priority ASC, rowid ASC LIMIT 1', node.kind);
    const target = repl ? repl.id : null;
    if (target) store.run('UPDATE model_defaults SET node_id=?, updated_at=? WHERE kind=?', target, U.nowIso(), node.kind);
    else { // 无可用节点：按部署档案重建一个种子节点作为默认
      const now = U.nowIso(); const nid = U.uid('mn_');
      const meta = M.NODE_META[node.kind] || {};
      store.run('INSERT INTO model_nodes(id,kind,engine,endpoint,label,note,source,priority,weight,enabled,status,created_at,updated_at,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        nid, node.kind, node.engine, node.endpoint, meta.label || null, meta.note || null, 'seed', 100, 1, 1, 'unknown', now, now, now);
      store.run('UPDATE model_defaults SET node_id=?, updated_at=? WHERE kind=?', nid, U.nowIso(), node.kind);
    }
  }
  store.log('model_node.delete', { id: ctx.params.id, kind: node.kind });
  return { status: 200, body: { ok: true } };
}

// GET /admin/model-nodes/health（健康快照）
function health(ctx) {
  requireAdmin(ctx);
  return { status: 200, body: { items: M.healthSnapshot() } };
}

// POST /admin/model-nodes/:id/probe（手动探测并回写 status）
async function probe(ctx) {
  requireAdmin(ctx);
  const r = await M.probeNode(ctx.params.id);
  if (!r.found) throw new U.ApiError('NOT_FOUND', '节点不存在');
  store.log('model_node.probe', { id: ctx.params.id, healthy: r.healthy });
  return { status: 200, body: r };
}

// POST /admin/model-nodes/probe-all（全量探测：一次看清真机拓扑连通性）
async function probeAllHandler(ctx) {
  requireAdmin(ctx);
  const r = await M.probeAll();
  store.log('model_node.probe_all', { total: r.total, healthy: r.healthy });
  return { status: 200, body: r };
}

// GET /admin/config/routing（默认走向详情，含 locked）
function getRouting(ctx) {
  requireAdmin(ctx);
  const out = {};
  for (const kind of KINDS) out[kind] = M.defaultFor(kind);
  return { status: 200, body: { items: out } };
}

// POST /admin/config/routing {kind:{node_id,locked}} 或 {routing:{...}}（设置默认节点+锁定）
function setRouting(ctx) {
  requireAdmin(ctx);
  const b = ctx.body || {};
  const map = b.routing || b;
  const changed = [];
  for (const kind of Object.keys(map)) {
    if (!KINDS.includes(kind)) throw new U.ApiError('BAD_REQUEST', `不支持的节点种类：${kind}`);
    const cfg = map[kind] || {};
    let nodeId = cfg.node_id || cfg.id || null;
    if (nodeId) {
      const node = store.get('SELECT id FROM model_nodes WHERE id=?', nodeId);
      if (!node) throw new U.ApiError('BAD_REQUEST', `节点不存在：${nodeId}`);
    }
    const locked = store.norm(!!cfg.locked);
    const now = U.nowIso();
    const existing = store.get('SELECT * FROM model_defaults WHERE kind=?', kind);
    if (existing) {
      store.run('UPDATE model_defaults SET node_id=?, locked=?, updated_at=? WHERE kind=?', nodeId || existing.node_id, locked, now, kind);
    } else {
      // 尚无默认：优先用传入节点，否则取该 kind 首个可用节点
      if (!nodeId) { const first = store.get('SELECT id FROM model_nodes WHERE kind=? AND enabled=1 ORDER BY priority ASC, rowid ASC LIMIT 1', kind); nodeId = first ? first.id : null; }
      if (!nodeId) throw new U.ApiError('BAD_REQUEST', `该种类暂无可用节点，请先创建`);
      store.run('INSERT INTO model_defaults(kind,node_id,locked,created_at,updated_at) VALUES(?,?,0,?,?)', kind, nodeId, locked, now, now);
    }
    changed.push(kind);
    store.log('model_routing.set', { kind, node_id: nodeId, locked });
  }
  if (!changed.length) throw new U.ApiError('BAD_REQUEST', '未提供任何节点配置');
  return { status: 200, body: { ok: true, changed } };
}

module.exports = {
  routes: [
    { m: 'GET', p: '/admin/model-nodes/health', h: health },
    { m: 'POST', p: '/admin/model-nodes/probe-all', h: probeAllHandler },
    { m: 'POST', p: '/admin/model-nodes/:id/probe', h: probe },
    { m: 'POST', p: '/admin/config/routing', h: setRouting },
    { m: 'PATCH', p: '/admin/model-nodes/:id', h: update },
    { m: 'DELETE', p: '/admin/model-nodes/:id', h: remove },
    { m: 'GET', p: '/admin/config/routing', h: getRouting },
    { m: 'POST', p: '/admin/model-nodes', h: create },
    { m: 'GET', p: '/admin/model-nodes', h: list },
  ],
};
