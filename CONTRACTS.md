# MusicBox · 冻结契约 v1（多智能体并行施工的唯一真源）

> 各施工方（server / executor+workers / app / tests）**只以本文档为接口真源**。改动契约必须先改本文档。
> 架构背景见 `docs/musicbox-architecture-design.md`（§1 拓扑、§3 服务端、§5 API、§6 序列）。
> **2026-11-24：v2 · MV 契约增量（v2.0–v2.17）全部冻结**——二期施工基线；后续改动走「改契约→改码→回归 V13–V16」流程（真机遗留见施工计划 §3/§6.3）。

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
POST /v1/auth/guest {device_key}     → 200 {access_token, refresh_token, first_time, user:{id, nickname, is_guest:true}}
POST /v1/auth/claim {device_key, recovery_code} → 200 {access_token, refresh_token, first_time:false, recovered:true, user}
                          # 换机/重装后用**备份码**认领自己的老身份：按 sha256(备份码) 命中 users.recovery_hash 才允许；
                          # 命中后 guest_key=sha256(device_key)，该用户**旧会话全部作废**。备份码不对 → 401，
                          # 绝不允许"知道 user_id 就认领"（游客号是匿名身份，别的信息都不构成所有权证明）。
POST /v1/auth/recovery/rotate (需鉴权) → 200 {recovery_code}
                          # 重新生成备份码：旧码当场失效。**只回显这一次**，库里只存 sha256，
                          # 不存在任何读回旧码的接口（要换码只能 rotate）—— 备份码等同账号凭证。
                          # device_key 必填且 ≥16 字符（客户端 Random.secure 生成的 64 位 hex，只生成一次、永不重生成）；
                          # 缺失/过短 → 400 BAD_REQUEST，**禁止**静默建号（旧行为：无锚点每次 INSERT 新号返回 200 → 用户作品"全没了"）
                          # first_time=true 表示本次新建了账号，客户端必须可对用户说明；同一 device_key 复用则 false
                          # device_key 必填且 ≥16 字符（客户端 Random.secure 生成的 64 位 hex，只生成一次、永不重生成）；
                          # 缺失/过短 → 400 BAD_REQUEST，**禁止**静默建号（旧行为：无锚点每次 INSERT 新号返回 200 → 用户作品"全没了"）
                          # first_time=true 表示本次新建了账号，客户端必须可对用户说明；同一 device_key 复用则 false
POST /v1/auth/phone/request-code   {phone}         → 200 {sent:true}；DEV_OTP=1 时验证码固定 888888
POST /v1/auth/phone/verify         {phone, code}   → 200 {access_token, refresh_token, user:{id,nickname,is_guest:false}}
POST /v1/auth/refresh              {refresh_token} → 200 {access_token, refresh_token}
GET  /v1/me                        → 200 {user:{id,nickname,phone_masked,is_guest}, credits:{balance, daily_quota, daily_used}, prefs:{}}
```

### 文本创作线
```
POST /v1/works/generate   {mode:"simple"|"custom", prompt?, lyrics?, tags?, mood?, bpm?, sec?(15-240,默认45), count?(1-4,默认3), persona_id?,
                          seed?|seed_base?(0-2147483647，锁定复现基准，候选依次 +0/+1/+2), instrumental?(bool，显式表态优先于「空歌词即纯音乐」推断)}
                          → 202 {job_id, credits_charged, idempotent:false|true}
                          # 幂等键=hash(user_id+归一化参数，含 seed/instrumental)；重复提交返回同一 job（idempotent:true，不重复扣分）
GET  /v1/jobs/:id         → 200 {id, type, status:"queued"|"leased"|"running"|"done"|"failed"|"canceled",
                          gen?:{lyrics,mood,bpm,sec,tags,instrumental} // 用户自己提交的输入回显（v3.3：候选/暂存架要能回看歌词，不许"用完就丢"）；payload 未落时缺省
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
POST /v1/intent/text    {text; hint?; intent_id?}                 → 202 {intent_id}   # v3.2：端侧转写/确认页改字→只过理解不过 ASR；带 intent_id 原地重编译并清空旧答案
GET  /v1/intent/:id     → 200 {intent}                            # v3.2 起 intent 含 source_text/degraded
GET  /v1/health/speech  → 200 {asr:{ok,reason,model_loaded?,device?}, checked_at}   # v3.2：语音自检（公开，探测缓存 15s）
POST /v1/intent/:id/answer {answers:[{q_idx, option_idx}]} → 200 {intent}   # 可能追加新题，status 仍 clarifying；≤2 轮
PATCH /v1/intent/:id       {mood?/vocal?/genre_hypotheses?/scene_desc?/sec?/bpm?/count?} → 200 {intent}   # 卡面「点改」唯一落库通道（v2.19）
POST /v1/intent/:id/generate → 202 {job_id}    # 仅 status=ready 可调；卡变 consumed
POST /v1/works/:id/adjust  {text} → 200 {understood:true, job_id} | {understood:false, clarify:"…"}
```

**卡面编辑纪律（v2.19 新增，服务端强制）**：`PATCH` 是意图卡「可点改」的唯一生效路径——App 在卡面上改 mood/vocal/流派/描述/时长/BPM/候选数后必须回传，否则 `generate` 只会按服务端卡面出稿（"能看不能改"视为缺陷）。
- `status=consumed` 一律拒（`BAD_REQUEST`，与 generate 同口径，防改卡后重复派单）；`clarifying`/`ready` 可改，且**编辑不改变 status、不消耗澄清轮次、不动 confidence**。
- 字段裁剪：`mood` ≤3 项（每项 ≤20 字）、`genre_hypotheses` ≤3 项、`vocal ∈ song|instrumental|unknown`、`sec ∈ [G.sec_min,G.sec_max]`、`bpm ∈ [40,200]`、`count ∈ [G.count_min,G.count_max]`；越界 `BAD_REQUEST`，空数组表示"清空该项"。
- `scene_desc` ≤300 字且过审核词库（命中 `MODERATION_BLOCK`）。
- 结构化生乐参数（`sec/bpm/count/tags`）落 `intent_cards.gen_params`（JSON），与卡面同源于一次 PATCH；每次 PATCH 全量替换 gen_params 中提交的键。

**generate 参数优先级（v2.19 明确）**：`gen_params`（用户显式点改）> 卡面（AI 推测/答题回填）> 服务端默认。即 `sec/bpm/count/tags` 取 `gen_params` 覆盖值，缺省回退卡面推导；`mood` 取卡面首项（卡面即 PATCH 后的值）；`instrumental = gen_params.instrumental ?? (vocal==="instrumental")`；`count` 缺省用 `config.gen.count_default`。

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
POST /v1/works/:id/to-persona            {name?,start_sec?,seconds?(默认28，clamp 到 20-40)} → 200 {persona}   # 从自己作品取一段当声纹
                          # 服务端裁剪后**必须**落 var/voices（voice_ref 带 voices/ 前缀，不在 /f/* 内，对齐 v5.2.1）；
                          # 裁剪工具不可用 → 503 NOT_READY 明确指引改走录音登记，**禁止**静默退化为"整条作品当声纹"（2026-11-27 修的旧 bug）
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

---

# v2 · MV 契约增量（2026-11-24）

> 二期 MV 创作（N0 无口型闭环）契约增量。v1 全条不变。本段冻结素材来自 docs/musicbox-phase2-mv-plan.md、docs/musicbox-phase2-architecture-design.md（§5 DDL / §6 API / §7 S5/S7/S8）；与 v1 冲突一律以本段/架构 §12 次序（契约>架构>施工）裁决。
> **本段只冻结契约，不含实现**：未登记的端点（boot/preview/suggest/assistant/tickets 等）显式延期至下一版契约。

## v2.0 范围与纪律

- **端点总开关**：`config.mv.enabled`（默认 false）。关闭时 /v1/mv/* 一律 404 `NOT_FOUND`（保留 v1 零影响）。二期启用时才放行。
- **双形态**：歌唱曲（work.lyrics 非空 → kind='vocal'）/ 纯音乐（无歌词 → kind='instrumental'）。
- **计费纪律（照 v1）**：先扣后派单；失败 engine 全额 refund；系统自动补拍（initiated_by=system）恒免费；摄影/封面等成片 `ai_label` 恒 1；用户 face 上传走 PIPL 最小化（consent + 72h TTL）。
- **错误码**：沿 v1（UNAUTHORIZED/FORBIDDEN/NOT_FOUND/BAD_REQUEST/RATE_LIMITED/CREDITS_NOT_ENOUGH/MODERATION_BLOCK/INTERNAL + 新增 409 STALE / NOT_READY）。
- **幂等纪律**：项目级幂等键=hash(user+work_id+kind)；重建同一活跃项目一律 409（状态非 canceled/failed）。

## v2.1 REST（前缀 /v1，2xx 裸 JSON，错误 {code,message}）

```
POST /v1/mv/projects          {work_id, brief?, character?:{gender:'m'|'f', source:'upload'|'ai', image_id?, name?}}
                              → 201 {project}                       # 免积分；N1 单主演（D3）
                              # work_id 须属于当前用户；kind=lyrics 非空→'vocal'，否则 'instrumental'
                              # 同一 work_id 已有未结束（status∉failed/canceled）项目 → 409
POST /v1/mv/image             multipart(file; jpg/png ≤8MB)        → 200 {image_id}
                              # 魔数实测（JPEG FFD8FF / PNG 89504E47）+ sha256 去重 + consent 前置
                              # consent 必填 form 字段 consent='true'，缺失 → 400（PIPL 勾选前置）
                              # 存储 var/uploads（kind='mv_portrait'，owner=当前用户）+ 72h TTL 同 v1 uploads
POST /v1/mv/projects/:id/cast/confirm  {character_id, cast_image_url, frame_sel[]:{url,score,sel}}
                              → 200 {character}                  # 拍板固化 viewRefs（身份真源）
                              # 校验 project 存在/归属 + character 归属 project；frame_sel 镜头级勾选
### v2.23 定脸方案点（cast_method，2026-11-26 · 方案一默认）

> 编号更正（2026-11-27）：本节此前误标 `v2.19`，与音乐线「意图卡点改落库」重号。
> 保留 `v2.19`＝音乐线意图卡点改（v1 §2 与 V8 的引用指向它，零改动）；定脸方案点改号 `v2.23`。语义未变。
- **分支点**：`mv_characters.cast_method`（每角色独立）+ `mv_projects.cast_method`（项目级覆盖/继承基线）。
- **白名单**：`i2v_first_frame`（**默认＝方案一**）、`h3_image_cast`（遗留，已证伪，仅显式启用）、`ref2va`、`likeness_lora`（未来）。
- **上传角色图后默认走方案一**：`POST /v1/mv/projects` 接受 `character.cast_method`（或顶层 `b.cast_method`），缺省/非法一律回退 `i2v_first_frame`；非法值 → 400。
- **统一定妆派发**：`POST /jobs {type:"cast", params:{cast_method?}}` 按 `cast_method` 分流 → `i2v_first_frame`=`mv_cast`（20⚡，女主原图 I2V 首帧直出定妆视频+抽帧+逐帧 facegate）；`h3_image_cast`=`mv_cast_image`（10⚡，遗留）。幂等键含 `cast_method`，不同方案各自幂等。
- **方案一实现**（executor `lanes/mv.js` `realCastI2V`）：女主原图 `portrait_path` → `h3-fl2va` I2V（首帧锁脸，SP6 方法 A/B：首帧+prompt 换景/转头）→ ffmpeg 抽 ~13 帧 → facegate 逐帧对照原图（score/yaw/pitch/pass）。与遗留 `realCastVideo`（取 candidate 为首帧）共享 `castI2VCore` 抽帧/facegate 核心。
- **默认不可被静默切**：新增方案只往白名单追加，默认恒 `i2v_first_frame`；回滚靠项目/角色级 `cast_method='h3_image_cast'`（显式、可逐项目）。
- **形状**：`characterShape` 输出新增 `cast_method`（缺省回填 `i2v_first_frame`）。

PATCH /v1/mv/projects/:id     {title?, brief?, script_json?, queue_mode?:'normal'|'night', ver}
                              → 200 {project} | 409 STALE        # ver CAS（script_ver 恒≥1）
GET  /v1/mvs                  ?mine=1&cursor                      → 200 {items:[mv], next_cursor}
GET  /v1/mv/projects/:id      → 200 {project, characters[], shots[], tickets:[pending]}
GET  /v1/mv/projects/:id/report → 200 {align_report, sync_dist, phrase_hit, degraded_shots[]}   # STUB（全 0，诚实标注）
POST /v1/mv/projects/:id/cancel → 200 {refunded}                    # 未拍镜 reserved credit 全额 refund（账本核算，≥0），status→canceled
```

语义说明：
- `POST /v1/mv/projects/:id/cast/confirm` 在 v2.1 只落 viewRefs+confirmed_at；**project status 推进到 scripting 显式延期至下一版契约**（拍板帧数据源依赖 executor 帧抽取，本期无可用帧来源）。
- `GET .../report` 为 STUB：对齐/sync/句点命中/降级镜清单均全 0，响应体带 `{stub:true}` 诚实标注（真实聚合归下一版契约）。
- `POST /v1/mv/projects/:id/cancel` 幂等：已 canceled/failed → 200 {refunded:0}；退款按账本核算（ref_type='mv_project'），未拍镜（status=draft）单镜 reserved = credits.mv.shot（40）；已 refund（reason='mv_cancel_refund'）不得重复。
- `PATCH` 的 ver CAS 仅用「当前 script_ver」比较：客户端带 ver==当前 → 放行（script_json 变更时 ver++）；失配 → 409 STALE。

**延期至下一版契约**（架构 §6 有规划但本期未实现）：POST /v1/mv/projects/:id/jobs、POST /v1/mv/projects/:id/preview、POST /v1/mv/projects/:id/boot、POST /v1/mv/shots/:id/jobs、POST /v1/mv/projects/:id/suggest(/apply)、POST /v1/mv/assistant/messages、POST /v1/mv/tickets/:id/confirm|deny。本期这些路径一律 404。
> **2026-11-24 wave-2 落地批（增补注记，原文保留为历史）**：上述延期项中 jobs / preview / boot / shots-jobs / suggest(/apply) 已按 **v2.8** 实现并冻结；assistant/tickets 仍延期（这些路径继续 404）。
> **2026-11-24 wave-3 落地批（增补注记，原文保留为历史）**：最后两项延期项 assistant / tickets 已按 **v2.13–v2.15** 实现并转正（jobs type 增补 align 见 v2.16）。

## v2.2 WSS 增量（`/ws?token=<access_token>`，消息均为 JSON）

```
{type:"mv.progress", project_id, status, progress, note, shots:[{id,status}]}   # 剧组通告板数据源（拍一镜=一个 mv_shot job，项目进度=jobs 聚合）
{type:"mv.ticket",   ticket_id, project_id, action, est}                          # 确认票签发（UX 面，V16 不本期启用）
```

job.progress/job.done 语义不变。

## v2.3 mv_* job type payload 契约（lane → payload）

```js
// type="mv_cast"（lane vidspark）—— 定脸方案一：女主原图 I2V 首帧直出定妆视频+抽帧+逐帧 facegate（保脸成立，默认）
//   派单入口 type:"cast"（jobs 端点）按 cast_method 分流：i2v_first_frame→mv_cast；h3_image_cast→mv_cast_image
{gender:'m'|'f', desc, portrait_path, cast_method:'i2v_first_frame'|'h3_image_cast'|'ref2va'|'likeness_lora', seed}
// type="mv_cast_image"（lane imgspark）—— files{cast_image_1..3} + face_scores[]（遗留分支，已证伪，仅显式启用）
{gender:'m'|'f', desc, portrait_path|null, anchor_refs[], seed, cast_method?}
// type="mv_cast_video"（lane vidspark）—— files{cast_video:mp4, frame_1..13:png}（遗留分支）
{cast_image, seed, motion}
// type="mv_storyboard"（lane imgspark）—— files{board_<shotId>:png} ×N
{shots:[{id,desc,camera,cast_ids,background}], viewrefs:{char:['url',...]}}
// type="mv_shot"（lane vidspark）—— files{clip_<shotId>:mp4}（原生声画保留，compose 剥离）
{shot:{first_frame,refs[],motion,singing,lyric}, project_kind, seed, tier:'quality'|'fast'}
// type="mv_lipsync"（lane lipsync）—— files{synced_<shotId>:mp4} + result.sync_score (0-1)
{video, audio_master, win:{start_sec,dur_sec}}
// type="mv_align"（lane align）—— result.timings=[{line,start,end}]
{audio_master, lyrics, structure}
// type="mv_preview"（lane ffmpeg）—— files{preview:mp4}（zoompan 轮播，免费档）
{board_urls[], audio_master, seg_sec}
// type="mv_compose"（lane ffmpeg）—— files{mv_video:mp4, cover:png} + sidecar{subtitles,music,ai_label,degraded_shots}
{takes:[{video,start_sec,strip_audio}], audio_master, title, subtitles?}
// v2.12 增补批注（executor 自测已实现，均有安全默认值，2026-11-24）：
//   takes[].segment   string|number —— 段落身份；相邻取值不同 → 该边界加 xfade（否则段内硬切）
//   takes[].xfade     bool          —— 强制该边界淡入淡出
//   takes[].degraded  string[]      —— 逐镜降级标记（如 'broll_subtitle' → 字幕强调）；汇入 sidecar.degraded_shots
//   degraded_shots    string[]      —— 项目级降级标记（sidecar 真源）
//   subtitles         string[] 或 [{line|text,start,end}]（align timings；有片名卡自动 +2s 平移）
//   takes[].dur_sec / mv_align.duration_sec —— ffprobe/ASR 缺席时的时长兜底（默认按 shot.sec）
```

## v2.12 mv_* payload 增补批注（2026-11-24 · executor 自测已实现，均有安全默认值）

> 编号补位说明：本批字段此前只以「v2.12 增补批注」形式活在上方 v2.3 payload 代码块的注释里，**没有对应章节**，
> 而 `test/acceptance/v14_mv_instrumental.test.js` 等 3 处代码注释引用了「契约 v2.12」。本节把它正式落位
> （append-only 纪律：不改写 v2.3 既往，仅补齐编号与口径）。

- `takes[].segment` `string|number` —— 段落身份；相邻段取值不同 → 该边界加 xfade，否则段内硬切。
- `takes[].xfade` `bool` —— 强制该边界淡入淡出（覆盖 segment 推导）。
- `takes[].degraded` `string[]` —— 逐镜降级标记（如 `broll_subtitle` → 字幕强调），汇入 `sidecar.degraded_shots`。
- `sidecar.degraded_shots` `string[]` —— 项目级降级标记（sidecar 为真源，App 侧据此出横幅）。
- `sidecar.subtitles` `string[] | [{line|text,start,end}]` —— 来自 align timings；存在片名卡时整体自动 +2s 平移。
- `takes[].dur_sec` / `mv_align.duration_sec` —— ffprobe/ASR 缺席时的时长兜底（默认按 `shot.sec`）。

Status: 生效（编号补位，字段语义与上方批注一致）

## v2.4 积分口径（config.mv.credits，可调；照 v1 先扣后派单）

| 项 | 值 | 说明 |
|---|---|---|
| **mv_cast** | **20 / 角色** | **定脸方案一：I2V 首帧直出定妆视频+抽帧+逐帧 facegate（默认，保脸成立）** |
| mv_cast_image | 10 / 角色 | H3-Image ×3 候选（遗留分支，已证伪，仅显式启用） |
| mv_cast_video | 20 / 角色 | 定妆视频+抽帧评分（遗留分支，取 candidate 照为首帧） |
| mv_storyboard | 5 / 镜 | 关键帧 |
| mv_shot | 40 / 镜（quality） | 拍摄（fast 档 15 留 N3） |
| mv_lipsync | 20 / 镜（仅歌唱曲演唱镜） | 口型 |
| mv_align | 5 | 歌词对齐 |
| mv_preview | 5 / 次（**每项目首次免费**，重出 5，D9） | 样片 |
| mv_compose | 10 | 成片合成 |
| 系统自动补拍 | 0 | initiated_by=system（≤2 次，免费明示） |

示例：歌唱曲 45s·12 镜（8 演唱镜）≈ 10+20+60+480+160+10 + align 5 = 745⚡（单主演）；纯音乐 8 镜 ≈ 400⚡（不计入系统免费项）。

## v2.5 uploads 扩展：kind='mv_portrait'

- 人像上传复用一期 `uploads` 表：`kind='mv_portrait'`，72h TTL（`config.upload.ttlHours` 同源，不另设）。
- 魔数实测（JPEG FFD8FF / PNG 89504E47）+ sha256 去重（同用户同哈希复用同一 image_id/同一个物理文件）+ consent 前置。
- 文件落 `var/uploads/<id>.<ext>`，记录 `path`/`bytes`/`sha256`/`mime`/`expire_at`；sweep 按 72h 自动清理（v1 sweep 自动覆盖，无需改动）。
- consent（PIPL）：仅用于本次角色生成、不用于训练；成片含真人脸时 App 侧强制「本人或已获授权」勾选（App 侧，本段只登记服务端约束）。

## v2.6 lane 注册（server 侧 `lanes/index.js` LC，executor 镜像）

| lane | types | timeoutMs | ladder 纪律 |
|---|---|---|---|
| imgspark | mv_cast_image, mv_storyboard | 900s | steps 8→4 恒定 turbo，重试保真；同参 OOM 不重试（铁律） |
| vidspark | mv_cast, mv_cast_video, mv_shot | 3600s | 帧网格≤362；steps 恒定 4；不降分辨率档（计费诚信）；mv_cast=方案一 I2V 首帧定妆 |
| lipsync | mv_lipsync | 1800s | 推理步数 30→20 一次；仍败 → B-roll 降级（非 fail 全片） |
| align | mv_align | 120s | 纯 CPU 直落 |
| ffmpeg | mv_preview, mv_compose（+ 一期 transcode/dsp）| 600s（mv_*） | — |

不变量：未知 mv_* 类型仍兜底 ffmpeg 需先登记 lanes 表 + executor ROUTE 双处（V13 契约）。V13 CI 断言 `laneOf` 正确路由。

## v2.7 约定与未决

- **未决（需 contract-first 拍板）**：mv-plan §6 写「mv_script/mv_preview/mv_align = 0 免费」与本段「align:5」不一致 —— 以架构 §6/本段（align:5）为准，mv-plan §6 标记待勘误。
- **本期交付边界**：N0 闭环（定妆+定妆视频→拍板固化 viewRefs）预计覆盖 projects/image/cast-confirm/PATCH/cancel；scripting/preview/boot/shoot/compose 一律延期。
- **mvModelLicense**（meta 路线，非 hn 用户面显示）：`{model:'MiniMax-H3 Community',usage:'attribution'}`（架构 §5 与 mv-plan §1.4 一致；公测前法务核对照 §1.4）。
- **mv.progress / mv.ticket WSS** 本期仅登记契约形状，emitter 由后续 executor/engine 扩展落地。
> **2026-11-24 wave-2 落地批**：`mv.progress` emitter 已落地（engine/api 在每次 shot/project 状态变更时广播，见 v2.8）；`mv.ticket` 仍为登记态。

## v2.8 派单·报价·开机·建议 契约增量（2026-11-24 wave-2，v2.1 延期项转正）

> 架构 §6/§7 S6-S10 的开机链接口冻结。全部沿用 v1/v2 全局纪律：2xx 裸 JSON、错误 `{code,message}`、`*_url` 绝对化、先扣后派单、`config.mv.enabled=false` 时 404。错误码新增：`EST_STALE`（409 报价 CAS 失配）、`BUDGET_EXCEEDED`（402 预算护栏，见 v2.11）、`NOT_READY`（409，LLM 离线/前置未满足，不装忙）。

### v2.8.1 派单（先扣后派单）
```
POST /v1/mv/projects/:id/jobs   {type:"cast"|"cast_image"|"cast_video"|"storyboard"|"preview"|"shoot"|"compose", params?}
                                → 202 {job_id, credits_charged, idempotent}   # 幂等键=hash(user+project+type+ver+params)；
                                #   命中活跃/近期同参 → 同一 job、不重复扣分（credits_charged=0, idempotent:true）
                                # 扣分成功但 enqueue 抛错 → 即时全额 refund（reason=refund，账本配对）
                                # params：cast 需 {cast_method?}（缺省/非法→方案一 i2v_first_frame）；cast_video 需 {cast_image_url}；shoot 需 {shot_id}；storyboard 无参（整项目关键帧，5×镜数）
                                #   cast 前置=角色有上传人像（portrait_upload）；分流：i2v_first_frame→mv_cast（20⚡，默认）；h3_image_cast→mv_cast_image（10⚡，遗留）
                                #   cast_video 前置=已有 cast_image_url；shoot 前置=项目 status≥scripting 且镜未成片
                                # 项目 paused=1 时一切计费派单一律 402 BUDGET_EXCEEDED（恢复见 v2.11）
POST /v1/mv/projects/:id/preview → 202 {job_id, credits_charged, idempotent}
                                # 前置=已有镜头（mv_shots 非空）；**每项目首次免费**（按已存在的该项目 mv_preview job 数判定），重出 5⚡（D9）
POST /v1/mv/projects/:id/boot   {est_ver} → 202 {jobs:[job_id...], credits_charged, idempotent}
                                # C6 语义：① status≥previewed（否则 409 NOT_READY）；② est_ver==项目存储 hash12（否则 409 EST_STALE，est 未生成也 409 NOT_READY）；
                                #   ③ 预算护栏（cost+est > budget×1.2 → 402 BUDGET_EXCEEDED + paused=1，见 v2.11）；④ 余额 ≥ 报价总额（否则 CREDITS_NOT_ENOUGH）；
                                #   ⑤ enqueueOnce 逐镜（idem=hash(user+project+shot+script_ver)），已成片镜（clipReady/synced/locked）跳过；
                                #   重复 boot 返回同一批 job（每镜恒一个 mv_shot job、只扣一次）。成功后 status→shooting 并广播 mv.progress。
                                # boot 扣费=拍摄 40×待拍镜（reason=mv_shot，ref=(mv_project, project_id)）；
                                #   演唱镜口型费 20/镜 在 mv_shot 完成派生子任务时按同纪律另扣（v2.8.4）
POST /v1/mv/shots/:id/jobs      {type:"reshoot"|"resync", reason?, initiated_by?}
                                → 202 {job_id, credits_charged, idempotent}
                                # initiated_by 缺省=user：reshoot=40⚡（mv_shot）、resync=20⚡（mv_lipsync），幂等键含 rerolls 计数（同镜可多次）
                                # initiated_by=system：credits_cost=0、不扣分、take.origin=system_auto、审计 initiated_by=system（契约 v2.4 系统补拍恒免费）
                                # reason 过禁词净化后写入 shot.reason_history（chips 诊断链）
```

### v2.8.2 剧本建议（LLM 可选，离线不装忙）
```
POST /v1/mv/projects/:id/suggest        {note} → 200 {suggest} | 409 NOT_READY
                                # suggest={id,note,summary,script,mode:"llm",created_at}
                                # LLM 不可达/返回不可用 → 409 {code:"NOT_READY"}（快速失败，绝不超过 30s；不硬答、不装忙、退回手动编辑）
                                # 建议挂 project.suggest_json 草稿，**不 ver++**（剧场 suggest 纪律）
POST /v1/mv/projects/:id/suggest/apply  {suggest_id, ver} → 200 {project} | 409 STALE
                                # ver CAS（==当前 script_ver）；命中才落 suggest.script、ver++、机检重审（v2.10）重跑；suggest_id 失配 → 404
GET  /v1/mvs/:id                → 200 {mv, parent_work}   # mv=列表项同形（v2.1）；parent_work=母 work 简卡（work 形状）；非本人/不存在 404
```

### v2.8.3 报价快照（est_json / est_ver）
```js
est = { shots, singing, lipsync, breakdown:[{item,unit,count,credits}], credits, minutes, at }
// item∈{拍摄, 口型, 歌词对齐, 成片合成}；credits=Σ行；minutes 按 config.mv.est 常数（架构 §8）
// est_ver = hash12(JSON.stringify(est))；生成点=mv_preview 完成（报价卡时刻，S7）；boot 以此做 CAS
// GET /v1/mv/projects/:id 的 project.est / project.est_ver 即报价卡数据源
```

### v2.8.4 计费口径补充（v2.4 同源，逐条落点）
- 派单扣分 ledger reason：`mv_cast_image` / `mv_cast_video` / `mv_storyboard` / `mv_shot` / `mv_lipsync` / `mv_preview` / `mv_compose`；ref_type=`mv_project`，ref_id=project_id（cancel 退款按此账本核算，v2.1 语义不变）。
- 先扣后派单：`credits.charge` 成功 → `engine.enqueue`；enqueue 抛错 → `credits.refund`（同 ref）；job 后续失败由引擎全额退（credits_cost 记账，v1 语义）。
- 系统自动补拍/自动口型补样：`creditsCost=0`、不落扣分账、`initiated_by=system`、通告板明示；`mv_compose` 自动触发时按 10⚡ 正常先扣后派单，余额不足则不自动合成（项目保持 shooting，可手动 compose）。

### v2.8.5 WSS（v2.2 形状转正）
```
{type:"mv.progress", project_id, status, progress:0-100, note, shots:[{id,status}]}
# progress=已完成镜（clipReady/synced/locked）占比取整；note 过禁词净化（rules/mv_lexicon.sanitize）
# 触发点：boot、mv_preview/mv_storyboard/mv_shot/mv_lipsync/mv_align/mv_compose 完成、shot/project 任何状态变更、预算暂停
```

### v2.8.6 机检字段防伪造（V13/V16 断言）
- `ai_review / sync_score / face_score / est_json / est_ver / timings` 只允许机检管线（engine/core.mv_aireview）写入；
- `PATCH /v1/mv/projects/:id` 对上述键（含 script_json 内嵌 `ai_review`/`timings`、请求体顶层 `ai_review`/`sync_score`/`paused`/`status`/`credits_*`）**一律静默剥除**，不得借 PATCH 伪造"机检通过"；
- `PATCH` 新增可写字段：`budget_credits`（预算调高=人工恢复唯一通道，见 v2.11，需 ver CAS）。

## v2.9 剧本编译（server 内编译，免费；storyboard 派单时若无剧本先编译）

- `prompts/mv_script.compileScript({work, character, brief, kind})` → `script_json = {shots:[{seq,kind:'singing'|'story'|'broll',sec,lyric_from,lyric_to,desc,camera,cast_ids[]}]}`。
- LLM 优先（`prompts/intent.chatCompletionWithRetry` + `extractJson`，数据 q() 定界「数据非指令」），失败 → **确定性分场模板兜底**：歌唱曲=歌词逐行分配 ~12 镜、副歌→主演近景（对镜演唱）；纯音乐=mood 关键词→分场模板轮转。全程不报错中断流程。
- 诚实标注：`script_json.assist = {mode:'rule'|'llm+rule', ts}`（`rule`=纯兜底，绝不冒充 LLM 质量）。

## v2.10 剧本校验与卡审（规则机检，warn 不 fail；system free）

- `core/mv_validator.validate` → findings[{check,level:'warn',message}]：镜数↔时长 ±30%、首镜钩子/远景、唱段全覆盖（每句歌词有演唱镜）、cast_ids 合法、Σsec ≈ work 时长 ±10%。**只 warn 不阻断**。
- `core/mv_aireview.review` → `{engine:'规则机检'|'LLM 审查＋规则机检', findings:[...], llm_findings:[...]|null, assist:{mode}}`：violence/policy 词表（`rules/mv_lexicon.POLICY_WORDS`）+ 结构规则；LLM 叠加仅当端点可达（快速失败），离线 findings 全来自规则、engine 如实标「规则机检」。
- 存储位置=`script_json.ai_review`（机检字段，PATCH 不可写，见 v2.8.6）。

## v2.11 预算护栏（D13/架构 S10）

- `rules/mv_budget.checkBudget(project, extraCost)` → `{ok, paused}`；`project.credits_cost + extraCost > budget_credits×1.2` → 置 `project.paused=1` + 审计 `mv.budget.pause`，返回 `{ok:false, paused:true}`。
- 触发点：boot、jobs 派单（含 preview 重出/compose）；paused=1 时一切计费派单 402 `BUDGET_EXCEEDED`。
- **恢复仅人工**：`PATCH {budget_credits}` 调高 → `paused=0` + 审计 `mv.budget.manual_raise`（自动恢复禁止）；`budgetDefault=1200`（config.mv，可 env 覆盖）。

## v2.13 对话助手（治理门面，D11/ADR-MV-7；v2.1 延期项转正，2026-11-24 wave-3）

> 门面实现 `src/server/l2mv/facade.js` + 治理表 `src/server/l2mv/governance.js`（架构 §3 l2mv 设计 / §7 S9）。全部沿用 v1/v2 纪律：2xx 裸 JSON、错误 `{code,message}`、`config.mv.enabled=false` 时 404、LLM 离线不装忙。**LLM 是增强不是依赖（ADR-MV-9）**：`config.mv.assistant.chat.enabled=false`（默认）时一律规则模式，回复如实 `meta.mode:'rule'`，**绝不冒充 LLM**；开启后 LLM 不可达/超时/返回不可用同样落规则模式，单次请求绝不悬挂（<30s，超时上限 `config.mv.llmAssistTimeoutMs`）。

### v2.13.1 REST
```
POST /v1/mv/assistant/messages  {session_id?, text, chips:[{type:'project'|'shot', id}]}
                                → 200 {session_id, reply?, ticket?, meta:{mode:'rule'|'llm+rule', rejected?:true, intent?}}
                                # 404=mv 未启用/会话不存在或非本人；400=缺 text 或无有效归属 project 上下文（chips 需含本人 project）；
                                #   409 SESSION_BROKEN=会话已被预算熔断（见 v2.15，仅可新开会话）；429=限流
                                # chips 是实体唯一来源：project/shot 实体一律服务端按 chips 做归属校验后注入；
                                #   LLM/文本给出的任何 id 一律不信任、校验失败即弃（防幻觉实体/参数注入，架构 §10-2）
                                # reply=顾问式回执（≤150 字、机械剥除行首编号与裸内部 id）；ticket 见 v2.14（昂贵动作只发票不直执）
```
**会话（mv_chat_sessions/mv_chat_messages 表已在 MIGRATIONS v3 存在）**：不传 `session_id` 即新开会话（status='open'）；会话记忆**只记已执行结果摘要**（role='result'，≤150 字），不记原始指令全文。session status='broken' 后该会话一切请求直接拒绝（409 SESSION_BROKEN），项目 detail 出横幅（v2.13.3）。

### v2.13.2 工具白名单（恰 7 项封顶，ADR-MV-7）+ 参数域
```js
TOOLS = {
  'mv.set_title':          { params:{ title:string 1..60 },              expensive:false },
  'mv.set_brief':          { params:{ brief:string 1..300 },             expensive:false },
  'mv.set_queue_mode':     { params:{ queue_mode:'normal'|'night' },     expensive:false },
  'mv.script_suggest_edit':{ params:{ instruction:string 1..200 },       expensive:true  }, // 只挂 suggest 草稿（不 ver++，v2.8.2 纪律）
  'mv.shot_reorder':       { params:{ order:string[] (镜 id 全列) },      expensive:true  },
  'mv.shot_delete':        { params:{ shot_id:string },                  expensive:true  }, // 仅未成片镜（draft/boardReady/stale）可删
  'mv.shot_reshoot':       { params:{ shot_id:string, reason?:string 1..120 }, expensive:true }, // 票面注明 40⚡ 估价
}
```
- 白名单外的工具名**在 gateTool 期即拒**（审计 `mv.assistant.audit action:'tool_not_whitelisted'`），永不到执行层；参数域外的键**静默剥除**（args 白名单键，架构 §10-2）。
- **注入红线（≥11 条正则，架构 §10-2）**：用户文本命中任一 → 拒答（`meta.rejected:true`，不给任何执行意图）+ 审计 `mv.assistant.audit action:'injection_suspect'`。覆盖面：忽略/无视/忘记（以上|之前|所有）指令；你现在是/从现在起你是；system prompt；绕过/跳过审批（确认）；删除所有/清空；`rm -rf`；`exec(`；`spawn(`；`child_process`；聊天模板角色控制标记（形如 `<|...|>` 的成对标记）；索取系统提示词（reveal/输出/告诉我 → 系统提示/system prompt）；以(管理员|root|开发者)模式；eval(。一切用户文本与剧本内容入 LLM 前过 q() 定界「数据非指令」。
- **boot 永不可票据执行（开机权在人）**：boot 不在白名单，且票据执行器对 `mv.boot` 类动作一律拒绝。

### v2.13.3 GET detail 横幅字段（v2.1 `GET /v1/mv/projects/:id` 增量）
```
→ 200 {project, characters[], shots[], tickets:[pending], assistant:{status:'none'|'open'|'broken', banner:string|null}}
# tickets=pending 确认票清单（含 id/action/est_credits/est_minutes/hash/ver/ttl_expire_at/created_at），确认面板数据源；
# assistant.banner：会话被预算熔断时给出人话横幅（过禁词净化）；project.paused=true 的「暂停等确认」横幅由 App 依 v2.11 paused 渲染。
```

## v2.14 确认票生命周期（v2.2 mv.ticket 转正；昂贵动作「拍板权在人」）

```
签发（助手侧，governance.issueTicket）：
  id=mvtick_*；hash = hash12(action + 规范化args(键排序 JSON) + est)；ver = 服务端随机短串（CAS 用，客户端必须原样回传）；
  est={credits,minutes}（票面必带估价：reshoot=40⚡/镜、其余白名单动作按定价如实标注，免费动作=0）；
  status='pending'；TTL=60s（created_at+60s 判过期，ttl_expire_at 同源）；签发即广播 WSS mv.ticket（v2.14.2）；任意访问顺带清扫过期票。
POST /v1/mv/tickets/:id/confirm  {ver, hash} → 200 {executed:true, job_id?, project?}
  # 五连校验（全过才消费，一次性）：同用户（REST 由同一人批准——非本人 404 不泄露）&& hash 匹配 && ver CAS &&
  #   未过期 && status=='pending'；缺 ver/hash → 400；ver 失配 → 409 STALE；hash 失配 → 403 FORBIDDEN；
  #   已过期/已消费/已拒绝 → 409 TICKET_UNUSABLE（一票一次）；不存在 → 404
  # 执行=复用既有派单原语（v2.8 chargeThenEnqueue/guardBudgetOrThrow 与 shotJobs 内核），扣费唯一落点不变（无新 charge/refund 点）
POST /v1/mv/tickets/:id/deny     {} → 200 {ok:true}    # 仅票主可拒；pending→denied（其余状态幂等 200）
```
- `mv_tickets` 表列已在 MIGRATIONS v3 冻结（id/project_id/user_id/action/args_json/est_credits/est_minutes/hash/ver/status/ttl_expire_at/created_at/consumed_at）。
- 确认票只覆盖 v2.13.2 中 `expensive:true` 的四项；免费直执类（set_title/set_brief/set_queue_mode）属低风险可逆，即时执行 + 审计 `initiated_by:'assistant'`。

### v2.14.1 预算双熔断（S10 助手侧，与 v2.11 项目暂停互相独立）
- 助手**代发付费动作**（est.credits>0）在签票前核验：`project.credits_cost + 本动作估价 > 报价总额(est.credits)×1.2`（无报价则 `budget_credits×1.2`）→ 该会话 `status='broken'` + 审计 `mv.assistant.fuse`，回复如实说明并提示新开会话；此后该会话一切请求 409 SESSION_BROKEN。
- 项目侧 v2.11 paused（通告板「暂停等确认」、402 BUDGET_EXCEEDED）语义不变——**双熔断**：项目级护栏照旧触发 paused，助手侧另断会话。恢复均仅人工（PATCH budget_credits / 新会话）。

### v2.14.2 WSS（v2.2 登记形状转正）
```
{type:"mv.ticket", ticket_id, project_id, action, est:{credits, minutes}}   # 确认票签发（面板弹卡）
```

## v2.15 审计与记忆口径（助手治理链，V16 断言面）
- `store.log` kind 约定：`mv.assistant.message`（每次请求：user_id/project_id/session_id/mode/intent/tool/action∈executed|ticket|rejected）、`mv.assistant.audit`（action∈injection_suspect|tool_not_whitelisted|entity_rejected）、`mv.assistant.fuse`（预算双熔断）、`mv.assistant.exec`（票据消费执行）、`mv.ticket.issue|confirm|deny|expire`。
- 助手执行的写操作复用既有审计 kind（`mv.project.patch` 等）并加 `initiated_by:'assistant'` 标记；系统动作 `initiated_by:'system'` 语义（v2.8.1）不变。
- 回执/横幅/WSS note 一律过 `rules/mv_lexicon.sanitize`（三层净化之首，ADR-MV-8）。

### v2.15.1 剧本→镜行同步物化 + shots 暴露批注（2026-11-24 wave-3，app 实测修复，原文保留为历史）

- `PATCH /v1/mv/projects/:id` 应用 `script_json`（ver CAS 通过、ver++ 之后）必须同步物化**未成片镜**（status ∉ clipReady/synced/locked）：按位置对齐更新 `desc/camera/sec/kind/lyric_from/lyric_to/cast_ids/seq`；剧本新增尾部行 → 物化新 draft 镜。**已成片镜（clipReady/synced/locked）绝不动**（编辑权在人、成片稳定性，与 suggestApply 同源纪律）。同步后广播 `mv.progress`（note 过净化）。
- **删镜语义（择一冻结）= 删行**：脚本中移除的行，其对应的未成片 mv_shots 行删除（级联删其 mv_takes 行，审计 `mv.shot.script_removed` 留痕）；对应**成片镜则保留行不删**（剧本不覆盖成片）。不引入新 shot status。
- `GET /v1/mv/projects/:id` 的 shots[] 每项增暴露：`degraded: string[]`（flags.degraded 归一为数组，未降级恒 `[]`，如 `['broll_subtitle']` → 字幕强调角标）与 `best_take_origin: 'auto'|'system_auto'|'user_reshoot'|null`（system_auto 时 App 显「自动返工」角标，替代靠 WSS 文案匹配；无 best_take 为 null）。
- V13 增白盒断言：PATCH 改 desc → 之后 `jobs{shoot}` 派单 payload `shot.motion` 含新文案（杜绝「改了词仍按旧 motion 拍」）。

## v2.16 jobs type 增补：align（v2.8.1 派单面转正，S8「mv_align 先行」）
```
POST /v1/mv/projects/:id/jobs  {type:"align"} → 202 {job_id, credits_charged:5, idempotent}
  # 前置：project.kind=='vocal'（纯音乐 → 400 BAD_REQUEST，无词可对）且剧本就绪（否则 409 NOT_READY）；
  # 扣费 5⚡（reason=mv_align，ref=(mv_project,project_id)，先扣后派单/预算护栏/幂等全部复用 v2.8.1 原语）；
  # 幂等键=hash(user+project+align+script_ver)（同版本重复请求返回同一 job、不重复扣分）；
  # 完成回流=engine.completeMvAlign（既有）：result.timings → script_json.timings + 演唱镜 window 分配（ADR-MV-11 timings 三分用）。
```

## v2.17 助手端点错误码增补（沿 v2.8 惯例）
`SESSION_BROKEN`（409，会话被预算熔断，仅新开会话可用）、`TICKET_UNUSABLE`（409，票已过期/消费/拒绝）。其余错误码沿用 v1/v2 集合。

## v2.18 非计算收尾批注（2026-11-24 终扫 · N1-5/N2-5 落地，append-only，不改写既往）
- **lane 指标（观测面）**：`GET /healthz` 在 `mv_enabled=true` 时增 `mv_metrics` 段——`{ types: { <job_type>: {done, p50_ms, p90_ms} }, lanes: { <lane>: {queued, leased} } }`；进程内内存态、重启清零、粗略分位估计（每 type 环形样本 ≤500）；仅 `/healthz` 公开观测（无新鉴权面），不构成 SLO 承诺（架构 §11 最小可观测集子集）。
- **夜间档派发（N1-5，架构 §8 单点化）**：`queue_mode='night'` 项目的 mv_* 派发 jobs 由 server poll 侧过滤——窗口（`config.mv.queueNightMode.window`，默认本机钟 [0,8)；env `MB_MV_NIGHT_ENABLED/_WINDOW_START/_WINDOW_END`）外不出队（保持 queued，不占租约）；窗口内 night 优先于 normal（created_at 次级序）。night 挂起不阻塞 normal 出队（防 starvation 由派发侧保证，executor 侧零改动=单点裁决）；enabled=false 即不门控。测试钩子 env：`MB_MV_FORCE_NIGHT=1` / `MB_MV_FORCE_DAY=1`。`projects.queue_mode` 的 PATCH 语义不变（v2.1）。
- **takes TTL（N1-5，并入一期 sweep，架构 §8/§11）**：`mv_takes` 行+产物文件（及 var/out 无任何表/result 引用的无主产物、mtime 超 72h）清理条件=created_at 超 72h **且** 非任何 `mv_shots.best_take_id` 引用 **且** 所属项目 `status='ready'` 满 72h（ready 时长代理=updated_at 过期，ready 前/未满 72h 绝不动）；留审计 `mv.takes.cleanup` 一条。sweep 周期 env `MB_SWEEP_MS`（默认 30000，验收可加速）。
- **幽灵 poll 防线（N2-5 演练实测驱动）**：`POST /executor/poll` 长挂期间若执行器连接已断（进程被杀/断网），server 在领单前检查 socket 存活并放弃派发——不再把 job 租给死会话白等 10min 租约（既有租约过期回队语义兜底不变）。

## v2.19 音乐线意图卡「点改」落库（2026-11-24 第 2 轮 UX 优化 · append-only，不改写既往）

一期创作线实测：意图卡 UI 标榜「AI 推测 · 可点改」，但 `mood`/`vocal` 的点改只存在于 App 内存（`setState` 本地副本），`POST /v1/intent/:id/generate` 无请求体、服务端只按库内卡面派单——**用户改的一切在生成时被静默丢弃**（能看不能改＝假动作，比不给改更伤信任）。本批把「点改」变成真通道：

- **新端点** `PATCH /v1/intent/:id`（形状与裁剪见 §2 多模态意图线）：`mood/vocal/genre_hypotheses/scene_desc` 改卡面，`sec/bpm/count` 改结构化生乐参数（落 `intent_cards.gen_params`）。返回 200 `{intent}`（与 answer 同形状，App 可直接换卡）。
- **写权限**：仅卡主；`status=consumed` → `BAD_REQUEST`「意图卡已使用」（与 generate 同口径，杜绝改卡再派）；`clarifying`/`ready` 均可改；编辑**不推进 status/rounds/confidence**（澄清纪律与编辑解耦，答题仍是唯一的置信度来源）。
- **审核与限流**：`scene_desc` 走 `rules.moderateFields`（命中 `MODERATION_BLOCK`）；与 voice/image 共用 `intent:<user_id>` 速率桶（10 次/分钟），防脚本刷卡。
- **generate 尊重点改**：`gen_params` 覆盖 `sec/bpm/count/tags/instrumental`，缺省回退卡面推导；`count` 不再恒取 `config.gen.count_default`（用户显式选了 1 首就不发 3 首，计费维度与交付一致，对齐 DEV-LADDER-PAY 的「不静默改变计费交付」结论）。
- **审计**：`store.log` 增 kind `intent.patch`（`user_id/intent_id/fields/status`，fields 为提交的键名数组，不记原文）；每次成功 PATCH 广播 `intent.card`（v1 §3 事件不变，App 借此即时对齐多端）。
- **验收**：V8-⑦（点改落库 + generate payload 带上覆盖值）/V8-⑧（consumed 拒改、越界拒、非卡主 404）钉死，见 `test/acceptance/v8_intent.test.js`。
- **执行器零改动**：`intent_voice`/`intent_image` payload 与结果卡协议不变；本批纯 server + App 面。

## v2.20 制片助手可见性与 assistant_chat 判定源修正（2026-11-24 二期可见性修复 · append-only，不改写既往）

**背景（缺陷登记）**：v2.13.3 冻结的 `GET /v1/mv/projects/:id` 形状只出 `assistant:{status,banner}`，而 App 入口判据读的是 `detail.assistant_enabled`（`mv_models.dart`）并 `|| kMvAssistantEnabled`（`assistant_sheet.dart` 写死 `false`）→ server 从不发 `assistant_enabled` ⇒ **制片助手 FAB 恒不显示**（含"无 LLM 也能用"的规则模式），属契约字段名漂移，非能力缺失。又 `feature_flags.assistant_chat` 业务链路零消费（`facade.js` 只读 env `config.mv.assistant.chat.enabled`）⇒ 灰度系数形同虚设。本批修通。

**策略**（决策：规则模式默认可见 · 对话版按灰度）：规则助手对所有 MV 可见用户常开；对话版 LLM 增强按 `assistant_chat` 灰度放量（Inkling-2-Mini 就位前默认关，见 ADR-MV-9/D4）。

- **detail 增量**（在 v2.13.3 `GET /v1/mv/projects/:id` 返回体上追加，`assistant` 段扩展）：
  ```
  GET /v1/mv/projects/:id → 200 {project, characters[], shots[], tickets:[pending],
    assistant: {status:'none'|'open'|'broken', banner:string|null,
                enabled:boolean, chat_enabled:boolean, mode_hint:'rule'|'chat'}}
  ```
  - `assistant.enabled`：该用户是否可进入制片助手（规则模式）——MV 项目对当前用户可访问时恒 `true`（**不再受 assistant_chat 约束**，规则模式是默认能力）。
  - `assistant.chat_enabled`：对话版 LLM 增强对该用户是否开放 = `AC.featureOn('assistant_chat', user_id)`（灰度系数生效；默认 `enabled=false`→ 规则模式）。
  - `assistant.mode_hint`：`chat_enabled? 'chat' : 'rule'`，供 App 呈现"当前为规则助手模式/对话助手模式"。
  - `status/banner` 语义不变（v2.13.3）。旧客户端读 `assistant.status` 仍兼容；`enabled/chat_enabled` 缺省视为 `false`（保守隐藏，仅本批新客户端据 `enabled` 出 FAB）。
- **assistant_chat 判定源统一（死开关转真开关）**：`facade.js` LLM 增强闸门由 `config.mv.assistant.chat.enabled` 改为 `AC.featureOn('assistant_chat', ctx.user_id)`；`config.mv.assistant.chat`（enabled+grayscale）仍作 `initDefaults` 的种子来源（core/appconfig.js:98 不变）。flag 关闭→一律规则模式、回复如实 `meta.mode:'rule'`（ADR-MV-9 不变，LLM 是增强不是依赖）。使 ARCH §80「灰度系数 0.2」名副其实。
- **App 入口判据**：`assistantOn` 改判 `detail.assistant.enabled`（server 下发为权威）；`kMvAssistantEnabled` 降级为**联调强制钩子**（`|| kMvAssistantEnabled` 保留，默认仍 false，不参与生产判定）。自由输入/发送按钮依 `detail.assistant.chat_enabled`；false 时快捷指令 chips（走既有 `/suggest`）与规则意图可用，**绝不冒充 LLM**。
- **RemoteConfig**：`core/state.dart` 增 `assistantChat` getter（读 `/v1/app/config` `features.assistant_chat`），仅作 App 侧粗判/文案；**权威以 detail.assistant.enabled / chat_enabled 为准**（避免灰度判定分散）。
- **验收（V16 追加）**：① `assistant_chat` flag 翻转驱动 `facade` 的 `meta.mode`（关=rule、开且 LLM 可达=chat）；② `GET detail` 恒出 `assistant.enabled=true`（MV 可访问时）且 `chat_enabled` 随 flag；③ 断言 server 不再依赖被废弃的顶层 `assistant_enabled` 字段名（统一嵌于 `assistant.enabled`）。
- **执行器零改动**：本批纯 server（api/mv.js、l2mv/facade.js）+ App（mv_models/state、mv_wizard/progress、assistant_sheet）面。

## v2.21 AI 卡审下发 + 音画报告真聚合（2026-11-24 二期可见性修复 B · append-only，不改写既往）

**背景（缺陷登记）**：`mv_aireview.review()`（规则机检 + LLM 叠加，`core/mv_aireview.js`）产物只写 `script_json.ai_review`（v2.10），但 `GET /v1/mv/projects/:id` 的 `projectShape`/`getProject` 不返回 script_json → **卡审结论到不了客户端**；App 对 `ai_review/findings` 零命中。又 `GET .../report` 恒 STUB（v2.1，全 0 + stub:true），承诺的乐句命中率/sync 分布/降级镜清单未落地。本批补齐（server 侧；App 消费归 App 树另行接入）。

- **detail 增只读机检段 `ai_review`**（`GET /v1/mv/projects/:id` 返回体追加；机检字段防伪造纪律不变，PATCH 不可写，见 v2.8.6）：
  ```
  GET /v1/mv/projects/:id → … , ai_review: {
    engine: '规则机检'|'LLM 审查＋规则机检'|null,   // 如实标注来源
    findings: [{rule, level:'high'|'warn', message, shot_seq?}],   // 已过禁词净化，message 人话
    llm_findings: [{rule, level, message, source:'llm'}]|null,     // LLM 在线叠加；离线 null（不装忙）
    assist: {mode:'rule'|'llm+rule', ts, persona}|null, blocked: boolean,
    checked_at: string|null, has_script: boolean }                 // 无剧本 → null/[]、has_script:false
  ```
  来源 = `script_json.ai_review`（机检管线写入）；缺 script_json → `{engine:null,findings:[],llm_findings:null,has_script:false}`（诚实空态，绝不伪造"通过"）。`block` 级命中仍不阻断施工（warn 不 fail，v2.10 语义），仅呈现供人决策。
- **音画报告真聚合（替换 STUB）** `GET /v1/mv/projects/:id/report` → 200：
  ```
  { align_report:{aligned_lines,mean_abs_err_ms,within_150ms_ratio},
    sync_dist:{count,mean,p50,p90,below_threshold},
    phrase_hit:number,            // 乐句命中率 [0,1]：timings 命中句点/总句点
    degraded_shots:[{seq,label}], // flags.degraded 归一（broll_subtitle/lipsync_failed…）
    stub:false }                  // 数据可得即真值；对应来源缺失则该项 0/[] 并如实
  ```
  STUB 判据（计费诚信·续 V14-S2）：`stub:true` 当且仅当**无任何真实聚合来源**（无 best_take.sync_score 且无 script_json.timings 且无 flags.degraded）；有任一真实信号即 `stub:false` 并出真值（兼容既有「空 mock 项目须 stub:true」断言，不放宽）。
  真实来源：`mv_takes.sync_score`（sync_dist、below_threshold vs `config.mv.syncThreshold`）；`script_json.timings`（align_report 误差、phrase_hit）；`mv_shots.flags_json.degraded`（degraded_shots）；纯器乐无 timings → align/phrase 项 0（诚实，非造假）。落地实现置于 `core/mv_report.js`（api/mv.js 仅调用）。
- **验收**：V13/V16 增断言——①有剧本 detail 出 `ai_review.engine/findings`（且 PATCH 注入 `ai_review` 被剥除，防伪造）；②有 takes/timings 时 report `stub:false` 且数值随真机产物变化；③无产物时对应项 0/[] 且 `stub` 仅在零 shot 时为 true。
- **执行器零改动**：数据来源均既有表列；本批 server（api/mv.js、新增 core/mv_report.js）面。

## v2.22 AI 辅助增强：基调建议 / 运动改写 / 人像预检（2026-11-24 二期可见性修复 C · append-only，不改写既往）

**背景**：mv-plan §5.1 承诺但 server 未实现——①基调建议 `buildToneSuggest`/`MOOD_TONE`（PLAN:354）；②重拍「动作不对」→ 运动描述 LLM 改写/词典兜底（PLAN:387；现 api/mv.js 原样 desc 派单）；③选角人像预检 4 项人话反馈（PLAN:355）。App 侧"基调建议/运动改写"chip 现仅把自然语言塞 `/suggest`（名不副实）。本批补 server 真实现；App 接线归 App 树。

- **基调建议** `POST /v1/mv/projects/:id/tone` → 200 `{tone_suggest:{mood_tags:[…], bpm, key_hint, reason}}`（≤3 组备选）：`prompts/mv_assist.buildToneSuggest(workBrief)` LLM 优先、`MOOD_TONE` 确定性词典兜底（LLM 离线不装忙仍出词典结果，`assist.mode:'rule'` 如实）。系统 free（只读建议，不计费、不改剧本；采纳走既有剧本 PATCH）。
- **运动改写**（重拍「动作不对」通道）：`POST /v1/mv/shots/:id/jobs {type:'reshoot', reason:'动作不对', note?}` 时，`motion` 先过 `prompts/mv_assist.rewriteMotion(desc, note)`——LLM 改写运动描述（离线 → `MOTION_LEXICON` 词典换运镜短语），改写结果过禁词净化再派单；来源（`rule`/`llm`）记入该镜 `reason_history` 末条 `motion_assist`（**不开新列**）。其余 reason 不变。
- **人像预检** `POST /v1/mv/image/precheck {file|image_id}` → 200 `{pass:bool, checks:[{key:'frontal'|'lighting'|'occlusion'|'resolution', pass:bool, msg}]}`（4 项人话反馈）：调用 facegate `:8395 /score`（yaw/pitch/遮挡）+ 本地分辨率校验；facegate 不可达 → `{available:false, checks:[…null], msg:'人脸预检服务未就绪'}` **诚实降级**，不阻断上传（预检是辅助不是门禁，PIPL：仅本地即时判定、不留存）。
- **验收**：V13/V16 增断言——①`/tone` LLM 离线仍出 `MOOD_TONE` 结果且 `assist.mode:'rule'`；②reshoot `动作不对` 的派单 payload `shot.motion` 为改写后文案、`motion_assist` 标注来源；③`/image/precheck` 在 facegate 缺席时 `available:false` 且不 500。
- **执行器最小改动**：reshoot motion 由 server 侧改写后下发，executor 不感知来源；`/image/precheck` 只读观测，无产物落库。

## v3.1 跨模块音乐助手：把制片助手治理范式横向搬到「音乐创作」域（2026-11-24 二期 · append-only，不改写既往）

**背景（用户诉求）**：AI 助手不应只服务 MV——音乐制作（意图卡指挥 / 作品微调 / 候选与二次创作）同样要能被助手「遥控指挥 + 嵌入确认票」。既有音乐创作 AI（intent 意图卡、`works.adjust` 单轮 NL→delta→直接扣费派单）**不是**命令助手：无对话会话、无确认票、无注入红线、无审计门面；尤其 `works.adjust` 是「NL 一句话直接扣费」的后门。本批把 MV 已验证的 l2 治理门面（红线/白名单/gateTool/确认票 hash-ver-TTL-一票一次/预算双熔断/会话记忆）横向复用到音乐域，**MV 侧 `l2mv/*` 与 `mv_chat_*`/`mv_tickets` 零改动**（V13/V16 全绿即零回归证据），音乐侧新代码走通用 `l2/governance_core.js` + 新 `chat_*` 表（`scope` 分区，物理与 MV 隔离）。

**开关（服务端下发为权威，`GET /v1/app/config` `features`）**：
- `music_assistant`：助手**接口总闸**（规则模式，含"无 LLM 也能用"）。`config.music.assistant.enabled`（env `MB_MUSIC_ASSISTANT`，默认 0）或后台开关任一开启，否则三端点 **404**（对齐 MV `requireEnabled` 语义，保留 v1 行为）。规则意图对所有可访问该作品的用户常开。
- `assistant_chat_music`：**对话版 LLM 增强**灰度（`config.music.assistant.chat`，env `MB_MUSIC_ASSISTANT_CHAT`/`MB_MUSIC_ASSISTANT_GRAYSCALE`，默认关 0.2）。关闭 → `facade` 一律规则模式、`meta.mode:'rule'` 如实、绝不冒充 LLM；开启后 LLM 不可达同样落规则、单次不悬挂（<30s）。**LLM 是增强不是依赖（ADR-MV-9 同源）**。

### v3.1.1 REST（前缀 `/v1`，2xx 裸 JSON，错误 `{code,message}`）

```
POST /v1/music/assistant/messages  {session_id?, text, chips:[{type:'work'|'intent'|'job'|'candidate'|'persona', id}]}
  → 200 { session_id, reply, meta:{mode:'rule'|'llm+rule', intent, rejected?, fused?},
          ticket?: { ticket_id, scope:'music', subject_type, subject_id, action, est:{credits, minutes} } }
  # 主实体（subject）取 chips 里首个属主合法的 work/intent；无合法主体 → 400 BAD_REQUEST
  # 注入命中 → 200 meta.rejected:true（不给任何执行意图，不发票、零派单）
POST /v1/music/tickets/:id/confirm  {ver, hash}
  → 200 { ok:true, action, reply, job_id, credits_charged }     # 五连校验通过后唯一执行器落扣费
  # 缺 hash|ver→400；hash 失配→403 FORBIDDEN；ver CAS 失配→409 STALE；过期/已用→409 TICKET_UNUSABLE；非票主→404
POST /v1/music/tickets/:id/deny     {} → 200 { ok:true }         # 记 denied；denied 后 confirm→409
```

### v3.1.2 工具白名单（恰 7 项，封顶对齐 ADR-MV-7）+ 三域映射

| 工具 | 域 | 计费 | 参数域（`l2music/governance.js`）| 执行 |
|---|---|---|---|---|
| `music.query_status` | 只读 | free | — | 直执（回执作品/意图卡状态）|
| `music.set_title` | 作品微调 | free | `title:string≤80` | 直执（UPDATE works.title，审计 `initiated_by:'assistant'`）|
| `music.set_card` | 意图卡指挥 | free | `mood:string≤20?`,`vocal:enum(song/instrumental/unknown)?`,`sec:int?`,`bpm:int(40-200)?`,`count:int?`,`scene_desc:string≤300?` | 直执（复用 `intent.patchIntentInternal`，净化+审核+审计）|
| `music.adjust_params` | 作品微调 | **expensive**（`credits.adjust`）| `text:string≤200` | **确认票**：发票前 `adjustPrompt.parseAdjust` 解析（`understood:false` → 只追问、**绝不发票、绝不扣费**）；确认后 `works.dispatchMusic('adjust')` 唯一扣费点 |
| `music.regenerate` | 候选二次创作 | **expensive**（`per_candidate×count`）| `count:int?` | **确认票**：work→`dispatchMusic('generate',variationBase,count)`；intent→`intent.generateIntentInternal`（消费卡出曲）|
| `music.cover` | 候选二次创作 | **expensive**（`credits.cover`）| `persona_id:entity(persona,属主或公开)` | **确认票**：`dispatchMusic('cover')` + `personas.use_count++` |
| `music.extend` | 候选二次创作 | **expensive**（`credits.extend`）| `sec:int?` | **确认票**：`dispatchMusic('extend')` |

- 花钱大门（`generate`/`boot` 级）**不入白名单**；付费动作一律 `expensive → 确认票`，杜绝 `works.adjust` 式「NL 直接扣费」后门被助手复用。
- **白名单外工具** gateTool 期即拒（审计 `music.assistant.audit action:'tool_not_whitelisted'`），永不到执行层；`executeMusicTicketAction` 对非白名单动作**双保险硬拒 FORBIDDEN**。参数域外的键静默剥除。
- **注入红线（≥13 条正则，复用 `l2/governance_core` 与 MV 同源口径）**：命中 → `meta.rejected:true` + 审计 `music.assistant.audit action:'injection_suspect'`。覆盖：忽略/无视/忘记 … 以上/之前/所有/全部/上述 … 指令/规则/设定/提示词；你现在是/从现在起你是；system prompt；绕过/跳过审批（确认）；删除所有/清空（含 作品/候选/歌曲）；`rm -rf`；`exec(`；`spawn(`；`child_process`；`<|...|>` 聊天模板标记；索取系统提示词；以(管理员|root|开发者)模式；`eval(`。
- **租户注入（对齐 v2.13.1）**：实体 id 只认 chips 的服务端属主核验结果，LLM/文本给的 id 一律不信任；跨租户 chips 静默丢弃（他人 work/intent/candidate/job 不改不派），persona 实体校验属主或 `is_public`。

### v3.1.3 确认票与会话（复用 `l2/governance_core`，新表 `chat_*` · `scope='music'`）

- **确认票五连**：`chat_tickets(scope,subject_type,subject_id,user_id,action,args_json,est_credits,est_minutes,hash,ver,status,ttl_expire_at,created_at,consumed_at)`；hash=`hash12(action|canonical(args)|est)`；confirm 需 `user_id` 匹配 + `hash` timingSafeEq + `ver` CAS + 未过期(TTL 60s) + `status='pending'` → 一次性 `UPDATE ... WHERE status='pending'`（`changes!=1` → 409，一票一次）。语义与 v2.14 逐条同构，仅表/作用域不同。
- **预算双熔断**：助手**代发付费动作**（est.credits>0）签票前核验 `本用户音乐域已消费确认票 est_credits 合计 + 本动作估价 > 助手侧基准(100)×1.2` → `chat_sessions.status='broken'` + 审计 `music.assistant.fuse`；此后该会话一切请求 **409 SESSION_BROKEN**。（音乐域无项目报价，用固定助手侧软预算基准 100。）
- **会话记忆（只记结果摘要）**：`chat_sessions(scope,subject_type,subject_id,user_id,status,ctx_json)` + `chat_messages(session_id,role,content≤150,meta_json)`，只落已执行结果摘要（过净化），**原始指令全文不落库**。
- **作用域物理隔离（V17-⑫）**：`chat_sessions/chat_tickets` 仅 `scope='music'`；`mv_chat_sessions`/`mv_chat_messages`/`mv_tickets` 独立，音乐助手零写 MV 表。
- **WSS**：`{type:"music.ticket", ticket_id, scope:'music', subject_id, action, est:{credits,minutes}}`（确认面板弹卡，与 `mv.ticket` 平行）。

### v3.1.4 审计 kind（`store.log`，V17 断言面）

- `music.assistant.message`（每请求：user_id/subject_id/session_id/mode/intent/tool/action∈executed|ticket|rejected|gated|need_chip|clarify|fused|reply）
- `music.assistant.audit`（action∈injection_suspect|tool_not_whitelisted|entity_rejected）
- `music.assistant.fuse`（双熔断）· `music.assistant.exec`（票据消费执行，`initiated_by:'assistant'`）· `music.assistant.exec_fail`（确认后执行失败，票已消费不退还，不重复扣费）
- `music.ticket.issue|confirm|deny|expire`
- 助手写操作复用既有审计 kind（`works.patch`、`intent.patch`）并加 `initiated_by:'assistant'`；扣费唯一落点 `works.dispatchMusic`（复式记账，`credits_charged` 回执 = 账本 -est = `job.credits_cost`）。

### v3.1.5 落地文件与验收

- server 新增：`l2/governance_core.js`（通用治理核心）、`l2music/governance.js`（7 工具 + 实体校验）、`l2music/execute.js`（免费直执 + 确认票唯一执行器）、`l2music/facade.js`（对话流水线 interpret→红线→gate→直执/发牌）、`api/music_assistant.js`（3 端点 + 门控）。
- server 改：`store.js` migration **v10**（`chat_sessions`/`chat_messages`/`chat_tickets`）；`config.js` 增 `music.assistant.{enabled,chat}`；`core/appconfig.js` `FLAG_KEYS` 增 `music_assistant`/`assistant_chat_music` + 种子；`index.js` 注册路由；`api/works.js` 导出 `variationBase`；`api/intent.js` 导出 `patchIntentInternal`/`generateIntentInternal`（助手 set_card/regenerate-from-intent 复用）。
- **执行器零改动**：所有付费动作经既有 `dispatchMusic` 派单，executor 不感知助手来源。
- **验收 V17（`test/acceptance/v17_music_assistant.test.js`，13 项全绿）**：①开关关三端点 404；②LLM 离线降级 `rule` 不悬挂不冒充；③注入红线全拒答 + 审计；④白名单外 gateTool 即拒 + execute 硬拒 + 白名单恰 7；⑤跨租户 chips 丢弃 / 无主体 400；⑥付费经票（发票不派单不扣分，confirm 后 +1 job + 账本 -est 恒等）；⑦确认票五连/一票一次/TTL/非票主/deny；⑧双熔断 broken + 409 SESSION_BROKEN；⑨意图卡 set_card 落库 + 审计；⑩血缘 `lineage.kind=adjust`+parent、`initiated_by=assistant`；⑪语言纪律 lexicon CI 回执 clean；⑫会话作用域隔离（chat_* 只 music、mv_chat_* 零污染）；⑬资金不变量（重复 confirm 不重扣不重派）。**V13/V16 同跑全绿 = MV 零回归**。

## v3.2 创作选择项目录下发：曲风/心情/风格点缀（2026-11-24 第 2 轮 UX 优化「标签改选择项」批 · append-only，不改写既往）

一期深度档实测：一个「标签（逗号分隔）」自由文本框 + 英文示例 `city pop, retro, synth`——用户不知道它是曲风还是情绪，等于把生乐模型的提示词词表甩给用户抄；且 App 侧另硬编了一份 12 心情 + 12 流派，与服务端词典（24 心情 + 18 曲风）**不同源**：用户选「激昂／未来感／复古」这类词典没有的词，`dict.scan` 命中不到 → BPM/tags 补全静默失效。本批把选择项唯一真源收回服务端词典：

- **新下发字段** `GET /v1/app/config` 响应增 `style_options`：
  ```js
  style_options = {
    moods:       [{ zh, bpm|null }],              // 24：词典 ENTRIES(type=mood)；bpm=该情绪典型速度，供滑杆给起点
    genres:      [{ zh, en, tags[], instrumental }], // 18：曲风；zh 给用户看，en 为派单规范词
    style_words: [{ zh, en }],                    // 20：风格点缀（**只放乐器与制作质感**）
    voice:       [{ zh, en, dim }],               // 12：人声维度 dim∈{gender,delivery,layer}（v3.2 增量）
  }
  ```
  **维度纪律（2026-11-27 真机后定）**：曲风=编曲骨架、情绪=唱什么心情、**人声=谁在唱/怎么唱**、质感=乐器与制作。
  四者正交，同一个词只允许属于一个维度。`女声/男声/童声/合唱` 属 `voice(dim=gender)`，
  `微醺/气声/烟嗓/哭腔/嘶吼/念白/拖拍` 属 `voice(dim=delivery)`，**不得再出现在 `style_words`**：
  性别曾被当成风格点缀，与「钢琴/黑胶噪点」抢同一份 tags 配额并被挤掉，直接造成"用户要女声、拿到男声"。
  `gender` 为互斥单选（一个性别）；旧 App 不认识 `voice` 时忽略即可（不得白屏），
  此时服务端 `dict.scan` 仍能从自由文本里认出这些词并把性别词排在 tags 首位。

  **`tags` 上限 = 12**（`works.js` `unionArr(params.tags, scan.tags, 12)`，去重后截断；用户手选在前、扫描猜测在后，
  所以配额吃紧时先丢猜测而不是丢用户的选择）。2026-11-27 从 6 提到 12：拆出人声维度后 App 四组上限是
  `性别1 + 演唱状态2 + 曲风3 + 质感3 = 9`，卡在 6 会让"选了却被静默丢"复活（真机丢过「女声」）。
  端侧 `StylePicker.maxTotal` 必须等于本数字（V31-③ 从 works.js 读真源核对，判词不许写死数字）。
  内容 = `prompts/dictionary.catalog()` 直发（唯一真源，禁止在 App/别处另抄一份词表）；`config_version` 签名纳入 `style_options`（运营改词典即换版本号，APK 据此刷新）。
- **语言纪律**：`zh` 是界面唯一可见文案（普通用户不该看到 `city pop` 这类模型词），`en` 只做括注与派单，不进标题/按钮/提示主体。心情直发中文（引擎 `mood` 字段本就吃中文，词典默认 `'温暖'` 同源）；曲风/风格点缀发 `en` 规范词。
- **兼容不变**：`POST /v1/works/generate` 的 `tags` 语义不变（自由字符串数组，原样进 `payload.tags`）。旧版/直连发中文曲风仍可用——`buildMusicPayload` 的 `dict.scan` 会把中文别名补成英文规范词一并下发（例：`电子` → 追加 `electronic,edm`），故不破坏既有验收面；`style_options` 缺失时 App 用同构本地兜底，选择项不得变空白。
- **配额在前端、语义在服务端**：曲风≤3、风格点缀≤6 由选择器强制（满额即禁用未选项并明说，不静默丢弃）；服务端 `buildMusicPayload` 仍按 `cap 6` 裁剪 `tags`，不新增错误码。
- **`tags` 一词的口径（写死防再次歧义）**：`tags` = **风格提示词**（喂 `:8190/music` 的 `tags` 逗号串），曲风是其子集；界面不再出现"标签"这种无主语叫法，一律称「曲风」「风格点缀」。
- **验收 V18（`test/acceptance/v18_style_catalog.test.js`）**：①`/v1/app/config` 下发 `style_options` 三段非空、`zh` 为中文且 `genres/style_words` 带 `en`；②下发内容与 `dict.catalog()` 逐字段等值（证明同源而非抄一份）；③用户选中的词无论中英都进 `payload.tags`，不静默丢弃（`guofeng/synth` 直发、`电子` 经词典补出 `electronic`）。



## v3.3 端侧语音：本机管手感、服务端管准（2026-11-25 追加，append-only）

> 编号更正（2026-11-27）：本节此前误标 `v3.2`，与「创作选择项目录下发」重号。
> 保留 `v3.2`＝创作选择项目录（App 的 style_options / 词典同源引用指向它，零改动）；端侧语音改号 `v3.3`。语义未变。

### 动机（2026-11-24 排查实录）
语音线此前只有服务端一条路。`:8191` worker 没人启动时，`intent_voice` job 仍报 `done/100/"意图卡已生成"`，
`result.fallback=true` 但库里没有任何痕迹，用户看到的是「只说不理解，然后什么都没了」。
同时 App 侧此前没有任何端侧语音能力，弱网/无网即完全不可用。

### 分工（不可静默换档）
| 角色 | 承担 | 给得出 | 给不出 |
|---|---|---|---|
| 端侧·即时 | 长按期间的实时回显 | 逐字（无标点） | 情绪、音频事件 |
| 端侧·精听 | 服务端不可达时的整段兜底 | 逐字 + 情绪 + 音频事件 + 时间戳 | — |
| 服务端 | **最终逐字与情绪的权威来源** | `{text, emotion, events[], duration}`（§4） | — |

换档（端侧模型未就位→服务端；服务端不可达→端侧）必须把原因回传前端上屏，**禁止静默换档**。

### 新增端点
- `POST /v1/intent/text {text, hint?, intent_id?}` → `202 {intent_id}`。`text` ≤500 字（超长截断），空/纯空白 `BAD_REQUEST`；
  带 `intent_id` 时**原地重编译**（`answers` 清空、`rounds` 归零、`status` 回 `clarifying`），非本人 `NOT_FOUND`，`consumed` 拒。
  jobs 新增 type `intent_text`（归 `intent` lane，超时同 90s）。
- `GET /v1/health/speech`（公开）→ `{asr:{ok,reason,model_loaded?,device?}, checked_at}`。探测 `MB_SENSEVOICE_URL/healthz`，
  超时 2.5s，结果缓存 15s；结论原样给前端，App 不得写死「正常」。

### IntentCard 诚实化字段（store 迁移 v11）
- `source_text`：用户到底说了什么——语音=ASR 逐字；文本=用户原话；图片=画面理解摘要。拿不到 `null`，**不得用 scene_desc 顶替**。
- `degraded`：`1` = 本轮理解由本地词典兜底（ASR 或 LLM 未起来）。此时 job `note` 必须是「没听清：识别服务没起来，已用本地词典兜底」
  这类人话，不得继续报「意图卡已生成」。

### 录音回显与等待纪律（2026-11-25 追加）
- 端侧流式 partial 必须实时回填**当前创作页的同一个灵感输入框**；端侧终稿与服务端 `source_text` 到达后也必须回填，不得只显示在录音浮层或确认页。
- 服务端识别包含模型冷启动、ASR 与意图理解，草稿态 `clarifying + source_text=null + degraded=0` **不是失败终态**。App 等待上限为 120 秒；超时只能提示“暂时没拿到识别结果”，不得断言“服务端没听清”。
- 服务端未返回逐字时不得用场景描述、占位文案或本地假文本冒充转写；已有端侧终稿可作为明确标注的降级结果回填。

### 端侧模型资产（不打包、不启动自动下，首次使用确认后下载，可删除）
即时识别 4 件 ≈167MB；精听 2 件（**只下 int8，fp32 937MB 永不下**）≈228MB；中文朗读声库 16 件 ≈135MB（含 `lexicon.txt` 与 jieba `dict/`，
缺件即判不可用，不硬跑）。全部落在应用私有目录，设置页可看体积与删除，删除即刻释放原生资源。
用户首次主动使用端侧识别时，必须先提示模型体积与流量消耗，确认后才下载；下载进度可见、可取消，失败可重试。
下载完成前不得开始端侧录音；创作页可在用户选择后改用服务端识别，MV 助手无服务端听写能力时必须明确阻断。下载完成后本次手势不自动开录，须再次按住说话。

## v4.0 统一创作助手（全局入口、跨域上下文、可恢复会话，2026-11-25 追加，append-only）

### 定位与兼容边界

- 统一助手是创作副驾驶，不新增底部一级页、不绕过既有创作/计费内核。全局入口在迷你播放器上方，任务与待确认票统一进入「助手中心」。
- v3.1 音乐助手与 v2.13 制片助手端点、工具、表与既有行为继续有效；v4 不要求把 `chat_*`、`mv_chat_*` 物理合并。统一层增量扩展 `chat_*`，通过领域适配器复用既有执行器。
- REST 是任务真相。`assistant_events` 仅保存助手消息、确认票、任务变化通知，供重连补发；既有 `jobs` 队列与 WSS 业务事件不改为事件溯源。
- 规则模式始终可用；LLM 仅增强理解与工具选择。模型不可达、未就绪或 scaffold 时如实返回 `mode:'rule'`，不得把 HTTP 端口可达冒充模型就绪。
- 所有实体 ID 只接受服务端验证过的 `context.refs`；文本或 LLM 给出的 ID 不参与实体解析。跨用户引用丢弃，确认票归属和会话归属再次校验。

### 开关（服务端为权威）

- `assistant_core`：全局助手总闸，关闭时 v4 端点 404；种子默认开启、灰度 1.0。运营可改 `enabled/grayscale`，沿用 `appconfig.featureOn` 用户哈希分桶。
- `assistant_actions`：统一助手的付费动作闸门，种子默认关闭；仅控制 v4 跨域动作，不改变 v3.1/v2.13 原有入口。
- `assistant_chat_music`：继续作为 v4 LLM 增强开关；关闭或 LLM 未就绪时 `mode:'rule'`。`music_assistant`/`assistant_chat` 保持各自原端点语义。

### REST（前缀 `/v1`，2xx 裸 JSON，错误 `{code,message}`）

```
GET /v1/assistant/bootstrap
  → 200 {available, mode:'rule'|'llm+rule', capabilities:{chat,voice,actions,music,mv,llm},
         recent_session:{id,title,surface,updated_at}|null, pending_tickets:[], tasks:[], server_time}
POST /v1/assistant/sessions  {title?, context?:{surface, refs:[entity_ref]}}
  → 201 {session:{id,title,surface,refs,created_at,updated_at}}
GET /v1/assistant/sessions/:id/messages?after_seq=0
  → 200 {session_id, messages:[assistant_message], next_seq}
POST /v1/assistant/messages  {session_id?, client_msg_id, text, context?:{surface,refs:[entity_ref]}, feedback?:{message_id,result}}
  → 200 {session_id, message, reply, ticket?:assistant_ticket, meta:{mode,intent,tool,status,rejected?}}
  # client_msg_id 必填且 ≤80；同会话同键重复提交返回首次结果，不重复执行、不重复记账
  # text 1..1000；context.refs 0..12；session_id 缺省时取最近 open 会话或新建
  # feedback.result 为 accepted|dismissed|completed；仅记录效果指标，不改变任务结果
GET /v1/assistant/tasks?limit=50
  → 200 {items:[{kind:'job', id, title, status, progress, updated_at, result_work_id?, credits_cost}]}
GET /v1/assistant/tickets?limit=50
  → 200 {items:[assistant_ticket]}                 # 含 pending/executing/succeeded/failed/reconciling/compensated
POST /v1/assistant/tickets/:id/confirm  {ver,hash}
  → 200 {ok:true, ticket:assistant_ticket, action, reply, job_id?, credits_charged}
  # 五连校验与原子状态迁移；重复 confirm 返回同一 ticket，不重复执行或扣费
POST /v1/assistant/tickets/:id/deny     {}
  → 200 {ok:true, ticket:assistant_ticket}
GET /v1/assistant/events?after_seq=0&limit=100
  → 200 {items:[{id,seq,type,payload,created_at}], next_seq}
POST /v1/assistant/feedback  {message_id,result}
  → 200 {ok:true}
```

### 数据形状

- `entity_ref = {type:'work'|'intent'|'job'|'project'|'shot'|'persona', id}`。`shot` 必须属于 refs 中同项目或当前会话固化的项目；`job` 必须属于当前用户。refs 去重，最多 12 个。
- `assistant_message = {id,seq,session_id,role:'user'|'assistant'|'tool'|'result'|'system',content,meta,client_msg_id?,created_at}`。`meta` 只含已净化后的工具名、状态、票 ID 等，不落原始模型指令。
- `assistant_ticket = {ticket_id,scope:'assistant',session_id,subject_type,subject_id,action,est:{credits,minutes},
  status:'pending'|'executing'|'succeeded'|'failed'|'reconciling'|'compensated'|'denied'|'expired'|'consumed',
  ver?,hash?,job_id?,reply?,created_at,expires_at,consumed_at?}`。`hash/ver` 只返回给票主，列表仍保留展示所需估价。
- 统一会话：`chat_sessions.scope='global'`，`subject_type='user'`，`subject_id=user.id`。一个用户可有多个会话，消息只按会话恢复，不把不同用户/主体的上下文混入。

### v4 工具与确认边界

| 工具 | 类型 | 说明 |
|---|---|---|
| `assistant.context` | free | 校验并固化当前 refs/surface，输出人话上下文摘要 |
| `assistant.task_query` | free | 查询当前 job/project 或最近任务，不派单 |
| `assistant.ticket_query` | free | 查询当前用户待处理与最近确认票 |
| `library.search` | free | 复用既有曲库检索，只返回当前用户可见作品 |
| `music.query_status` | free | 复用 v3.1 只读工具 |
| `music.set_title` | free + explicit confirm | 先返回前后差异，用户确认后才写；每票一次 |
| `music.set_card` | free + explicit confirm | 复用 `intent.patchIntentInternal`；先确认差异，再写 |
| `work.explain` | free | 基于当前作品字段给结构化解释，不虚构模型内幕 |
| `music.adjust_params` | paid + confirm | `assistant_actions` 开启；确认后复用 `executeMusicTicketAction`，唯一扣费派单 |
| `mv.shot_reshoot` | paid + confirm | `assistant_actions` 开启；项目/镜头属主校验，确认后复用 `mv.executeTicketAction` |

- 付费动作没有批准票绝不派单、不扣费。`music.regenerate/cover/extend` 与 MV 写操作仍走原入口；v4 首轮不扩大白名单。
- 所有写操作先展示 diff/预估，再由用户点击票面确认；助手回复只能说「已提交确认」或「已开始执行」，不能在确认前说已完成。
- 注入命中返回 `meta.rejected:true`、`reply` 拒绝说明，不执行、不发票。白名单外工具 403 `FORBIDDEN`。

### 确认票生命周期与故障恢复

- `pending → executing → succeeded | failed | reconciling | compensated`；`denied/expired` 为终态。旧 `consumed` 记录按 succeeded 兼容展示。
- confirm 在同一事务内完成 hash/ver/TTL/owner 校验和 `pending → executing` CAS；执行器以 `ticket_id` 幂等。执行成功后置 `succeeded`，明确失败置 `failed` 并记录原因，疑似结果不明置 `reconciling`，严禁盲目重放。
- 动作执行前不扣费；执行器按既有唯一扣费点落账。重复 confirm 返回已存在 ticket/job，不新增 job、不重复扣费；可补偿失败按既有账本原语退款，不靠删除记录修复。
- TTL 60s。列表可将过期 pending 票展示为 `expired`，但 confirm 仍以数据库状态和 TTL 硬判。

### 增量迁移（schema v12）

- `chat_messages` 增 `seq INTEGER`、`client_msg_id TEXT`，并增 `(session_id,seq)` 唯一索引；旧 role='result' 保留，历史 seq 回填。
- `chat_tickets` 增 `session_id`、`meta_json`、`job_id`、`reply`、`expires_at`、`started_at`、`finished_at`、`failure_code`；旧 `consumed` 保持兼容。
- 新表 `assistant_events(id,user_id,seq,type,payload,created_at)`，唯一 `(user_id,seq)`；`assistant_metrics(id,user_id,session_id,surface,tool,mode,status,kind,latency_ms,credits,created_at)` 持久化采用与结果指标。
- 不迁移、不改写既有 MV 表；不存语音原文件或模型完整提示词。

### WSS 与事件

- v4 事件 `{type:'assistant.event', seq, event:{id,type,payload,created_at}}`，既有 job/credit/MV 事件不变。
- 离线事件保留在 `assistant_events`；端侧重连后先 `GET /events?after_seq` 补发，再继续接收实时事件。响应 `next_seq` 为当前用户游标。
- `assistant.message`、`assistant.ticket`、`assistant.task` 均带 `session_id`（可用时）；事件仅作通知，任务状态最终以 REST/jobs 为准。

### 审计、指标与验收

- 审计：`assistant.message`、`assistant.tool`、`assistant.ticket.issue|confirm|deny|execute|reconcile`、`assistant.feedback`、`assistant.metric`。
- 指标至少覆盖请求数、工具成功率、LLM/规则占比、p50/p90 延迟、建议采纳/驳回/完成、票确认/拒绝/执行失败、助手触发积分成本。管理员聚合接口不向普通用户暴露他人数据。
- `GET /v1/admin/assistant/metrics?days=7` → `{range_days, totals, tools:[], modes:[], daily:[]}`；越权 401/403，不得返回用户原始文本。
- 验收 V19：开关/灰度；会话恢复与幂等消息；跨用户/跨会话拒绝；离线事件补发；免费工具与低风险写确认；付费票五连与重复 confirm 不重派；故障状态不盲重放；注入/工具越界；规则降级；指标聚合；V13/V16/V17 零回归。
- 端侧验收：全局入口不增加第六 tab；关闭/重开助手恢复同一会话；detach 后不再发送旧 refs；重试切换到新 job；暂存恢复保留回调；任务/票中心可处理跨域待办；付费入口均有确认票。


### 验收
- `V8-⑨`：文本线逐字必落库；改字原地重编译且清空旧澄清答案；空文本/超长/他人卡边界。
- `V8-⑩`：ASR 不可达 ⇒ `degraded=1`、`source_text` 不得凭空出现、`note` 说清兜底（此前该失败模式零自动化覆盖）。
- App `test/speech_test.dart`：WAV 往返与「采样率跟着结果走」、契约字段不编造（无情绪就不出 `emotion` 键）、
  语音偏好 k=v 字符串落盘回读、清单只含 int8 且中文声库带 lexicon/dict、用户可见文案不含引擎型号名；
  首次模型准备先确认再下载、进度可取消、失败可重试、创作页可选择服务端而 MV 助手明确阻断、下载完成后不自动开录。

## v5.0 统一端侧多模态全场景业务助手（2026-11-26 追加，append-only）

### 定位与兼容边界

- v5.0 把 v3.1 音乐助手、v2.13 制片助手、v4.0 统一助手收敛为「一个统一助手：一套工具白名单、一套确认票、一套上下文」。原三套端点（`/v1/music/assistant/*`、`/v1/mv/assistant/*`、`/v1/assistant/*`）行为保留兼容；统一助手在 `/v1/assistant/*` 下覆盖全场景，是默认入口。
- 全场景 = 音乐（查询/改标题/改意图卡/微调/重出/翻唱/续长）+ MV（片名/简介/队列档/编剧改稿/重排/删镜/重拍）+ 通用（上下文/任务/票/曲库/解释）。统一助手共 19 个工具 = 音乐 7 + MV 7 + 通用 5；原入口可做的事，统一助手都能做（在相应开关下），但原入口不迁移、不废弃。
- 端侧策略（D-1）：LLM 留在服务端（`assistant_chat_music` 开关 + LLM 端点可达时增强理解与工具选择），端侧保留规则层作为 always-available 基线；完整 LLM 不下沉到端侧，但保留可插拔解释层接口，供未来端侧小模型（N3）接入。
- 多模态（D-3）：图片理解走服务端 VLM（:8090），端侧仅拍摄/选择本地图片并上传；继承既有同意与 72h TTL 规则。
- 所有实体 ID 只接受服务端验证过的 `context.refs`；文本或 LLM 给出的 ID 不参与实体解析。跨用户引用丢弃，确认票归属与会话归属再次校验。
- 拍板权在人：所有写操作先展示 diff/预估，由用户点击票面确认；助手回复不能说「已完成」，只能说「已提交确认」或「已开始执行」。

### 工具白名单（19 项）

| 工具 | 域 | 类型 | 说明 |
|---|---|---|---|
| `assistant.context` | 通用 | free | 校验并固化当前 refs/surface，输出人话上下文摘要 |
| `assistant.task_query` | 通用 | free | 查询当前 job/project 或最近任务，不派单 |
| `assistant.ticket_query` | 通用 | free | 查询当前用户待处理与最近确认票 |
| `library.search` | 曲库 | free | 复用既有曲库检索，只返回当前用户可见作品 |
| `music.query_status` | 音乐 | free | 查询作品/任务进度、位次、ETA |
| `work.explain` | 音乐 | free | 基于当前作品字段给结构化解释，不虚构模型内幕 |
| `music.set_title` | 音乐 | free + confirm | 改作品标题；先 diff 再确认 |
| `music.set_card` | 音乐 | free + confirm | 改意图卡参数（mood/vocal/sec/bpm/count/scene_desc）；先 diff 再确认 |
| `music.adjust_params` | 音乐 | paid + confirm | 自然语言微调；`assistant_actions` 闸门 |
| `music.regenerate` | 音乐 | paid + confirm | 按当前参数重出 N 个候选；`assistant_actions` 闸门 |
| `music.cover` | 音乐 | paid + confirm | 用某声音人格翻唱；`assistant_actions` 闸门 |
| `music.extend` | 音乐 | paid + confirm | 续写时长；`assistant_actions` 闸门 |
| `mv.set_title` | MV | free + confirm | 改片名；先 diff 再确认 |
| `mv.set_brief` | MV | free + confirm | 改故事基调简介；先 diff 再确认 |
| `mv.set_queue_mode` | MV | free + confirm | 切换正常档/夜间档；先 diff 再确认 |
| `mv.script_suggest_edit` | MV | free + confirm | AI 编剧生成新版建议（不替换现行剧本，挂草稿） |
| `mv.shot_reorder` | MV | paid + confirm | 重排镜头（需选中全部镜头）；`assistant_actions` 闸门 |
| `mv.shot_delete` | MV | paid + confirm | 删除未成片镜头；`assistant_actions` 闸门 |
| `mv.shot_reshoot` | MV | paid + confirm | 重拍镜头；`assistant_actions` 闸门 |

- 分类纪律：免费读工具直接执行、不发票；所有写工具先确认票、再执行；付费工具另受 `assistant_actions` 闸门。`music.regenerate/cover/extend` 与 `mv.shot_reorder/shot_delete` 是 v5.0 新扩入统一助手的动作（原入口保留，不迁移）。
- 执行复用既有内核：音乐写复用 `l2music.executeMusicTicketAction`，MV 写复用 `api/mv.executeTicketAction`；不重写计费与派单，唯一扣费点不变。

### 确认票

- 统一助手所有写操作走 `chat_tickets`（`scope='assistant'`），复用既有五连校验（hash12 + ver + TTL 60s + 一票一次 + 归属）；状态机 `pending → executing → succeeded|failed|reconciling|compensated`，`denied/expired` 为终态。
- 付费动作无批准票绝不派单、不扣费；确认后才执行，重复 confirm 返回同一 ticket/job，不新增 job、不重复扣费。
- 免费写（`set_title/set_card/set_brief/set_queue_mode/script_suggest_edit`）票面 `est:{credits:0,minutes:0}`，不受 `assistant_actions` 闸门限制；付费写（`adjust_params/regenerate/cover/extend/shot_reorder/shot_delete/shot_reshoot`）受闸门限制，默认关时返回 `gated`、不发票。
- 既有条目：`mv_tickets` 与 `chat_tickets(scope='music')` 保留兼容，不做数据迁移；统一助手新票一律 `scope='assistant'`。

### 开关与灰度收敛

- `assistant_core`：全局助手总闸（关闭时 v5 端点 404）；种子默认开启、灰度 1.0。
- `assistant_actions`：统一助手付费动作闸门，种子默认关闭；v5.0 在 V21 全绿后灰度开启。
- `assistant_chat_music`：统一助手 LLM 增强开关；关闭或 LLM 不可达时 `mode:'rule'`。
- 收敛：`music_assistant`/`assistant_chat` 保留原端点语义（v3.1/v4 兼容），不再作为统一助手入口；新入口一律走 `/v1/assistant/*`。
- `GET /v1/assistant/bootstrap` 的 `capabilities` 固定为 `{chat,voice,actions,music,mv,llm}` 六字段，不新增字段，保持端侧兼容。

### 数据形状

- `entity_ref = {type:'work'|'intent'|'job'|'project'|'shot'|'persona', id}`（v5.0 核心）；`shot` 必须属于 refs 中同项目或当前会话固化的项目；refs 去重，最多 12 个。
- `assistant_message` 增可选 `image` 字段（v5.0 扩展，阶段三）：`{image:{type:'image', id, url?, caption?}}`；端侧上传后由服务端 VLM 理解，继承同意与 72h TTL。文本消息体不变。
- 统一会话/票表沿用 v13 既有列；v5.0 阶段一 schema-neutral（不新增列）。

### 增量迁移

- 阶段一（v5.0 后端统一）：schema-neutral，沿用 v13；`chat_tickets` 已含 `scope/session_id/meta_json/job_id/reply/expires_at/started_at/finished_at/failure_code`，`chat_sessions` 已含 `scope/surface/title`。
- v14（预留，阶段三）：引入图片引用时新增 `assistant_images(id,user_id,session_id,ref_id,url,token_hash,expires_at,created_at)` 等；本版本不实现。

### 验收

- V21 统一助手全场景：19 工具白名单（读直接执行、免费写确认票、付费写 `assistant_actions` 闸门）；跨域动作（音乐重出/翻唱/续长、MV 片名/简介/队列档/编剧改稿/重排/删镜）复用既有执行内核且不重放；确认票五连与重复 confirm 不重派/不重复扣费；注入红线与工具越界；规则降级；离线事件补发；V13/V16/V17/V19 零回归。
- V22（阶段三）：`image` ref 上传、服务端 VLM 理解、继承同意与 72h TTL；端侧仅拍摄/选择本地文件。
- 端侧：统一入口承接音乐/MV 场景；旧音乐、MV 助手页转为薄壳（重定向到统一表面并预绑定 surface/refs）；端侧语音（阶段二）接入统一表面。

## v5.1 MV 加固回归口径（2026-11-27 追加，append-only）

> 由来：`test/acceptance/v20_mv_hardening.test.js` 自诞生起就没有契约对应块（抢救计划 P1-4 指出的"验收黑洞"之一）——
> 用例只在自己文件里断言，改坏了没人能从契约发现。本块把三条判据提升为契约，验收文件即该套件。
> 说明：契约版本沿用本档自己的 vN.M 序号（此处 v5.1），**不复用测试文件号 v20**，
> 以免"契约版本"与"测试编号"两套空间互相污染（`scripts/verify_routes.mjs` 按 `契约 vN.M` 双向核对）。

| # | 判据 | 违反后果 | 验收 |
|---|---|---|---|
| v5.1.1 | 审核词库**读取失败必须 fail closed**：读不到时 `available=false`、`stale=true`，但仍以**最后一次已知好规则**继续拦截（`moderate()` 对命中词仍返回 `ok:false`），不得"读不到就放行"。 | 词库文件损坏/权限异常期间全部违规内容直通 | `v20_mv_hardening.test.js` 第 1 例 |
| v5.1.2 | 机审指纹 `scriptHash()` 只随**用户面剧本内容**变化：派生身份、生成 id、时间窗、对齐结果等派生字段变化**不得**让机审过期；用户可见的剧本语义（如 `shots[].desc`）变化**必须**让机审过期。 | 要么机审永不重跑（违规剧本长期在线），要么每次执行都重复审（成本与延迟爆炸） | 同上第 2 例 |
| v5.1.3 | 库里以文本存的 JSON 数组列必须经 `U.toArr()` 归一：`'[]'→[]`、`'["a","b"]→[a,b]'`、逗号串 `'a,b'→[a,b]`；不得把整个 JSON 串当单元素返回。 | 前端拿到一个巨型字符串，标签/候选类字段整块显示异常 | 同上第 3 例 |

## v5.2 声纹样本私有化与字段长度真源（2026-11-27 追加，append-only）

> 由来：契约草案复核判定出两条真缺陷（`docs/contract-draft-adjudications.md` 判定 2、判定 4），
> 验收见 `test/acceptance/v30_persona_privacy.test.js`（5 例）。

| # | 判据 | 违反后果 | 验收 |
|---|---|---|---|
| v5.3.0 | 游客身份必须有可恢复锚点：`POST /v1/auth/guest` **必须**带 `device_key`（≥16 字符），服务端按 `sha256(device_key)` 复用同一游客号；无锚点一律 400，**禁止** `if (!user) INSERT` 静默建号；响应必须回 `first_time`，客户端在新建账号且本机已有内容时必须向用户明说。客户端清 token（登出/刷新失败）**不得**清除 device_key | 重装/清数据/401 刷新失败即换人：用户全部作品"凭空消失"且界面零提示（2026-11-27 真机 P0，用户原话「重装覆盖不能保存本地内容？？？？？？？？？？」） | V36-①②③④ |
| v5.6.0 | **克隆不许说谎 + 身份必须可自助恢复**：① `meta.clone.applied=true` 当且仅当 stage②（cover 变声）**成功替换了成品**；失败必须 `applied=false` + `stage2_failed=true`（可另带 `ref_unavailable`/`invalid_strength`），端侧必须把「没有套上」说给用户听 —— 禁止"payload 带了 persona 就宣布已克隆"。② `cover_strength`（唯一能锁音色/性别的旋钮）默认值**唯一真源 = `config.persona.defaultCoverStrength`**，业务代码与执行器一律不得自带默认数；App 深度档必须可调。③ 游客身份必须能被本人恢复：首次建号发一次备份码（只存 sha256），`POST /v1/auth/claim` 认领（本机已有临时号时摘锚让位、有作品时 403 停下），rotate 换码。④ 用户选的 `cover_strength`/`clone_mode` 必须过派单白名单并进幂等键，真的抵达引擎。⑤ 克隆诚实性只有一个读取路径：`meta.clone` 在候选 meta 根上 | 真机 2026-11-27：引擎 cover 失败（`stage2_error=MUSIC_HTTP`）时 `applied` 仍为 true，用户以为用的是自己的人格其实拿到默认音色；强度被硬编码 0.2 共三处、用户想锁也锁不住；重装后游客号无从恢复，只能靠运维手工 UPDATE guest_key | V37-①…⑩ |
| v5.2.1 | 用户上传的**声纹样本属敏感个人信息**，必须存私有目录 `var/voices/`（**不在** `/f/*` 公共静态映射内），`personas.voice_ref` 以 `voices/` 前缀标记；经 `GET /v1/personas/:id/voice` 取件，响应必须 `cache-control: private, no-store` | 任何持 URL 者可下载他人声纹（未经同意的声纹扩散） | V30-①② |
| v5.2.2 | 取件口按身份把关：**属主本人**或持 `X-Executor-Token` 的执行器可取；他人 403、未登录 401；**人格 `is_public=1` 只公开元数据，绝不公开声纹**；列表响应不得带出 `voice_ref` | 公开人格成为声纹泄露面；执行器取不到参考音频 → 声线克隆静默失效 | V30-②③ |
| v5.2.3 | 历史行（曾误存 `out` 的裸相对路径）必须仍可解析（`resolveVoiceRef` 兼容），加固不得把用户已有数据判死 | 升级即丢声纹，用户需重新录音 | V30-④ |
| v5.2.5 | **不得使用他人的人格做声音克隆**：`POST /v1/works/generate` 携带 `persona_id` 时必须校验归属，非属主一律 `403`（含 `is_public=1`）并记 `persona.use_denied` 审计；未经同意使用他人声纹属深度合成违规。公开人格仅可浏览元数据，若要开放复用须先引入"本人授权"字段（产品待决，不是删掉本条校验的理由） | 任何人可用他人声纹变声（深度合成/人身权益事故） | V31-① |
| v5.2.6 | 执行器侧声纹参考必须**真实可读**才允许声称已克隆：`payload.persona` 必须带 `id`；执行机读不到 `ref_abs_path`（跨机必然）时经 `GET {apiUrl}/v1/personas/:id/voice`（执行器令牌）回捞；取不到则 `meta.clone.applied=false` + `ref_unavailable=true` 诚实降级，**不得**报 `persona_applied=true`。同一 job 的 guide 与 cover 必须打到同一引擎（`payload.music_endpoint`） | 用户以为克隆生效其实从未发生；变声打到另一台机器 | V31-②③④ |
| v5.2.4 | 同一字段的长度上限必须**单点供给**：`mood` 由 `l2/governance_core.FIELD_LIMITS.mood` 提供，且必须等于落库截断长度（`api/works.js` 的 `slice(0,20)`） | 助手放行 60 字、写库截成 20 字 → 用户静默丢字，且两处会各自漂移 | V30-⑤ |

## v5.3 数据库并发写冲突口径（2026-11-27 追加，append-only）

> 由来：实机日志出现 `ERROR INTERNAL database is locked @ store.js:366`，正落在"扣钱+派单"的单事务上。
> 根因是 `store.tx` 用 deferred `BEGIN`：WAL 下"先读后写"的升级死锁会**立刻**回 SQLITE_BUSY，
> `PRAGMA busy_timeout` 在这条路径上**不生效**，于是用户看到 500，而且没人说得清那 15⚡ 扣了没有。
> 验收：`test/acceptance/v32_db_busy.test.js`（3 例，用第二条白盒连接真实持锁逼出竞争，不用 mock 锁）。

| # | 判据 | 违反后果 | 验收 |
|---|---|---|---|
| v5.3.1 | 写事务必须以 `BEGIN IMMEDIATE` 起（进事务即取写锁），使并发写排队等 `busy_timeout`（当前 5000ms），而不是等第一条 UPDATE 才炸 | 锁竞争变成即时 500，重试也救不回来 | V32-①（等待时长 ≥4s 是"真的排过队"的证据） |
| v5.3.2 | `BEGIN IMMEDIATE` 自身必须在 `try` 之内。放外面会绕过错误映射，更会打乱 BEGIN/COMMIT 配对 —— `txDepth` 泄漏后，后续每次 `tx()` 都误判"已在事务内"而跳过 BEGIN/COMMIT，写路径整体失去原子性 | 全站事务语义静默失效（比 500 更糟） | V32-②（BUSY 失败后同进程事务仍能正常配对并提交） |
| v5.3.3 | 超时的锁冲突必须回 `503 SERVICE_BUSY` + "请稍后重试"，**不得**混进 `500 INTERNAL`；客户端可原样重试（幂等键保证不重复扣分） | 客户端无法区分"该重试"与"真失败"，投诉与资损都难归因 | V32-①② |
| v5.3.4 | 锁冲突**不得**计入 `/healthz.audit_failures`（那个计数专指"审计写不进去"），也不得留下半截账：失败后 `Σdelta==balance` 必须仍成立、余额不变、该用户名下不得有 job | 观测噪声淹没真故障；半截扣款 | V32-① |


## v5.4 助手诚实兜底与上下文门（2026-11-27 追加，append-only）

> 来源：真机音乐链跑 `scripts/verify_real_music.mjs` 时抓到的**体感故障** —— 用户说「把标题改成《星河》」
> 「把这首歌改得更明亮一点」，助手回「我在。可以查任务和确认票、搜索曲库、解释作品…」（`mode=rule`、`tool=null`）。
> 根因不在 LLM：规则层的作品级分支全 gated 在 `work`（已核验作品引用）上，没有 work 就直接掉到最后那句
> 能力清单。MV 侧本来就有 `need_context` 先例（"先选择一个属于你的 MV 镜头"），音乐侧缺的就是同款。

| 条目 | 口径 | 不这样会怎样 | 验收 |
|---|---|---|---|
| v5.4.1 | 有明确**作品级**意图（改标题 / 调声 / 重出·翻唱·续长）但没有已核验的作品引用时，必须回 `meta.intent="need_context"`，且回复要**点明缺什么、怎么补**（"打开那首歌再说一次，或说出歌名我搜"）；**禁止**回能力清单式自我介绍 | 用户听起来就是被忽略，"助手看着不能用"的直接来源；也掩盖了真正缺上下文这一事实 | V33-① |
| v5.4.2 | 工具面里**没有**对应能力的问题（积分/余额）必须诚实指路（"没有查余额的工具，余额在「我的」页顶部"），**不得编造具体数字**、不得凭空冒出一个工具、且该回合不得动余额 | 编一个余额数字就是资损级信任事故；背清单是二次伤害 | V33-② |
| v5.4.3 | 实体解析只认服务端核验过的 `context.refs`：`work` 必须是**本用户名下的 works 行**（候选 `c_…` 不是作品，采纳后才出 `w_…`）；他人作品 / 不存在 id 一律丢弃并记 `refs.rejected` 审计，且**不得**命中任何写工具 | 跨用户改库 = 越权；把候选当作品会让"改标题"永远静默失败 | V33-⑤ |
| v5.4.4 | 工具命中后的票据口径按**读/写分档**：读类（`library.search` / `assistant.task_query` / `assistant.ticket_query` / `assistant.context` / `music.query_status`）**不得**发票；免费**写**（`music.set_title` / `music.set_card`）**必须**发 `body.ticket`，票未确认不得落库、不得扣费；付费动作在 `assistant_actions` 关（默认 fail-closed）时必须明确告知"尚未开放"，不发票、不扣费、不静默 | 无条件"发票即报"会把契约要求的正确行为报成故障；反过来静默改库或先扣钱是资损 | V33-③④ |
| v5.4.5 | **登记观测缺口（未修）**：付费闸门拒绝时的 `gated` 位只在 reply 文案里，没进响应体 —— 客户端只能靠读中文文案判断"是被闸门挡了还是没听懂"。是否加 `meta.gated` 待产品定，不加则验证脚本只能按文案放行 | 客户端无法机器分流（该显示"未开放"还是"请补充上下文"）；测试判据被迫依赖文案措辞 | 见 docs/contract-draft-adjudications.md |

## v5.5 智能体共创（伴创）·两层助手与端侧引擎（2026-11-27 追加，append-only）

> 由来：产品要求在不破坏既有三档（简约/标准/深度）的前提下，让用户「聊天即完成创作」，且助手要能覆盖音乐 + MV 全流程。
> 本轮核实的四个前置事实决定了本版的形状：
> ① `l2assistant` 全程**不调** `governance_core.fuseCheck`（实现在 `l2/governance_core.js:231`，只有 `l2music`/`l2mv` 接了）——多步智能体连发确认票就是资损；
> ② `assistant_actions` 种子 `on=0; gray=0`（`core/appconfig.js:105`），统一助手 9 个付费动作一律 `gated`；
> ③ `facade.js:19-25` 用手搓 JSON + `extractJson` 模拟 function calling，而实机探针证明 `qwen38-fp4` 原生支持 `tools`/`tool_calls` 且 `reasoning` 与 `content` 分离；
> ④ 板块小助手的两份 sheet **是现役生产代码**（`work_detail_page.dart:693`、`intent_flow_page.dart:555`、`mv_wizard_page.dart:150`、`mv_progress_page.dart:240`），且绕过统一助手直打 l2 后端，因此今天没有事件流、没有 `assistant_metrics` 记账。
> 方案全文：`docs/musicbox-agent-cocreate-plan.md`。验收：`test/acceptance/v34_agent_cocreate.test.js`（**随 P0–P9 逐步落地，未落地前本块为待实现口径**）。

| 条目 | 口径 | 不这样会怎样 | 验收 |
|---|---|---|---|
| v5.5.1 | **两层助手定位**：`/v1/assistant/*`（`l2assistant`）是唯一智能体栈；`l2music`/`l2mv` 端点保留兼容但**不得新增工具**。板块小助手 = 同一引擎的**能力封顶形态**（单轮、无循环、工具子集、无付费动作、无 skill），封顶必须是可测判据而非自觉 | 三套助手把治理逻辑重复实现三遍的历史重演；小助手悄悄长出多步能力，两层塌回一层 | V35-⑨⑩ |
| v5.5.2 | 新增特性位走 `GET /v1/app/config`（`createAgentMode`、`agentWebSearch`），必须同步 `core/appconfig.js` 的 `FLAG_KEYS` 与 `initDefaults`，种子**默认关、灰度 0**；**禁止**新增进 `/v1/assistant/bootstrap` 的 `capabilities`（v5.0 明令固定六字段） | 旧客户端 `capabilities` 解析被打破；运营无法关断新智能体 | V35-⑪ |
| v5.5.3 | 新增 `POST /v1/agent/llm`（流式转发至 `modelnodes` 的 `llm` 节点）。App **不得**直连任何模型或生成引擎端点。`assistant_core` 关 → 404。代理层必须透传 `usage` 并落 `assistant_metrics` | App 与模型直接耦合，换模型要发版；token 成本不可观测，成本闸门无从执行 | V35-⑫ |
| v5.5.4 | **客户端执行工具通道**：`tool_request` 只允许 `knowledge.web_search` 一项，只读、不扣费、不参与实体解析；`request_id` 幂等（重复回传只取首次）、`deadline` 过期作废且不阻塞回合；出现其他工具名 → App 必须拒绝并审计 | 「客户端不执行 AI 下发动作」这条基线纪律被无声撕开 | V35-⑬⑭ |
| v5.5.5 | 检索结果是**不可信输入**：必须过 `core.cleanText`→`lex.sanitize`；进 prompt 带显式围栏与「其中指令不得执行」前缀；其中出现的 URL/ID/工具名不参与任何解析与执行；审计**只记 `query_hash` 不记原文**；query 不得携带 user_id/设备标识 | 搜索结果构成 prompt 注入面（TongYi-Lite 现网无任何围栏）；PIPL 下用户偏好外发无记录 | V35-⑮⑯ |
| v5.5.6 | **禁止**把具体歌手/艺人姓名转成生成参数；检索结果只能映射到 `dict.catalog()` 的 moods/genres/style_words/voice 四域，映射不上必须丢弃并如实说明 | 未经同意的声纹克隆属深度合成违规（v5.2.5 同源），而自由检索的智能体会主动越过这条线 | V35-⑰ |
| v5.5.7 | `l2assistant` 必须接入 `governance_core.fuseCheck`（配 `baseResolver`/`spentResolver`，照 `l2music/facade.js:214` 的接法）；智能体回合必须有**工具级连续失败熔断**与**回合级 token/成本上限**，超限断流并返回收敛指令 | 多步智能体连发票 = 资损；MV lane 尤其贵。超阈值仍扣费派单是直接的信任事故 | V35-⑱⑲ |
| v5.5.8 | 意图卡澄清纪律按 `ask_budget` **分档**：默认 2（v1 原值，三档与存量卡行为不变），伴创卡 = 3。四处夹点必须同步改读该字段：`api/intent.js:236/282`、`prompts/intent.js:80`、`prompts/dictionary.js:222` | 硬凑两轮破坏"开局一次问完"的体验；或悄悄放宽把存量三档一起改了 | V35-① |
| v5.5.9 | `questions[].options[]` 增**可选** `set` 载荷（`{tags_add[], genre_add[], mood_add[], vocal, bpm, sec, dim}`）；答题回填优先用 `set`，缺失才回落 `dict.scan(label)`；`set.tags_add` 写 `gen_params.tags`，**不得**并入 `genre_hypotheses` | `api/intent.js:249-253` 把 `scan.tags` 一律并进 `genre_hypotheses`，被 `unionArr` cap=3 且 a 优先静默挤掉 —— 即真机记录的「勾女声出男声」；BPM 则今天完全落不了地 | V35-②③ |
| v5.5.10 | `POST /v1/intent/:id/answer` 必须以 `BEGIN IMMEDIATE` 事务执行（对齐 v5.3.1）并按 `q_idx` 去重合并 `answers`；UPDATE 语句必须包含 `gen_params` | 现在是裸 read-modify-write，并发两次都从 `rounds=0` 起算 → 丢更新、rounds 少计、半截答案 | V35-④ |
| v5.5.11 | **轻量写边界**：AI 直写意图卡仅当「属主本人 + `status∈{clarifying,ready}` 未 consumed + 该 intent 在本次会话已核验 `refs` 内 + `patchIntentInternal` 限流通过」全部成立；任一不满足必须发确认票。`patchIntentInternal`（`api/intent.js:302`）**内部必须**执行 `U.allowRate`，不得只在 HTTP 端点 `:298` 校验。派单永远走票 | 助手通道 `l2music/execute.js:59`、`l2assistant/facade.js:444` 一直在绕过那个 10次/60s 的桶；智能体化会把它放大成脚本刷卡通道 | V35-⑤⑥⑦ |
| v5.5.12 | Skill 三级 rank：100 APK 内置最小集 / **150 服务端下发** / 200 用户自定义，同名按 rank 高者胜（复用 `provider.dart:133` 的去重）。每回合目录只注入**已启用** skill 的一行摘要；下发不可达时回落内置并如实告知。skill 正文引用的工具名必须 ∈ `TOOLS` 白名单（CI 强制）；正文禁止祈使式副作用表述，涉副作用只能写「调用 `x`（需用户确认）」。`load_skill` **同会话重复加载不得重复注入全文** | skill 焊死在 APK → 调话术要发版（IA review #7 同类事故）；skill 指向不存在的工具会让模型幻觉调用；重复加载吃光上下文 | V35-⑧⑳㉑㉑b㉘ |
| v5.5.13 | 智能体人格为**服务端可配基础项**，作为 system 追加段置于工具/审批纪律**之前**且**不得覆盖**之；配置不可达必须回落内置默认，助手不得失声。声音人格（`personas`）迁「我的 → 声音与人格」，v5.2.1~④ 的声纹私有化、`cache-control: private, no-store`、consent 流程一律不变 | 一次错误的人设配置即可让智能体绕过工具白名单；把敏感流程顺手改坏 | V35-㉒㉓ |
| v5.5.14 | 智能体每步事件必须回放到 `assistant_events`（三分类 + `ignorable` 版本门；压缩 = 追加遮蔽不删原文；崩溃修复只追加不改写、不伪造时间戳）。`seq` 分配必须在服务端单点事务内 | 决策过程不可审计，"它为什么这么做"无人能答；端侧循环的审计债就此悬空 | V35-㉔ |
| v5.5.15 | 底部 tab 数量保持 **5**；伴创替换「人格」槽位（不破 CONTRACTS.md:718「不新增底部一级页」/:814「不增加第六 tab」）。创建页档位列表改数据驱动，`tier` 整数为持久化身份（0/1/2 不可变，伴创 = 3），显示顺序可变 | 破第六 tab 红线；或 `create_tier` 持久化 int 与显示顺序耦合，升级后用户档位记忆错位 | V35-㉕㉙ |
| v5.5.16 | 新增服务端 `agent_memory` 表（`scope ∈ {global, intent:<id>, work:<id>}`）与 `memory_set/get/delete`（free，不涉扣费不发票，但审计 `initiated_by:'agent'`）。记忆注入 system 独立段、置于工具/审批纪律之前且**不得覆盖**之；不得存凭据/手机号/声纹；有条数与长度上限；「我的 → 伴创记忆」必须逐条可见可删可清空 | 用户每次创作都要重述同样偏好；或反之，记忆成为绕过白名单的后门、成为无法删除的个人信息 | V35-㉙㉚ |
| v5.5.17 | **迁移 UI 规范**：从 TongYi-Lite 只搬逻辑层（`lib/agent/{loop,session,skills,tools,llm/adapter,llm/openai_adapter,agent_tier}` 与 `lib/websearch/src/*`），**禁带其 `lib/screens/**`（5109 行）与 `lib/widgets/**`（含 `agent_workflow.dart` 2334 行）**；移植后的逻辑层文件不得 `import 'package:flutter/material.dart'`。伴创 UI 全部用 `CreationPalette`/`CreationBackdrop`/`creationFieldDecoration` 与既有公共件（`PrimaryButton`/`TagChip`/`MoodChips`/`AiBadge`）重建，业务文件不得出现 `Color(0x` 字面量或裸 `InputDecoration(`；不得引入 `pubspec.yaml` 未声明依赖；关键交互件必须有语义节点且**不可点必须带 reason**。用户可见文案不得出现引擎名/模型名/协议黑话 | "遵守总体设计"若只是叮嘱，会退回今天 `assistant_surface.dart` 的样子（8 处硬编色绕过设计系统、`:543` 用 Material 默认 `OutlineInputBorder`）；缺语义节点的按钮对 TalkBack 与自动化**同样点不到**（IA review #10/#14/#15 已实证） | V35-㉛㉜㉝ |

## v5.6 克隆诚实性、强度唯一真源与身份可自助恢复（2026-11-27 追加，append-only）

> 由来：小米13 真机选人格生成，引擎 cover 变声失败（`meta.clone.stage2_error="MUSIC_HTTP"`），
> 但候选 meta 仍是 `{applied:true, stage2_failed:true}` —— 执行器在发起变声**之前**就把 applied 写死了 true，
> 失败分支只补 stage2_failed 从不撤销。用户以为拿到自己录的声线，实际拿到默认音色；而这件事界面上一字不提。
> 同期另外三件事：`cover_strength`（唯一能锁音色/性别的旋钮）被硬编码 `0.2` 共三处且 App 无处可调；
> 老作品 tags 被按空格切碎（`female,vocal` / `vinyl,crackle`）；游客号换机后无人能恢复，最后靠运维手工
> `UPDATE users SET guest_key=…` 救号。验收：`test/acceptance/v37_clone_honesty.test.js`（V37-①…⑥，含真跑的功能判词）。

| # | 判据 | 违反后果 | 验收 |
|---|---|---|---|
| v5.6.1 | `meta.clone.applied=true` **当且仅当** stage②（cover 变声）成功替换了成品。全文件只允许一处把 applied 置真，且必须位于成品替换（`renameSync(coverAbs…)`）之后；失败必须 `applied=false` + `stage2_failed=true`（可另带 `ref_unavailable`/`invalid_strength`/`stage2_error`） | 用户把默认音色当成自己的声线，且无从知道；人格功能整体失去可信度 | V37-①（源码结构判词：置真位置必须在成品替换之后） |
| v5.6.2 | 端侧必须把"没套上"说给用户：`Candidate.personaApplied/personaFailed/personaFailReason` 真读 `meta.clone`，揭晓页引用它们。只写进 meta 而界面沉默 = 等于没说 | 同 v5.6.1，且用户连投诉的线索都没有 | V37-③ |
| v5.6.3 | `cover_strength` 默认值的**唯一真源 = `config.persona.defaultCoverStrength`**：建人格、派单、执行器一律不得自带数字；缺省走 config、给了就 clamp 到 `[min,max]`；默认值经 `/v1/app/config` 下发（必须进 `config_version` 的 sig），端侧取不到要如实显示"未取到"，**不许**自带 `?? 0.6` | 运营改默认后 App 显示的档位和实际跑出来的不是一回事；用户想锁音色锁不住 | V37-② |
| v5.6.4 | 「谁来唱」三档一致：简约/标准/深度都必须能单选性别，且中文标签→规范词必须走词典真源（`styleCatalog.wireOf`） | 最省事的那一档恰恰锁不住性别；端侧词表各说各话 | V37-④ |
| v5.6.5 | 游客身份必须能被**本人**恢复：首次建号发一次备份码（库里只存 sha256，之后任何接口都不得吐回），`POST /v1/auth/claim` 按备份码命中才认领（命中后换锚点 + 该用户旧会话全部作废），`POST /v1/auth/recovery/rotate` 换码即作废旧码。认领失败**绝不许**顺手建号；无 `device_key` 认领一律 400 | 重装/换机即永久丢号（今天的现实是运维手工 UPDATE）；或恢复通道变成任何人可冒充的接管入口 | V37-⑥（旧 token 认领后必须 401、rotate 后旧码必须 401、乱码必须 401 且不建号） |
| v5.6.6 | 批量修用户数据的脚本必须：词表只从 `prompts/dictionary` 读（代码里不得出现规范词字面量）、默认干跑（显式 `--apply` 才写库）、幂等（二次运行 0 改动）、按原存储格式写回、落审计 `tags.repair` | 第二个词表真源开始漏修；一次误跑把用户数据改没且无从追溯 | V37-⑤ |
| v5.6.7 | 用户选的音色贴近程度必须**抵达引擎**：`POST /v1/works/generate` 的入参白名单必须含 `cover_strength` 与 `clone_mode`；且二者必须进**幂等键**（只拖滑杆/只切模式再派单，必须是一单新的活，不得被 10 分钟窗口内的旧 job 吃掉） | 滑杆只是装饰：显示 100%、payload 永远跑默认值；或改完强度按生成拿回上一首 —— 都是「选了却被静默丢」 | V37-⑨（1 / 0.35 / 越界夹紧 / `clone_mode=full` 原样抵达 + 改强度不得命中幂等旧单；抽掉白名单字段或幂等键字段判词必须变红） |
| v5.6.8 | 备份码认领必须处理**重装的真实顺序**（首启先自动建临时游客号，用户才想起认回）：本机锚点被空壳号占用时摘锚退役（改 `guest_key='retired-'||id` + 作废其会话，**保留行** —— 积分流水等外键指着它，删行留孤儿账）；持有人已有作品则 403 停下并说清下一步，绝不为认领静默毁掉任何一侧内容 | 恢复通道在最需要它的那一刻 500（`UNIQUE users.guest_key`）；或用恢复换掉别人的作品 | V37-⑦（复刻真机顺序：先本机建号再认领必须 200、内容一行不少、临时号被摘锚且留审计）、V37-⑧（本机号有内容必须 403，两边内容都不许少） |
| v5.6.9 | 克隆诚实性的**唯一公开读取路径 = `meta.clone`（根上）**。执行器把引擎回执整包写在 `raw.meta.clone` 时，服务端必须在 `store.candidateOf` 归位到根；端侧只准认这一个路径，不得去猜嵌套 | 数据是诚实的但界面读不到 = 等于说谎：真机揭晓页因此完全不显示「没有套上」 | V37-⑩（灌入真机形制的 `raw.meta.clone`，`GET /v1/jobs/:id` 返回的候选 `meta.clone` 必须在根上且 `applied/stage2_failed/cover_strength` 原样抵达；抽掉归位判词必须变红） |
| v5.6.10 | 变声阶段失败必须留下**可诊断面包屑**：`meta.clone.ref_path`（引擎被要求读的声纹路径）与 `meta.clone.engine`（引擎 host:port）。跨机拓扑下 `MUSIC_HTTP` 绝大多数是「引擎那台机器读不到这个路径」 | 同样的 400 每次都要翻执行器日志重查 20 分钟，缺陷因此长期存活 | V37-①（源码判词：失败分支必须落 ref_path/engine） |
| v5.6.11 | 跨机部署下**声纹与源曲都必须先经引擎 `POST /ref` 投递口**送进去，`/music` 的 `ref_audio`/`src_audio` 只能是该口返回的**引擎本机路径**。投递口规矩（实现 `ref_intake.py`，与 `server.py` 同目录同推）：未配 `ACE_REF_KEY` → 503（**禁止匿名写文件**）、错 key → 401、空 body → 400、超 25MiB → 413、扩展名白名单外 → 415、落盘名一律引擎生成（客户端给的路径/文件名不得进路径）、过期声纹按期清理。执行器投递失败必须诚实退回本机路径，并把 `meta.clone.ref_delivery`/`src_delivery` 的 `reason`（`unsupported`/`key_rejected`/`intake_disabled`/`http_*`/`net_*`）落全 | 引擎只认自己文件系统里的绝对路径（`os.path.isfile`），递执行器本机的 Linux 路径必然 `HTTP 400 ref_audio not found` —— **人格克隆自上线以来一次都没有真的生效过**，用户长期说「不像我的人格/性别不对」却谁都查不到原因（2026-11-27 真机靠执行器日志查了 20 分钟）。只投声纹不投源曲等于修了一半：cover 任务引擎要同时读两个文件 | V38-①…⑤（假引擎带**虚拟文件系统**：没投递过的路径一律按引擎真实脾气回 400 → 投了才允许 `applied=true`，没投必须 `applied=false + stage2_failed=true` 且 reason 有名有姓；抽掉投递判词必红）+ `scripts/check_ace_ref_intake.py` 12 条自测 |
| v5.6.12 | 「空壳作品」的判定**只有一个真源 = `Work.isHusk`**（标题/时长/标签/歌词/音频全空，显示占位符「未命名作品」按空标题算）。曲库卡片与作品详情都必须走它：空壳不得画伪波形、不得写 `0:00`、**不得留一颗点了没反应的播放键**，必须说「数据不完整」并给出路（重试/删除） | 骨架被打扮成正经歌 = 用户以为“我存好的歌变成了一首空歌”，比直接报错更像数据丢了；而列表才是用户第一眼看到的地方，只修详情页等于没修（2026-11-27 真机） | V37-⑪（服务端确实会原样发这种行 + 卡片/详情都必须用 `.isHusk`、不许私有复刻、空壳分支不许出现 `onPlay`/`play_arrow`）+ `src/app/test/work_husk_honesty_test.dart` 5 条 |
| v5.6.13 | **界面里不许出现「解释控件不是什么」的说明句**：`Text`/`hint`/`trailing`/`label` 等**用户可见字符串**里不得出现「这是 X，不是 Y」「而非风格」式澄清句。需要靠脚注才能被理解的控件即为不合格控件 —— **该删的是控件或改它的形态，不许给用户加阅读负担**。分组的可见标签**不许**因 `shortScreen` 等条件消失（只剩裸 chips 更容易被误读成风格），chips 必须单行横向滚动 | 这是同一批 bug 的化石：女声/男声曾被塞进「风格点缀」，于是简约档、标准档、要素选择器**各挂一句**「这是人不是风格」，把设计失败转嫁成用户的阅读负担；同时小屏上「谁来唱」标签还整行消失，只剩裸 chips。用户原话「这他妈的都可以做界面提示，是我疯了还是你疯了？」（2026-11-28） | V39-①②（扫全部 Dart 用户可见字符串；把说明句塞回去判词必红）+ `create_layout_test`（标签常驻仍不溢出 320×568 @2× 字号）+ V31 锚点跟随标题改名 |
| v5.6.14 | **「要人声」和「有歌词」是一件事的两半，不许静默拆票**：歌词为空而用户要人声时，执行器**必须**按纯音乐向引擎发请求（`instrumental:true` —— 不许拿 `false` 去骗一个只会出纯音乐的引擎），并落 `meta.vocal={requested:true,delivered:false,reason:'no_lyrics'}`；端侧必须说破（`Candidate.vocalUnmet` + 揭晓页横幅 + 歌词字段上的后果提示）；**没有歌词时不许发起 cover**（`clone.skipped_no_vocal`，一个字节都不许多投）。**界面承诺必须有实现兜着**：服务端没有写词模块就不许出现「自动填词」类文案 | 真机 2026-11-28：载荷 `{"lyrics":"","instrumental":false}` 一路照发到引擎，用户在深度档选了「人声演唱」拿到的却是纯音乐（他原话「这不是纯音乐么？」），而字段上写着「留空则由 AI 自动填词」—— 全仓零实现，用户只会以为是自己的歌词没写好；连带对一首没有人的歌做 cover = 白烧一次 GPU + 谎称「用了你的人格」 | V40-①…⑤（假引擎跑真实数据路径：不许骗引擎 / 不许误伤正常路径 / 纯音乐不许假告状 / 无歌词不许 cover 且零字节投递；⑤ 是「承诺 ↔ 能力」对账，真写了填词模块会自动放行文案）+ `vocal_honesty_test.dart` 4 条 |
