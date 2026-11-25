// MusicBox 执行器 daemon —— 注册 lanes → long-poll 领单 → 分发执行 → 进度/回传/心跳 → 优雅退出（2026-11-23）
// 启动：node src/executor/index.js --api http://127.0.0.1:7900 --token <executorToken> --lanes music,intent,ffmpeg
// 常用环境：EXECUTOR_MOCK=1（music/intent/mv_* 走 mock 真产物）；MB_MUSIC_URL/MB_ASR_URL/MB_LLM_VLM_URL/MB_VAR_DIR/MB_FFMPEG
// MV（二期）lane：imgspark/vidspark/lipsync/align（+ffmpeg 复用）；MB_COMFY_URL/MB_LIPSYNC_URL/MB_FACEGATE_URL/MB_MV_ASR_URL
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('./lib/net.js');

const VERSION = '1.0.0';
const POLL_TIMEOUT_MS = 35000;  // 服务端 long-poll 最长 25s，客户端留裕量
const HEARTBEAT_MS = 60000;     // 执行中每 60s 续租
const UPLOAD_RETRY = 3;

// ---------- 参数与配置 ----------
function parseArgs(argv) {
  const args = { lanes: null, api: null, token: null, mvAspectRatio: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const take = (cur) => cur !== null && cur !== undefined ? cur : (i + 1 < argv.length ? argv[++i] : null);
    if (a === '--api') args.api = take(args.api);
    else if (a === '--token') args.token = take(args.token);
    else if (a === '--lanes') args.lanes = take(args.lanes);
    else if (a === '--mv-aspect-ratio' || a === '--mv-aspect') args.mvAspectRatio = take(args.mvAspectRatio);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--api=')) args.api = a.slice(6);
    else if (a.startsWith('--token=')) args.token = a.slice(8);
    else if (a.startsWith('--lanes=')) args.lanes = a.slice(8);
    else if (a.startsWith('--mv-aspect-ratio=') || a.startsWith('--mv-aspect=')) args.mvAspectRatio = a.slice(a.indexOf('=') + 1);
  }
  return args;
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node src/executor/index.js --api <API地址> --token <执行器令牌> --lanes music,intent,ffmpeg,imgspark,vidspark,lipsync,align [--mv-aspect-ratio 9:16|16:9|1:1]\n' +
      '环境: EXECUTOR_MOCK=1 | MB_API_URL MB_EXECUTOR_TOKEN MB_LANES MB_VAR_DIR\n' +
      '      MB_MUSIC_URL(默认 http://127.0.0.1:8190) MB_ASR_URL(默认 http://127.0.0.1:8191)\n' +
      '      MB_LLM_VLM_URL(默认 http://127.0.0.1:8193/v1) MB_LLM_VLM_MODEL MB_FFMPEG MB_FFPROBE\n' +
      '      MV(二期): MB_COMFY_URL(默认 http://127.0.0.1:8188，只观测不干预) MB_LIPSYNC_URL(默认 :8390)\n' +
      '               MB_FACEGATE_URL(默认 :8395) MB_MV_ASR_URL(默认 :8391)\n' +
      '               MB_MV_ASPECT_RATIO MB_MV_FPS MB_MV_SEED MB_MV_FACEGATE_GATE MB_MV_CACHE_DIR\n' +
      '               MB_MV_COMPOSE_BUDGET_MS MB_MV_PREVIEW_BUDGET_MS');
    process.exit(0);
  }
  const lanes = String(args.lanes || process.env.MB_LANES || 'music,intent,ffmpeg')
    .split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const varDir = path.resolve(process.env.MB_VAR_DIR || path.join(process.cwd(), 'var'));
  return {
    api: String(args.api || process.env.MB_API_URL || 'http://127.0.0.1:7900').replace(/\/+$/, ''),
    token: String(args.token || process.env.MB_EXECUTOR_TOKEN || ''),
    lanes,
    varDir,
    execTmp: path.join(varDir, 'exec'),
    musicUrl: process.env.MB_MUSIC_URL || 'http://127.0.0.1:8190',
    asrUrl: process.env.MB_ASR_URL || 'http://127.0.0.1:8191',
    // MV（二期）：ComfyUI 共宿主只读观测+提交（架构 §1.2）；83xx 为 MusicBox 自有 worker 段
    comfyUrl: process.env.MB_COMFY_URL || 'http://127.0.0.1:8188',
    lipsyncUrl: process.env.MB_LIPSYNC_URL || 'http://127.0.0.1:8390',
    facegateUrl: process.env.MB_FACEGATE_URL || 'http://127.0.0.1:8395',
    mvAsrUrl: process.env.MB_MV_ASR_URL || 'http://127.0.0.1:8391',
    mvFontFile: process.env.MB_MV_FONT || '', // compose 叠层 drawtext 字体（可选，Spark Linux 默认 fontconfig 即可）
    mvAspectRatio: args.mvAspectRatio || process.env.MB_MV_ASPECT_RATIO || '9:16',
    mvFps: Number(process.env.MB_MV_FPS) || 24,
    mvSeed: Number(process.env.MB_MV_SEED),
    mvImageWidth: Number(process.env.MB_MV_IMAGE_WIDTH) || undefined,
    mvImageHeight: Number(process.env.MB_MV_IMAGE_HEIGHT) || undefined,
    mvFacegateGate: Number(process.env.MB_MV_FACEGATE_GATE),
    mvCacheDir: process.env.MB_MV_CACHE_DIR || path.join(__dirname, '..', '..', 'var', 'cache', 'mv'),
    composeBudgetMs: Number(process.env.MB_MV_COMPOSE_BUDGET_MS),
    previewBudgetMs: Number(process.env.MB_MV_PREVIEW_BUDGET_MS),
    llmVlmUrl: process.env.MB_LLM_VLM_URL || 'http://127.0.0.1:8193/v1',
    llmVlmModel: process.env.MB_LLM_VLM_MODEL || 'qwen38-fp4',
    ffmpegBin: process.env.MB_FFMPEG || 'ffmpeg',
    ffprobeBin: process.env.MB_FFPROBE || 'ffprobe',
    mock: process.env.EXECUTOR_MOCK === '1',
    pollIntervalMs: 1500,
  };
}

const cfg = loadConfig();
let serverNodes = null;
let nodeRefresh = null;
function log(msg) { console.log(new Date().toISOString().slice(11, 19) + ' [执行器] ' + msg); }

// 应用服务端下发的节点配置（后台可配，覆盖环境变量默认；env 仍作兜底）
function applyServerNodes(nodes) {
  if (!nodes || typeof nodes !== 'object') return;
  const map = {
    music: ['musicUrl'], asr: ['asrUrl'], llm: ['llmVlmUrl', 'llmVlmModel'],
    comfy: ['comfyUrl'], lipsync: ['lipsyncUrl'], facegate: ['facegateUrl'], mv_asr: ['mvAsrUrl'],
  };
  for (const kind of Object.keys(map)) {
    const n = nodes[kind]; if (!n) continue;
    const keys = map[kind];
    if (n.endpoint && keys[0]) cfg[keys[0]] = n.endpoint;
    if (n.engine && keys[1]) cfg[keys[1]] = n.engine;
  }
}

// type → lane 归属（music 家族复用音乐通道；intent/ffmpeg 一一对应；mv_* 为二期 MV 五 lane，架构 §3.2）
const ROUTE = {
  music: 'music', adjust: 'music', extend: 'music', cover: 'music', variation: 'music',
  intent_voice: 'intent', intent_image: 'intent', intent_text: 'intent',
  transcode: 'ffmpeg', dsp: 'ffmpeg',
  mv_cast_image: 'imgspark', mv_storyboard: 'imgspark',
  mv_cast_video: 'vidspark', mv_shot: 'vidspark',
  mv_lipsync: 'lipsync',
  mv_align: 'align',
  mv_preview: 'ffmpeg', mv_compose: 'ffmpeg',
};
const KNOWN_LANES = ['music', 'intent', 'ffmpeg', 'imgspark', 'vidspark', 'lipsync', 'align'];
cfg.lanes = cfg.lanes.filter((l) => KNOWN_LANES.indexOf(l) !== -1);

// ---------- API 客户端（全部带 X-Executor-Token） ----------
async function apiCall(method, apiPath, obj, timeoutMs, bodyOverride, contentType, extraOpts) {
  const headers = { 'x-executor-token': cfg.token };
  let body;
  if (bodyOverride !== undefined) { body = bodyOverride; headers['content-type'] = contentType; }
  else { body = JSON.stringify(obj || {}); headers['content-type'] = 'application/json'; }
  const opts = Object.assign({ headers, body, timeoutMs: timeoutMs || 15000 }, extraOpts || {});
  const res = await net.request(method, cfg.api + apiPath, opts);
  if (res.status < 200 || res.status >= 300) {
    const e = new Error('API ' + apiPath + ' 返回 ' + res.status + '：' + res.body.slice(0, 160).toString('utf8'));
    e.httpStatus = res.status;
    throw e;
  }
  return res.json();
}
const apiPost = (p, obj, t, extra) => apiCall('POST', p, obj, t, undefined, undefined, extra);

// ---------- 任务执行 ----------
function pickRunner(type) {
  const music = require('./lanes/music.js');
  const intent = require('./lanes/intent.js');
  const ffmpeg = require('./lanes/ffmpeg.js');
  const mock = require('./lanes/mock.js');
  const mv = require('./lanes/mv.js');
  switch (type) {
    case 'music': case 'adjust': case 'extend': case 'cover': case 'variation':
      return cfg.mock ? mock.runMusic : music.runMusic;
    case 'intent_voice': return cfg.mock ? mock.runVoice : intent.runVoice;
    case 'intent_image': return cfg.mock ? mock.runImage : intent.runImage;
    // 文本线不需要 ASR/LLM 也能诚实兜底，故 mock 模式同样走真实现
    case 'intent_text': return intent.runText;
    case 'transcode': return ffmpeg.runTranscode;
    case 'dsp': return ffmpeg.runDsp;
    // MV 家族（二期）：五 lane 全部汇聚到 lanes/mv.js 的分支表（mock 真产物桩 / 真 mode lib/comfy.js）
    case 'mv_cast_image': case 'mv_storyboard':
    case 'mv_cast_video': case 'mv_shot':
    case 'mv_lipsync': case 'mv_align':
    case 'mv_preview': case 'mv_compose':
      return mv.runMvJob;
    default: return null;
  }
}

async function postProgress(job, progress, note) {
  try {
    await apiPost('/executor/jobs/' + job.id + '/progress', { progress: Math.max(0, Math.min(100, Math.round(progress))), note: String(note || '') }, 10000);
  } catch (e) {
    log('进度上报失败(忽略) ' + job.id + '：' + e.message);
  }
}

async function postComplete(job, out) {
  const files = (out.files || []).map((f) => ({
    field: f.field,
    filename: f.filename || (f.field + (f.abs ? path.extname(f.abs) : '')),
    data: f.data !== undefined ? f.data : fs.readFileSync(f.abs),
    type: /\.json$/i.test(f.filename || f.field || '') ? 'application/json' : 'application/octet-stream',
  }));
  const result = Object.assign({}, out.result || {});
  const map = {};
  for (const f of out.files || []) map[f.logical || f.field] = f.field; // {逻辑名: 上传字段名}
  result.files = map;
  const mp = net.buildMultipart({ result: JSON.stringify(result) }, files);
  let lastErr = null;
  for (let attempt = 1; attempt <= UPLOAD_RETRY; attempt++) {
    try {
      await apiCall('POST', '/executor/jobs/' + job.id + '/complete', null, 120000, mp.body, 'multipart/form-data; boundary=' + mp.boundary);
      log('任务完成回传 ' + job.id + '（' + files.length + ' 个文件）');
      return;
    } catch (e) { lastErr = e; log('回传失败(' + attempt + '/' + UPLOAD_RETRY + ') ' + job.id + '：' + e.message); }
  }
  throw lastErr || new Error('回传失败');
}

async function postFail(job, code, message) {
  try {
    await apiPost('/executor/jobs/' + job.id + '/fail', { code: code || 'INTERNAL', message: message || '后台服务异常' }, 10000);
    log('任务失败上报 ' + job.id + '：' + (code || 'INTERNAL') + ' ' + (message || ''));
  } catch (e) {
    log('失败上报未送达 ' + job.id + '（租约到期后服务端自动回队）：' + e.message);
  }
}

async function runJob(job) {
  const laneName = ROUTE[job.type];
  log('领到任务 ' + job.id + ' 类型=' + job.type);
  if (!laneName || cfg.lanes.indexOf(laneName) === -1) {
    await postFail(job, 'UNSUPPORTED_JOB_TYPE', '本机未启用该任务通道');
    return;
  }
  const jobId = String(job.id == null ? '' : job.id);
  if (!jobId || jobId === '.' || jobId === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(jobId)) {
    await postFail(job, 'BAD_PARAMS', '任务目录名不合法'); return;
  }
  const workDir = path.join(cfg.execTmp, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  const hb = setInterval(async () => {
    try { await apiPost('/executor/heartbeat', { job_id: job.id }, 15000); }
    catch (e) { log('心跳失败(下轮重试)：' + e.message); }
  }, HEARTBEAT_MS);
  const ctx = {
    cfg, job, workDir, log,
    progress: (p, note) => postProgress(job, p, note),
  };
  try {
    const runner = pickRunner(job.type);
    if (!runner) { await postFail(job, 'UNSUPPORTED_JOB_TYPE', '不支持的任务类型'); return; }
    const out = await runner(job, ctx);
    await postComplete(job, out || { result: {}, files: [] });
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 保留备查 */ }
  } catch (e) {
    log('任务出错 ' + job.id + '：' + (e.failMessage || e.message) + (e.stack ? '\n' + String(e.stack).split('\n').slice(0, 3).join('\n') : ''));
    await postFail(job, e.failCode || 'INTERNAL', e.failMessage || '后台服务异常');
    log('工作目录留档：' + workDir);
  } finally {
    clearInterval(hb);
  }
}

// ---------- 主循环 ----------
let stopping = false;
let running = null; // 当前任务 Promise（SIGINT 时等待）
let pollAbortRef = null; // long-poll 中止钩子（SIGINT 时立刻断开挂起请求）

function stoppableSleep(ms) {
  return new Promise((resolve) => {
    const step = 100;
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (stopping || waited >= ms) { clearInterval(t); resolve(); }
    }, step);
    // 常驻保活：此定时器必须保持 ref——否则空闲退避时事件循环无被引用句柄，Node 会静默 exit 0（2026-11-23 修复空闲自杀 bug）
  });
}

async function registerWithRetry() {
  let attempt = 0;
  for (;;) {
    try {
      const r = await apiPost('/executor/register', { lanes: cfg.lanes, version: VERSION }, 15000);
      if (r && Number(r.poll_interval_ms) > 0) cfg.pollIntervalMs = Number(r.poll_interval_ms);
      if (r && r.nodes) { serverNodes = r.nodes; applyServerNodes(r.nodes); }
      log('已接入调度：执行器 ' + ((r && r.executor_id) || '?') + ' 通道=' + cfg.lanes.join(',') + (cfg.mock ? '（mock）' : '') + (serverNodes ? ' 节点=' + Object.keys(serverNodes).join(',') : ''));
      return;
    } catch (e) {
      attempt++;
      const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(attempt, 5)));
      log('接入失败：' + e.message + '，' + delay + 'ms 后重试');
      if (stopping) throw e;
      await stoppableSleep(delay);
    }
  }
}

async function main() {
  fs.mkdirSync(cfg.execTmp, { recursive: true });
  log('启动：API=' + cfg.api + ' 通道=' + cfg.lanes.join(',') + ' 数据目录=' + cfg.varDir + (cfg.mock ? ' [MOCK]' : ''));
  if (!cfg.token) log('警告：未提供执行器令牌，调度端可能拒绝');
  await registerWithRetry();
  // 周期刷新节点配置（后台可配即时生效；每 30s 复用 register 顺带刷新 last_seen）
  nodeRefresh = setInterval(async () => {
    if (stopping) return;
    try {
      const r = await apiPost('/executor/register', { lanes: cfg.lanes, version: VERSION }, 10000);
      if (r && r.nodes) { serverNodes = r.nodes; applyServerNodes(r.nodes); }
    } catch (e) { /* 网络异常：保持当前节点 */ }
  }, 30000);
  let netStreak = 0;
  const pollAbort = { current: null };
  pollAbortRef = pollAbort;
  while (!stopping) {
    try {
      const r = await apiPost('/executor/poll', { lanes: cfg.lanes }, POLL_TIMEOUT_MS, { abortRef: pollAbort });
      netStreak = 0;
      const job = r && r.job;
      if (!job || !job.id) { await stoppableSleep(cfg.pollIntervalMs); continue; } // 无 job：1.5s 退避
      running = runJob(job);
      await running;
      running = null;
    } catch (e) {
      running = null;
      if (stopping && (e.netCode || e.message === 'AbortError')) break;
      netStreak++;
      const delay = Math.min(30000, 1500 * Math.pow(2, Math.min(netStreak, 5))); // 网络错误指数退避
      log('调度通信异常：' + e.message + '，' + delay + 'ms 后重试');
      await stoppableSleep(delay);
    }
  }
  if (running) { try { await running; } catch (e) { /* 收尾 */ } } // SIGINT 后等待当前任务收尾
  log('执行器已退出');
}

process.on('SIGINT', () => {
  if (stopping) { log('再次收到中断，强制退出'); process.exit(1); }
  stopping = true;
  log('收到退出信号，等待当前任务收尾后退出（再按一次强制退出）');
  if (nodeRefresh) clearInterval(nodeRefresh);
  if (pollAbortRef && pollAbortRef.current) { try { pollAbortRef.current(); } catch (e) { /* ignore */ } } // 立刻断开挂起的 long-poll
});
process.on('SIGTERM', () => { stopping = true; });
process.on('unhandledRejection', (e) => log('未捕获异常：' + (e && e.message || e)));

main().catch((e) => { log('致命错误：' + (e && e.stack || e)); process.exit(1); });
