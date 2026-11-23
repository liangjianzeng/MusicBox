// 服务端集中配置：端口/端点/积分表/开发开关，全部支持 MB_* 环境变量覆盖（2026-11-23）
'use strict';
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..'); // 项目根 E:\Work\MusicBox
const VAR = process.env.MB_VAR_ROOT
  ? path.resolve(process.env.MB_VAR_ROOT)
  : path.join(ROOT, 'var');

function envStr(name, dflt) {
  const v = process.env[name];
  return v === undefined || v === '' ? dflt : v;
}
function envInt(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const config = {
  // —— 服务端口与对外地址 ——
  port: envInt('MB_PORT', 7900),
  publicBaseUrl: envStr('MB_PUBLIC_BASE_URL', 'http://127.0.0.1:7900'),
  // —— 执行器与引擎端点（CONTRACTS §0 定稿）——
  executorToken: envStr('MB_EXECUTOR_TOKEN', 'dev-executor-token'),
  musicUrl: envStr('MB_MUSIC_URL', 'http://127.0.0.1:8190'),        // ACE-Step 1.5（5060 Ti）
  llmVlmUrl: envStr('MB_LLM_VLM_URL', 'http://127.0.0.1:8193/v1'),  // DGX 托管 qwen38-fp4，OpenAI 兼容（内网实值见 deploy/spark/README）
  llmVlmModel: envStr('MB_LLM_VLM_MODEL', 'qwen38-fp4'),            // vLLM /models 返回的模型名
  senseVoiceUrl: envStr('MB_SENSEVOICE_URL', 'http://127.0.0.1:8191'),
  llmTimeoutMs: envInt('MB_LLM_TIMEOUT_MS', 60000),                 // 单轮 LLM 超时（思考模型推理耗时，2026-11-23 由 20s 上调）
  llmRetries: envInt('MB_LLM_RETRIES', 1),                          // 失败重试次数
  // —— 积分口径（CONTRACTS §1）——
  credits: {
    daily_free: envInt('MB_CREDIT_DAILY_FREE', 50),   // 每日免费，不结转
    per_candidate: envInt('MB_CREDIT_PER_CANDIDATE', 15), // generate 每候选
    adjust: envInt('MB_CREDIT_ADJUST', 10),           // 微调 variation
    extend: envInt('MB_CREDIT_EXTEND', 20),
    cover: envInt('MB_CREDIT_COVER', 20),
    dsp: envInt('MB_CREDIT_DSP', 5),
  },
  // —— 生成参数边界 ——
  gen: { sec_min: 15, sec_max: 240, sec_default: 45, count_min: 1, count_max: 4, count_default: 3 },
  // —— 任务引擎 ——
  engine: {
    pollHoldMs: 25000,      // long-poll 最长挂起
    leaseMs: 10 * 60000,    // 租约 10min
    sweepMs: 30000,         // 租约过期清扫周期
    maxAttempts: 3,         // attempts<3 回队，否则 failed+refund
    maxUploadMb: envInt('MB_MAX_UPLOAD_MB', 220), // executor complete multipart 上限（真机 45s 立体声 WAV≈8MB/候选，4×240s≈170MB；2026-11-23 由 20 上调）
    bodyLimitBytes: 1024 * 1024, // JSON body 上限 1MB
  },
  // —— 上传防线（CONTRACTS §8-2）——
  upload: {
    voiceMaxMb: 10, voiceMaxSec: 60, voiceExts: ['m4a', 'wav'],
    imageMaxMb: 8, imageExts: ['jpg', 'jpeg', 'png'],
    personaMinSec: 20, personaMaxSec: 40,
    ttlHours: 72,           // uploads 表 72h TTL
  },
  // —— 开发开关 ——
  DEV_OTP: envStr('MB_DEV_OTP', '1') === '1' ? '888888' : null, // 固定验证码（仅开发）
  otpTtlMs: 5 * 60000,
  accessTokenTtlMs: 2 * 60 * 60000,
  refreshTokenTtlMs: 30 * 24 * 3600 * 1000,
  // —— 运行时路径（一律 var/）——
  paths: {
    root: ROOT,
    var: VAR,
    db: path.join(VAR, 'db', 'musicbox.sqlite'),
    out: path.join(VAR, 'out'),           // 公共可读产物（/f/* 映射此目录）
    uploads: path.join(VAR, 'uploads'),   // 私有上传暂存（72h TTL）
    config: path.join(VAR, 'config'),     // 运营侧配置（审核词库等）
  },
  moderationWordFile: path.join(VAR, 'config', 'moderation_words.txt'),
};

module.exports = config;
