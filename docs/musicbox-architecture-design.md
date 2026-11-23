# MusicBox · 架构设计（v1 · 施工基线）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-architecture-design.md |
| 日期 | 2026-11-23 |
| 输入 | [musicbox-assessment-and-plan.md](musicbox-assessment-and-plan.md)（评估与产品方案，本文不重复其结论） |
| 范围 | 系统拓扑 / 客户端 / 服务端 / 数据模型 / API 契约 / 关键序列 / 多模态意图子系统 / ADR / 安全 / 运维 |
| 环境 | 开发机 Windows（Node v25.2.0、Flutter `C:/src/flutter`）；GPU：5060 Ti 16G（开发+生乐）＋ DGX Spark 128G（意图理解）——均在内网 |

---

## 1. 部署拓扑（决定性设计：执行器拉单模式）

**核心原则：GPU 机永不出内网、公网侧无长连接回源压力、worker 拉单天然削峰。**

```
┌ 公网 VPS（轻量 2C4G 起步）────────────────────────────────────┐
│  Nginx：TLS 终结 / WSS 升级 / 音频静态面 / 限流               │
│  Music API（Node ≥22 零依赖）：REST + WSS + executor 拉单口    │
│  SQLite（node:sqlite）+ 音频文件盘（wav master + mp3 播放档）  │
│  审核规则机检（剧场 rules 范式移植）                            │
└──────▲────────────────────▲───────────────────────────────────┘
       │ HTTPS（拉单/回传）  │ HTTPS
┌ 内网执行器（LAN，可多台）─────────────────────────────────────┐
│  executor daemon：注册 lanes → long-poll 领单（租约）→ 执行     │
│  → 回传产物+进度 → 心跳续租。同一时刻一 job 只属一个执行器      │
│  lane=music（5060 Ti）──► ACE-Step :8190（复用剧场服务协议）    │
│  lane=intent/vlm/llm（Spark）──► :8192 Qwen3-VL-4B（vLLM）     │
│                                  :8193 Qwen3-8B（LLM 常驻）    │
│  lane=ffmpeg（任意机）──► 本地 ffmpeg：转码/DSP/波形 JSON       │
└──────────────────────────────────────────────────────────────┘
```

**为什么拉单而不是推单/内网穿透**：①执行器主动外连，GPU 机零入站暴露（继承剧场 §4-4 安全红线）；②NAT/frp 免运维；③执行器离线时任务自动回到队列（租约 TTL），天然容错；④未来加第二张卡=多跑一个 daemon，调度零改动。显存互斥在 lane 层自然消解（music 与 vlm/llm 分属两台机器，不再同卡打架——这是比剧场单机 freeComfy 更稳的形态）。

**演进线**：用户量上来后，SQLite→Postgres、文件盘→对象存储+CDN、执行器按 lane 水平扩容——API 契约不变。

## 2. 客户端架构（Flutter）

```
lib/
  main.dart                 # 入口：bootstrap（环境配置/上报开关）
  core/
    api/                    # REST client（拦截器/重试/签名 token）
    ws/                     # WSS 重连退避 + 事件分发（job.progress/done, intent.card）
    db/                     # 端侧 SQLite（drift）：作品镜像/播放历史/离线缓存/草稿
    config.dart
  features/
    auth/                   # 游客态→手机号绑定
    create/                 # 创作台（Simple/Custom/多模态入口/意图卡/澄清/候选揭晓）
    library/                # 作品库（网格/筛选/详情/谱系树）
    player/                 # just_audio + audio_service（迷你条/锁屏/队列）
    persona/                # 声音人格（录音登记/列表/选用）
    me/                     # 积分/偏好/设置
  shared/                   # 设计系统：卡带组件/波形画布/星评/AI角标
```

| 决策点 | 选型 | 理由 |
|---|---|---|
| 状态管理 | Riverpod 3 | 编译期安全、异步流（job 轮询/WSS）表达力强 |
| 播放 | just_audio + audio_service | 事实标准；锁屏/通知栏 MediaSession 一套搞定 |
| 录音 | record（5.x） | 声纹登记 20–40s / 语音意图，m4a 输出体积小 |
| 波形 | 自绘 CustomPainter（服务端波形 JSON 预生成 + 端侧 LRU） | 服务端 FFmpeg 产 peaks，端侧零解码成本 |
| 实时 DSP 预览 | flutter_soloud（M1 末评估） | 变调变速即时听感；**成片一律云侧 FFmpeg**（ADR-MB-6） |
| 本地库 | drift（SQLite） | 离线作品镜像/草稿箱/缓存 LRU |
| 最低系统 | Android 8.0（API 26）+，targetSdk 35 | 覆盖率与商店合规双满足 |

**三档外壳（§产品方案 §7）落位**：`create/` 内三个 shell 组件共享同一 `CreationSession` 状态树；傻瓜级=对话流 shell，标准级=意图卡+轻参数 shell，深度级=全参数表单 shell。

## 3. 服务端架构（零依赖 Node，延续剧场纪律）

```
src/server/
  index.js          # http server + Nginx 反代假设（信任 X-Real-IP）
  core/
    store.js        # node:sqlite 封装：迁移版本号/事务/审计钩子
    engine.js       # 任务引擎：enqueue（幂等键）/租约/重试/降档梯子/事件
    bus.js          # 进程内事件 → WSS 广播（job.progress/done/intent.*）
    rules.js        # 审核软门（文本 prompt 层，剧场 moderate 范式移植）
    util.js
  api/              # auth / works / intent / personas / credits / jobs / executor / feed(M2)
  lanes/            # lane 注册表与降档策略（每 lane 声明：timeout/重试/降档参数）
  prompts/          # IntentCard 编译 / 澄清选择题 / 歌词扩写 / mood→tags 词典
```

**任务引擎语义（剧场 dag/engine 范式移植，去 ComfyUI 依赖）**：
- `enqueue(type, payload, {idempotency_key})`——幂等键 = hash(user_id + 归一化参数 + 活跃窗口)，重复点击不重复扣分不重复排队；
- 执行器 `register(lanes) → poll(25s long-poll) → lease(job, TTL 10min) → progress → complete(带产物 multipart) → 心跳续租`；租约过期任务自动回队，`attempts` 递增；
- **降档梯子**：lane 声明降档参数序列（如 music：`sec`×`count` 递减→单候选→报错呈现），OOM 同参数不重试（剧场铁律）；
- 成本口径：`credit_ledger` 复式记账，不变量 Σ(delta)==每用户最新 balance_after（验收 V1 断言）。

## 4. 数据模型（SQLite DDL 骨架）

```sql
users(id TEXT PK, phone TEXT UNIQUE, guest_key TEXT UNIQUE, nickname, avatar, status, created_at);
sessions(id TEXT PK, user_id, refresh_token_hash, expire_at);
credit_ledger(id PK, user_id, delta INT, balance_after INT, reason, ref_type, ref_id, created_at);
  -- reason: daily_free | gen | reward | purchase | refund
works(id TEXT PK, user_id, title, status,           -- draft|published|retired
  audio_master, audio_playback, duration_sec, format, waveform_ref,
  mood TEXT, genres TEXT, bpm REAL, key TEXT, language, lyrics, structure TEXT,
  gen_engine, gen_seed, gen_params TEXT,            -- 生成指纹（seed 分享包来源）
  lineage_kind, parent_id, lineage_depth INT,       -- remix|cover|extend|variation|adjust
  persona_id, license_model, license_usage,
  ai_label INT DEFAULT 1, visibility TEXT,          -- private|public(M2)
  created_at);
candidates(id PK, job_id, seq INT, audio_ref, duration_sec, title, meta JSON, created_at);
jobs(id PK, type, payload JSON, status,             -- queued|leased|running|done|failed|canceled
  idem_key UNIQUE, executor_id, lease_expire_at, attempts INT, error_code,
  result JSON, credits_cost INT, user_id, created_at, updated_at);
intent_cards(id PK, user_id, source_kind,           -- voice|image|video|text
  source_ref, mood TEXT, scene_desc, genre_hypotheses TEXT, vocal, duration_hint,
  confidence REAL, open_questions TEXT,             -- JSON [{q, options[], recommended, answered}]
  status,                                           -- draft|clarifying|ready|consumed
  created_at);
personas(id PK, user_id, name, is_public, voice_ref, clone_params JSON, derived_from_work, use_count, created_at);
prefs(user_id, key, value, updated_at, PRIMARY KEY(user_id,key));
uploads(id PK, user_id, kind, path, bytes, sha256, expire_at, created_at);  -- 语音/图片最小化保存，TTL 清理
-- M2 预留：follows / likes / comments / reports / challenges / challenge_entries
```

纪律：上传媒体（语音/图片/视频）**只存生成所需最短期**（`uploads.expire_at` 默认 72h），采纳后仅保留派生特征（意图卡），原始媒体可一键删除——PIPL 最小化（§合规）。

## 5. API 契约 v1（REST + WSS）

```
# 认证与账户
POST /v1/auth/guest                     → {user, access_token, refresh_token}   # 首启静默游客
POST /v1/auth/phone/request-code / verify                                        # 绑定手机号（游客升级）
POST /v1/auth/refresh
GET  /v1/me                             → {user, credits, daily_quota, prefs}

# 文本创作线（M0）
POST /v1/works/generate                 # {mode, prompt?, lyrics?, tags?, bpm?, sec?, count≤4, persona_id?}
                                        # → 202 {job_id}；幂等键服务端按参数生成
GET  /v1/jobs/:id                       → {status, progress, candidates[]|error}
POST /v1/works/:id/adopt                # 候选→作品（扣积分入账于 generate 时，失败 refund）
GET  /v1/works?mine&public&mood&genre&bpm_min..max&q&cursor
GET  /v1/works/:id                      # 含 lineage 父链 + 子代计数
PATCH /v1/works/:id                     # 元数据/评分/visibility

# 多模态意图线（M1）
POST /v1/intent/voice                   # multipart m4a/wav ≤10MB ≤60s → 202 {intent_id}
POST /v1/intent/image                   # multipart jpg/png ≤8MB
POST /v1/intent/video                   # M2：≤60s ≤50MB
GET  /v1/intent/:id                     → IntentCard（mood/scene/genres/vocal/confidence/questions[]）
POST /v1/intent/:id/answer              # {answers:[{q_idx, option_idx}]} → 卡更新（可能再出题，≤2 轮）
POST /v1/intent/:id/generate            # 按卡派 3 候选 → 202 {job_id}；卡 status=consumed
POST /v1/works/:id/adjust               # {text:"人声再温柔点"} → LLM 解析为参数 delta → variation job
                                        # 不识别成功则回一句澄清追问（不瞎猜）

# 声音人格（M1）
GET  /v1/personas                       POST /v1/personas {name, audio}（20–40s）
POST /v1/works/:id/to-persona           # 从作品提声纹
# 谱系动作（M1）
POST /v1/works/:id/{extend|cover|variation}  # {params delta / persona_id / seed}
# 端侧成片 DSP（M1）
POST /v1/works/:id/dsp                  # {op: trim|fade|pitch|tempo|concat|slice, params} → job
# 分享
GET  /v1/works/:id/seed-pack            # prompt+seed+参数 JSON/二维码载荷

# 执行器（内网 token 鉴权，公网不可枚举）
POST /executor/register {lanes, version}     GET /executor/poll?lanes=…（long-poll 25s→lease）
POST /executor/jobs/:id/progress             POST /executor/jobs/:id/complete（multipart 产物）
POST /executor/jobs/:id/fail {code, message} POST /executor/heartbeat {job_id?}

# WSS /ws（token 握手）：job.progress / job.done / intent.card / credit.delta
# M2：/v1/feed*、/v1/challenges/*、POST /v1/works/:id/report
```

音频文件经 Nginx 静态面 `/f/<sha-prefix>/<file>` 带 token 鉴权下发；播放档 mp3 320k，master wav 仅种子包/导出时给。

## 6. 关键序列

**S1 文本生成**：App `POST /works/generate` → API 审核软门 → enqueue(music, idem) → 扣积分 → 执行器领单 → ACE-Step :8190 ×3 seed（或串行×3）→ wav 上传 → ffmpeg lane 转码+波形 → job.done（WSS）→ App 揭晓页 3 卡带 → `adopt`。

**S2 语音意图**：App 录音 ≤60s → `POST /intent/voice` → 执行器 lane=intent：SenseVoice :8191（转写+情绪+事件）→ Spark LLM :8193 按 `prompts/intent` 编译 **IntentCard**（confidence<阈值 → `open_questions` ≤2 题）→ WSS `intent.card` → App 卡片（可点改）→ `answer`（可选）→ `generate` → 进 S1。

**S3 候选微调**：App 对候选说"更欢快一点" → `POST /works/:id/adjust` → LLM 把自然语言映射为参数 delta（tags/mood/bpm ±）→ enqueue(variation, parent=候选) → 新候选挂同谱系（depth+1）→ 揭晓页 A/B 并排。

**S4 声纹翻唱**：persona 登记（录音 → :8190 两段式：guide 完整歌 → cover 变声，快档=风格迁移 0.2）——协议与剧场 `workers/music.js` 完全一致，失败诚实降级标注。

## 7. ADR 记录

| # | 决策 | 状态 |
|---|---|---|
| ADR-MB-1 | 独立 Music API，不并入剧场；范式移植、:8190 服务共用 | 定（评估 §5.1） |
| ADR-MB-2 | 端侧 Flutter（Riverpod/just_audio/audio_service/record/drift） | 定（评估 §5.2） |
| ADR-MB-3 | 服务端零依赖 Node + `node:sqlite`（Node≥22）；触发条件后迁 Postgres | 定（本机 Node 25 已验证） |
| ADR-MB-4 | **执行器拉单模式**：GPU 机零入站、租约幂等、lane 隔离显存 | 定（本文 §1） |
| ADR-MB-5 | 意图算力自托管 Spark：Qwen3-8B（LLM）+ Qwen3-VL-4B 常驻；DeepSeek API 仅峰值兜底契约预留 | 定（评估 D7） |
| ADR-MB-6 | 成片 DSP 一律云侧 FFmpeg（质量/口径一致）；端侧 flutter_soloud 仅实时试听预览 | 定 |
| ADR-MB-7 | 推送一期=WSS 前台 + Android 前台服务通知（生成期保活）；FCM/厂商通道 M2 评估 | 定 |
| ADR-MB-8 | 模型白名单延续剧场纪律：ACE-Step(MIT)/DiffRhythm(Apache)/Demucs(MIT)/Qwen(Apache-2.0)/SenseVoice(可商用)；YuE/StableAudioOpen 不入商用链路 | 定（继承） |
| ADR-MB-9 | 上架市场口径：**先 Google Play 内测轨道**（快速验证），国内商店（软著+App 备案+隐私检测）材料并行办理 | 待拍板（施工 §7） |

## 8. 安全设计

1. **鉴权**：access token（短期）+ refresh（轮换）；executor 独立 token（内网+IP 白名单双因素）；所有写接口审计留痕（剧场 audit 范式）。
2. **上传防线**：类型白名单（m4a/wav/jpg/png/mp4）、大小上限、时长服务端实测、sha256 去重、图片/视频走机检软门；禁止执行任何上传内容（继承剧场"永不执行用户 workflow"红线）。
3. **限流**：游客态每设备生成频次限制、IP 级限流（Nginx）、积分余额硬顶（防刷）。
4. **隐私**：语音/图像上传前客户端弹窗（用途限定+不训练承诺）；`uploads` 72h TTL 清理作业；偏好数据不含原始媒体。
5. **合规三件套内建**：prompt 审核软门（拦截+解释）、作品页 AI 生成角标（`ai_label`）、应用内举报（M2 随社区上线，但 API 骨架 M0 预留）。

## 9. 观测与运维

- **不变量断言**（nightly）：Σledger==balance、无 lease 超时滞留 job、候选/作品引用完整性；
- **冒烟**：夜间 5-shot 音乐生成冒烟（剧场纪律）+ intent 链路 3-shot（语音→卡→tags）；
- **指标**：lane 耗时分布（ACE-Step 30s/整曲分档）、澄清轮次分布、adjust 识别成功率、排队 P90；
- **健康**：/healthz（API）、executor 心跳看板（VPS 侧记录 last_seen/版本/lanes）。
