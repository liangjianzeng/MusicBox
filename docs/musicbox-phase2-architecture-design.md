# MusicBox · 二期目标架构设计（MV 创作 · 施工基线）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-phase2-architecture-design.md |
| 日期 | 2026-11-23 |
| 输入 | [musicbox-phase2-mv-plan.md](musicbox-phase2-mv-plan.md)（二期规划，§11 决策已全部落定）、一期 [musicbox-architecture-design.md](musicbox-architecture-design.md)（基线，本文不重复其结论）、X-Theater 实现调研（引擎/流程/AI 辅助）、DGX Spark 实机勘探（SURVEY/EVIDENCE） |
| 范围 | 部署拓扑（二期全量 Spark）/ 客户端 / 服务端 / 执行器与微服务 / 数据模型 / API 契约 v2 / 关键序列 / 队列吞吐模型 / ADR-MV / 安全 / 观测运维 |
| 纪律 | 接口以 CONTRACTS.md **v2** 为唯一真源（拍板后冻结）；「先改契约，再改代码，再回归」；共宿主服务（剧场 ComfyUI `:8188`、vLLM `:8090`、ACE-Step、SearXNG）**零改动零杀死** |

---

## 1. 部署拓扑（二期全量 DGX Spark · Linux）

```
┌ 公网 VPS（一期既有，不动）──────────────────────────────────────┐
│ Nginx：TLS 终结 / WSS 升级 / 限流 / /f/* 静态面（成片档）        │
│ 反代回源 → tailnet → Spark :7900（App 与外网执行器唯一入口）      │
└──────▲──────────────────────────────▲───────────────────────────┘
       │ HTTPS（App REST/WSS）         │ HTTPS（executor 拉单，架构不变 ADR-MB-4）
┌ DGX Spark（Ubuntu 24.04 LTS aarch64 · GB10 · 121GB 统一内存 · NVMe 916G）─┐
│ ▍MusicBox 新增（systemd 托管，/opt/musicbox，运行时 var/ 落 NVMe）          │
│   musicbox-api        :7900  Node ≥22 arm64 零 npm 依赖（server 本体）      │
│   musicbox-executor   —      拉单 daemon；--lanes imgspark,vidspark,        │
│                             lipsync,align,ffmpeg；**--concurrency 1 强制**   │
│   mv-lipsync-svc      :8390  EchoMimicV3-Flash（uv venv，懒加载/用后释放）   │
│   mv-facegate         :8395  ArcFace /score /swap（insightface onnx，CPU）   │
│   mv-asr              :8391  SenseVoice CPU（时间戳对齐；一期 :8191 同码拷贝）│
│ ▍共用（他人所有 —— 只调用、只观测，绝不 /free / 绝不 kill / 零改动）          │
│   ComfyUI             :8188  ★ D1 裁决共用队列；H3 全家桶热集（NVMe）        │
│   vLLM                :8090  LLM（qwen38-fp4 → Inkling-2-Mini 换装，D4）     │
│   ACE-Step 1.5        :待登记（E1）  二期 MV 不依赖；N3 音乐 lane 并机候选    │
└─────────────────────────────────────────────────────────────────────────────┘
┌ 5060 Ti（一期现状保留）───────────────────────────────────────┐
│ ACE-Step :8190（剧场共用）＋ executor(music,intent,ffmpeg) ＋ 开发调测 │
└────────────────────────────────────────────────────────────────┘
```

### 1.1 进程与端口表

| 进程 | 端口 | 属主 | 说明 |
|---|---|---|---|
| musicbox-api | 7900 | MusicBox | 与一期同码（Node 零依赖天然可迁 arm64）；`MB_VAR_ROOT=/opt/musicbox/var` |
| musicbox-executor | — | MusicBox | 拉单本机 API；心跳/租约语义不变 |
| mv-lipsync-svc | 8390 | MusicBox | `GET /health{weights_loaded}`、`POST /lipsync {video,audio}`→mp4+sync_score；FastAPI/uvicorn（同 sensevoice worker 形态，`src/workers/mv_lipsync/`） |
| mv-facegate | 8395 | MusicBox | `POST /score {img_b64,ref_file}→{score,yaw,pitch,pass}`、`POST /swap→{png_b64,score}`（剧场 runtime/facegate **协议范式移植**，自有部署） |
| mv-asr | 8391 | MusicBox | `POST /asr {path}→{text,segments[]}`（一期 `src/workers/sensevoice/app.py` 拷贝+时间戳扩展） |
| ComfyUI（共用） | 8188 | 剧场 | `POST /prompt`、`GET /history/{id}`、`GET /view`、`POST /upload/image`、`GET /system_stats`、`GET /queue`（位次观测）；**`:8288` 为逃生口**（仅 SP-MV-4 互扰超标启用，executor `MB_COMFY_URL` 一键切换） |
| vLLM（共用） | 8090 | 宿主 | OpenAI 兼容；模型名以 `/models` 为准（`MB_LLM_VLM_MODEL`） |

端口避让已占用清单（SURVEY 实测：22/53/2222/3080/3350/3389/5201/8080/9230/11000/17670/45893/55319/64038/8085/8088/8089/8188/8090）；83xx 段为 MusicBox 视频微服务专用段，部署前 `ss -ltn` 复核。

### 1.2 内存预算与仲裁（121GB 统一内存 · 共宿主）

| 常驻/项 | 典型占用 | 策略 |
|---|---|---|
| H3 视频族（fl2va 20G + TE qwen3vl 15G + video VAE 5.2G + turbo LoRA ~2G） | ~42G | ComfyUI 同族常驻不释放（EVIDENCE 纪律）；TE/DiT 动态分页已实证无 OOM |
| H3-Image 族（image 20G + TE-LLM 6.9G + image VAE 1.2G） | ~28G | 与视频族**跨族切换**由 :8188 队列管理 |
| vLLM :8090（现 qwen38-fp4，Inkling-2-Mini 预期更小） | 托管方管理 | MusicBox 只调 API，内存调度不归我们 |
| mv-lipsync-svc（EchoMimicV3-Flash） | 12–16G | **懒加载 + 空闲 10min 释放**（一期 ACE-Step 纪律） |
| mv-facegate / mv-asr | ~2G / ~2G | onnx/CPU，常驻可 |
| Node×2 + ffmpeg 合成突发 | ~4–6G | — |

**仲裁纪律**：① MusicBox executor `--concurrency 1`（一次一 job，全局串行——比一期按 lane 并行更保守，保共宿主安全）；② 领单前读 `:8188/system_stats.ram_free`，`< 20G` 水位线则挂起等待（只观测不干预，连续 3 次低水位上报观测指标）；③ lipsync/facegate/asr 由 executor 独占调用（83xx 段不对外）；④ 与剧场任务的真实互扰度 = SP-MV-4 交付物，超标走 `:8288` 逃生口。

### 1.3 systemd 单元与环境文件（`deploy/spark/`）

```
musicbox-api.service          # ExecStart=/opt/musicbox/node/bin/node src/server/index.js
musicbox-executor.service     # --api http://127.0.0.1:7900 --lanes imgspark,vidspark,lipsync,align,ffmpeg --concurrency 1
mv-lipsync.service            # uv venv 启动 :8390（MODELSCOPE_CACHE=/opt/musicbox/var/models）
mv-facegate.service           # :8395
mv-asr.service                # :8391
# 统一 EnvironmentFile=/etc/musicbox/spark.env：
#   MB_COMFY_URL=http://127.0.0.1:8188  MB_LLM_VLM_URL=http://127.0.0.1:8090/v1
#   MB_LIPSYNC_URL=http://127.0.0.1:8390  MB_FACEGATE_URL=http://127.0.0.1:8395  MB_ASR_URL=http://127.0.0.1:8391
#   MB_EXECUTOR_TOKEN=<executor token>  MB_MUSIC_URL=http://192.168.1.x:8190（一期不变，二期 MV 不用）
```

灰度与熔断配置面（server `config.js`）：`mv_enabled`（总开关，默认 false 灰度）、`mv_assistant.chat`（对话版开关+灰度系数 0.2）、`comfyUrl`（:8188/:8288 切换）、`mvBudgetDefault=1200`、`mvQueueNightMode`（夜间档开关）。

---

## 2. 客户端架构（Flutter · 安卓唯一前端）

```
lib/
  features/mv/                      # ★ 新增特性域（文件归属：app 施工方 C）
    mv_page.dart                    # tab 主页：我的 MV 列表 + ＋新 MV
    mv_wizard_page.dart             # 六步向导壳（步骤条 + 卡流；步骤可退出续作）
    steps/step_work.dart            #   ① 选曲（复用曲库数据源 works(mine)）
    steps/step_cast.dart            #   ② 选角：双通道硬要求（拍照/上传 + AI 生成歌手）+ consent 门禁
    steps/step_look.dart            #   ③ 定妆：3 候选→定妆视频播放→13 帧格勾选（facegate 分排序）→拍板
    steps/step_script.dart          #   ④ 剧本/分镜：镜卡竖列（长按改词/删镜/调序/景别 chips）+「让它改改」
    steps/step_boot.dart            #   ⑤ 样片播放器（非正式角标）→ 报价卡 →「开机开拍」
    mv_progress_page.dart           #   ⑥ 剧组通告板：TaskChip×镜 + 位次/ETA + 重拍 chips/诊断卡
    mv_detail_page.dart             # 成片详情：播放器+母 work 谱系+音画报告入口
    mv_reveal_page.dart             # 首映礼揭晓动画（复用 RevealPage 视觉语言）
    assistant_sheet.dart            # bottom-sheet 制片助手（N2，灰度可见性服务端下发）
  core/api_client.dart              # + mvImage/mvProject/mvJobs/mvTicket* /mvReport/mvAssistant*
  core/models.dart                  # + MvProject/MvCharacter/MvShot/MvTake/Mv 模型（禁词过滤后入库）
  shared/widgets/mv_task_chip.dart  # 5 态 TaskChip（排队/开拍/对口型/合成/完成）
  shared/widgets/lang_filter.dart   # 端侧禁词二次幂等过滤（§10）
```

- **状态管理**：Riverpod `StateNotifierProvider`（全 App 范式）——`mvProjectProvider(family:projectId)` 聚合 project+shots；进度页双通道（3s 轮询 jobs + WSS `mv.progress`），沿用 `ProgressPage` 已验证模式。
- **视频播放**：新增 `video_player` + `chewie`（官方件）；失败降级「海报+音频预览」（低端机保底）；成片按需缓存（drift LRU，一期离线包范式）。
- **通知**：复用一期 ADR-MB-7（WSS 前台 + 前台服务通知），`mv.done` 完成通知拉回验收。
- **上传**：`image_picker`（相机/相册）+ consent（`biometricConsented` 门禁范式）+ Dio multipart，走 `POST /v1/mv/image`。
- 播放条/曲库联动：曲库网格 `kind=mv` 封面卡；详情页「用这首拍 MV」直达向导步②。

---

## 3. 服务端架构（零依赖 Node，延续一期纪律）

```
src/server/
  api/mv.js                 ★ projects/image/jobs/shots/tickets/assistant/report + routes 注册（index.js 模块数组加 mvApi）
  core/engine.js            + completeMv 分流：completeMvCastImage/CastVideo/Storyboard/Clip(+子 lipsync)/Align/Preview/Compose
                              finalizeMvClipParent（仿 finalizeMusicParent：子任务终态才 done+广播）
  core/store.js             + MIGRATIONS version:3（§5 DDL）
  lanes/index.js            + imgspark/vidspark/lipsync/align 四 lane（timeoutMs/ladder/concurrency=1，§3.2）
  prompts/mv_script.js      ★ 剧本编译（qwen/Inkling）+ 确定性分场模板兜底（LLM 可选性纪律）
  prompts/mv_assist.js      ★ 基调建议/让它改改/运动改写/顾问回执（人格包装，数据非指令 q() 定界）
  core/mv_validator.js      ★ 剧本结构校验（镜数↔时长/首镜钩子/副歌主演/唱段全覆盖/cast 合法，warn 不 fail）
  core/mv_aireview.js       ★ 多人格卡审：规则机检 findings（engine="规则机检"）+ LLM 在线叠加 llm_findings（诚实标签）
  l2mv/facade.js            ★ 助手门面：消息→注入红线→interpret（LLM 意图+正则表）→gateTool→ticket/execute→审计
  l2mv/governance.js        ★ 工具白名单 7 项/参数域/确认票生命周期/预算双熔断/会话记忆（剧场 l2 范式裁剪）
  rules/mv_lexicon.js       ★ 禁词表 + sanitize()（三层净化之首）
  rules/mv_budget.js        ★ 项目护栏（1200⚡默认，>120% paused 仅人工恢复）+ 助手代动熔断
  config.js                 + credits.mv* / mv 端点 / mv_enabled / mv_assistant.chat / comfyUrl
```

### 3.1 任务引擎扩展（parent-child 链，复用一期语义）

- `enqueue({type,payload,userId,idemKey,creditsCost,parentJobId})` 不变；MV 类型族：`mv_cast_image/mv_cast_video/mv_storyboard/mv_shot/mv_lipsync/mv_align/mv_preview/mv_compose`。
- **mv_shot 父子链**（歌唱曲演唱镜）：`mv_shot` complete（clip 落 take）→ server 判 shot.kind=singing → `enqueue(mv_lipsync, parentJobId)` 并延长父租约 → 子 complete（synced take + sync_score）→ `finalizeMvClipParent` 收口（失败语义沿用 attempts<3 回队降档、耗尽 failed+refund）。
- **项目自动合成**：project 全部 shot 达 `clipReady/synced/locked` → server 自动 `enqueue(mv_compose)`（project→composing）；任何镜重拍完成后自动再 compose（幂等键含 shot 状态哈希）。
- **计费**：先扣后派单（`credits.charge`→enqueue，抛错即退）；系统补拍 `creditsCost=0` + `initiated_by=system`；报价外动作必须过确认票后才扣。

### 3.2 lanes 表（server 侧声明，executor 镜像注册）

| lane | types | timeoutMs | ladder（只降技术档不降计费维度） |
|---|---|---|---|
| imgspark | mv_cast_image, mv_storyboard | 900s | steps 8→4 恒定 turbo，重试保真；同参 OOM 不重试（铁律） |
| vidspark | mv_cast_video, mv_shot | 3600s | 帧网格上限内截 362；steps 恒定 4；不降分辨率档（计费诚信 DEV-LADDER-PAY 教训） |
| lipsync | mv_lipsync | 1800s | 推理步数 30→20 一次；仍败 → 走兜底降级（换 B-roll）非 fail 全片 |
| align | mv_align | 120s | 纯 CPU 直落 |
| ffmpeg | mv_preview, mv_compose（+一期 transcode/dsp） | 600s（compose） | — |

**未知类型仍兜底 ffmpeg（一期陷阱）**：新类型必须先登记 lanes 表 + executor ROUTE 双处，CI（V13）断言 `laneOf` 正确路由。

---

## 4. 执行器与推理微服务（GPU 重活全部 Spark）

```
src/executor/
  index.js        ROUTE + mv_*→lanes/mv.js；KNOWN_LANES + imgspark/vidspark/lipsync/align；pickRunner +；--concurrency 1 强制
  lib/comfy.js    ★ 剧场 adapters/comfy.js 协议移植：templates/<name>.json 读入→manifest tmpl_sha16 校验
                    （漂移抛 COMFY_TMPL_DRIFT）→<KEY> 注入→POST /prompt→轮询 /history→GET /view 拉产物；
                    /upload/image 传垫图；GET /system_stats、GET /queue 只读观测；**无 /free 实现**（代码层不提供）
  lib/h3ir.js     ★ 六段式 IR 移植：buildFL2VA（三字段）/buildREF2VA（subject_definitions…+<d> 唱段），
                    lengthFrames=5+17k 网格（≤362）；sings 变体=「对镜歌唱表演」语义（口型由 post-hoc 驱动，不要求模型唱准）；
                    validateIR 校验不过弃用重写；rewriteWithLLM 钩子默认关（:8090）
  lanes/mv.js     ★ runner 表（§4.1）；错误码族 COMFY_UNREACHABLE/COMFY_HTTP/COMFY_TIMEOUT/COMFY_QUEUE/LIPSYNC_UNREACHABLE/
                    ASR_UNREACHABLE/FFMPEG_MISSING/IDENTITY_GATE_FAIL；mock 模式（§4.3）
src/workers/
  mv_lipsync/app.py   ★ :8390 FastAPI；EchoMimicV3-Flash（uv venv，权重 ModelScope/hf-mirror→var/models）；
                        POST /lipsync {video,audio}→{file,sync_score}（SyncNet 自检内置，SP-MV-1 定档）
  mv_facegate/app.py  ★ :8395；insightface onnx；/score /swap（inswapper_128）
  mv_asr/app.py       ★ :8391；一期 sensevoice app.py 拷贝 + segments 时间戳输出
```

### 4.1 runner × payload（契约 v2 §4 冻结口径）

| type | 流程 | 产物→result |
|---|---|---|
| mv_cast_image | 上传照→/upload/image 垫图 → h3-image-cast（864×1536×3 seed）；AI 脸=纯 desc t2i | files{cast_image_1..3} + face_scores[]（facegate 对照传照） |
| mv_cast_video | h3-fl2va（turbo4，736×1312，124f/5.17s）→ ffmpeg `select=not(mod(n,10))` 抽 ~13 帧 → facegate 逐帧（yaw/pitch 惩罚） | files{cast_video, frame_1..13} + frames[{url,score,pass}] |
| mv_storyboard | 角色镜=h3-image-edit「人物完全不变…只替换背景」（viewRef 姿态帧垫图）；空镜/剧情镜=t2i；低分 → inswapper /swap ×2 | files{board_<shotId>} ×N |
| mv_shot | 角色镜→h3-ref2va（viewRefs≤3 + sings IR）；剧情镜→h3-fl2va（关键帧首帧）；tier=quality（H3 唯一主力，D2） | files{clip_<shotId>}（原生声画保留，compose 剥离） |
| mv_lipsync | ffmpeg 按 `{start_sec,dur_sec}` 切窗（±0.2s 余量）→ POST :8390 → SyncNet 自检 | files{synced_<shotId>} + sync_score |
| mv_align | POST :8391 /asr → 与 lyrics 逐句规则对齐（标点归一/分段匹配）→ 失配句 LLM 辅助（可选） | result.timings=[{line,start,end}] |
| mv_preview | 分镜图×已制曲 → zoompan 轮播（1.5–6s/图） | files{preview} |
| mv_compose | 见 §4.2 filter 基线 | files{mv_video, cover} + sidecar{subtitles,music,ai_label,degraded_shots} |

### 4.2 ffmpeg 视频基线（lanes/mv.js 内 filter 常量表）

抽帧 `select=not(mod(n,k))`；切窗 `-ss/-t`；剥音轨 `-an`；归一 `scale=W:H:force_original_aspect_ratio=decrease,pad,fps=24,setsar=1` + aac 48k；轮播 `loop+zoompan`（z='min(zoom+0.0015,1.3)'）；拼接 `concat=n=N:v=1:a=0`；段落转场 `xfade=transition=fade:duration=0.5`（仅段落界）；铺轨 `amix inputs=2:normalize=0` + `volume` 主 1.0；字幕逐句 `drawtext`（`y=h-text_h-h*0.08`，ASS 可选）；片名卡 2s 720×1280；封面=首帧截图；AI 角标常驻 `drawtext`。

### 4.3 mock 模式（契约 §0 延伸，V13 无 Spark 全绿的保证）

`EXECUTOR_MOCK=1` 下 mv_* 全部产**真实可用假产物**：有 ffmpeg（PATH/`MB_TEST_FFMPEG`）→ lavfi `testsrc2`+正弦音 5s mp4 / 随机噪点 png；无 ffmpeg → 内置最小合法 mp4/png 字节桩；align → 按歌词行数均匀分配 timings；lipsync → 透传 clip 并回 `sync_score=0.95`（V13 只验契约/账本，质量归 V15 真机）。

---

## 5. 数据模型（`core/store.js` MIGRATIONS version 3）

```sql
mv_projects(id TEXT PK, user_id TEXT, work_id TEXT,      -- 母 work（已制曲=唯一音轨真源）
  title, kind TEXT,                                       -- vocal|instrumental（lyrics 判定）
  status TEXT,                                            -- drafting|casting|scripting|previewed|shooting|composing|ready|failed|canceled
  brief, cast_json, script_json, script_ver INT DEFAULT 1, suggest_json,   -- suggest 挂草稿不 ver++（§5 辅助纪律）
  est_json, est_ver TEXT,                                 -- 报价快照 hash12 → 开机 CAS
  budget_credits INT DEFAULT 1200, paused INT DEFAULT 0,  -- D13：>120% 暂停仅人工恢复
  preview_url, video_url, cover_url, duration_sec REAL,
  credits_cost INT DEFAULT 0, credits_refunded INT DEFAULT 0,
  ai_label INT DEFAULT 1, license_model, license_usage,   -- MiniMax-H3 Community/attribution + meta 路线（§10）
  queue_mode TEXT DEFAULT 'normal',                        -- normal|night（夜间档调度位）
  created_at, updated_at);
mv_characters(id PK, project_id, gender 'm'|'f', name, source 'upload'|'ai'|'reuse',
  portrait_upload TEXT,                                    -- uploads.kind='mv_portrait'（72h TTL 复用一期表）
  cast_image_url, cast_video_url, viewrefs_json,           -- 拍板固化帧库[{url,score,sel}]＝身份真源
  confirmed_at);
mv_shots(id PK, project_id, seq INT, kind 'singing'|'story'|'broll', sec REAL,
  lyric_from INT, lyric_to INT,                            -- timings 索引对（歌唱曲唱段窗）
  desc, camera, cast_ids, storyboard_url, first_frame_url,
  status TEXT,                                             -- draft|boardReady|clipReady|synced|locked|stale
  best_take_id, rerolls INT DEFAULT 0,
  reason_history TEXT, flags_json);                        -- chips 诊断链（§5.3 单一真源）
mv_takes(id PK, shot_id, job_id, engine_tier TEXT DEFAULT 'quality', video_url,
  lipsynced INT DEFAULT 0, sync_score REAL, face_score REAL,
  origin 'auto'|'system_auto'|'user_reshoot', ai_label INT DEFAULT 1, created_at);
mv_tickets(id PK, project_id, user_id, action, args_json, est_credits INT, est_minutes INT,
  hash TEXT, ver TEXT, status 'pending'|'consumed'|'expired'|'denied',
  ttl_expire_at, created_at, consumed_at);                 -- 确认票（TTL60s/一票一次/hash+ver CAS）
mv_chat_sessions(id PK, project_id, user_id, status 'open'|'broken', ctx_json, created_at);  -- broken=预算熔断
mv_chat_messages(id PK, session_id, role, content, meta_json, created_at);                   -- 记忆只记执行结果
-- uploads 扩 kind：'mv_portrait'（TTL sweep 自动覆盖）；jobs 表零改动（payload/result JSON 承载 mv 语义）
-- 索引：mv_shots(project_id,seq)、mv_takes(shot_id)、mv_tickets(status,ttl_expire_at)
```

**状态机**：`project`：drafting→casting→scripting→previewed→shooting→composing→ready；任何阶段可 canceled（未拍镜全额退）；ready 后重拍→shooting 局部回环（受影响镜 stale→重拍→自动再 compose）。`shot`：draft→boardReady→clipReady→(singing)synced→locked；sync 两次不过→locked 走 B-roll 降级（明示）。机检字段（face_score/sync_score/ai_review）**只允许机检管线写入**，PATCH 白名单外拒写（V16 断言）。

---

## 6. API 契约 v2（REST + WSS + 执行器；拍板后全文入 CONTRACTS.md）

REST（前缀 `/v1`，2xx 裸 JSON、错误 `{code,message}`、`*_url` 绝对化、禁词净化——均承一期）：

```
POST /v1/mv/projects          {work_id, brief?, character:{gender, source:"upload"|"ai", image_id?, name?}}
                              → 201 {project}                                   # 免费；N1 单主演（D3），N2 character→characters[] 双人
POST /v1/mv/image             multipart(file; jpg/png ≤8MB; consent 前置) → 200 {image_id}      # sha256+魔数+72h TTL
POST /v1/mv/projects/:id/jobs {type:"cast_image"|"cast_video"|"storyboard"|"preview"|"shoot"|"compose", params?}
                              → 202 {job_id, credits_charged, idempotent}        # 先扣后派单；幂等=hash(user+project+type+ver+params)
POST /v1/mv/projects/:id/cast/confirm  {character_id, cast_image_url, frame_sel[]} → 200 {character}  # 拍板固化 viewRefs
PATCH /v1/mv/projects/:id     {title?/brief?/script_json?/queue_mode?, ver}      → 200 {project} | 409 STALE
POST /v1/mv/projects/:id/suggest   {note} → 200 {suggest} | 409 NOT_READY（LLM 离线不装忙）
POST /v1/mv/projects/:id/suggest/apply {suggest_id, ver} → 200 {project}          # 建议挂草稿，apply 才 ver++ 重审
POST /v1/mv/projects/:id/preview   → 202 {job_id}（首免，重出 5⚡，D9）
POST /v1/mv/projects/:id/boot      {est_ver} → 202 {jobs:[...]}                    # C6 语义：报价 CAS + 已 accept + enqueueOnce 逐镜防重
POST /v1/mv/shots/:id/jobs    {type:"reshoot"|"resync", reason?} → 202 {job_id}    # chips→动作（§5.3）；system_auto 免费
POST /v1/mv/projects/:id/cancel → 200 {refunded}
GET  /v1/mv/projects/:id      → 200 {project, characters[], shots[], tickets:[pending]}
GET  /v1/mvs                  ?mine=1&cursor → 200 {items:[mv], next_cursor}
GET  /v1/mvs/:id              → 200 {mv, parent_work}        # 谱系：母 work 简卡
GET  /v1/mvs/:id/report       → 200 {align_report, sync_dist, phrase_hit, degraded_shots[]}
POST /v1/mv/assistant/messages {session_id?, text, chips:[{type:"project",id}]} → 200 {session_id, reply|ticket|intent}
POST /v1/mv/tickets/:id/confirm {ver, hash} → 200 {executed}｜POST .../deny → 200 {ok}
```

WSS 增量：`{type:"mv.progress", project_id, status, progress, note, shots:[{id,status}]}`、`{type:"mv.ticket", ticket_id, project_id, action, est}`。job.progress/done 语义不变。

执行器 payload 与 runner 对齐 §4.1（`complete=multipart(files, result=JSON)`，`result.files={逻辑名:字段名}` 回填 `*_url`）。积分（§6 定价）：`credits.mv = {cast_image:10, cast_video:20, storyboard:5, shot:40, lipsync:20, align:5, preview_free:1, preview_reroll:5, compose:10}`。

---

## 7. 关键序列

**S5 定妆链（N0）**
```
App 选角(上传照|AI 脸) →[consent]→ POST /v1/mv/image(72h TTL) → jobs{cast_image}
  → executor: comfy h3-image-cast ×3 → facegate 对照评分 → 用户选1 → jobs{cast_video}
  → h3-fl2va 5.17s → 抽帧13 → facegate 逐帧 → 用户帧格勾选 → cast/confirm（固化 viewRefs）
```

**S6 剧本与分镜（N1）**
```
jobs{script}: prompts/mv_script（LLM→失败重试1→确定性分场模板兜底+如实标注）
  → mv_validator(warn) → mv_aireview（system free；规则机检[+LLM]）→ 镜卡呈现
  → 用户编辑/「让它改改」(suggest→apply, ver CAS) → jobs{storyboard}（角色镜 edit 只换背景壳，swap×2 兜底）
```

**S7 样片→报价→开机（N1）**
```
jobs{preview}(免费1次) → 用户看片 → server estimateBreakdown(shots×档位×实测常数)
  → 报价卡 est_ver=hash12 → 用户 accept+boot{est_ver}(CAS+已 accept 校验+预算核验)
  → enqueueOnce(mv_shot ×N, idem=project+shot+ver) → project=shooting
```

**S8 歌唱 MV 流水线（N2）**
```
[mv_align 先行：master→timings→剧本唱段分配]
mv_shot(角色镜 sings) done → 父租约延长 → enqueue mv_lipsync(切窗音频)
  → :8390 驱动口型 → SyncNet 自检：<阈值 → 自动补样×1(system free) → 仍不过 → B-roll+字幕降级(明示)
全部镜 clipReady/synced → auto mv_compose(剥音轨→归一→xfade→铺 master→字幕→片名→封面)
  → done → mv 行入库 → WSS mv.progress(done)+完成通知 → 首映礼
```

**S9 助手对话治理链（N2）**
```
text+chips → 注入红线（命中→拒答+audit injection_suspect）→ interpret（LLM 意图|正则表）
  → gateTool（白名单7/参数域/会话 broken 校验/租户参数注入）
  → 只读：执行→顾问式回执(≤150字,禁编号) ｜ 昂贵：签发确认票→面板批准→五连校验→执行→审计+记忆
```

**S10 预算护栏**：cost+est > budget×1.2 → project.paused + 通告板横幅「暂停等确认」；恢复仅人工调高 budget（审计留痕）；助手代发动作超报价 120% → session.broken。

**S11 mock 验收路径（V13）**：`EXECUTOR_MOCK=1` + 无 Spark → 全 type 产假产物 → 断言状态机/账本/幂等/refund/TTL/禁词/确认票（CI 可跑，不依赖 GPU）。

---

## 8. 队列·吞吐·成本模型

| 常数（报价与 ETA 单一真源 `config.mv.est`，随真机刷新） | 值 |
|---|---|
| 生图（cast/storyboard） | 15s |
| H3 拍摄（fl2va/ref2va turbo4） | 290s/镜（EVIDENCE 实测 260–286s） |
| 定妆视频 | 290s |
| lipsync | 240s/镜（SP-MV-1 实测后刷新） |
| compose / align | 180s / 30s |

- **单并发串行队列**：executor `--concurrency 1` 一次一 job；ETA = Σ(待跑常数) + :8188 队列等待（`GET /queue` 位次 × 剧场均值，只加不减如实展示）。45s 歌 12 镜歌唱 MV ≈ **95–115 分钟**。
- **夜间档**：`queue_mode=night` 任务在 00:00–08:00 优先派发（server 派发过滤 + executor poll 过滤双保险），给报价折扣位留接口（公测再定价）。
- **成本控制**：预算护栏（1200⚡/120%）、boot CAS 防双开、enqueueOnce 逐镜防重（一期 DEV-LADDER-PAY 教训：降档永不减计费交付维度）、takes TTL 72h 清理作业（并入一期 sweep）。

---

## 9. ADR-MV 决策记录（承接 ADR-MB 编号）

| # | 决策 | 状态 |
|---|---|---|
| ADR-MV-1 | 二期后台（server+executor+推理微服务）全量部署 DGX Spark（Linux aarch64），5060 Ti 保留一期与调测 | 定（发起人指示） |
| ADR-MV-2 | 视频引擎**MiniMax 全家桶唯一主力**（H3-Image/H3 FL2VA/REF2VA），Wan/LTX/CogVideoX 等暂不引入；S2V 仅 N3 观察 | 定（发起人指示） |
| ADR-MV-3 | 口型=post-hoc 指定音频驱动：i2v 拍「演唱表演」画面（原生声画丢弃）+ EchoMimicV3-Flash（首选）/MuseTalk（兜底）；**二期唯一新增模型** | 定（D2） |
| ADR-MV-4 | ComfyUI 与剧场**共用 :8188**（只发任务+观测，代码层无 /free）；逃生口 :8288 共 models 目录，仅 SP-MV-4 互扰超标启用 | 定（D1） |
| ADR-MV-5 | Spark executor **单机单并发** + ram_free 水位观测挂起；共宿主服务零改动零杀死 | 定（共宿主纪律） |
| ADR-MV-6 | MV 为**独立资源**（mv_* 表 + /v1/mv），works 形状零改动；曲库按 kind 过滤展示 | 定（D8） |
| ADR-MV-7 | 助手=**治理层优先**：工具白名单 7 项封顶、确认票、注入红线、预算双熔断、拍板权在人；不建通用 agent；对话版灰度 20% 可关 | 定（剧场 l2 范式裁剪，D11） |
| ADR-MV-8 | 语言纪律代码化：`rules/mv_lexicon.js` 单一禁词表+三层净化+V16 CI（H3 标注义务与匿名化冲突走元数据路线+公测前法务） | 定 |
| ADR-MV-9 | **LLM 是增强不是依赖**：每个辅助点均有规则兜底且独立撑起闭环；Inkling-2-Mini 就位后开 `mv_assistant`（SP-MV-5 冒烟前置） | 定（D4） |
| ADR-MV-10 | 已制曲音轨=唯一音轨真源：成片音轨 = work.audio_master（SHA 一致，V14 断言）；模型不重新演唱 | 定（产品分水岭） |
| ADR-MV-11 | 歌词对齐=SenseVoice 时间戳 + 规则对齐（LLM 仅失配句辅助）；timings 三分用（唱段分配/口型切窗/字幕） | 定（SP-MV-2 门） |
| ADR-MV-12 | 预算护栏 1200⚡ 默认、>120% 仅人工恢复；系统补拍一律免费且明示 | 定（D13） |

---

## 10. 安全与合规

1. **人脸/PIPL（敏感个人信息）**：consent（限定「仅本次角色生成、不用于训练」）→ uploads `mv_portrait` 72h TTL（一期 sweep 覆盖）→ 一键删除入口；**含真人脸成片强制「本人或已获授权」勾选**；AI 生成歌手通道为免人脸首选露出（D6 双通道硬要求）；界面不做「颜值/情绪诊断」表述（人格化提示只说「更像你的角度」）。
2. **对话治理**：注入红线正则（忽略指令/绕过审批/system prompt/shell 关键词等）命中即拒+审计 `injection_suspect`；一切用户文本与剧本内容 q() 定界「数据非指令」；工具白名单外 spawn 期即拒；args 白名单键+服务端注入（防幻觉实体/参数注入）；确认票五连校验；预算双熔断。
3. **上传防线**：魔数实测（FFD8FF/89504E47）+大小+sha256 去重；`/f/*` 静态读维持不可猜文件名+Nginx；executor 永不执行上传内容（一期红线）。
4. **审核与标注**：剧本/字幕/prompt 过 `rules.js` 词库软门；成片 `ai_label` 恒 1 + 常驻角标；分享物带标注（一期三件套延伸）。
5. **许可合规**：H3 族 `license{model:"MiniMax-H3 Community",usage:"attribution"}` + `meta.ai_label`；内测口径不触发商用义务，**公测前法务核对**（营收门槛/区域排除/UI 标注/托管防滥用，§1.4 备忘）；EchoMimic(Apache)/MuseTalk(MIT)/SenseVoice 白名单内。
6. **限流与防刷**：游客禁 MV（注册解锁）；每人并发项目 ≤2、每日项目 ≤N（config）；boot/shoot 端点 IP+账号双限流；积分余额硬顶（一期引擎兜底）。

---

## 11. 观测与运维

- **指标**（VPS 看板 + `/healthz` 扩展）：lane 耗时 p50/p90、队列深度与等待、ComfyUI `:8188` 等待位次、ram_free 水位曲线、sync_score 分布、对齐误差抽检、facegate 过门率、chips 使用分布、重拍率、助手拦截计数（注入/白名单外/预算）、夜间档占比、成片带宽。
- **不变量（nightly 断言）**：Σledger==balance（含 mv reason）；mv_takes 均有 shot_id 且 best_take_id 可解析；`sync_score` 仅 lipsynced=1 非空；tickets 无过期 pending 滞留；uploads TTL；**成片音轨 SHA==母 work master**。
- **冒烟**：nightly V13（mock，无 GPU）；weekly Spark 真机 5-shot（cast 1 图 + fl2va 1 镜 + compose 1 片）+ 剧场共存观察（SP-MV-4 延续）；Inkling 换装日 SP-MV-5 剧本编译回归。
- **降级演练**：`:8188` 不可达→job 回队+诚实呈现；`:8390` 挂→lipsync 自动改走 B-roll 降级链；`:8090` 离线→规则模式横幅+主流程零阻塞（V16 断言路径）。

---

## 12. 契约与文档治理

- 本档 §5/§6 + mv-plan §4.4/§5 为 **CONTRACTS.md v2** 冻结素材；冻结后任何接口改动走「改契约→改码→回归 V13–V16」流程。
- 文件归属沿 CONTRACTS §5：server=A、executor+workers=B、app=C、tests=D；新增 `src/workers/mv_*` 归 B、`docs/` 公共只读。
- 本文与施工计划（[musicbox-phase2-construction-plan.md](musicbox-phase2-construction-plan.md)）冲突时，以「契约 v2 > 架构 > 施工」次序裁决；实测数据（耗时/内存）以 EVIDENCE 类实测记录回写覆盖设计常数。
