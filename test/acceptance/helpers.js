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
    // 必须显式给 Content-Length：Node 客户端在 GET+body 时既不补 Content-Length 也不补 Transfer-Encoding，
    // 线上请求缺帧 → 被服务端解析层直接 400（无 JSON 错误体），排查时极易误判成"鉴权/路由有问题"。
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body));
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
    srv.listen(port);
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

// ---------- MV mock 产物（架构 §4.3：有 ffmpeg→lavfi testsrc2+正弦真实 mp4；无→内置 ftyp/mdat 字节桩） ----------
// 字节桩：ftyp 盒（major=isom）+ mdat；magic 合法（bytes[4..8]='ftyp'）、非空。V13(h) 用其钉死"mock mp4 可播"下限。
function makeMp4Stub(marker) {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4); ftyp.write('isom', 8); ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('isom', 16); ftyp.write('iso2', 20);
  const payload = Buffer.concat([Buffer.from('MB-MOCK-VIDEO', 'ascii'), marker ? Buffer.from(String(marker), 'utf8') : Buffer.alloc(0)]);
  const mdat = Buffer.alloc(8); mdat.writeUInt32BE(8 + payload.length, 0); mdat.write('mdat', 4);
  return Buffer.concat([ftyp, mdat, payload]);
}
// ffmpeg 可用→真产 2s testsrc2+mpeg4+aac mp4（真实可解码）；否则字节桩
let _mockMp4Cache = null;
function makeMockMp4(marker) {
  const ff = findFfmpeg();
  if (ff) {
    if (!_mockMp4Cache) {
      const tmp = path.join(os.tmpdir(), 'mb_mockmp4_' + crypto.randomBytes(4).toString('hex') + '.mp4');
      try {
        const r = spawnSync(ff, ['-y', '-v', 'error',
          '-f', 'lavfi', '-i', 'testsrc2=size=240x426:rate=12:duration=2',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
          '-shortest', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', tmp], { timeout: 90000, windowsHide: true });
        if (r.status === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 1000) _mockMp4Cache = fs.readFileSync(tmp);
        try { fs.unlinkSync(tmp); } catch (e) { /* noop */ }
      } catch (e) { /* 回退字节桩 */ }
    }
    if (_mockMp4Cache) return marker ? Buffer.concat([_mockMp4Cache, Buffer.from(String(marker), 'utf8')]) : Buffer.from(_mockMp4Cache);
  }
  return makeMp4Stub(marker);
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
    this.lanes = ['music', 'intent', 'ffmpeg', 'imgspark', 'vidspark', 'lipsync', 'align']; // MV 二期 lanes（V13，契约 v2.6）
    this.stopping = false;
    this.executorId = null;
    this.pollIntervalMs = 1500;
    this.transcodeMode = 'park'; // 'park'(默认：占住租约不改变 job 状态，保证资金断言无竞态) | 'auto'(按环境) | 'real' | 'fail'
    this.failPlan = null;        // {type, code, message, times, armedAt}：连败 N 次逼出 attempts>=3 → failed+refund
    // 计划性失败请用 planFail()（自动带 armedAt，只命中武装之后创建的 job）
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
  // 武装"计划性连败"：armedAt 之后的 job 才算数，前面用例残留的 queued job 不得来蹭这 N 次失败
  // exclude：已在飞的同型 job id（Set/数组），它们不得来蹭这 N 次计划失败。
  // 用法：const stale = S.db.all("SELECT id FROM jobs WHERE type='music' AND status NOT IN ('done','failed','canceled')").map(r=>r.id);
  //       S.executor.planFail({ type:'music', times:3, code:'…', message:'…', exclude: stale });
  planFail(plan) {
    const p = Object.assign({}, plan);
    if (p.exclude) p.exclude = p.exclude instanceof Set ? p.exclude : new Set(p.exclude);
    this.failPlan = p;
    return this.failPlan;
  }

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
    // 计划性连败（V1-④ fail→refund）：同型 job 连续 fail times 次，逼服务端走 attempts>=3 → failed+refund。
    // 必须只命中"计划武装之后创建的 job"：前面用例用 generate 后不等终态，会留下 queued 的 music job，
    // 它们若把 3 次失败吃掉，本用例的 job 就会走 _music → 停在 progress=90 等一个 parked 的转码子 job，
    // 表现为 20 轮里偶发 3 次、每次卡满 60s 超时（真 flake 根因，别再用"多等一会儿"糊过去）。
    // 定域靠**显式排除集**（由用例在白盒里把已在飞的同型 job 取来），不靠 job.created_at：
    // poll 下发的 lease 载荷并不保证带 created_at，Date.parse(undefined)=NaN 会让计划永不命中，
    // 于是 job 走 _music → 停在 progress=90 等一个 parked 的转码子 job → 60s 超时（本文件曾这样红过 10/10 轮）。
    const excl = (this.failPlan && this.failPlan.exclude) || null;
    const planIsMine = !excl || !excl.has(job.id);
    if (this.failPlan && this.failPlan.type === type && this.failPlan.times > 0 && planIsMine) {
      this.failPlan.times--;
      const fr = await this.api('POST', `/executor/jobs/${job.id}/fail`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: exJson({ code: this.failPlan.code, message: this.failPlan.message }) });
      if (!fr.ok) this.errors.push('planned fail 失败 ' + job.id + ' → ' + fr.status + ' ' + fr.text.slice(0, 160));
      return;
    }
    if (type === 'music') return this._music(job);
    if (type === 'transcode') return this._transcode(job);
    if (type === 'intent_voice' || type === 'intent_image' || type === 'intent_text') return this._intent(job);
    if (type === 'replica_analyze') return this._replicaAnalyze(job); // 契约 v5.7.4（复刻）：mock 先行，确定性假观测
    if (type === 'mv_cast_image') return this._mvCastImage(job);
    if (type === 'mv_cast_video') return this._mvCastVideo(job);
    if (type === 'mv_storyboard') return this._mvStoryboard(job);
    if (type === 'mv_shot') return this._mvShot(job);
    if (type === 'mv_lipsync') return this._mvLipsync(job);
    if (type === 'mv_align') return this._mvAlign(job);
    if (type === 'mv_preview' || type === 'mv_compose') return this._mvVideo(job, type);
    await this.api('POST', `/executor/jobs/${job.id}/fail`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: exJson({ code: 'UNSUPPORTED_JOB_TYPE', message: '验收 fake executor 不支持该 job 类型: ' + type }) });
  }

  // —— MV mock 分支（契约 v2.3 payload / 架构 §4.1 runner 形状；mock 语义=真实可播假产物）——
  async _mvComplete(job, result, files, progressNote) {
    await this.api('POST', `/executor/jobs/${job.id}/progress`, { executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(), json: { executor_id: this._exId, progress: 20, note: progressNote || '验收 mock（MV）' } });
    const r = await this.api('POST', `/executor/jobs/${job.id}/complete`, {
      executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
      multipart: { fields: { result: JSON.stringify(result), executor_id: this._exId }, files: files || [] },
    });
    if (!r.ok) this.errors.push('mv complete 失败 ' + job.type + ' ' + job.id + ' → ' + r.status + ' ' + r.text.slice(0, 200));
  }
  // mv_cast_image：3 张有效 PNG（H3-Image ×3 候选 mock）+ face_scores
  // 注意 face_scores 恒为 null 且 meta.facegate.ran=false：mock 里没有 facegate 在跑，
  // 过去这里凭空发 0.90/0.83/0.76，等于脚手架自己造了一份"验过脸"的假证据（V43-④ 钉死）。
  async _mvCastImage(job) {
    const files = []; const logical = {}; const scores = [];
    for (let i = 1; i <= 3; i++) {
      const field = 'f_ci' + i;
      files.push({ field, filename: 'cast_image_' + i + '.png', data: makePng(), contentType: 'image/png' });
      logical['cast_image_' + i] = field;
      scores.push(null);
    }
    await this._mvComplete(job, {
      files: logical, face_scores: scores, mock: 'mv_cast_image',
      meta: { comfy: false, facegate: { attempted: 3, scored: 0, ran: false, reason: 'mock_executor' } },
    }, files);
  }
  // mv_cast_video：stub mp4 + 13 帧有效 PNG（facegate 逐帧评分 mock）
  async _mvCastVideo(job) {
    const files = [{ field: 'f_cv', filename: 'cast_video.mp4', data: makeMockMp4(), contentType: 'video/mp4' }];
    const logical = { cast_video: 'f_cv' }; const frames = [];
    for (let i = 1; i <= 13; i++) {
      const field = 'f_f' + i;
      files.push({ field, filename: 'frame_' + i + '.png', data: makePng(), contentType: 'image/png' });
      logical['frame_' + i] = field;
      frames.push({ idx: i, score: Math.round((0.88 - (i % 5) * 0.04) * 100) / 100, pass: true });
    }
    await this._mvComplete(job, { files: logical, frames, mock: 'mv_cast_video' }, files);
  }
  // mv_storyboard：1 张关键帧 png（board_<shotId>）
  async _mvStoryboard(job) {
    const p = job.payload || {};
    const shots = (p.shots && p.shots.length) ? p.shots : [{ id: 'shot_x' }];
    const files = []; const logical = {};
    shots.slice(0, 1).forEach((s, i) => {
      const field = 'f_b' + i; const sid = String(s.id || 'shot_x').replace(/[^\w.-]/g, '_');
      files.push({ field, filename: 'board_' + sid + '.png', data: makePng(), contentType: 'image/png' });
      logical['board_' + sid] = field;
    });
    await this._mvComplete(job, { files: logical, mock: 'mv_storyboard' }, files);
  }
  // mv_shot：stub mp4（clip_<shotId>，原生声画保留、compose 剥离）
  async _mvShot(job) {
    const p = job.payload || {};
    const sid = String((p.shot && p.shot.id) || p.shot_id || 'shot_x').replace(/[^\w.-]/g, '_');
    const files = [{ field: 'f_clip', filename: 'clip_' + sid + '.mp4', data: makeMockMp4(), contentType: 'video/mp4' }];
    await this._mvComplete(job, { files: { ['clip_' + sid]: 'f_clip' }, mock: 'mv_shot' }, files);
  }
  // mv_lipsync：透传 clip + sync_score=0.95（架构 §4.3：V13 只验契约/账本，质量归 V15）
  async _mvLipsync(job) {
    const p = job.payload || {};
    let data = null;
    try {
      const abs = resolveVarPath(this.varDir, p.video || p.clip);
      if (abs && fs.existsSync(abs)) { const b = fs.readFileSync(abs); if (b.length) data = b; }
    } catch (e) { /* 透传失败回退 mock 产物 */ }
    if (!data) data = makeMockMp4();
    const sid = String(p.shot_id || (p.win && p.win.shot_id) || 'shot_x').replace(/[^\w.-]/g, '_');
    const files = [{ field: 'f_sy', filename: 'synced_' + sid + '.mp4', data, contentType: 'video/mp4' }];
    await this._mvComplete(job, { files: { ['synced_' + sid]: 'f_sy' }, sync_score: 0.95, mock: 'mv_lipsync' }, files);
  }
  // mv_align：按歌词行数均匀分配 timings（架构 §4.3 mock 语义）
  async _mvAlign(job) {
    const p = job.payload || {};
    const lyrics = String(p.lyrics || '');
    let lines = lyrics.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length) lines = ['（mock 对齐行）'];
    const total = Number(p.duration_sec) || Number(p.total_sec) || 45;
    const step = total / lines.length;
    const timings = lines.map((line, i) => ({ line, start: Math.round(i * step * 1000) / 1000, end: Math.round((i + 1) * step * 1000) / 1000 }));
    await this._mvComplete(job, { files: {}, timings, mock: 'mv_align' }, [], '对齐中（验收 mock）');
  }
  // mv_preview / mv_compose：stub mp4（compose 另出 cover png）
  async _mvVideo(job, type) {
    const files = [{ field: 'f_v', filename: (type === 'mv_preview' ? 'preview' : 'mv_video') + '.mp4', data: makeMockMp4(), contentType: 'video/mp4' }];
    const logical = {}; logical[type === 'mv_preview' ? 'preview' : 'mv_video'] = 'f_v';
    if (type === 'mv_compose') {
      files.push({ field: 'f_cover', filename: 'cover.png', data: makePng(), contentType: 'image/png' });
      logical.cover = 'f_cover';
    }
    await this._mvComplete(job, { files: logical, ai_label: 1, degraded_shots: [], mock: type }, files);
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

  // replica_analyze（契约 v5.7.4 mock 先行）：确定性假观测 —— 有文本/情绪/事件，
  // 服务端规则画像能从文本命中词典词（与 src/executor/lanes/mock.js 同一形状）。
  // LLM 归纳在服务端 completeReplicaAnalyze；闸门默认 LLM 不可达 → 走规则画像（degraded=1）。
  async _replicaAnalyze(job) {
    const r = await this.api('POST', `/executor/jobs/${job.id}/complete`, {
      executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
      multipart: {
        fields: {
          result: JSON.stringify({
            asr: {
              emotion: 'happy', events: ['BGM'], duration: 45,
              text: 'mock 参考曲转写：轻快的电子节拍，温暖的钢琴与弦乐铺底，女声气声唱法',
            },
            fallback: false,
          }),
          executor_id: this._exId,
        },
        files: [],
      },
    });
    if (!r.ok) this.errors.push('replica_analyze complete 失败 ' + job.id + ' → ' + r.status + ' ' + r.text.slice(0, 200));
    return;
  }

  // intent：按上传字节里有无 HIGHCONF 标记决定高/低置信意图卡（V8 用它驱动服务端澄清纪律断言）
  async _intent(job) {
    const p = job.payload || {};
    // 文本线（端侧转写 / 确认页改字重编译）：不经 ASR，用户原话原样进 result.text；
    // 命中 HIGHCONF → 视为 LLM 编译成功，否则视为词典兜底（fallback=true）——
    // 让「degraded / source_text」这两条诚实化断言（v11）可确定性验证。
    if (job.type === 'intent_text') {
      const own = String(p.text || '').trim();
      const hi = own.includes(HIGHCONF_MARKER);
      const card = hi
        ? {
          mood: ['治愈'], scene_desc: '一个人待着的安静时刻', genre_hypotheses: ['爵士'],
          vocal: 'instrumental', duration_hint: 'medium', confidence: 0.88, questions: [],
        }
        : {
          mood: [], scene_desc: '信息不足', genre_hypotheses: ['流行'],
          vocal: 'unknown', duration_hint: 'medium', confidence: 0.3,
          questions: [
            { q_idx: 0, q: '你想要什么氛围？', options: [{ idx: 0, label: '欢快动感' }, { idx: 1, label: '平静治愈' }], recommended_idx: 1 },
          ],
        };
      const result = Object.assign({}, card, { text: own });
      if (!hi) result.fallback = true;
      const r = await this.api('POST', `/executor/jobs/${job.id}/complete`, {
        executorToken: EXECUTOR_TOKEN, headers: this._exHeaders(),
        multipart: { fields: { result: JSON.stringify(result), executor_id: this._exId }, files: [] },
      });
      if (!r.ok) this.errors.push('intent_text complete 失败 ' + job.id + ' → ' + r.status + ' ' + r.text.slice(0, 200));
      return;
    }
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
// 白盒连库统一入口（2026-11-26 抢救 P1-1）：必须带 busy_timeout。
// 此前 11 处裸 new DatabaseSync 与 server 写事务竞合 → V1-⑥ / V17-⑦ 反复 database is locked（实测每 2-3 轮挂一次）。
function openWhiteDb(dbPath, opts) {
  const o = opts || {};
  let db;
  try { db = o.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath); }
  catch (e) { db = new DatabaseSync(dbPath); }
  try { db.exec('PRAGMA busy_timeout=8000;'); } catch (e) { /* 只读连接可能拒绝，忽略 */ }
  return db;
}

function makeDb(dbPath) {
  function open() {
    try { return openWhiteDb(dbPath, { readOnly: true }); } catch (e) { return openWhiteDb(dbPath); }
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
      const w = openWhiteDb(dbPath);
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

  // —— MV 白盒只读（V13，契约 v2 未提供这些查询端点 → 兜底，同 DEV-LEDGER 纪律）——
  function mvProject(id) {
    if (!findTable(/^mv_projects$/i)) return { error: '缺少 mv_projects 表（store.js MIGRATIONS v3 未落）' };
    const rows = all('SELECT * FROM mv_projects WHERE id=?', id);
    return { row: rows[0] || null };
  }
  function mvCharactersOf(projectId) {
    if (!findTable(/^mv_characters$/i)) return { error: '缺少 mv_characters 表（store.js MIGRATIONS v3 未落）' };
    return { rows: all('SELECT * FROM mv_characters WHERE project_id=? ORDER BY rowid ASC', projectId) };
  }
  function mvShotsOf(projectId) {
    if (!findTable(/^mv_shots$/i)) return { error: '缺少 mv_shots 表（store.js MIGRATIONS v3 未落）' };
    return { rows: all('SELECT * FROM mv_shots WHERE project_id=? ORDER BY seq ASC', projectId) };
  }
  function mvTakesOf(shotId) {
    if (!findTable(/^mv_takes$/i)) return { error: '缺少 mv_takes 表（store.js MIGRATIONS v3 未落）' };
    return { rows: all('SELECT * FROM mv_takes WHERE shot_id=? ORDER BY rowid ASC', shotId) };
  }
  function mvJobsOf(userId) {
    return { rows: all("SELECT * FROM jobs WHERE user_id=? AND type LIKE 'mv_%' ORDER BY rowid ASC", userId) };
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

  return { dbPath, all, tables, columns, findTable, ledgerRows, setLastCreditDate, uploadTtlRows, auditRowsLike,
    mvProject, mvCharactersOf, mvShotsOf, mvTakesOf, mvJobsOf };
}

// ---------- 套件自举 ----------
// boot('V1') → { port, baseUrl, varDir, dbPath, api, executor, db, ffmpeg, close(), me/credits/newGuest 等 }
async function boot(suiteName, opts) {
  opts = opts || {}; // {env:{...}}：套件级 env 覆盖（如 V16 开助手灰度 MB_MV_ASSISTANT_CHAT，端点仍指不可达）
  // 二期追加（V14/V15 真机套件，additive 不改默认行为）：
  //   opts.runId          —— 固定 var-test/<runId>（真机断点续作：kill 后用同一 runId 重 boot 复验状态完好）
  //   opts.noFakeExecutor —— 不启动内置 FakeExecutor（真机语境：真实 executor 是唯一拉单者，假执行器注册会抢单）
  const runId = opts.runId || (String(suiteName || 'SUITE') + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex'));
  const varDir = path.join(ROOT, 'var-test', runId); // 独立 var 前缀，互不污染（正式运行时数据在 var/）
  // 抢救 P0-7：套件垃圾自增回收 —— 一次全量跑约留 20 个目录 / 0.1G，历史累积到 3.4G / 645 个目录。
  // 只保留最近 KEEP 个（正在使用的当前 runId 永不删），失败排查窗口内仍可复查。
  try {
    const KEEP = Number(process.env.MB_TEST_KEEP_RUNS || 40);
    // 只按"个数"回收不够：V8/V2/V4 这类带音频产物的套件单个目录就有 12–36M，
    // 20 轮全量跑完 40 个目录能堆到 224M，直接顶破 P0-7 的 `du -sh var-test < 200M` 判据。
    // 故再加**总量上界**：先按个数削，再从最旧的开始删到总占用 ≤ KEEP_MB（当前 runId 永不删）。
    const KEEP_MB = Math.max(16, Number(process.env.MB_TEST_KEEP_MB || 120));
    const base = path.join(ROOT, 'var-test');
    const dirBytes = (p) => {
      let sum = 0;
      const stack = [p];
      while (stack.length) {
        const cur = stack.pop();
        let ents;
        try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of ents) {
          const fp = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(fp);
          else { try { sum += fs.statSync(fp).size; } catch (e2) { /* 竞态删除 */ } }
        }
      }
      return sum;
    };
    if (fs.existsSync(base)) {
      const dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory())
        .map(d => ({ n: d.name, t: fs.statSync(path.join(base, d.name)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      const doomed = new Set(dirs.slice(KEEP).map(d => d.n));
      let total = 0;
      const kept = [];
      for (const d of dirs) {
        if (doomed.has(d.n)) continue;
        const abs = path.join(base, d.n);
        const b = abs === varDir ? 0 : dirBytes(abs); // 当前 run 的目录不计入待删额度
        total += b; kept.push({ n: d.n, b });
      }
      if (total > KEEP_MB * 1024 * 1024) {
        for (const d of kept.slice().reverse()) { // 从最旧的开始削
          if (total <= KEEP_MB * 1024 * 1024) break;
          doomed.add(d.n); total -= d.b;
        }
      }
      for (const n of doomed) {
        if (path.join(base, n) === varDir) continue;
        try { fs.rmSync(path.join(base, n), { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
      }
    }
  } catch (e) { /* 回收失败不影响验收 */ }
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
    // 默认仍指向不可达地址 → 走确定性启发式（无 GPU 也能跑闸门）。
    // 设 MB_TEST_LLM_URL 即切到真 LLM（助手线真值验证，DGX 实测 http://127.0.0.1:8090/v1 + qwen38-fp4）。
    MB_LLM_VLM_URL: process.env.MB_TEST_LLM_URL || LLM_DEAD_URL,
    MB_LLM_VLM_MODEL: process.env.MB_TEST_LLM_MODEL || 'qwen38-fp4',   // 不可达 → 确定性启发式兜底（契约 §0），无 GPU/LLM 也能全链路
    MB_MUSIC_URL: 'http://127.0.0.1:9',             // 本套件不真打 GPU（fake executor 产 mock 音频）
    MB_SENSEVOICE_URL: 'http://127.0.0.1:9',
    // —— MV 二期（V13）：开灰度总开关；GPU 端点一律指向不可达（严禁触 :8188/:8090/模型）——
    MB_MV_ENABLED: '1',
    MB_COMFY_URL: 'http://127.0.0.1:9',             // 不可达（验收纪律：绝不发任务给剧场 ComfyUI）
    MB_LIPSYNC_URL: 'http://127.0.0.1:9',
    MB_FACEGATE_URL: 'http://127.0.0.1:9',
    MB_MV_ASSISTANT_CHAT: '0',                      // 对话版助手关（N2 灰度项，不阻塞主流程；opts.env 可覆盖）
    NODE_NO_WARNINGS: '1',
  }, opts.env || {});

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
        // 就绪探针也必须带合格锚点：服务端已拒绝无锚点建号（身份可恢复性 P0）
        const r = await api('POST', '/v1/auth/guest', { json: { device_key: 'boot-probe-' + runId }, timeoutMs: 3000 });
        if (r.ok && r.json && r.json.access_token) { ready = true; break; }
        lastErr = 'guest HTTP ' + r.status + ' ' + r.text.slice(0, 120);
      } else lastErr = 'healthz HTTP ' + h.status;
    } catch (e) { lastErr = e.message; }
    await sleep(250);
  }
  if (!ready) throw new Error('验收自举失败：15s 内 server 未就绪（/healthz + POST /v1/auth/guest → {access_token,…}）。最后错误: ' + lastErr + '。日志尾部:\n' + log.slice(-2500));
  // 就绪的完整判据：迁移真正落盘可见（白盒 seed 直接开库写；防 server init 与白盒写的可见性竞态，
  // 偶发 "no such table: works" / 白盒写入对 server 不可见的 flake，2026-11-24 夜间档用例暴露）
  {
    const t1 = Date.now();
    for (;;) {
      let hasWorks = false;
      try {
        const d0 = openWhiteDb(dbPath, { readOnly: true });
        try { hasWorks = !!d0.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='works'").get(); }
        finally { try { d0.close(); } catch (e) { /* noop */ } }
      } catch (e) { /* server 尚未建文件，继续等 */ }
      if (hasWorks) break;
      if (Date.now() - t1 > 15000) throw new Error('验收自举失败：server 已应答但 15s 内 sqlite schema（works 表）对白盒不可见。日志尾部:\n' + log.slice(-2500));
      await sleep(150);
    }
  }

  const executor = new FakeExecutor(baseUrl);
  executor.varDir = varDir;
  if (!opts.noFakeExecutor) await executor.start(); // 真机套件（V14/V15）传 noFakeExecutor：真实 executor 独占拉单

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
  ctx.newGuest = async (guestOpts) => {
    // 每个测试用户**各自一个**锚点：同一 device_key 必须复用同一游客号（服务端已硬性要求），
    // 但绝不能整套件共用一个 —— 那会让"两个不同用户"静默变成同一个人，隔离类判词当场失真。
    const go = guestOpts || {};
    const dk = go.deviceKey || ('test-device-' + crypto.randomBytes(16).toString('hex'));
    const r = await api('POST', '/v1/auth/guest', { json: { device_key: dk } });
    if (!r.ok || !r.json || !r.json.access_token) throw new Error('契约 §2 POST /v1/auth/guest 应 200 {access_token,refresh_token,user:{is_guest:true}}，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    return { token: r.json.access_token, refreshToken: r.json.refresh_token, user: r.json.user, deviceKey: dk, firstTime: r.json.first_time, resp: r };
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

  // —— MV 白盒 seed（V13：mv job/shot 派单端点尚未进契约 → 白盒补种前置，server 落 /jobs 后删除）——
  // 白盒写统一走 seedWrite：瞬时 SQLITE_BUSY/LOCKED/（极端窗口下的）no such table 重试 ≤8s，防与 server 写者的偶发对撞 flake
  const _syncSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  function seedWrite(fn) {
    const t0 = Date.now();
    for (;;) {
      const w = openWhiteDb(dbPath);
      try { return fn(w); }
      catch (e) {
        const m = String((e && e.message) || e);
        if (/BUSY|LOCKED|no such table/i.test(m) && Date.now() - t0 < 8000) {
          try { w.close(); } catch (e2) { /* noop */ }
          Atomics.wait(_syncSleepBuf, 0, 0, 150);
          continue;
        }
        throw e;
      } finally { try { w.close(); } catch (e2) { /* noop */ } }
    }
  }
  ctx.seedWork = (userId, opts) => {
    opts = opts || {};
    const id = opts.id || uniq('w_');
    seedWrite((w) => {
      w.prepare('INSERT INTO works(id,user_id,title,status,lyrics,duration_sec,format,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, userId, opts.title || '验收 MV 母带', 'draft', opts.lyrics === undefined ? '' : opts.lyrics,
          opts.duration_sec == null ? 45 : opts.duration_sec, 'wav', new Date().toISOString());
    });
    return id;
  };
  ctx.seedMvJob = (opts) => {
    const id = uniq('j_');
    const now = new Date().toISOString();
    seedWrite((w) => {
      w.prepare('INSERT INTO jobs(id,type,payload,status,idem_key,attempts,progress,credits_cost,user_id,parent_job_id,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?,?,?,?)')
        .run(id, opts.type, JSON.stringify(opts.payload || {}), 'queued', opts.idemKey || null,
          Math.trunc(Number(opts.creditsCost) || 0), opts.userId || null, opts.parentJobId || null, now, now);
    });
    // 无需通知 server：engine.poll 有 2s 安全轮询兜底（core/engine.js），白盒种子 job 会被领走
    return id;
  };
  ctx.seedMvShot = (projectId, opts) => {
    opts = opts || {};
    const id = opts.id || uniq('mvs_');
    seedWrite((w) => {
      w.prepare('INSERT INTO mv_shots(id,project_id,seq,kind,sec,status,rerolls) VALUES(?,?,?,?,?,?,0)')
        .run(id, projectId, opts.seq == null ? 1 : opts.seq, opts.kind || 'story', opts.sec == null ? 5 : opts.sec, opts.status || 'draft');
    });
    return id;
  };
  ctx.setMvShot = (shotId, fields) => {
    const keys = Object.keys(fields || {});
    if (!keys.length) return;
    seedWrite((w) => {
      w.prepare('UPDATE mv_shots SET ' + keys.map((k) => k + '=?').join(',') + ' WHERE id=?')
        .run(...keys.map((k) => fields[k]), shotId);
    });
  };
  // takes 种子（N1-5 TTL 用例前置）：产物文件真实落 outDir（可设 mtime 年龄），created_at 可按小时回拨
  ctx.seedMvTake = (shotId, opts) => {
    opts = opts || {};
    const id = opts.id || uniq('mvt_');
    // 产物命名与真实 saveToOut 一致（yyyy-mm/f_*.mp4），保证「被引用=可识别」不误入无主清理
    const _d = new Date();
    const month = _d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0');
    const rel = opts.videoUrl || (month + '/f_' + crypto.randomBytes(10).toString('hex') + '.mp4');
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, opts.fileBytes || makeMp4Stub(id));
    const ageMs = (opts.ageHours == null ? 0 : Number(opts.ageHours)) * 3600000;
    if (ageMs > 0) { const t = new Date(Date.now() - ageMs); fs.utimesSync(abs, t, t); }
    const created = opts.createdAt || new Date(Date.now() - ageMs).toISOString();
    seedWrite((w) => {
      w.prepare('INSERT INTO mv_takes(id,shot_id,job_id,engine_tier,video_url,lipsynced,sync_score,origin,ai_label,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, shotId, opts.jobId || null, opts.tier || 'quality', rel, opts.lipsynced ? 1 : 0,
          opts.sync_score == null ? null : opts.sync_score, opts.origin || 'auto', 1, created);
    });
    return { id, rel, abs };
  };
  // 无主产物文件种子（TTL orphan 用例）：直接落 outDir，可控 mtime 年龄
  ctx.seedOutFile = (rel, ageHours) => {
    const abs = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, makeMp4Stub(rel));
    const h = Number(ageHours) || 0;
    if (h > 0) { const t = new Date(Date.now() - h * 3600000); fs.utimesSync(abs, t, t); }
    return { rel, abs };
  };
  // —— wave-2 白盒（V13 v2.8：状态推进/账本种子——契约未提供这些端点，同 DEV-LEDGER 纪律只作测试前置）——
  ctx.setMvProject = (projectId, fields) => {
    const keys = Object.keys(fields || {});
    if (!keys.length) return;
    seedWrite((w) => {
      w.prepare('UPDATE mv_projects SET ' + keys.map((k) => k + '=?').join(',') + ' WHERE id=?')
        .run(...keys.map((k) => fields[k]), projectId);
    });
  };
  // 账本种子：正数=发放（测试充值）；负数+projectId=mv 派单扣分模拟（ref=(mv_project,pid)，供 cancel 退款核算用例）
  ctx.seedLedger = (userId, delta, opts) => {
    opts = opts || {};
    seedWrite((w) => {
      const last = w.prepare('SELECT balance_after FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(userId);
      const bal = (last ? last.balance_after : 0) + Math.trunc(delta);
      w.prepare('INSERT INTO credit_ledger(id,user_id,delta,balance_after,reason,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(uniq('cl_'), userId, Math.trunc(delta), bal, opts.reason || (delta >= 0 ? 'test_grant' : 'mv_shot'),
          opts.refType || (delta >= 0 ? 'test' : 'mv_project'), opts.refId || (delta >= 0 ? 'seed' : (opts.projectId || 'seed')), new Date().toISOString());
    });
    return Math.trunc(delta);
  };
  ctx.mvJobRows = (userId, type) => {
    const like = type ? " AND type='" + type.replace(/[^\w_]/g, '') + "'" : '';
    return db.all("SELECT * FROM jobs WHERE user_id=? AND type LIKE 'mv_%'" + like + ' ORDER BY rowid ASC', userId);
  };

  return ctx;
}

// ---------- 最小 WSS 客户端（V13 mv.progress 断言；服务端帧不掩码，手写解析零依赖） ----------
function wsConnect(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: '/ws?token=' + encodeURIComponent(token || ''),
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
      },
      timeout: 10000,
    });
    req.on('response', (res) => { req.destroy(); reject(new Error('WS 升级失败 HTTP ' + res.statusCode)); });
    req.on('timeout', () => { req.destroy(); reject(new Error('WS 升级超时')); });
    req.on('error', reject);
    req.on('upgrade', (res, socket, head) => {
      const client = { events: [], closed: false, _waiters: [] };
      client.close = () => { client.closed = true; try { socket.destroy(); } catch (e) { /* noop */ } };
      client.waitFor = (pred, timeoutMs) => new Promise((res2) => {
        const hit = client.events.find(pred);
        if (hit) return res2(hit);
        const timer = setTimeout(() => {
          client._waiters = client._waiters.filter((wt) => { if (wt.pred === pred) { wt.resolve(null); return false; } return true; });
        }, timeoutMs || 15000);
        client._waiters.push({ pred, resolve: (v) => { clearTimeout(timer); res2(v); } });
      });
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (opcode === 0x8) { client.closed = true; return; }
          if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, payload.length])); } catch (e) { /* noop */ } continue; } // pong 回
          if (opcode === 0x1) {
            let obj = null;
            try { obj = JSON.parse(payload.toString('utf8')); } catch (e) { /* 忽略非 JSON */ }
            if (!obj) continue;
            client.events.push(obj);
            client._waiters = client._waiters.filter((wt) => { if (wt.pred(obj)) { wt.resolve(obj); return false; } return true; });
          }
        }
      });
      socket.on('error', () => { client.closed = true; });
      socket.on('close', () => { client.closed = true; });
      resolve(client);
    });
    req.end();
  });
}

module.exports = {
  ROOT, BASE_PORT, EXECUTOR_TOKEN, DEV_OTP, WORD_A, WORD_B, HIGHCONF_MARKER,
  boot, api: makeApi, httpReq, buildMultipart, makeSineWav, makePng, makeMp4Stub, makeMockMp4, findFfmpeg, computePeaks,
  FakeExecutor, makeDb, resolveVarPath, sleep, uniq, wsConnect, openWhiteDb,
  realLLM: !!process.env.MB_TEST_LLM_URL,   // true → 走真 LLM（DGX qwen38-fp4）；false → 启发式兜底（闸门默认）
};
