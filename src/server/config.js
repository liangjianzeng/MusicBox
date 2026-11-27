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
function envFloat(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

const config = {
  // —— 运行环境（2026-11-26 抢救 P0-3）：prod 下任何不安全默认值直接拒绝启动，见 core/security.js ——
  env: envStr('MB_ENV', 'dev'),
  // —— 服务端口与对外地址 ——
  port: envInt('MB_PORT', 7900),
  bind: envStr('MB_BIND', '0.0.0.0'), // 真机调试需局域网可达；生产建议 127.0.0.1 + 反向代理
  publicBaseUrl: envStr('MB_PUBLIC_BASE_URL', 'http://127.0.0.1:7900'),
  // —— 执行器与引擎端点（CONTRACTS §0 定稿）——
  executorToken: envStr('MB_EXECUTOR_TOKEN', 'dev-executor-token'),
  musicUrl: envStr('MB_MUSIC_URL', 'http://127.0.0.1:8190'),        // ACE-Step 1.5（5060 Ti）
  // DGX Spark 已托管的 qwen38-fp4（OpenAI 兼容）。2026-11-26 实测 http://127.0.0.1:8090/v1/models → id=qwen38-fp4。
  // 历史默认 :8193（自建 vLLM 双实例）已随契约 §0 作废，别再往回改。
  llmVlmUrl: envStr('MB_LLM_VLM_URL', 'http://127.0.0.1:8090/v1'),
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
    leaseMs: envInt('MB_LEASE_MS', 10 * 60000),    // 租约 10min（可加速供验收观察租约回收/看护上界）
    parentGuardMs: envInt('MB_PARENT_GUARD_MS', 30 * 60000), // 父 job 等子 job 的看护上界：超时把卡死的后处理子 job 判失败，禁止无限续租挂账（P1-2）
    creditAuditTicks: envInt('MB_CREDIT_AUDIT_TICKS', 12), // 每 N 次 sweep 做一次账本不变量巡检（测试可设 1）
    sweepMs: envInt('MB_SWEEP_MS', 30000), // 租约过期清扫周期（takes TTL 并入此作业，N1-5；验收可加速）
    maxAttempts: 3,         // attempts<3 回队，否则 failed+refund
    maxUploadMb: envInt('MB_MAX_UPLOAD_MB', 220), // executor complete multipart 上限（真机 45s 立体声 WAV≈8MB/候选，4×240s≈170MB；2026-11-23 由 20 上调）
    bodyLimitBytes: 1024 * 1024, // JSON body 上限 1MB
  },
  // —— 上传防线（CONTRACTS §8-2）——
  upload: {
    voiceMaxMb: 10, voiceMaxSec: 60, voiceExts: ['m4a', 'wav'],
    imageMaxMb: 8, imageExts: ['jpg', 'jpeg', 'png'],
    personaMinSec: 20, personaMaxSec: 40,
    // 「从作品提声纹」要在服务端裁剪音频。这台机器有 ffmpeg 就能用；
    // 没有就必须**明确失败**（503 + 让用户改走录音登记），绝不许静默把整条作品当声纹 ——
    // 真 bug：旧实现直接写 audio_master（240s 整条），既不满足 20-40s 契约，
    // 又把声纹落在公共 out 目录（违反 v5.2.1：声纹必须进私有 var/voices/）。
    ffmpegBin: process.env.MB_FFMPEG || 'ffmpeg',
    ttlHours: 72,           // uploads 表 72h TTL
  },
  // —— MV 二期（架构 §1.3/§5/§8；默认关闭，按灰度开放）——
  mv: {
    enabled: envStr('MB_MV_ENABLED', '0') === '1',               // 二期 MV 总开关，默认 false
    comfyBaseUrl: envStr('MB_COMFY_URL', 'http://127.0.0.1:8188'), // 共用 ComfyUI 队列（ADR-MV-4，只发任务+观测）
    facegateUrl: envStr('MB_MV_FACEGATE_URL', envStr('MB_FACEGATE_URL', 'http://127.0.0.1:8395')).replace(/\/+$/, ''),
    budgetDefault: envInt('MB_MV_BUDGET_DEFAULT', 1200),         // 项目级预算护栏默认值（D13）
    // credits.mv 定价（架构 §6 / mv-plan §6，照 v1 先扣后派单）：
    // preview 首次免（D9）；系统自动补拍恒 0（initiated_by=system）
    credits: {
      align: 5, cast: 20, cast_image: 10, cast_video: 20, storyboard: 5,
      shot: 40, lipsync: 20, preview: 5, compose: 10,
      reshoot_system: 0,
    },
    // 报价/ETA 常数（秒，架构 §8，随真机 EVIDENCE 刷新）
    est: { img: 15, video: 290, lipsync: 240, compose: 180, align: 30 },
    // 口型质量门（契约 v2.8.4 / 架构 S8）：sync_score < 阈值 → 系统免费补样 ≤2 次，仍不过 → B-roll+字幕降级
    syncThreshold: envFloat('MB_MV_SYNC_THRESHOLD', 0.6),
    // LLM 辅助单点超时（suggest/剧本/审读：快速失败不装忙，V13 断言 <30s 返回）
    llmAssistTimeoutMs: envInt('MB_MV_LLM_ASSIST_TIMEOUT_MS', 12000),
    // 夜间档（N1-5，架构 §8）：queue_mode='night' 项目的 mv_* jobs 仅在本机钟 window 内派发，窗口内 night 优先；
    // enabled=false → 不门控（night 等同 normal 随时派发）。测试钩子 env：MB_MV_FORCE_NIGHT=1 / MB_MV_FORCE_DAY=1。
    queueNightMode: {
      enabled: envStr('MB_MV_NIGHT_ENABLED', '1') === '1',
      window: [envInt('MB_MV_NIGHT_WINDOW_START', 0), envInt('MB_MV_NIGHT_WINDOW_END', 8)], // [0,8)=00:00–08:00
    },
    // 对话版助手（D11；灰度 0.2，默认关——Inkling-2-Mini 就位前不开）
    assistant: { chat: { enabled: envStr('MB_MV_ASSISTANT_CHAT', '0') === '1', grayscale: envFloat('MB_MV_ASSISTANT_GRAYSCALE', 0.2) } },
    mvModelLicense: { model: 'MiniMax-H3 Community', usage: 'attribution' }, // 许可 meta 路线（架构 §10/mv-plan §1.4）
  },
  // —— 音乐助手（契约 v3.1 / 架构 l2）：把 MV 已验证的助手治理范式横向搬到「音乐创作」域；默认关，按灰度开放 ——
  music: {
    assistant: {
      enabled: envStr('MB_MUSIC_ASSISTANT', '0') === '1', // 接口总闸（对齐 MB_MV_ENABLED 语义；关且后台开关未开→404）
      // LLM 增强灰度（对齐 MV assistant.chat：规则模式恒可见，LLM 解析按灰度）
      chat: { enabled: envStr('MB_MUSIC_ASSISTANT_CHAT', '0') === '1', grayscale: envFloat('MB_MUSIC_ASSISTANT_GRAYSCALE', 0.2) },
    },
  },
  // —— 开发开关 ——
  // 固定验证码（仅开发）：2026-11-26 抢救 P0-3 把默认值由 '1' 翻为 '0'（fail-closed）。
  // 开发机需免短信登录时显式导出 MB_DEV_OTP=1；prod 下带此开关会被 assertBootable 拒绝启动。
  DEV_OTP: envStr('MB_DEV_OTP', '0') === '1' ? '888888' : null,
  // worker 内部令牌（ASR/口型/换脸/对齐）：非空时 server 侧健康探测与执行器调用一律带 x-worker-token
  workerToken: envStr('MB_WORKER_TOKEN', ''),
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
    voices: path.join(VAR, 'voices'),      // 声纹样本（PIPL 敏感个人信息）：**不在 /f/* 公共静态目录下**，仅属主/执行器经鉴权取件
    config: path.join(VAR, 'config'),     // 运营侧配置（审核词库等）
  },
  moderationWordFile: path.join(VAR, 'config', 'moderation_words.txt'),
};

module.exports = config;
