// 服务入口：:7900 HTTP 迷你路由 + JSON/limit + /f/* 静态 + /ws 手写最小 RFC6455 + /healthz（2026-11-23）
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const config = require('./config');
const store = require('./core/store');
const bus = require('./core/bus');
const engine = require('./core/engine');
const util = require('./core/util');
const auth = require('./api/auth');
const creditsApi = require('./api/credits');
const worksApi = require('./api/works');
const intentApi = require('./api/intent');
const personasApi = require('./api/personas');
const executorApi = require('./api/executor');
const mvApi = require('./api/mv');
const musicAssistantApi = require('./api/music_assistant');
const assistantApi = require('./api/assistant');
const adminAuth = require('./api/admin');
const modelnodesApi = require('./api/modelnodes');
const appconfigApi = require('./api/appconfig');
const adminOpsApi = require('./api/admin_ops');

const U = util;

// —— 迷你路由表：/v1/works/:id/adopt 形式，字面段多者优先 ——
const routes = [];
function addRoute(m, p, h, opts) {
  const names = [];
  const regexSrc = '^' + p.split('/').map(seg => {
    if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/') + '$';
  routes.push({ m, re: new RegExp(regexSrc), names, h, literal: p.split('/').filter(s => s && !s.startsWith(':')).length, opts: opts || {} });
}
for (const mod of [auth, creditsApi, worksApi, intentApi, personasApi, executorApi, mvApi, musicAssistantApi, assistantApi, adminAuth, modelnodesApi, appconfigApi, adminOpsApi]) {
  for (const r of mod.routes) addRoute(r.m, r.p, r.h, r);
}
routes.sort((a, b) => b.literal - a.literal);

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.json': 'application/json; charset=utf-8', '.peaks.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj === undefined ? {} : obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// —— /f/* 公共静态（文件名为不可猜 id；生产由 Nginx 接管）——
function serveFile(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/f\//, ''));
  if (rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]/).some(s => s === '..')) {
    return sendJson(res, 400, { code: 'BAD_REQUEST', message: '路径无效' });
  }
  const abs = path.join(config.paths.out, rel);
  if (!abs.startsWith(path.resolve(config.paths.out) + path.sep)) return sendJson(res, 400, { code: 'BAD_REQUEST', message: '路径无效' });
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { code: 'NOT_FOUND', message: '文件不存在' });
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'public, max-age=31536000, immutable' });
    fs.createReadStream(abs).pipe(res);
  });
}

// —— 运营控制台单文件页面（/admin；无构建 vanilla SPA，禁缓存便于迭代）——
const ADMIN_HTML = path.join(__dirname, 'admin', 'index.html');
function serveAdminConsole(res) {
  fs.readFile(ADMIN_HTML, (err, buf) => {
    if (err) return sendJson(res, 404, { code: 'NOT_FOUND', message: '控制台页面缺失' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store, max-age=0' });
    res.end(buf);
  });
}

// —— 主请求处理 ——
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const urlPath = u.pathname;
  if (req.method === 'GET' && urlPath === '/healthz') {
    // audit_failures：审计写入失败计数（抢救 P1-2）。审计曾静默吞异常，运维无从得知"审计在掉"。
  // audit_failures：审计写入失败计数；credit_violations：账本 Σdelta==balance 巡检破损次数（抢救 P1-2 可见性门票）
  const body = { ok: true, ts: U.nowIso(), online: bus.onlineCount(),
    audit_failures: store.getAuditFailures(), credit_violations: engine.getCreditViolations() };
    // mv_metrics（契约 v2.18 / N1-5，架构 §11 最小可观测集）：mv 灰度开启时附 lane 耗时直方 + 队列深度
    if (config.mv.enabled) {
      try { body.mv_metrics = require('./core/metrics').snapshot(); } catch (e) { /* 观测不阻断健康检查 */ }
    }
    return sendJson(res, 200, body);
  }
  if (req.method === 'GET' && urlPath.startsWith('/f/')) return serveFile(req, res, urlPath);
  if (req.method === 'GET' && (urlPath === '/admin' || urlPath === '/admin/')) return serveAdminConsole(res);

  const route = routes.find(r => r.m === req.method && r.re.test(urlPath));
  if (!route) return sendJson(res, 404, { code: 'NOT_FOUND', message: '接口不存在' });

  const maxBytes = (route.opts.limitMb || (config.engine.bodyLimitBytes / 1024 / 1024)) * 1024 * 1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) return sendJson(res, 400, { code: 'BAD_REQUEST', message: `请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）` });
  const raw = await readBody(req, maxBytes);
  if (raw === null) return sendJson(res, 400, { code: 'BAD_REQUEST', message: `请求体过大（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）` });

  let body = {};
  const ct = String(req.headers['content-type'] || '');
  if (!route.opts.raw && raw.length) {
    if (/json/i.test(ct) || raw[0] === 0x7b || raw[0] === 0x5b) {
      try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return sendJson(res, 400, { code: 'BAD_REQUEST', message: '请求体不是合法 JSON' }); }
    }
  }
  const mm = route.re.exec(urlPath);
  const params = {};
  route.names.forEach((n, i) => { params[n] = decodeURIComponent(mm[i + 1]); });
  const query = Object.fromEntries(u.searchParams.entries());
  const ctx = {
    req, res, params, query, body, raw, headers: req.headers,
    ip: String(req.headers['x-real-ip'] || req.socket.remoteAddress || ''),
    requireUser: () => auth.requireUser(ctx),
  };
  const out = await route.h(ctx);
  if (out && typeof out.status === 'number') sendJson(res, out.status, out.body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) { aborted = true; resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
  });
}

// —— 手写最小 RFC6455：SHA1+base64 accept，服务端发文本帧，解析掩码帧，close/ping-pong ——
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsAccept(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}
function wsEncodeFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x81; // FIN + text
  return Buffer.concat([head, data]);
}
function handleUpgrade(req, socket) {
  const u = new URL(req.url, 'http://localhost');
  if (!u.pathname.startsWith('/ws')) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key || !/websocket/i.test(String(req.headers.upgrade || ''))) { socket.destroy(); return; }
  const token = u.searchParams.get('token') || '';
  const fakeCtx = { headers: { authorization: 'Bearer ' + token } };
  const user = auth.userFromRequest(fakeCtx);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  socket.setNoDelay(true);

  const conn = {
    send(obj) { socket.write(wsEncodeFrame(JSON.stringify(obj))); },
    close() { try { socket.write(Buffer.from([0x88, 0x00])); } catch (e) {} socket.destroy(); },
  };
  const detach = bus.attach(user.id, conn);

  // 客户端帧解析：必须掩码；支持分片续帧；close/ping 处理
  let buf = Buffer.alloc(0);
  let fragOpcode = 0; let frags = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 1024 * 1024) { conn.close(); return; }
      if (!masked) { conn.close(); return; } // 客户端帧必须掩码
      if (buf.length < off + 4 + len) return;
      const mask = buf.slice(off, off + 4); off += 4;
      const payload = Buffer.from(buf.slice(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.slice(off + len);
      if (opcode === 0x8) { conn.close(); return; }               // close
      if (opcode === 0x9) {                                        // ping → pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        try { socket.write(pong); } catch (e) {}
        continue;
      }
      if (opcode === 0xa) continue;                                // pong
      if (opcode === 0x1 || opcode === 0x2) { fragOpcode = opcode; frags = [payload]; }
      else if (opcode === 0x0 && frags.length) frags.push(payload);
      if (fin && frags.length) {
        const msg = Buffer.concat(frags).toString('utf8');
        frags = []; fragOpcode = 0;
        try {
          const obj = JSON.parse(msg);
          if (obj && obj.type === 'ping') conn.send({ type: 'pong', ts: U.nowIso() });
        } catch (e) { /* 非 JSON 客户端消息忽略 */ }
      }
    }
  });
  const cleanup = () => detach();
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('end', cleanup);
}

// —— 启动 ——
function main() {
  // 抢救 P0-3：启动前安全审计。MB_ENV=prod 且存在不安全默认值 → 拒绝启动（退出码 2）。
  const SEC = require('./core/security');
  if (!SEC.assertBootable().ok) process.exit(2);
  store.init();
  // 模型节点/管理员种子（空表时写入默认，保证节点不写死且服务可启动）
  const modelnodes = require('./core/modelnodes');
  modelnodes.initDefaultNodes();
  require('./core/appconfig').initDefaults(); // 功能开关种子（mv/dsp/persona/assistant_chat）
  adminAuth.initDefaultAdmin();
  engine.start();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const code = err && err.name === 'ApiError' ? err.code : 'INTERNAL';
      const status = (err && err.httpStatus) || (err && err.name === 'ApiError' ? err.httpStatus : 500) || 500;
      const message = U.sanitizeEngineNames((err && err.message) || '服务开小差了，请稍后重试');
      if (!/UNAUTHORIZED|FORBIDDEN|NOT_FOUND|RATE_LIMITED/.test(code)) {
        console.error(new Date().toISOString(), 'ERROR', code, message, err && err.stack ? err.stack.split('\n')[1] : '');
      }
      try { sendJson(res, status >= 400 ? status : 500, { code, message }); } catch (e) {}
    });
  });
  server.on('upgrade', handleUpgrade);
  server.headersTimeout = 60000;
  server.requestTimeout = 120000; // long-poll 25s + LLM 20s*2 余量
  server.listen(config.port, config.bind, () => {
    console.log(new Date().toISOString(), `[MusicBox] 服务端已启动 http://${config.bind}:${config.port} ；产物 /f/* ；WSS /ws ；健康 /healthz`);
    if (config.bind !== '127.0.0.1' && config.bind !== 'localhost' && SEC.audit().length) {
      console.warn(new Date().toISOString(), `[security] 正在监听 ${config.bind}（非回环）且仍有 ${SEC.audit().length} 项开发默认值 ——`
        + ' 局域网内任意主机都能打到本服务，上线前请改绑 127.0.0.1 或置于反向代理之后');
    }
  });
  process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'FATAL', U.sanitizeEngineNames(e && e.message || String(e))));
  // 抢救 P1（此前无优雅退出）：SIGTERM/SIGINT 停止接新连接后退出；long-poll 会挂住连接，故加 500ms 强制兜底。
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(new Date().toISOString(), `[MusicBox] 收到 ${sig}，停止接收新连接`);
    try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) main();
module.exports = { main, handle, routes };
