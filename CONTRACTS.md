# MusicBox · 冻结契约 v1（多智能体并行施工的唯一真源）

> 各施工方（server / executor+workers / app / tests）**只以本文档为接口真源**。改动契约必须先改本文档。
> 架构背景见 `docs/musicbox-architecture-design.md`（§1 拓扑、§3 服务端、§5 API、§6 序列）。

## 0. 全局约定

- **端口/端点（2026-11-23 定稿）**：Music API `:7900`；**ACE-Step 1.5 = 5060 Ti 服务**（剧场现有只读复用，`cfg.musicUrl` 默认 `http://127.0.0.1:8190`）；SenseVoice（执行器同机 CPU）`:8191`；**多模态 LLM/VLM = DGX Spark 已托管的 qwen38-fp4（OpenAI 兼容，单端点兼顾文本与图像）**，基址 `cfg.llmVlmUrl`（默认 `http://127.0.0.1:8193/v1`，环境变量 `MB_LLM_VLM_URL` 覆盖；**内网实测真值 `http://192.168.1.10:8090/v1`**，见 deploy/spark/README）——**不再自建 vLLM 双实例**。思考模型输出带 `reasoning`，客户端按 `content || reasoning` 兜底（2026-11-23 实测）。
- **语言与代码风格（服务端/执行器）**：Node.js ≥22，**零 npm 依赖**（只用 `node:` 内建模块，DB 用 `node:sqlite`），CommonJS，`"use strict"`，中文简短注释（剧场风格：文件头注明职责与日期）。运行时数据一律 `var/`（DB=`var/db/musicbox.sqlite`，音频=`var/out/<yyyy-mm>/`）。
- **错误约定**：HTTP 2xx=成功（直接返回业务 JSON，无 envelope 包装）；4xx/5xx=`{code, message}`。常用 code：`UNAUTHORIZED/ FORBIDDEN / NOT_FOUND / BAD_REQUEST / RATE_LIMITED / CREDITS_NOT_ENOUGH / MODERATION_BLOCK / INTERNAL`。
- **鉴权**：请求头 `Authorization: Bearer <access_token>`。执行器接口另用 `X-Executor-Token`（配置 `executorToken`）。
- **URL 字段**：所有返回给 App 的文件一律给**绝对 URL**（`cfg.publicBaseUrl + /f/...`），字段名 `*_url`。**部署纪律（2026-11-23 真机实测）**：`MB_PUBLIC_BASE_URL` 必须配置为**客户端可达地址**（真机=局域网/Tailscale IP；模拟器=10.0.2.2）；该值在 complete 时写死进 `*_url`，留默认 `127.0.0.1` 会使真机播放全挂。
- **用户面纪律**：任何引擎型号名（ACE-Step/Qwen/SenseVoice…）**不得出现在面向用户的字符串**；AI 生成内容必须带 `ai_label` 标记。
- **LLM 可选性**：`:8193` 不可达时，服务端必须走**确定性启发式兜底**（mood 关键词典），不得报错中断流程（confidence 降低即可）。开发机没有 GPU 服务也能全链路跑通。
- **Mock 执行器**：`EXECUTOR_MOCK=1` 时执行器对 `music/intent_voice` lane 产出**有效静音/正弦 wav**（真实可播放），保证无 GPU 环境端到端验收。

## 1. 积分口径（可调，集中 `config.js`）

| 项 | 值 |
|---|---|
| 每日免费积分 | 50（游客与注册用户同），不结转 |
| generate 每候选 | 15（默认 count=3 → 45） |
| adjust（微调 variation） | 10 |
| extend / cover | 20 |
| dsp | 5 |
| 失败 | 自动全额 refund（ledger reason=refund） |

## 2. REST 契约（前缀 `/v1`）

### 认证与账户
```
POST /v1/auth/guest                → 200 {access_token, refresh_token, user:{id, nickname, is_guest:true}}
POST /v1/auth/phone/request-code   {phone}         → 200 {sent:true}；DEV_OTP=1 时验证码固定 888888
POST /v1/auth/phone/verify         {phone, code}   → 200 {access_token, refresh_token, user:{id,nickname,is_guest:false}}
POST /v1/auth/refresh              {refresh_token} → 200 {access_token, refresh_token}
GET  /v1/me                        → 200 {user:{id,nickname,phone_masked,is_guest}, credits:{balance, daily_quota, daily_used}, prefs:{}}
```

### 文本创作线
```
POST /v1/works/generate   {mode:"simple"|"custom", prompt?, lyrics?, tags?, mood?, bpm?, sec?(15-240,默认45), count?(1-4,默认3), persona_id?}
                          → 202 {job_id, credits_charged, idempotent:false|true}
                          # 幂等键=hash(user_id+归一化参数)；重复提交返回同一 job（idempotent:true，不重复扣分）
GET  /v1/jobs/:id         → 200 {id, type, status:"queued"|"leased"|"running"|"done"|"failed"|"canceled",
                                 progress:0-100, note, candidates:[candidate]|null,
                                 error:{code,message}|null, result_work_id|null}
    candidate = {id, seq, title, audio_url, duration_sec, format:"mp3", waveform_url|null, meta:{}}
    # format=转码后的播放档 mp3（transcode 完成后 job 才算 done）；wav master 另存，供导出/seed-pack
    # 降级语义（2026-11-23 裁决，DEV-TXFAIL）：transcode 子任务永久失败（attempts 耗尽）→ 父 job 仍 done，
    #   候选保持 wav master（format="wav"、waveform_url=null、audio_url=master 直发、result.meta.degraded=true），
    #   **不退款**（生成本身成功、产物真实可播；转码失败属环境/执行器侧问题）；全部子任务 failed 且候选为空才 failed+refund。
# /f/* 为公共静态读（文件名为不可猜 id，无鉴权；生产由 Nginx 接管）
POST /v1/works/:id/adopt  {candidate_id}      → 200 {work}
GET  /v1/works            ?mine=1|public=1&genre&mood&bpm_min&bpm_max&q&cursor → 200 {items:[work], next_cursor}
GET  /v1/works/:id        → 200 {work, lineage_parents:[work(简)], children_count}
PATCH /v1/works/:id       {title?/mood?/genres?/rating?(1-5)/visibility?} → 200 {work}
```

### work 形状（全接口一致）
```js
work = { id, title, status:"draft"|"published"|"retired", mood, genres:[], bpm, duration_sec,
  lyrics, language, gen:{engine, seed}, lineage:{kind:"origin"|"adjust"|"variation"|"extend"|"cover", parent_id, depth},
  persona_id, rating, ai_label:true, visibility:"private"|"public",
  audio_url, waveform_url, created_at }
```

### 多模态意图线（M1）
```
POST /v1/intent/voice   multipart(field=file; m4a/wav ≤10MB ≤60s) → 202 {intent_id}
POST /v1/intent/image   multipart(field=file; jpg/png ≤8MB)       → 202 {intent_id}
GET  /v1/intent/:id     → 200 {intent}
POST /v1/intent/:id/answer {answers:[{q_idx, option_idx}]} → 200 {intent}   # 可能追加新题，status 仍 clarifying；≤2 轮
POST /v1/intent/:id/generate → 202 {job_id}    # 仅 status=ready 可调；卡变 consumed
POST /v1/works/:id/adjust  {text} → 200 {understood:true, job_id} | {understood:false, clarify:"…"}
```

### intent 形状
```js
intent = { id, source_kind:"voice"|"image"|"text", status:"clarifying"|"ready"|"consumed",
  mood:[], scene_desc, genre_hypotheses:[], vocal:"song"|"instrumental"|"unknown",
  duration_hint, confidence:0-1,
  questions:[{q_idx, q, options:[{idx, label}], recommended_idx}],   # options 恒 2-4 个
  answers:[{q_idx, option_idx}], created_at }
```
**澄清纪律（服务端强制）**：总轮次 ≤2、每轮 ≤2 题、每题必带 `recommended_idx`、`confidence≥0.75` 时 questions 为空数组直接 ready。

### 声音人格 / 谱系 / DSP / 分享
```
GET  /v1/personas                        → 200 {items:[{id,name,is_public,use_count,created_at}]}
POST /v1/personas                        multipart(name,file; 20-40s 音频) → 200 {persona}
POST /v1/works/:id/to-persona            {name} → 200 {persona}   # 从作品提声纹
POST /v1/works/:id/extend  {sec}         → 202 {job_id}
POST /v1/works/:id/cover   {persona_id}  → 202 {job_id}
POST /v1/works/:id/variation {delta:{tags?/mood?/bpm?/seed?}} → 202 {job_id}
POST /v1/works/:id/dsp     {op:"trim"|"fade"|"pitch"|"tempo"|"concat"|"slice", params} → 202 {job_id}
GET  /v1/works/:id/seed-pack           → 200 {seed_pack:{prompt, tags, bpm, sec, seed, engine}}
POST /v1/works/:id/report {reason}       → 200 {ok:true}   # M2 前仅落审计
```

## 3. WSS 事件（`/ws?token=<access_token>`，消息均为 JSON）

```
{type:"job.progress", job_id, progress, note}
{type:"job.done",     job_id, result:{candidates:[candidate]} , error:null}
{type:"job.done",     job_id, error:{code,message}}          # 失败
{type:"intent.card",  intent_id, status}
{type:"credit.delta", delta, balance_after}
```

## 4. 执行器拉单协议（executor → API，全部带 `X-Executor-Token`）

```
POST /executor/register   {lanes:["music","intent","ffmpeg"], version} → 200 {executor_id, poll_interval_ms:1500}
POST /executor/poll       {lanes:[...]}     → 200 {job: leaseJob|null}   # 服务端最多挂起 25s（long-poll）
    leaseJob = {id, type, payload, lease_expire_at}   # 租约 10min；心跳续租
POST /executor/jobs/:id/progress {progress:0-100, note}     → 200 {ok:true}
POST /executor/jobs/:id/complete multipart(files=...若干文件, result=JSON 字符串) → 200 {ok:true}
    # result 中 files 字段为 {logical_name: "上传时文件字段名"}，服务端落 var/out 并生成 *_url 回填 job.result
POST /executor/jobs/:id/fail    {code, message}             → 200 {ok:true}   # attempts<3 自动回队，否则 failed+refund
POST /executor/heartbeat {job_id?}                          → 200 {ok:true, lease_extended}
```

### job payload 契约
```js
// type="music"（lane music）——payload 与剧场 :8190 协议对齐
{ mood, tags, lyrics, bpm, sec, count, seed_base, instrumental,
  persona: {ref_abs_path, cover_strength, clone_mode:"fast"|"full"} | null,   // 两段式克隆由执行器编排
  candidates: [{seq, seed_delta}] }   // 每候选一条；执行器逐条调 :8190 POST /music
// :8190 请求体: {mood, seconds, seed, tags, bpm, lyrics, prompt, instrumental, ref_audio?, cover_strength?, src_audio?}
//   引擎侧 pydantic 严格校验（2026-11-23 实测 422 教训，执行器负责归一化）：
//   tags=逗号分隔**字符串**（非数组）；bpm=null 或 30-300（0 非法，缺省勿发）；seconds∈[15,180]（API 层 15-240，超 180 执行器截断）；mood 必填≥1 字
// :8190 响应:   {file, seconds, seed, gen_seconds, vram_peak_mb, task_type}

// type="intent_voice"（lane intent）——payload {upload_path}
//   执行器：POST :8191 /asr {path} → {text, emotion, events[], duration}
//           POST ${llmVlmUrl}/chat/completions（qwen38-fp4 OpenAI 兼容，system=prompts/intent 编译指令）→ IntentCard JSON
//           complete(result=IntentCard JSON)；端点不可达→执行器本地词典启发式编译（confidence<0.5）

// type="intent_image"（lane intent）——payload {upload_path}
//   执行器：POST ${llmVlmUrl}/chat/completions（多模态：content 含 image_url base64 data URL）→ 场景描述 → 同上编译

// type="transcode"（lane ffmpeg）——payload {src, targets:["mp3","peaks"]}
//   产物：同目录 <name>.mp3（320k）与 <name>.peaks.json（峰值数组 400 点）→ 回填 work/candidate 的 *_url

// type="dsp"（lane ffmpeg）——payload {op, src, params}
//   trim{start_sec,end_sec} fade{in_sec,out_sec} pitch{semitones} tempo{factor} concat{srcs[]} slice{start_sec,duration}
//   ffmpeg 参数基线：变速不变调=atempo；变调不变速=asetrate+aresample+atempo 补偿；fade=afade；concat=concat filter
```

## 5. 文件归属（并行施工边界）

| 施工方 | 独占目录 |
|---|---|
| server | `src/server/**` |
| executor+workers | `src/executor/**`、`src/workers/**`、`deploy/**`、`spikes/**` |
| app | `src/app/**` |
| tests | `test/**`、根 `README.md` |

公共只读：`CONTRACTS.md`、`docs/`。运行时 `var/` 由 server/executor 启动时自建。
