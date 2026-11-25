// ComfyUI 执行适配层 —— MusicBox 自有移植（剧场 adapters/comfy.js 协议范式，非跨仓引用）（2026-11-24）
// 纪律：
//  - 只提交固化模板（src/executor/templates/*.json），永不执行外部 workflow；
//  - tmpl_sha16 锁：manifest 登记的模板 hash 与磁盘文件不符＝拒跑（COMFY_TMPL_DRIFT）；
//  - 共宿主红线（架构 §1.2 / ADR-MV-4）：只发任务 + 只读观测（/system_stats、/queue），
//    本模块不提供 /free、/sd-reload 等任何干预/卸载端点，绝不杀死或卸载共宿主任务；
//  - 错误一律带 e.code + e.failCode + e.failMessage（执行器协议直接透传）；
//  - 快失败纪律：端点不可达必须**立刻**抛 COMFY_UNREACHABLE（连接失败不等满超时），严禁吊死。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('./net.js');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const DEFAULT_TIMEOUT_MS = 240000;
const POLL_MS = 1500;

// ---------- 错误工厂 ----------
function err(code, message) {
  const e = new Error(message);
  e.code = code;
  e.failCode = code;
  e.failMessage = message;
  return e;
}

function sha16(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// 产物扩展名：以真实字节魔数为准，文件名正则次之，两者皆无才 .bin。
// 根因：部分自定义节点（如 H3-Image 出图）history 回写的 filename 常丢扩展名，
// 只靠 filename 正则会误判成 .bin → 落盘 octet-stream，App/浏览器预览失效。
function sniffExt(bytes, filename) {
  const byName = (/\.(mp4|webm|mov|gif|png|jpg|jpeg|webp)$/i.exec(String(filename || '')) || ['', ''])[1].toLowerCase();
  let byMagic = '';
  if (bytes && bytes.length > 12) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) byMagic = 'png';
    else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) byMagic = 'jpg';
    else if (bytes.slice(0, 4).toString('ascii') === 'RIFF' && bytes.slice(8, 12).toString('ascii') === 'WEBP') byMagic = 'webp';
    else if (bytes.slice(0, 4).toString('ascii') === 'GIF8') byMagic = 'gif';
    else if (bytes.slice(4, 8).toString('ascii') === 'ftyp') byMagic = 'mp4';
  }
  const ext = byMagic || byName || 'bin';
  return '.' + ext;
}

// ---------- 模板加载与四元组锁 ----------
function loadManifest(tmplId) {
  const p = path.join(TEMPLATES_DIR, 'manifest.json');
  if (!fs.existsSync(p)) {
    throw err('COMFY_MANIFEST_MISSING', '模板清单缺失：' + p + '（先完成登记再启用真引擎）');
  }
  let m;
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    throw err('COMFY_MANIFEST_BAD', 'manifest.json 解析失败：' + e.message);
  }
  const entry = m.templates && m.templates[tmplId];
  if (!entry || !entry.tmpl_sha16) {
    throw err('COMFY_MANIFEST_NOENTRY', 'manifest 缺少模板条目 ' + tmplId);
  }
  return entry;
}

function loadTemplate(tmplId, entry) {
  const p = path.join(TEMPLATES_DIR, tmplId + '.json');
  if (!fs.existsSync(p)) throw err('COMFY_TMPL_MISSING', '固化模板不存在：' + p);
  const buf = fs.readFileSync(p);
  const normalized = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  if (sha16(normalized) !== entry.tmpl_sha16) {
    throw err('COMFY_TMPL_DRIFT', '模板 hash 与清单登记不符（' + tmplId + '）：禁止执行未登记的模板');
  }
  let wf;
  try { wf = JSON.parse(buf.toString('utf8')); } catch (e) {
    throw err('COMFY_TMPL_BAD', '模板 JSON 解析失败：' + e.message);
  }
  return wf;
}

// 占位替换：节点输入中 "<KEY>" 字符串整体替换为 values 值（数值转数字，其余转字符串）
function applyParams(wf, values) {
  const out = {};
  for (const [nid, node] of Object.entries(wf)) {
    const n = JSON.parse(JSON.stringify(node));
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (typeof v === 'string') {
        const m = /^<([A-Z0-9_]+)>$/.exec(v);
        if (m && Object.prototype.hasOwnProperty.call(values, m[1])) {
          const val = values[m[1]];
          n.inputs[k] = typeof val === 'number' ? val : String(val);
        }
      }
    }
    out[nid] = n;
  }
  return out;
}

// ---------- HTTP（零依赖，快失败） ----------
// 连不上（ECONNREFUSED/DNS 等 netCode='NET'）→ COMFY_UNREACHABLE（立刻）；超时 → COMFY_TIMEOUT。
async function httpJson(base, pathname, body, method, timeoutMs, errPrefix) {
  const opts = { timeoutMs: timeoutMs || 10000 };
  if (body !== undefined && body !== null) {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await net.request(method || (body !== undefined && body !== null ? 'POST' : 'GET'), base + pathname, opts);
  } catch (e) {
    if (e.netCode === 'TIMEOUT') throw err(errPrefix + '_TIMEOUT', '请求超时（' + (opts.timeoutMs) + 'ms）：' + base + pathname);
    throw err(errPrefix + '_UNREACHABLE', '服务不可达（' + base + '）：' + e.message);
  }
  const data = res.json();
  if (res.status < 200 || res.status >= 300) {
    const msg = (data && (data.error && data.error.message || data.error)) || res.body.toString('utf8').slice(0, 200);
    throw err(errPrefix + '_HTTP', base + pathname + ' → ' + res.status + '：' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
  }
  return data;
}

async function httpBytes(base, pathname, timeoutMs) {
  let res;
  try {
    res = await net.request('GET', base + pathname, { timeoutMs: timeoutMs || 60000 });
  } catch (e) {
    throw err('COMFY_FETCH_FAIL', '取产物失败：' + e.message);
  }
  if (res.status < 200 || res.status >= 300) throw err('COMFY_FETCH_HTTP', '取产物 HTTP ' + res.status + '：' + pathname);
  return res.body;
}

function comfyBase(cfg) {
  const url = (cfg && cfg.comfyUrl) || process.env.MB_COMFY_URL || 'http://127.0.0.1:8188';
  return String(url).replace(/\/+$/, '');
}

// ---------- 只读观测（共宿主纪律：永不 /free） ----------
async function getSystemStats(cfg) {
  return httpJson(comfyBase(cfg), '/system_stats', null, 'GET', 8000, 'COMFY');
}

// ram_free 观测（GB）——领单前水位判定只观测不干预（架构 §1.2）；返回 {ram_free_gb, ram_total_gb} | null
async function observeRamFree(cfg) {
  try {
    const s = await getSystemStats(cfg);
    if (!s || !s.system) return null;
    const free = Number(s.system.ram_free);
    if (!Number.isFinite(free)) return null;
    const total = Number(s.system.ram_total);
    return { ram_free_gb: free / 1024 ** 3, ram_total_gb: Number.isFinite(total) ? total / 1024 ** 3 : null };
  } catch (e) {
    return null; // 观测失败不阻塞主流程
  }
}

// 队列位次观测（只读）：返回 {queued, processing} | null
async function observeQueue(cfg) {
  try {
    const q = await httpJson(comfyBase(cfg), '/queue', null, 'GET', 8000, 'COMFY');
    return {
      queued: Array.isArray(q && q.queue_pending) ? q.queue_pending.length : 0,
      processing: Array.isArray(q && q.queue_running) ? q.queue_running.length : 0,
    };
  } catch (e) {
    return null;
  }
}

// 资产上传（垫图 → LoadImage 可用文件名）：唯一允许的写端点，不触碰他人任务
async function uploadAsset(cfg, bytes, filename) {
  const base = comfyBase(cfg);
  const name = String(filename || 'asset.png').replace(/[^\w.\-]/g, '_').slice(0, 64) || 'asset.png';
  const boundary = '----MusicBoxComfy' + crypto.randomBytes(10).toString('hex');
  const head = Buffer.from(
    '--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="' + name + '"\r\n' +
    'Content-Type: application/octet-stream\r\n\r\n', 'utf8');
  const tail = Buffer.from(
    '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--' + boundary + '--\r\n', 'utf8');
  let res;
  try {
    res = await net.request('POST', base + '/upload/image', {
      headers: { 'content-type': 'multipart/form-data; boundary=' + boundary },
      body: Buffer.concat([head, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), tail]),
      timeoutMs: 30000,
    });
  } catch (e) {
    if (e.netCode === 'TIMEOUT') throw err('COMFY_TIMEOUT', '上传垫图超时：' + e.message);
    throw err('COMFY_UNREACHABLE', 'ComfyUI 不可达（上传垫图）：' + e.message);
  }
  if (res.status < 200 || res.status >= 300) throw err('COMFY_HTTP', '上传垫图 HTTP ' + res.status);
  const data = res.json();
  if (!data || !data.name) throw err('COMFY_UPLOAD_BAD', '上传垫图未返回文件名');
  return data.subfolder ? data.subfolder + '/' + data.name : data.name;
}

// ---------- 主入口（唯一导出函数） ----------
// submitComfyJob({templateName, values, timeoutMs, cfg, jobId, log, onPoll})
//   → { bytes, ext, promptId, filename, entry, meta }（filename-anchored 语义同剧场：/view?filename=...）
// mock 路径抽象可切换：调用方（lanes/mv.js）在 EXECUTOR_MOCK=1 时根本不调用本函数，
//   而是走 lanes/mv.js 内置的 ffmpeg/字节桩合成器——网络层在本模块集中，mock 替换点在 lane 层。
async function submitComfyJob(opts) {
  const o = opts || {};
  const cfg = o.cfg || {};
  const base = comfyBase(cfg);
  const templateName = String(o.templateName || '');
  if (!templateName) throw err('BAD_PARAMS', 'submitComfyJob 缺少 templateName');
  const entry = loadManifest(templateName);
  const raw = loadTemplate(templateName, entry);
  const wf = applyParams(raw, o.values || {});

  const clientId = 'musicbox-' + (o.jobId || 'x');
  const sub = await httpJson(base, '/prompt', { prompt: wf, client_id: clientId }, 'POST', 15000, 'COMFY');
  const promptId = sub && sub.prompt_id;
  if (!promptId) throw err('COMFY_NO_PROMPT_ID', 'ComfyUI 未返回 prompt_id');

  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let outputs = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let hist = null;
    try {
      hist = await httpJson(base, '/history/' + encodeURIComponent(promptId), null, 'GET', 8000, 'COMFY');
    } catch (e) {
      if (e.failCode === 'COMFY_UNREACHABLE' || e.failCode === 'COMFY_TIMEOUT' || e.failCode === 'COMFY_HTTP') throw e;
      continue;
    }
    const rec = hist && hist[promptId];
    if (!rec) continue;
    const st = rec.status || {};
    const done = st.completed === true || st.status_str === 'success' || st.status_str === 'completed';
    if (st.status_str === 'error') {
      const msgs = ((st.messages || []).map((m) => JSON.stringify(m)).join(' | ') || '').slice(0, 400);
      throw err('COMFY_EXEC_ERROR', 'ComfyUI 执行失败：' + msgs);
    }
    if (done && rec.outputs && Object.keys(rec.outputs).length) { outputs = rec.outputs; break; }
    if (done) { outputs = rec.outputs || {}; break; }
  }
  if (!outputs) throw err('COMFY_TIMEOUT', '生成超时（' + Math.round(timeoutMs / 1000) + 's）：模板 ' + templateName);

  // 取产物节点：视频（videos）优先，其次 gifs，再次图像
  let out = null;
  for (const nid of Object.keys(outputs)) {
    const n = outputs[nid] || {};
    const arr = n.videos || n.gifs || n.images || (n.video ? [n.video] : null);
    if (arr && arr.length) { out = arr[0]; break; }
  }
  if (!out || !out.filename) throw err('COMFY_NO_OUTPUT', 'history 无产物输出：' + JSON.stringify(outputs).slice(0, 200));
  const q = '?filename=' + encodeURIComponent(out.filename)
    + '&subfolder=' + encodeURIComponent(out.subfolder || '')
    + '&type=' + encodeURIComponent(out.type || 'output');
  const bytes = await httpBytes(base, '/view' + q, 60000);
  if (!bytes || bytes.length < 100) throw err('COMFY_EMPTY_ART', '产物异常（' + (bytes ? bytes.length : 0) + ' 字节）');
  const ext = sniffExt(bytes, out.filename);

  if (o.log) { try { o.log('comfy 完成 ' + templateName + ' prompt=' + promptId + ' ' + bytes.length + 'B'); } catch (e) { /* ignore */ } }
  return {
    bytes, ext, filename: out.filename, promptId, entry,
    meta: { tmpl_sha16: entry.tmpl_sha16, comfy_commit: entry.comfy_commit, cn_commits: entry.cn_commits, weights: entry.weights },
  };
}

module.exports = {
  submitComfyJob,
  loadManifest,
  loadTemplate,
  applyParams,
  sha16,
  TEMPLATES_DIR,
  comfyBase,
  uploadAsset,
  getSystemStats,
  observeRamFree,
  observeQueue,
};
