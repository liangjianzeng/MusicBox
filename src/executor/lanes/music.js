// music lane —— 逐候选调用音乐生成服务(:8190) POST /music；persona 两段式克隆编排（2026-11-23）
// 失败口径：不可达→MUSIC_UNREACHABLE / 非200→MUSIC_HTTP / 超时→MUSIC_TIMEOUT；单候选 seed=seed_base+seed_delta
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('../lib/net.js');

const MUSIC_TIMEOUT_MS = 300000; // 单次生成最长 300s

function laneErr(code, message) { const e = new Error(message); e.failCode = code; e.failMessage = message; return e; }

// 网络层错误 → 契约错误码
function classifyNetErr(e) {
  if (e && e.failCode) return e;
  if (e && e.netCode === 'TIMEOUT') return laneErr('MUSIC_TIMEOUT', '音乐生成服务响应超时，请稍后重试');
  return laneErr('MUSIC_UNREACHABLE', '音乐生成服务不可达，请检查生成机状态');
}

// POST ${musicUrl}/music；body 见契约 §4；异常统一映射为 MUSIC_* 错误码
async function callMusic(musicUrl, body, log) {
  const base = String(musicUrl || '').replace(/\/+$/, '');
  const payload = JSON.stringify(body);
  let res;
  try {
    res = await net.request('POST', base + '/music', {
      headers: { 'content-type': 'application/json' },
      body: payload,
      timeoutMs: MUSIC_TIMEOUT_MS,
    });
  } catch (e) { throw classifyNetErr(e); }
  if (res.status !== 200) {
    log('生成服务返回 HTTP ' + res.status + '：' + res.body.slice(0, 200).toString('utf8'));
    throw laneErr('MUSIC_HTTP', '音乐生成服务响应异常（' + res.status + '）');
  }
  const j = res.json();
  if (!j || !j.file) throw laneErr('MUSIC_HTTP', '音乐生成服务返回数据不完整');
  return j; // {file, seconds, seed, gen_seconds, vram_peak_mb, task_type}
}

// 把**执行器本机的音频**投到引擎，换回**引擎本机绝对路径**（2026-11-27）。
// 声纹（ref_audio）和源曲（src_audio）**都要走它**：cover 任务里引擎要同时读这两个文件，只投一个
// 照样 HTTP 400 —— 声纹修好了、源曲还是异机路径，等于白修（2026-11-27 写判词时才发现）。
// 为什么非做不可：/music 的 ref_audio 走的是引擎侧 `os.path.isfile()`，只认它自己文件系统里的路径。
// 人格 WAV 存在服务端这台 Linux 机上，跨机拓扑下我们把 `/tmp/mb-dev/voices/xxx.wav` 递过去，
// 引擎那边永远读不到 —— 真机日志 `HTTP 400 {"detail":"ref_audio not found: ..."}` 就是它，
// 也就是说**人格克隆自上线以来没有一次真的生效过**，用户听到的"不像我的人格"根因在此。
// 老引擎没有 /ref（404/405）→ 诚实退回旧行为（直接用本机路径，同机部署本就正确），并回传 reason；
// 绝不因为投递失败就假装克隆成功，也绝不静默吞掉原因。
async function deliverAudio(refAbs, musicUrl, cfg, log) {
  const base = String(musicUrl || '').replace(/\/+$/, '');
  const key = process.env.ACE_REF_KEY || (cfg && cfg.aceRefKey) || '';
  if (!base) return { path: refAbs, uploaded: false, reason: 'no_endpoint' };
  let buf;
  try { buf = fs.readFileSync(refAbs); }
  catch (e) { return { path: refAbs, uploaded: false, reason: 'ref_unreadable' }; }
  const ext = (path.extname(refAbs) || '.wav').toLowerCase();
  let res;
  try {
    res = await net.request('POST', base + '/ref', {
      headers: {
        'content-type': 'application/octet-stream',
        'x-mb-ref-key': key,          // 引擎未配 ACE_REF_KEY 时会 503；空 key 会 401 —— 都会落到 meta
        'x-mb-ext': ext,
      },
      body: buf,
      timeoutMs: 60000,
    });
  } catch (e) { return { path: refAbs, uploaded: false, reason: 'net_' + (e && e.code || 'err') }; }
  if (res.status === 404 || res.status === 405) {
    log('引擎没有 /ref 声纹口（旧版本），退回本机路径 —— 跨机部署下这一步必然导致变声失败');
    return { path: refAbs, uploaded: false, reason: 'unsupported' };
  }
  if (res.status === 401) return { path: refAbs, uploaded: false, reason: 'key_rejected' };
  if (res.status === 503) return { path: refAbs, uploaded: false, reason: 'intake_disabled' };
  if (res.status !== 200) {
    const detail = res.body.slice(0, 160).toString('utf8');
    log('声纹投递被拒 HTTP ' + res.status + '：' + detail);
    return { path: refAbs, uploaded: false, reason: 'http_' + res.status, detail };
  }
  let j = null;
  try { j = res.json(); } catch (e) { /* 下面按坏响应处理 */ }
  const p = j && typeof j.path === 'string' ? j.path : '';
  if (!p) return { path: refAbs, uploaded: false, reason: 'bad_response' };
  log('声纹已投递 → 引擎路径 ' + p);
  return { path: p, uploaded: true, engineRefId: j.id, bytes: j.bytes };
}

// 生成产物落盘到工作目录。三种形态都要认（2026-11-27 真机实测：跨机部署必然走到第三种）：
//   ① URL → 下载；
//   ② 本机绝对路径 → 直接复制（生成服务与执行器同机，剧场 :8190 协议的原意）；
//   ③ **异机绝对路径**（引擎在 5060 Ti 那台机器上返回 E:\...\out\x.wav，Linux 执行器既读不到
//      也不该当成「产物缺失」）→ 按协议规范取件口 GET {musicUrl}/music/{id}/file 回捞。
// 之前只认 ①②，导致「引擎真的出歌了、执行器却报产物缺失」这种最难查的假故障。
async function ingestArtifact(genRes, destAbs, log, musicUrl) {
  const r = genRes && typeof genRes === 'object' ? genRes : { file: genRes };
  const s = String(r.file || '');
  if (/^https?:\/\//i.test(s)) {
    let res;
    try { res = await net.request('GET', s, { timeoutMs: 60000 }); }
    catch (e) { throw classifyNetErr(e); }
    if (res.status !== 200 || res.body.length < 100) throw laneErr('MUSIC_HTTP', '音乐生成产物下载失败');
    fs.writeFileSync(destAbs, res.body);
    return;
  }
  if (s && fs.existsSync(s)) { fs.copyFileSync(s, destAbs); return; }
  const id = String(r.id || '').trim();
  const base = String(musicUrl || '').replace(/\/+$/, '');
  if (id && base) {
    const url = base + '/music/' + encodeURIComponent(id) + '/file';
    let res;
    try { res = await net.request('GET', url, { timeoutMs: 120000 }); }
    catch (e) { throw classifyNetErr(e); }
    if (res.status === 200 && res.body.length >= 100) {
      fs.writeFileSync(destAbs, res.body);
      if (log) log('产物按协议取件口回捞成功（file 是异机路径 ' + s + '）：' + url);
      return;
    }
    throw laneErr('MUSIC_HTTP', '音乐生成产物取件失败（' + res.status + '）：' + url + '；file 字段=' + s);
  }
  throw laneErr('MUSIC_HTTP', '音乐生成产物缺失，无法取回；file 字段=' + s + '（且响应无 id，无法走 /music/{id}/file）');
}

// 人格声纹参考 —— 与产物取件口同一类问题（2026-11-27 真机语境：server 在 DGX、ACE-Step 在 GeekPro）。
// payload.persona.ref_abs_path 是**服务端**算出的绝对路径，执行器与 server 不同机时必然读不到；
// 旧代码 `p.persona && p.persona.ref_abs_path ? ... : null` 只看"有没有这个字段"，
// 于是变声阶段拿着一个不存在的路径去请求引擎（或整段静默跳过），用户以为克隆生效了其实没有。
// 现在：本机可读 → 直读；否则按鉴权取件口 GET {apiUrl}/v1/personas/{id}/voice 回捞（执行器令牌）。
const PERSONA_REF_TTL_MS = 10 * 60 * 1000;
const PERSONA_REF_MAX = 16;
const personaRefCache = new Map(); // `${apiUrl}|${personaId}` → {abs, bytes, at}
function personaRefPut(key, val) {
  personaRefCache.set(key, val);
  while (personaRefCache.size > PERSONA_REF_MAX) {
    const oldest = personaRefCache.keys().next().value;
    const old = personaRefCache.get(oldest);
    try { if (old && old.abs) fs.unlinkSync(old.abs); } catch (e) { /* 临时文件清理尽力而为 */ }
    personaRefCache.delete(oldest);
  }
}
const CT_EXT = { 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' };

async function resolvePersonaRef(persona, cfg, log) {
  if (!persona) return null;
  const abs = persona.ref_abs_path ? String(persona.ref_abs_path) : '';
  try { if (abs && fs.existsSync(abs) && fs.statSync(abs).size >= 100) return abs; } catch (e) { /* 当作读不到，走回捞 */ }
  const id = String(persona.id || '').trim();
  const base = String((cfg && cfg.apiUrl) || '').replace(/\/+$/, '');
  const tok = (cfg && cfg.executorToken) || process.env.MB_EXECUTOR_TOKEN || '';
  if (!id || !base || !tok) {
    if (log) log('人格声纹不可用且无法回捞（ref_abs_path=' + (abs || '空') + '，persona.id=' + (id || '缺')
      + '，apiUrl=' + (base || '缺') + '，token=' + (tok ? '有' : '缺') + '）—— 本候选按不克隆交付，不谎称已克隆');
    return null;
  }
  const key = base + '|' + id;
  const hit = personaRefCache.get(key);
  if (hit && Date.now() - hit.at < PERSONA_REF_TTL_MS && fs.existsSync(hit.abs) && fs.statSync(hit.abs).size === hit.bytes) {
    return hit.abs; // 同一 job 多候选复用，避免每候选重复下载
  }
  const url = base + '/v1/personas/' + encodeURIComponent(id) + '/voice';
  let res;
  try {
    res = await net.request('GET', url, { headers: { 'X-Executor-Token': tok }, timeoutMs: 60000 });
  } catch (e) {
    if (log) log('人格声纹取件网络失败（' + (e.netCode || e.message) + '）：' + url + ' —— 本候选按不克隆交付');
    return null;
  }
  if (res.status !== 200 || res.body.length < 100) {
    if (log) log('人格声纹取件失败 HTTP ' + res.status + '：' + url + ' —— 本候选按不克隆交付，不谎称已克隆');
    return null;
  }
  const ct = String(res.headers && res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const dir = path.join(os.tmpdir(), 'musicbox-persona-refs');
  fs.mkdirSync(dir, { recursive: true });
  const sha = crypto.createHash('sha256').update(res.body).digest('hex').slice(0, 12);
  const tmp = path.join(dir, id + '-' + sha + (CT_EXT[ct] || '.wav'));
  fs.writeFileSync(tmp, res.body);
  personaRefPut(key, { abs: tmp, bytes: res.body.length, at: Date.now() });
  if (log) log('人格声纹按鉴权取件口回捞成功（ref_abs_path 是异机路径 ' + (abs || '空') + '）：' + url);
  return tmp;
}

// runMusic(job, ctx) → {result, files}；files=[{field, filename, abs}]，由 daemon 统一 multipart 上传
async function runMusic(job, ctx) {
  const cfg = ctx.cfg;
  const p = job.payload || {};
  const count = Math.max(1, Math.min(4, Number(p.count) || 3));
  const candidates = (Array.isArray(p.candidates) && p.candidates.length)
    ? p.candidates
    : Array.from({ length: count }, (_, i) => ({ seq: i + 1, seed_delta: i }));
  const seedBase = Number.isFinite(Number(p.seed_base)) ? Number(p.seed_base) : 424242;
  // 节点选择：job.payload 里的 music_endpoint/music_engine 由后台/用户选择决定（后端配置，不写死）；缺省回退本机 cfg
  const musicUrl = p.music_endpoint || cfg.musicUrl;
  const sec = Math.max(15, Math.min(240, Number(p.sec) || 45));
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(/[,，]/).filter(Boolean);
  const instrumental = !!p.instrumental;
  const persona = p.persona && (p.persona.ref_abs_path || p.persona.id) ? p.persona : null;
  let cloneAppliedAny = false;

  const files = [];
  const resultCandidates = [];
  const n = candidates.length;
  await ctx.progress(3, n + ' 个候选排队中');

  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    const seq = Number(c.seq) || (i + 1);
    const seed = seedBase + (Number(c.seed_delta) || 0);
    // :8190 严格 schema（2026-11-23 实测 422 教训）：tags=逗号串（非数组）；bpm=null 或 30-300（0 非法）；
    // seconds 上限历史上是 180（引擎入口自设），2026-11-27 收编进 vendor/acestep 后放到 600（模型自身能力）。
    // 注意：**对外 API 仍是 sec 15-240**（contract sec_max），这里放宽只是不再让引擎入口二次砍用户的时长。
    const baseBody = {
      mood: p.mood || '温暖',
      seconds: Math.max(15, Math.min(600, sec)),
      seed,
      tags: tags.join(','),
      lyrics: p.lyrics || '',
      prompt: p.prompt || [p.mood, tags.join(' ')].filter(Boolean).join(' '),
      instrumental,
    };
    const bpmN = Number(p.bpm);
    if (Number.isFinite(bpmN) && bpmN >= 30 && bpmN <= 300) baseBody.bpm = Math.round(bpmN);

    // ① guide：完整歌（无 ref_audio）
    const r1 = await callMusic(musicUrl, baseBody, ctx.log);
    let finalAbs = path.join(ctx.workDir, 'cand_' + seq + '.wav');
    await ingestArtifact(r1, finalAbs, ctx.log, musicUrl);
    let meta = { clone: { applied: false, stage2_failed: false }, gen_seconds: r1.gen_seconds, task_type: r1.task_type };
    let finalSeconds = Number(r1.seconds) || sec;
    let finalSeed = Number.isFinite(Number(r1.seed)) ? Number(r1.seed) : seed;

    // ② persona：cover 变声（ref_audio + cover_strength）；失败诚实降级交 ①
    if (persona) {
      // cover_strength 由**服务端唯一写入**（works.js 归一化），执行器不再自己兜一个默认值：
      // 0.2 曾在 personas.js 两处 + 这里共三处硬编码，改一处漏两处，而且它恰恰是"能不能锁住音色/性别"的唯一旋钮。
      const cs = Number(persona.cover_strength);
      const refAbs = await resolvePersonaRef(persona, cfg, ctx.log);
      if (!refAbs) {
        // 诚实降级：拿不到声纹就**不假装克隆过**（applied=false），并保留 ① 的完整歌，用户仍有可交付产物。
        meta.clone = { applied: false, stage2_failed: false, ref_unavailable: true, mode: persona.clone_mode || 'full' };
      } else if (!Number.isFinite(cs)) {
        // 强度缺失＝请求本身不合法：宁可不套也不许猜一个数当"已克隆"。
        ctx.log('候选' + seq + ' 人格缺少 cover_strength（服务端未归一化），跳过变声阶段');
        meta.clone = { applied: false, stage2_failed: false, invalid_strength: true, mode: persona.clone_mode || 'full' };
      } else {
        // **先按"没克隆"记账**：applied 只有在 ② 跑完并把成品换成变声版之后才置 true。
        // 历史 bug：这里曾直接写 applied:true，失败分支只补 stage2_failed，于是出现
        // `applied:true + stage2_failed:true` —— 用户以为用了他的人格，其实拿到的是默认音色。
        meta.clone = { applied: false, attempted: true, stage2_failed: false, mode: persona.clone_mode || 'full', cover_strength: cs };
        let refForEngine = refAbs;
        let srcForEngine = finalAbs;   // 同机时就是本机路径；跨机由 /ref 换回来
        try {
          // 先把声纹投到引擎再发 cover：ref_audio 只认引擎自己文件系统里的路径。
          // 同机部署（引擎与执行器同一台机器）时 /ref 可能不存在，退回本机路径是正确行为；
          // 跨机部署时不投递就必然 MUSIC_HTTP —— 投递结果连同原因一起落到 meta，不留猜的空间。
          const dlv = await deliverAudio(refAbs, musicUrl, cfg, ctx.log);
          refForEngine = dlv.path;
          meta.clone.ref_delivery = {
            uploaded: dlv.uploaded === true,
            reason: dlv.reason || null,
            engine_path: dlv.uploaded ? dlv.path : null,
            engine_ref_id: dlv.engineRefId || null,
            bytes: typeof dlv.bytes === 'number' ? dlv.bytes : null,
          };
          // 源曲（① 的完整歌）也必须投：cover 任务里引擎要**同时**读 src_audio，
          // 只投声纹等于修了一半 —— 源曲还是执行器本机的路径，引擎那边照样 HTTP 400。
          const dlvs = await deliverAudio(finalAbs, musicUrl, cfg, ctx.log);
          srcForEngine = dlvs.path;
          meta.clone.src_delivery = {
            uploaded: dlvs.uploaded === true,
            reason: dlvs.reason || null,
            engine_path: dlvs.uploaded ? dlvs.path : null,
            bytes: typeof dlvs.bytes === 'number' ? dlvs.bytes : null,
          };
          const body2 = Object.assign({}, baseBody, {
            src_audio: srcForEngine,                   // ① 的完整歌（跨机时由 /ref 换来）
            ref_audio: refForEngine,                   // 引擎被要求读的声纹路径（跨机时由 /ref 换来）
            cover_strength: cs,
            instrumental: false,
          });
          // 必须与 ① 同一个 musicUrl：写死 cfg.musicUrl 会让"guide 走 payload.music_endpoint、变声走本机默认"，
          // 跨机拓扑下等于向另一台机器要 cover（要么不可达要么风格不一致）。
          const r2 = await callMusic(musicUrl, body2, ctx.log);
          const coverAbs = path.join(ctx.workDir, 'cand_' + seq + '.cover.wav');
          await ingestArtifact(r2, coverAbs, ctx.log, musicUrl);
          fs.renameSync(coverAbs, finalAbs);
          finalSeconds = Number(r2.seconds) || finalSeconds;
          meta.clone.gen_seconds = r2.gen_seconds;
          meta.clone.applied = true;   // ← 唯一允许置真的位置：成品已被变声版替换
          cloneAppliedAny = true;
        } catch (e) {
          ctx.log('候选' + seq + ' 变声阶段失败，降级使用初版：' + (e.failMessage || e.message));
          meta.clone.stage2_failed = true;
          meta.clone.stage2_error = e.failCode || 'INTERNAL';
          // 面包屑：跨机拓扑下的 MUSIC_HTTP 绝大多数是"引擎那台机器读不到这个路径"
          // （2026-11-27 真机就是靠 executor 日志里的 ref_audio not found 才定位到，查了 20 分钟）。
          // 把引擎被要求读的路径和引擎地址一起落到 meta 里，下次一眼可见。
          meta.clone.ref_path = refForEngine;   // 引擎**被要求读**的那个路径（跨机时是 /ref 换回来的）
          meta.clone.src_path = srcForEngine;   // 源曲也是引擎要读的文件，失败时同样要看得见
          meta.clone.ref_local = refAbs;        // 我们这边真正的声纹文件，两边不一致才看得出纳不到
          try { meta.clone.engine = new URL(musicUrl).host; } catch (err) { /* 地址不合法就不记，不影响降级 */ }
        }
      }
    }

    const field = 'master_' + seq;
    files.push({ field, filename: field + '.wav', abs: finalAbs });
    resultCandidates.push({
      seq, seed: finalSeed, seconds: finalSeconds,
      duration_sec: finalSeconds, // server completeMusic 读取此字段回填 candidates.duration_sec
      file: field, // 逻辑名，服务端据 result.files 映射回填 *_url
      title: '',
      meta,
    });
    await ctx.progress(Math.round(((i + 1) / n) * 99), '已完成第 ' + (i + 1) + '/' + n + ' 个候选');
  }

  const result = {
    files: {}, // {逻辑名: 上传字段名}，daemon 上传时同样填充
    candidates: resultCandidates,
    persona_applied: cloneAppliedAny, // 只报"真的克隆成功了几个"，不因 payload 带 persona 就谎称已克隆
    mock: false,
  };
  return { result, files };
}

module.exports = { runMusic, callMusic, classifyNetErr, resolvePersonaRef, MUSIC_TIMEOUT_MS };
