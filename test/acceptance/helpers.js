// MusicBox 验收套件公共助手（施工方 D · tests+docs · 2026-11-23）
// 职责：自举真实 server 子进程 + 内置最小 fake executor + 零依赖 HTTP 客户端 + SQLite 白盒读取。
// 纪律：只用 node: 内建模块（node:test 由各测试文件引入）；接口形状一律以 CONTRACTS.md 为真源；
//       对 DB 只读（除 V1-⑥ 跨日模拟需要的 UPDATE）。白盒读库是兜底手段——契约未提供账本/审计查询端点（见 README 契约偏差清单）。
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------- 固定口径（与 CONTRACTS.md §0/§1 对齐） ----------
const BASE_PORT = Number(process.env.MB_TEST_BASE_PORT || 7901); // 验收默认基座端口（正式 API 是 7900，见 README 端口表）
const EXECUTOR_TOKEN = 'mb-test-executor-token';                  // 执行器 X-Executor-Token（测试端与服务端由同一环境变量约定）
const DEV_OTP = '888888';                                          // DEV_OTP=1 时固定验证码（契约 §2）
const WORD_A = '测试违禁词A';                                      // V2/V11 审核软门占位词（词库是外置文件，helper 写入）
const WORD_B = '测试违禁词B';
const HIGHCONF_MARKER = 'MB_HIGHCONF';                             // 上传字节里嵌此标记 → fake executor 产高置信意图卡
const LLM_DEAD_URL = 'http://127.0.0.1:9/v1';                      // 故意不可达 → 逼服务端走确定性启发式（契约 §0 LLM 可选性）

// ---------- 极简零依赖 HTTP 客户端（不用 fetch，避免 keep-alive 挂住测试进程） ----------
function httpReq(method, url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: opts.headers || {}, timeout: opts.timeoutMs || 30000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('HTTP 超时 ' + method + ' ' + url)));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// multipart 构造：files=[{field,filename,data,contentType}]，fields={k:v}
function buildMultipart(fields, files) {
  const boundary = '----MBTest' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v == null ? '' : String(v)}\r\n`, 'utf8'));
  }
  for (const f of files || []) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`, 'utf8'));
    parts.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

// ---------- 测试期 API 客户端 ----------
function makeApi(baseUrl) {
  // api('POST','/v1/works/generate',{token,json}) → {status, ok, json, text}
  return async function api(method, pathname, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    let body;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = Buffer.from(JSON.stringify(opts.json), 'utf8'); }
    else if (opts.multipart) { const mp = buildMultipart(opts.multipart.fields, opts.multipart.files); headers['Content-Type'] = mp.contentType; body = mp.body; }
    if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
    if (opts.executorToken) headers['X-Executor-Token'] = opts.executorToken;
    const r = await httpReq(method, baseUrl + pathname, { headers, body, timeoutMs: opts.timeoutMs });
    const text = r.buffer.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 保留 text */ }
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json, text, headers: r.headers, buffer: r.buffer };
  };
}

// ---------- 端口与就绪探测 ----------
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function findFreePort(base, span) {
  span = span || 90;
  const jitter = (crypto.randomBytes(2).readUInt16LE(0) % Math.max(1, Math.floor(span / 3))); // 多文件并行时错峰
  for (let i = 0; i < span; i++) {
    const p = base + ((jitter + i) % span);
    if (await portFree(p)) return p;
  }
  throw new Error('验收自举失败：端口段 ' + base + '~' + (base + span - 1) + ' 全部被占用');
}

// ---------- wav / png 合成器（mock 语义：产出真实可播放音频，契约 §0 Mock 执行器） ----------
function makeSineWav(opts) {
  opts = opts || {};
  const sec = Math.max(1, Math.min(240, opts.sec == null ? 10 : opts.sec));
  const rate = 22050, ch = 1, bits = 16;
  const freq = opts.freq || 440, amp = 0.3;
  const n = Math.floor(rate * sec);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767);
    data.writeInt16LE(v < -32768 ? -32768 : v, i * 2);
  }
  const chunks = [];
  const marker = opts.marker ? Buffer.from(String(opts.marker), 'utf8') : null;
  if (marker) { // 自定义 MBID 块承载高置信标记（合法 RIFF 结构，任意解析器可容忍）
    const pad = marker.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    chunks.push(Buffer.from('MBID', 'ascii'), int32(marker.length + pad.length), marker, pad);
  }
  const dataLen = data.length;
  const bodySize = 4 + (8 + 16) + (8 + dataLen) + chunks.reduce((s, c) => s + c.length, 0);
  const head = [];
  head.push(Buffer.from('RIFF', 'ascii'), int32(4 + bodySize), Buffer.from('WAVE', 'ascii'));
  head.push(Buffer.from('fmt ', 'ascii'), int32(16), int16(1), int16(ch), int32(rate), int32(rate * ch * (bits / 8)), int16(ch * (bits / 8)), int16(bits));
  head.push(Buffer.from('data', 'ascii'), int32(dataLen), data);
  return Buffer.concat([].concat(head, chunks));
}
function int32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; }
function int16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; }

// 最小合法 1x1 PNG（尾部附标记字节，图像 magic 校验不受影响）
function makePng(marker) {
  const hex = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffffff7f0300070605fe3e6d5d420000000049454e44ae426082';
  return Buffer.concat([Buffer.from(hex, 'hex'), marker ? Buffer.from(String(marker), 'utf8') : Buffer.alloc(0)]);
}

// ---------- ffmpeg 解析（执行器机需 ffmpeg；缺失时 fake executor 走 FFMPEG_MISSING 失败方向） ----------
// 判定必须做"能力探测"而非只看 -version：存在只做视频编码的精简构建（如某些 IDE 自带的 ffmpeg），
// 无法 wav→mp3(libmp3lame)，若误判为存在会把 done 方向拖成假超时。
let _ffmpeg = undefined;
function ffmpegCanTranscodeAudio(ff) {
  try {
    const tmp = path.join(os.tmpdir(), 'mb_ffprobe_' + crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(tmp, { recursive: true });
    const wav = path.join(tmp, 'p.wav'); const mp3 = path.join(tmp, 'p.mp3');
    fs.writeFileSync(wav, makeSineWav({ sec: 1, freq: 440 }));
    const r = spawnSync(ff, ['-y', '-v', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-b:a', '320k', mp3], { timeout: 30000, windowsHide: true });
    const ok = r.status === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 1000;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* noop */ }
    return ok;
  } catch (e) { return false; }
}
function findFfmpeg() {
  if (_ffmpeg !== undefined) return _ffmpeg;
  const cands = [
    process.env.MB_TEST_FFMPEG,                                    // 显式指定优先
    'ffmpeg',                                                       // PATH
    path.join(__dirname, 'tools', 'ffmpeg', 'ffmpeg.exe'),          // 验收自带目录（README 说明）
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ].filter(Boolean);
  _ffmpeg = null;
  if (String(process.env.MB_TEST_FORCE_NO_FFMPEG || '') === '1') return _ffmpeg; // 强制模拟缺失（验证失败方向）
  for (const c of cands) {
    try {
      const v = spawnSync(c, ['-version'], { timeout: 10000, windowsHide: true });
      if (v.status !== 0) continue;
      if (ffmpegCanTranscodeAudio(c)) { _ffmpeg = c; break; }      // 能力探测通过才算存在
    } catch (e) { /* try next */ }
  }
  return _ffmpeg;
}

// 峰值数组（400 点，契约 §4 transcode 产物 peaks.json 同构）：ffmpeg 解出 s16le PCM 后降采样取包络
function computePeaks(ffmpegPath, srcAbs, points) {
  points = points || 400;
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-i', srcAbs, '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 120000 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  const pcm = r.stdout, samples = Math.floor(pcm.length / 2), bucket = Math.max(1, Math.floor(samples / points));
  const out = [];
  for (let b = 0; b < points; b++) {
    let peak = 0;
    const s = b * bucket, e = Math.min(samples, s + bucket);
    for (let i = s; i < e; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > peak) peak = v; }
    out.push(Math.round((peak / 32768) * 10000) / 10000);
  }
  return out;
}

// ---------- 内置最小 fake executor（不依赖 src/executor，按契约 §4 拉单协议） ----------
class FakeExecutor {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.api = makeApi(baseUrl);
    this.lanes = ['music', 'intent', 'ffmpeg'];
    this.stopping = false;
    this.executorId = null;
    this.pollIntervalMs = 1500;
    this.transcodeMode = 'park'; // 'park'(默认：占住租约不改变 job 状态，保证资金断言无竞态) | 'auto'(按环境) | 'real' | 'fail'
    this.failPlan = null;        // {type, code, message, times}：连败 N 次逼出 attempts>=3 → failed+refund
    this.musicPayloads = [];     // 领到的 music job payload 记录（V8 adjust 断言 delta 用）
    this.seenJobIds = new Set();
    this.errors = [];            // executor 侧异常（complete 失败等），断言不含意外错误时查看
  }

  async start() {
    this._exId = 'ex_test_' + (this.baseUrl.split(':').pop() || 'x'); // 稳定执行器身份（租约归属校验用）
    const r = await this.api('POST', '/executor/register', {
      executorToken: EXECUTOR_TOKEN, json: { lanes: this.lanes, version: 'mb-acceptance-fake-1', executor_id: this._exId },
    });
    if (!r.ok || !r.json || !r.json.executor_id) {
      throw new Error('验收自举失败：POST /executor/register 未按契约 §4 返回 {executor_id, poll_interval_ms}（实际 ' + r.status + ' ' + r.text.slice(0, 200) + '）');
    }
    this.executorId = r.json.executor_id;
    this.pollIntervalMs = Number(r.json.poll_interval_ms) || 1500;
    this._loop = this._runLoop(); // 不 await，后台跑
  }
  _exHeaders() { return { 'X-Executor-Id': this._exId }; }

  async _runLoop() {
    while (!this.stopping) {
      let job = null;
      try {
        const r = await this.api('POST', '/executor/poll', {
          executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
          json: { lanes: this.lanes, executor_id: this._exId }, timeoutMs: 30000,
        });
        job = r.ok && r.json ? r.json.job : null;
      } catch (e) {
        if (this.stopping) break;
        await sleep(500); continue; // server 未就绪/瞬时网络错
      }
      if (!job) { await sleep(Math.min(this.pollIntervalMs, 800)); continue; }
      try { await this._handle(job); } catch (e) { this.errors.push(job.type + ':' + (e && e.message)); }
    }
  }

  async _handle(job) {
    this.seenJobIds.add(job.id);
    const exJson = (extra) => Object.assign({ executor_id: this._exId }, extra || {});
    try { await this.api('POST', '/executor/heartbeat', { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: exJson({ job_id: job.id }) }); } catch (e) { /* 心跳尽力而为 */ }
    const type = job.type;
    // 计划性连败（V1-④ fail→refund）：同型 job 连续 fail times 次，逼服务端走 attempts>=3 → failed+refund
    if (this.failPlan && this.failPlan.type === type && this.failPlan.times > 0) {
      this.failPlan.times--;
      await this.api('POST', `/executor/jobs/${job.id}/fail`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: exJson({ code: this.failPlan.code, message: this.failPlan.message }) });
      return;
    }
    if (type === 'music') return this._music(job);
    if (type === 'transcode') return this._transcode(job);
    if (type === 'intent_voice' || type === 'intent_image') return this._intent(job);
    await this.api('POST', `/executor/jobs/${job.id}/fail`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: exJson({ code: 'UNSUPPORTED_JOB_TYPE', message: '验收 fake executor 不支持该 job 类型: ' + type }) });
  }

  // music：按契约 mock 语义产正弦 wav → complete（result.files={逻辑名:上传字段名}，契约 §4）
  async _music(job) {
    const p = job.payload || {};
    this.musicPayloads.push(JSON.parse(JSON.stringify(p)));
    const cands = (p.candidates && p.candidates.length) ? p.candidates : [{ seq: 1, seed_delta: 0 }];
    const files = [], logical = {}, candResults = [];
    await this.api('POST', `/executor/jobs/${job.id}/progress`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: { executor_id: this._exId, progress: 30, note: '候选生成（验收 mock）' } });
    const sec = Math.max(1, Math.min(240, Number(p.sec) || 45));
    for (const c of cands) {
      const seed = (Number(p.seed_base) || 0) + (Number(c.seed_delta) || 0);
      const wav = makeSineWav({ sec, freq: 220 + (Math.abs(seed) % 24) * 10 });
      const field = 'f_c' + c.seq;
      files.push({ field, filename: 'candidate_' + c.seq + '.wav', data: wav, contentType: 'audio/wav' });
      logical['audio_' + c.seq + '.wav'] = field;
      // file 字段 = 上传字段名（契约 §4 result.files 语义；服务端也按 candidate.file 取件）
      candResults.push({ seq: c.seq, seed, title: '验收候选 ' + c.seq, duration_sec: sec, file: field });
    }
    const result = { files: logical, candidates: candResults, engine: 'acceptance-mock' };
    const r = await this.api('POST', `/executor/jobs/${job.id}/complete`, {
      executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
      multipart: { fields: { result: JSON.stringify(result), executor_id: this._exId }, files },
    });
    if (!r.ok) this.errors.push('music complete 失败 ' + job.id + ' → ' + r.status + ' ' + r.text.slice(0, 200));
  }

  // transcode：ffmpeg 存在→真实转码（mp3 320k + peaks.json 400 点）；不存在→fail(FFMPEG_MISSING)。
  // 'park' 模式只占租约（默认，保证资金类断言不被失败退款竞态污染）。
  async _transcode(job) {
    const mode = this.transcodeMode === 'auto' ? (findFfmpeg() ? 'real' : 'fail') : this.transcodeMode;
    if (mode === 'park') return; // 不 complete 不 fail，租约 10min 后被服务端回收再 park，测试窗口内状态稳定
    const p = job.payload || {};
    if (mode === 'fail') {
      await this.api('POST', `/executor/jobs/${job.id}/fail`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: { executor_id: this._exId, code: 'FFMPEG_MISSING', message: '后台转码组件缺失（验收 fake executor 模拟环境缺件）' } });
      return;
    }
    const ff = findFfmpeg();
    if (!ff) throw new Error('fake executor：transcodeMode=real 但未找到 ffmpeg');
    const srcAbs = resolveVarPath(this.varDir, p.src);
    if (!srcAbs || !fs.existsSync(srcAbs)) { this.errors.push('transcode 源文件不存在: ' + p.src); return; }
    const dir = path.dirname(srcAbs), base = path.basename(srcAbs, path.extname(srcAbs));
    const mp3Path = path.join(dir, base + '.mp3');
    const conv = spawnSync(ff, ['-y', '-v', 'error', '-i', srcAbs, '-codec:a', 'libmp3lame', '-b:a', '320k', mp3Path], { timeout: 180000, windowsHide: true });
    if (conv.status !== 0) { this.errors.push('ffmpeg 转码失败: ' + (conv.stderr || '').toString().slice(0, 200)); return; }
    const peaks = computePeaks(ff, srcAbs, 400) || new Array(400).fill(0.5);
    const peaksPath = path.join(dir, base + '.peaks.json');
    fs.writeFileSync(peaksPath, JSON.stringify(peaks));
    // 契约 §4：产物为同目录 <name>.mp3 与 <name>.peaks.json；上传时逻辑名取 mp3/peaks（服务端按此回填 *_url/format）
    const result = { files: { mp3: 'f_mp3', peaks: 'f_peaks' }, peaks_points: 400 };
    const r = await this.api('POST', `/executor/jobs/${job.id}/complete`, {
      executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
      multipart: {
        fields: { result: JSON.stringify(result), executor_id: this._exId },
        files: [
          { field: 'f_mp3', filename: base + '.mp3', data: fs.readFileSync(mp3Path), contentType: 'audio/mpeg' },
          { field: 'f_peaks', filename: base + '.peaks.json', data: fs.readFileSync(peaksPath), contentType: 'application/json' },
        ],
      },
    });
    if (!r.ok) this.errors.push('transcode complete 失败 ' + job.id + ' → ' + r.status + ' ' + r.text.slice(0, 200));
  }

  // intent：按上传字节里有无 HIGHCONF 标记决定高/低置信意图卡（V8 用它驱动服务端澄清纪律断言）
  async _intent(job) {
    const p = job.payload || {};
    let hasMarker = false;
    try {
      const abs = resolveVarPath(this.varDir, p.upload_path || p.path);
      if (abs && fs.existsSync(abs)) hasMarker = fs.readFileSync(abs).includes(HIGHCONF_MARKER);
    } catch (e) { /* 读不到按低置信 */ }
    const card = hasMarker
      ? {
        mood: ['明亮', '欢快'], scene_desc: '一个阳光明媚的下午', genre_hypotheses: ['流行', '电子'],
        vocal: 'instrumental', duration_hint: 'medium', confidence: 0.92,
        questions: [{ q_idx: 0, q: '（高置信卡不应被服务端保留）', options: [{ idx: 0, label: '甲' }, { idx: 1, label: '乙' }], recommended_idx: 1 }],
      }
      : {
        mood: [], scene_desc: '画面信息不足', genre_hypotheses: ['流行'],
        vocal: 'unknown', duration_hint: 'medium', confidence: 0.32,
        questions: [
          { q_idx: 0, q: '你想要什么氛围？', options: [{ idx: 0, label: '欢快动感' }, { idx: 1, label: '平静治愈' }, { idx: 2, label: '宏大史诗' }], recommended_idx: 1 },
          { q_idx: 1, q: '需要人声吗？', options: [{ idx: 0, label: '要人声' }, { idx: 1, label: '纯音乐' }], recommended_idx: 1 },
        ],
      };
    const r = await this.api('POST', `/executor/jobs/${job.id}/complete`, {
      executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
      multipart: { fields: { result: JSON.stringify(card), executor_id: this._exId }, files: [] },
    });
    if (!r.ok) this.errors.push('intent complete 失败 ' + job.id + ' → ' + r.status + ' ' + r.text.slice(0, 200));
  }

  stop() { this.stopping = true; }
}

// 把服务端给的 var 相对/绝对路径解析为磁盘绝对路径
function resolveVarPath(varDir, p) {
  if (!p) return null;
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  const cands = [p, path.join(ROOT, p), varDir && path.join(varDir, p), varDir && path.join(varDir, 'out', p), varDir && path.join(varDir, 'uploads', p)];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return path.resolve(c); } catch (e) { /* noop */ } }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function uniq(prefix) { return prefix + '-' + crypto.randomBytes(4).toString('hex'); }

// ---------- SQLite 白盒助手（契约未提供账本/审计/TTL 查询端点 → 只读兜底；见契约偏差清单） ----------
function makeDb(dbPath) {
  function open() {
    try { return new DatabaseSync(dbPath, { readOnly: true }); } catch (e) { return new DatabaseSync(dbPath); }
  }
  function all(sql, ...params) {
    const db = open();
    try { return db.prepare(sql).all(...params); } finally { try { db.close(); } catch (e) { /* noop */ } }
  }
  function tables() { return all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name); }
  function columns(t) { return all('PRAGMA table_info(' + t + ')').map((r) => r.name); }
  function findTable(re) { return tables().find((n) => re.test(n)) || null; }
  function pickCol(cols, ...res) { for (const re of res) { const c = cols.find((x) => re.test(x)); if (c) return c; } return null; }

  // 账本：Σdelta 断言用。返回 {rows:[{reason,delta}]} 或 {error}
  function ledgerRows(userId) {
    const t = findTable(/ledger/i);
    if (!t) return { error: '数据库中未找到 ledger 表（现有表: ' + tables().join(',') + '）' };
    const cols = columns(t);
    const dCol = pickCol(cols, /^delta$/, /delta/i, /amount/i);
    const uCol = pickCol(cols, /^user_id$/, /user_id|uid|owner/i);
    const rCol = pickCol(cols, /^reason$/, /reason|type|kind/i);
    const oCol = pickCol(cols, /created_at/i, /seq/i, /^id$/i, /^ts$/i) || 'rowid';
    if (!dCol) return { error: 'ledger 表缺少 delta 列（列: ' + cols.join(',') + '）' };
    const where = uCol ? 'WHERE ' + uCol + ' = ?' : '';
    const params = uCol ? [userId] : [];
    let rows;
    try { rows = all('SELECT * FROM ' + t + ' ' + where + ' ORDER BY ' + oCol, ...params); }
    catch (e) { return { error: 'ledger 查询失败: ' + e.message }; }
    return { table: t, rows: rows.map((r) => ({ reason: rCol ? String(r[rCol]) : null, delta: Number(r[dCol]) })) };
  }

  // 跨日模拟（V1-⑥）：把"最近一次积分重置日"字段改到昨天。
  // server 实现把重置日记在 prefs(user_id,key='credit_reset_day')；兼容其他实现再扫 users 表日期列。
  function setLastCreditDate(userId, isoDate) {
    try {
      const w = new DatabaseSync(dbPath);
      try {
        if (tables().includes('prefs')) {
          const pc = columns('prefs');
          const hasRow = w.prepare("SELECT 1 AS x FROM prefs WHERE user_id=? AND key='credit_reset_day'").get(userId);
          if (hasRow) {
            w.prepare("UPDATE prefs SET value=? WHERE user_id=? AND key='credit_reset_day'").run(isoDate, userId);
            return { ok: true, mechanism: 'prefs.credit_reset_day' };
          }
          // 无行=从未重置过（当日首触即会重置）→ 直接插入"昨天"以显式表达跨日
          w.prepare('INSERT INTO prefs(user_id,key,value,updated_at) VALUES(?,?,?,?)')
            .run(userId, 'credit_reset_day', isoDate, new Date().toISOString());
          return { ok: true, mechanism: 'prefs.credit_reset_day(insert)' };
        }
        const t = findTable(/^users?$/i) || findTable(/user/i);
        if (!t) return { error: '未找到 prefs 表也未找到用户表 —— 无法模拟跨日（契约未固化重置日字段，见偏差清单 DEV-DAILY）' };
        const cols = columns(t);
        const dCol = pickCol(cols, /last_credit_date/i, /credit_date/i, /last_credit/i, /daily.*date/i);
        const iCol = pickCol(cols, /^id$/, /user_id/i);
        if (!dCol) return { error: 'prefs/users 均无重置日字段（users 列: ' + cols.join(',') + '），见偏差清单 DEV-DAILY' };
        w.prepare('UPDATE ' + t + ' SET ' + dCol + ' = ? WHERE ' + iCol + ' = ?').run(isoDate, userId);
        return { ok: true, mechanism: t + '.' + dCol };
      } finally { w.close(); }
    } catch (e) { return { error: e.message }; }
  }
  
  // 上传物 TTL（V11）：找 uploads 类表，检查过期字段 ≈ created+72h
  function uploadTtlRows(userId) {
    const t = findTable(/upload/i) || findTable(/intent_upload|attachment/i);
    if (!t) return { error: '未找到 uploads 类表（现有表: ' + tables().join(',') + '）——上传物 72h TTL 无落库痕迹' };
    const cols = columns(t);
    const cCol = pickCol(cols, /created_at/i, /^created/i, /ts/i);
    const eCol = pickCol(cols, /expire_at/i, /expires_at/i, /expiry/i, /ttl/i, /delete_after/i, /purge/i);
    const uCol = pickCol(cols, /^user_id$/, /user_id|uid|owner/i);
    const where = uCol ? 'WHERE ' + uCol + ' = ?' : '';
    const params = uCol ? [userId] : [];
    let rows;
    try { rows = all('SELECT * FROM ' + t + ' ' + where + ' ORDER BY rowid DESC LIMIT 20', ...params); }
    catch (e) { return { error: e.message }; }
    if (!eCol) return { error: 'uploads 表缺少过期字段（列: ' + cols.join(',') + '）' };
    return { table: t, rows: rows.map((r) => ({ created: cCol ? r[cCol] : null, expire: r[eCol], ttlHours: cCol ? (Date.parse(r[eCol]) - Date.parse(r[cCol])) / 3600000 : null })) };
  }

  // 审计（V11 report）：audit 类表 + 举报表里检索含 needle 的行（契约 §2"M2 前仅落审计"）
  function auditRowsLike(needle, extraTables) {
    const names = [findTable(/audit/i), findTable(/action_log|oplog|event_log/i)];
    for (const re of (extraTables || [])) names.push(findTable(re));
    const tablesHit = names.filter(Boolean);
    if (!tablesHit.length) return { error: '未找到 audit/举报类表（现有表: ' + tables().join(',') + '）——举报仅接口 200 但无审计落库' };
    let hits = [];
    for (const t of tablesHit) {
      let rows;
      try { rows = all('SELECT * FROM ' + t + ' ORDER BY rowid DESC LIMIT 500'); } catch (e) { continue; }
      hits = hits.concat(rows.filter((r) => JSON.stringify(r).includes(needle)).map((r) => ({ table: t, row: r })));
    }
    return { tables: tablesHit.join(','), hits };
  }

  return { dbPath, all, tables, columns, findTable, ledgerRows, setLastCreditDate, uploadTtlRows, auditRowsLike };
}

// ---------- 套件自举 ----------
// boot('V1') → { port, baseUrl, varDir, dbPath, api, executor, db, ffmpeg, close(), me/credits/newGuest 等 }
async function boot(suiteName) {
  const runId = String(suiteName || 'SUITE') + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  const varDir = path.join(ROOT, 'var-test', runId); // 独立 var 前缀，互不污染（正式运行时数据在 var/）
  const dbPath = path.join(varDir, 'db', 'musicbox.sqlite'); // server 按 MB_VAR_ROOT 派生同一路径
  const outDir = path.join(varDir, 'out');
  const uploadsDir = path.join(varDir, 'uploads');
  const configDir = path.join(varDir, 'config');
  const wordsFile = path.join(configDir, 'moderation_words.txt'); // server 固定读取 var/config/moderation_words.txt
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  // 词库是外置文件：先写入占位违禁词（V2/V11 审核软门样例，词库零内置敏感词、由运营/测试填入）
  fs.writeFileSync(wordsFile, '# 验收套件占位词库（helpers.js 写入；一行一词）\n' + WORD_A + '\n' + WORD_B + '\n', 'utf8');

  const port = await findFreePort(BASE_PORT);
  // env 命名：契约只固定了语义（PORT/DEV_OTP 未定 env 名），server 实现取 MB_* 前缀；两套都传以兼容
  const env = Object.assign({}, process.env, {
    PORT: String(port), MB_PORT: String(port),
    HOST: '127.0.0.1',
    DEV_OTP: '1', MB_DEV_OTP: '1',                  // 契约 §2：验证码固定 888888
    EXECUTOR_MOCK: '1',                             // 契约 §0：mock 执行器语义（本套件另内置 fake executor，不依赖 src/executor）
    MB_EXECUTOR_TOKEN: EXECUTOR_TOKEN,
    MB_VAR_ROOT: varDir,                            // 独立 var 前缀（db/out/uploads/config 全部派生于此）
    MB_PUBLIC_BASE_URL: 'http://127.0.0.1:' + port,
    MB_LLM_VLM_URL: LLM_DEAD_URL,                   // 不可达 → 确定性启发式兜底（契约 §0），无 GPU/LLM 也能全链路
    MB_MUSIC_URL: 'http://127.0.0.1:9',             // 本套件不真打 GPU（fake executor 产 mock 音频）
    MB_SENSEVOICE_URL: 'http://127.0.0.1:9',
    NODE_NO_WARNINGS: '1',
  });

  const entry = path.join(ROOT, 'src', 'server', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error('验收自举失败：服务端入口不存在 src/server/index.js（契约 §0 规定入口）。server 施工方交付后重跑。');
  }
  const child = spawn(process.execPath, ['src/server/index.js'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c.toString(); if (log.length > 60000) log = log.slice(-40000); });
  child.stderr.on('data', (c) => { log += c.toString(); if (log.length > 60000) log = log.slice(-40000); });
  let exited = null;
  child.on('exit', (code, sig) => { exited = { code, sig }; });

  const baseUrl = 'http://127.0.0.1:' + port;
  const api = makeApi(baseUrl);

  // 就绪探测：/healthz（server 健康端点，非契约面）→ 再确认 guest 能出票（契约 §2 最小闭环）
  const deadline = Date.now() + 15000;
  let ready = false, lastErr = null;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error('验收自举失败：server 子进程提前退出 code=' + exited.code + ' sig=' + exited.sig + '。日志尾部:\n' + log.slice(-2500));
    }
    try {
      const h = await api('GET', '/healthz', { timeoutMs: 3000 });
      if (h.ok) {
        const r = await api('POST', '/v1/auth/guest', { timeoutMs: 3000 });
        if (r.ok && r.json && r.json.access_token) { ready = true; break; }
        lastErr = 'guest HTTP ' + r.status + ' ' + r.text.slice(0, 120);
      } else lastErr = 'healthz HTTP ' + h.status;
    } catch (e) { lastErr = e.message; }
    await sleep(250);
  }
  if (!ready) throw new Error('验收自举失败：15s 内 server 未就绪（/healthz + POST /v1/auth/guest → {access_token,…}）。最后错误: ' + lastErr + '。日志尾部:\n' + log.slice(-2500));

  const executor = new FakeExecutor(baseUrl);
  executor.varDir = varDir;
  await executor.start();

  const db = makeDb(dbPath);
  const ffmpeg = findFfmpeg();

  const ctx = {
    suite: suiteName, port, baseUrl, varDir, dbPath, outDir, uploadsDir, wordsFile,
    api, executor, db, ffmpeg, log: () => log,
    close: async () => {
      executor.stop();
      if (exited === null) { try { child.kill('SIGKILL'); } catch (e) { /* noop */ } }
      const t0 = Date.now();
      while (exited === null && Date.now() - t0 < 5000) await sleep(100);
    },
  };

  // 常用业务助手（内部也走契约端点）
  ctx.newGuest = async () => {
    const r = await api('POST', '/v1/auth/guest');
    if (!r.ok || !r.json || !r.json.access_token) throw new Error('契约 §2 POST /v1/auth/guest 应 200 {access_token,refresh_token,user:{is_guest:true}}，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    return { token: r.json.access_token, refreshToken: r.json.refresh_token, user: r.json.user, resp: r };
  };
  ctx.newPhoneUser = async (phone) => {
    phone = phone || '13' + String(Date.now()).slice(-8);
    const rq = await api('POST', '/v1/auth/phone/request-code', { json: { phone } });
    if (!rq.ok || !rq.json || rq.json.sent !== true) throw new Error('契约 §2 request-code 应 200 {sent:true}（DEV_OTP=1），实际 ' + rq.status + ' ' + rq.text.slice(0, 200));
    const vf = await api('POST', '/v1/auth/phone/verify', { json: { phone, code: DEV_OTP } });
    if (!vf.ok || !vf.json || !vf.json.access_token) throw new Error('契约 §2 phone/verify（固定码 888888）应 200 {access_token,…}，实际 ' + vf.status + ' ' + vf.text.slice(0, 200));
    return { token: vf.json.access_token, refreshToken: vf.json.refresh_token, user: vf.json.user, phone };
  };
  ctx.me = async (token) => {
    const r = await api('GET', '/v1/me', { token });
    if (!r.ok) throw new Error('契约 §2 GET /v1/me 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    return r.json;
  };
  ctx.credits = async (token) => {
    const m = await ctx.me(token);
    if (!m.credits || m.credits.balance == null) throw new Error('契约 §2 GET /v1/me 应含 credits:{balance,daily_quota,daily_used}，实际 ' + JSON.stringify(m).slice(0, 200));
    return m.credits;
  };
  ctx.generate = (token, body) => api('POST', '/v1/works/generate', { token, json: body });

  // 等 job 到终态（done/failed），轮询 GET /v1/jobs/:id（契约 §2）
  ctx.waitForJob = async (token, jobId, opts) => {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 120000;
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      const r = await api('GET', '/v1/jobs/' + jobId, { token });
      if (!r.ok) throw new Error('契约 §2 GET /v1/jobs/:id 应 200（job=' + jobId + '），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      last = r.json;
      if (['done', 'failed', 'canceled'].includes(last.status)) return last;
      if (opts.stopWhen && opts.stopWhen(last)) return last;
      await sleep(400);
    }
    throw new Error('job ' + jobId + ' 在 ' + timeoutMs + 'ms 内未达终态（最后状态 ' + (last && last.status) + ' progress=' + (last && last.progress) + '）。fake executor 错误: ' + JSON.stringify(executor.errors).slice(0, 400) + '；server 日志尾部:\n' + log.slice(-1200));
  };

  // 等意图卡被执行器结果填充。注意：上传即建草稿卡（status=clarifying、confidence=0、questions=[]），
  // 故"已填充"判据 = ready/consumed，或 clarifying 且（有题 或 confidence>0）——避免把草稿态误当执行器结果。
  ctx.waitForIntent = async (token, intentId, opts) => {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 25000;
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      const r = await api('GET', '/v1/intent/' + intentId, { token });
      if (!r.ok) throw new Error('契约 §2 GET /v1/intent/:id 应 200（intent=' + intentId + '），实际 ' + r.status + ' ' + r.text.slice(0, 200));
      last = r.json.intent || r.json;
      const populated = ['ready', 'consumed'].includes(last.status) ||
        (last.status === 'clarifying' && (((last.questions || []).length > 0) || (typeof last.confidence === 'number' && last.confidence > 0)));
      if (populated && (!opts.statuses || opts.statuses.includes(last.status))) return last;
      if (populated && opts.statuses && !opts.statuses.includes(last.status)) {
        // 调用方限定期望状态但已填充成别的状态：再宽限 3s 后返回实况（由用例断言）
        const g = Date.now();
        while (Date.now() - g < 3000) { await sleep(300); const r2 = await api('GET', '/v1/intent/' + intentId, { token }); const i2 = r2.json.intent || r2.json; if (opts.statuses.includes(i2.status)) return i2; }
        return last;
      }
      await sleep(300);
    }
    throw new Error('intent ' + intentId + ' 在 ' + timeoutMs + 'ms 内未被执行器结果填充（最后 status=' + (last && last.status) + ' conf=' + (last && last.confidence) + '）。fake executor 错误: ' + JSON.stringify(executor.errors).slice(0, 300));
  };

  // adopt 一个候选为 work。契约 §2 的 POST /v1/works/:id/adopt 中 :id 语义未定稿（草稿 work？job？）——
  // 依次尝试候选载体，任一 200 即返回；全部失败抛契约偏差（不得放宽，见 README 偏差清单 DEV-ADOPT）。
  ctx.adoptCandidate = async (token, job, cand) => {
    const ids = [job.result_work_id, cand && cand.work_id, cand && cand.id, job.id].filter(Boolean);
    const tried = [];
    for (const id of ids) {
      const ad = await api('POST', '/v1/works/' + id + '/adopt', { token, json: { candidate_id: cand ? cand.id : undefined } });
      tried.push(id + '→' + ad.status);
      if (ad.ok && ad.json && ad.json.work) return ad.json.work;
      if (ad.ok && ad.json && ad.json.id) return ad.json; // 服务端可能直接返回 work 本体
    }
    throw new Error('契约 §2 POST /v1/works/:id/adopt {candidate_id} 未能返回 {work}（尝试: ' + tried.join(', ') + '）');
  };

  // 完整生成一条 done 的 work 并 adopt（需 transcode 真实完成；无 ffmpeg 环境下调用方应先 skip）
  ctx.genAndAdopt = async (token, body, opts) => {
    opts = opts || {};
    const g = await ctx.generate(token, body);
    if (!g.ok || !g.json || !g.json.job_id) throw new Error('generate 应 202 {job_id,…}，实际 ' + g.status + ' ' + g.text.slice(0, 200));
    const job = await ctx.waitForJob(token, g.json.job_id, { timeoutMs: opts.timeoutMs || 150000 });
    if (job.status !== 'done') throw new Error('job 未 done（status=' + job.status + ' error=' + JSON.stringify(job.error) + '）');
    const cand = (job.candidates || [])[opts.candIdx || 0];
    if (!cand) throw new Error('job done 但 candidates 为空（契约 §2 candidate=[id,seq,title,audio_url,…]）');
    const work = await ctx.adoptCandidate(token, job, cand);
    return { job, cand, work, generate: g };
  };

  return ctx;
}

module.exports = {
  ROOT, BASE_PORT, EXECUTOR_TOKEN, DEV_OTP, WORD_A, WORD_B, HIGHCONF_MARKER,
  boot, api: makeApi, httpReq, buildMultipart, makeSineWav, makePng, findFfmpeg, computePeaks,
  FakeExecutor, makeDb, resolveVarPath, sleep, uniq,
};
