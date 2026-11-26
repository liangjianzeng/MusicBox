# MusicBox · 生效契约（收敛重写草案）

| 字段 | 值 |
|---|---|
| **Status** | `DRAFT-FOR-REVIEW`（未生效；lead 审完替换 `CONTRACTS.md`） |
| **Date** | 2026-11-26 |
| **Owner** | lead |
| **Supersedes** | `CONTRACTS.md` v1–v5.0（含全部 append-only 增量批注） |
| **Verified-by** | `scripts/verify.sh`（辅以 `scripts/verify_routes.mjs`、`test/acceptance/*`） |
| **机器可读接口清单** | `contract/routes.json`（本档 §2/§3/§4/§5 的结构化真源，104 条＝100 路由项 + 4 内置） |
| **历史归档** | `docs/archive/contract-v1-v5.md`（待建，见 §9 与 `docs/archive/README.md`） |

> **本档的定位**：这是"当前生效契约"的唯一正文，不是变更日志。凡与代码冲突，**以代码为准并立即登记进 §8 偏差登记册**；凡与本文与 `contract/routes.json` 冲突，以 `routes.json` 为准（它由读码生成）。
>
> **写作纪律（对本档及后续所有契约文档生效）**
> 1. **禁止**出现任何明文凭据、令牌、验证码、口令、内网账号/内网 IP；需要指代时写环境变量名（如 `MB_EXECUTOR_TOKEN`）并标"值不入文"。
> 2. 引用代码**只写文件路径，不写行号**（`src/server/api/mv.js` ✅ ／ 「文件名 + 冒号 + 数字」的形式 ❌）。行号是腐化之源：一次插入即全体失真。
> 3. **禁止**在本文手抄价目表、算例、payload 字段清单——那些归 `config.js` / `lanes/index.js` / `routes.json`，抄一次就多一处会腐化的副本。
> 4. 版本号只增不改；一个版本号在 §9 只出现一次；重复/缺号必须走"重编号 + 别名映射"，不许静默复用。

---

## 0. 全局约定

### 0.1 运行时与依赖

- Node.js ≥ 22，**零 npm 依赖**（只用 `node:` 内建；DB 用 `node:sqlite`），CommonJS + `"use strict"`，文件头注明职责与日期。
- 运行时数据一律 `var/`：DB `var/db/musicbox.sqlite`、公开产物 `var/out/<yyyy-mm>/`、私有上传 `var/uploads/`（72h TTL）、运营配置 `var/config/`。路径由 `src/server/config.js` 的 `paths` 定义，`MB_VAR_ROOT` 可整体搬家。
- 服务入口 `src/server/index.js`：手写迷你路由（字面段多者优先）+ JSON body 上限 1MB + `raw` 路由按 `opts.limitMb` + `/f/*` 静态 + `/ws` 手写最小 RFC6455 + `/healthz`。

### 0.2 端口与引擎端点（**实测真值**）

| 通道 | 端点（实测真值） | 环境变量 | 声明处 |
|---|---|---|---|
| Music API | `:7900`，监听 `MB_BIND`（缺省 `0.0.0.0`，生产建议 `127.0.0.1` + 反代） | `MB_PORT` / `MB_BIND` | `src/server/config.js` |
| 音乐生成 | `http://127.0.0.1:8190` | `MB_MUSIC_URL` | `config.js` / `core/modelnodes.js` kind=`music` |
| ASR（一期语音） | `http://127.0.0.1:8191` | `MB_ASR_URL`（回退 `MB_SENSEVOICE_URL`） | `core/modelnodes.js` kind=`asr` |
| **多模态 LLM/VLM** | **`http://127.0.0.1:8090/v1`**（OpenAI 兼容；`GET /v1/models` 实测返回 **`qwen38-fp4`**） | `MB_LLM_VLM_URL` | `etc/spark.env` |
| ComfyUI（图/视频） | `http://127.0.0.1:8188`（互扰超标的逃生口见 `core/modelnodes.js` 节点 note） | `MB_COMFY_URL` | kind=`comfy` |
| 口型重绘 | `http://127.0.0.1:8390` | `MB_LIPSYNC_URL` | kind=`lipsync` |
| 身份门禁（ArcFace） | `http://127.0.0.1:8395` | `MB_FACEGATE_URL` / `MB_MV_FACEGATE_URL` | kind=`facegate` |
| MV 时间戳对齐 ASR | `http://127.0.0.1:8391` | `MB_MV_ASR_URL` | kind=`mv_asr` |

**统一口径（三条硬规定）**

1. **LLM 基址只有一个真值：`http://127.0.0.1:8090/v1`**。历史文档里出现过的旧 LLM 端口（自建 vLLM 双实例时代的两个端口）一律作废，本档及后续文档**不得再出现**。`src/server/config.js` 的 `llmVlmUrl` 缺省值目前仍是历史端口 —— 属偏差 **§8 R-04**，处置＝改代码到 `8090`，不是改文档去追。
2. **模型名两处待统一**：`config.js` 的 `llmVlmModel` 缺省为 `qwen38-fp4`（与 `/v1/models` 实测一致），而 `etc/spark.env` 写的是 `Inkling2-Mini:vision`。二者只能有一个生效真值 → **`[需 lead 裁决]`（§8 R-04）**。裁决前，任何验收**必须以运行时 `GET <llmVlmUrl>/v1/models` 的返回为准**，不得从任何文档抄模型名。
3. 引擎端点的运行时真源是 `model_nodes` 表（运营后台可改、可探测、可锁定），`config.js` 只提供空表种子：见 `src/server/core/modelnodes.js` 的 `KINDS` / `NODE_META` / `defaults()`。

### 0.3 HTTP 与错误约定

- 前缀 `/v1`（用户面）与 `/executor`（执行器）与 `/admin`（运营，见 §0.7）。
- **2xx = 成功，直接返回业务 JSON，无 envelope**；派单类成功用 **202**，只读/写回用 **200**，新建资源用 **201**。
  - 唯一历史例外：`POST /v1/works/:id/adjust` 成功返回 **200**（`{understood:false,…}` 是业务成功而非错误）。已在 `routes.json` 标注，不改代码以免破坏 App。
- **4xx/5xx = `{code, message}`**，`message` 面向用户、全中文、不得含引擎名。码 → 状态映射的**唯一真源**是 `src/server/core/util.js` 的 `CODE_STATUS` + 调用点显式 `httpStatus`：

| code | HTTP | 语义 |
|---|---|---|
| `BAD_REQUEST` | 400 | 参数/状态不合法（含"缺 ver""已 consumed"） |
| `CREDITS_NOT_ENOUGH` | 400 | 余额不足，message 须含所需与当前值 |
| `MODERATION_BLOCK` | 400 | 审核词库命中（`core/rules.js`） |
| `UNAUTHORIZED` | 401 | 用户/管理员凭证缺失或过期 |
| `FORBIDDEN` | 403 | 越权（非属主、白名单外工具、执行器令牌不符） |
| `NOT_FOUND` | 404 | 不存在；**也用于"功能开关未开"**（见 §0.6） |
| `BUDGET_EXCEEDED` | 402 | MV 项目预算护栏触发（超报价 120% 自动暂停） |
| `STALE` / `NOT_READY` / `EST_STALE` / `AI_REVIEW_BLOCKED` / `AI_REVIEW_STALE` | 409 | 乐观锁/前置未就绪/报价过期/机审拦截 |
| `INVALID_LLM_OUTPUT` | 422 | LLM 返回结构不合法（不装忙、不降级伪造） |
| `RATE_LIMITED` | 429 | `util.allowRate` 命中 |
| `INTERNAL` | 500 | 兜底；message 过 `util.sanitizeEngineNames` |

> 新增错误码必须同时改 `CODE_STATUS` 与 `routes.json` 的 `errors` 数组，否则调用点漏写 `httpStatus` 时会静默落到 400。

### 0.4 鉴权三轨

| 轨道 | 凭证 | 校验函数 | 归属代码 |
|---|---|---|---|
| 用户 | `Authorization: Bearer <access_token>` | `requireUser` / `userFromRequest` | `src/server/api/auth.js`（sessions 存哈希，access 2h / refresh 30d 轮换） |
| 执行器 | `X-Executor-Token`（+ 可选 `X-Executor-Id`） | `assertToken`（恒定时间比较） | `src/server/api/executor.js`；令牌来自 `MB_EXECUTOR_TOKEN`，**值不入文** |
| 运营 | `Authorization: Bearer <admin token>` | `requireAdmin` | `src/server/api/admin.js` + `src/server/core/security.js`（scrypt 口令、登录限流、令牌 12h 过期） |

**匿名面（无任何鉴权调用）必须显式列举，共 10 条**——完整机器可读清单见 `routes.json._meta.totals.unauthenticatedRoutes`：`POST /v1/auth/guest`、`/v1/auth/phone/request-code`、`/v1/auth/phone/verify`、`/v1/auth/refresh`（设计公开）、`GET /healthz`（设计公开）、`GET /f/*`（设计公开）、以及 **三条必须整改**：`GET /v1/app/config`（匿名泄露引擎名与全量定价，§8 R-01）、`GET /v1/health/speech`（透传上游 `device`，§8 R-05）、`GET /admin`（控制台 HTML 不鉴权，§8 R-03）。
另有一条**条件匿名**：`GET /v1/works?public=1` 分支完全跳过鉴权（§8 R-18）。

**Boot 闸门**：`MB_ENV=prod` 时 `core/security.js assertBootable()` 对不安全默认值（固定验证码开启、执行器令牌/管理员账号未显式配置、`MB_PUBLIC_BASE_URL` 未设、MV worker 无内部令牌）**拒绝启动**（`process.exit(2)`）。契约层要求：这五项在 prod 属于**部署前置条件**，不是可选项。

### 0.5 URL 字段与文件归属

- 所有回给 App 的文件一律**绝对 URL**，字段名 `*_url`，由 `store.publicUrl(rel)` = `MB_PUBLIC_BASE_URL` + `/f/` + rel 生成。
- **部署纪律**：`MB_PUBLIC_BASE_URL` 必须是**客户端可达地址**（真机=局域网/Tailscale 地址；模拟器=其网关别名）。它在 complete 时被写死进 `*_url`，留默认回环地址会让真机播放全挂（`core/security.js` 已把它列入 prod 闸门）。
- `var/out` 经 `/f/*` **永久公开**、无签名 URL、无 Referer 校验，唯一防线是文件名不可猜。→ 只有"可公开播放"的产物（候选音频、成片、封面、波形）允许落 out；`var/uploads` 是私有暂存（`intent_cards`/`personas`/`mv_portrait`/`assistant` 四类，72h TTL）。声纹样本落 out 的问题见 §8 R-07。

### 0.6 语言与用户面纪律（不可协商）

- 任何**引擎型号名**（含上文表格里的全部真名与 `comfy`/`arcface`/`echomimic`/`funasr` 等派生名）**不得出现在面向用户的字符串**里。落地点只有两处，改这两处即可全链合规：
  1. 出口净化：`src/server/core/util.js` 的 `sanitizeEngineNames` —— **其黑名单必须与 §0.2 的引擎清单同源**（当前缺 comfy/arcface/echomimic/sensevoice-ts/许可模型名，§8 R-02）；
  2. 出口白名单：`core/modelnodes.js routingForApp()` 不得把 `engine` 字段发给 App（§8 R-01）。
- AI 生成内容必须带 `ai_label`（works / mv_projects 默认 1）。
- **功能开关关闭 → 404 `NOT_FOUND`（"接口不存在"），不是 403**。这是既有端点行为（`mv.requireEnabled` / `music_assistant.requireEnabled` / `assistant.requireEnabled`），App 据此隐藏入口。
- **LLM 可选性**：LLM 不可达/未就绪/输出不合法时，必须走确定性词典兜底并如实标 `mode:'rule'` / `assist.mode:'rule'`；**绝不把"端口可达"冒充"模型就绪"**，也绝不因 LLM 缺席而 500。报价/建议类端点宁可 `NOT_READY` 也不"装忙"。

### 0.7 Mock 执行器与验收

- `EXECUTOR_MOCK=1`：执行器对 `music` / `intent` lane 产出**真实可播放**的静音/正弦 wav 与最小合法产物，保证无 GPU 环境跑通全链路（`src/executor/`）。
- 契约回归入口：`scripts/verify.sh`（含 `scripts/verify_routes.mjs` 与 `test/acceptance/*`）。**改契约必须先改本档，再改码，再跑 verify**；`contract/routes.json` 与路由表不一致即视为验收失败。

---

## 1. 积分口径（单一来源，禁止抄表）

**唯一声明处：`src/server/config.js` 的 `credits` 与 `mv.credits` 常量。** 本档不复制任何价目表或算例——历史上三处手抄算例（含 745⚡ / 400⚡ / 760⚡ 那三行）已全部删除，因为它们与 `config.js` 漂移过至少一次，且"示例值"被 App 当过真值。

**运行时读取路径（必须理解，否则改价不生效）**

```
config.js (credits / mv.credits)        ← 唯一「声明」处（也是首次种子）
   └─> core/appconfig.js defaultBlob()   ← 种子成运营快照默认
         └─> app_config 表（运营中心）    ← 运行时真值：POST /admin/config/app 改后即生效、可回滚
               └─> AC.credits()          ← 业务代码唯一读取口（api/credits.js、api/works.js、api/mv.js、l2*/governance.js）
```

- 因此"改 `config.js` 就改价"是**错的**：已有 `app_config` 行时它只影响 `defaults` 展示。改价走 `POST /admin/config/app`（`GET /admin/config/app` 可同时看到 `blob` 与 `defaults`）。
- 派单类扣分**一律先扣后派单**，且扣费点唯一：音乐线 `api/works.js` `dispatchMusic`，MV 线 `api/mv.js` `chargeThenEnqueue`。幂等命中一律 `credits_charged:0` 且**不产生第二笔账**；扣分成功但 enqueue 抛错/并发同键 → 同事务内即时全额退。
- 失败自动全额退款：`core/engine.js` `requeueOrFail` 在 `attempts` 耗尽时按 `jobs.credits_cost` 全额 `refund`（`reason='refund'`，并把 `credits_cost` 置 0 防重复退）。
- 账本不变量（`core/store.js appendLedger`）：`Σdelta == 最后一条 balance_after`；任何"删记录"式修复都是违约。
- 每日免费额度**惰性重置**（`api/credits.js ensureDaily`，新自然日首次触碰时 `daily_expire` + `daily_free` 成对入账，不结转）。
- 计费诚信铁律（**DEV-LADDER-PAY**）：用户已付费的**交付维度**（`count`、`sec`、每镜必拍、口型必做）**任何情况下不得在重试中被静默裁剪**。详见 §5。

> 需要"多少钱"时的唯一正确做法：读 `config.js`，或运行时 `GET /v1/app/config` 的 `credits` 字段（该端点的鉴权整改见 §8 R-01）。

---

## 2. REST 契约

**本节不再逐条抄写路由。** 104 个接口项（100 路由项 + 4 内置）的字段、错误码、计费、鉴权与门控，全部在 `contract/routes.json`，按 `C-API-<域>-<资源>-<动作>-NNN` 稳定寻址；本档只规定**跨接口的公共规则**与"哪些条目必须存在"。

### 2.1 域划分与必备条目

| 域 | 路由项 | 鉴权 | 代表 id |
|---|---|---|---|
| AUTH / CREDITS | 6 | public×4 + user | `C-API-AUTH-*`、`C-API-CREDITS-BALANCE-READ-006` |
| WORK / JOB | 12 | user（`GET /v1/works` 条件匿名） | `C-API-WORK-GENERATE-CREATE-007` |
| INTENT | 8 | user（`/v1/health/speech` 公开待整改） | `C-API-INTENT-TEXT-CREATE-022` |
| PERSONA | 3 | user | `C-API-PERSONA-CREATE-029` |
| MV | 20 | user + `mv` 门控 | `C-API-MV-JOBS-CREATE-048`、`C-API-MV-BOOT-CREATE-050` |
| MUSIC（音乐助手） | 3 | user + `music_assistant` 门控 | `C-API-MUSIC-TICKETCONFIRM-CREATE-058` |
| ASSISTANT（统一助手） | 12 | user + `assistant_core` 门控（metrics 为 admin） | `C-API-ASSISTANT-MESSAGES-CREATE-063` |
| EXEC | 6 | executor | `C-API-EXEC-COMPLETE-CREATE-034` |
| ADMIN | 28 | admin（`/admin/login` 公开） | `C-API-ADMIN-CONFIGSET-SET-094` |
| CORE 内置 | 4 | public×3 + user(`/ws`) | `C-API-CORE-WSS-CONNECT-104` |

### 2.2 跨接口公共规则

1. **幂等**：派单类必须带 `idem_key`（唯一索引）；命中活跃或 10 分钟内同参任务返回原 job + `idempotent:true` + `credits_charged:0`。键的归一化字段以 `api/works.js normalizeForIdem` / `api/mv.js idemOf` 为准，**seed 与 instrumental 必须在键内**（否则改 seed 重试被旧 job 吃掉）。失败/取消后重试由服务端自动加 `_retry_<n>` 后缀，客户端无需换键。
2. **审核前置**：一切用户可控文本（prompt/lyrics/tags/mood/title/brief/note/reason/scene_desc/persona name）必须在扣费与派单**之前**过 `core/rules.js moderateFields`（可经 `app_config.moderation_enabled` 总开关关闭）。命中 → `MODERATION_BLOCK`，不扣分。
3. **限流**：所有花钱/产物端点必须有 `util.allowRate` 桶，桶名与阈值写进 `routes.json.errors`/`notes`。当前阈值：`generate` 12/60s、`intent:voice|image` 10/60s、`intent:text` 20/60s、`mv:jobs` 30/60s、`mv:suggest` 10/60s、`mv` 建项目 10/h、人像与助手图片上传 20/h、`appcfg` 60/min、管理员登录 10/5min。
4. **乐观锁**：改剧本/改报价必须带 `ver`（`mv_projects.script_ver` / `est_ver`），不匹配 → `STALE`(409) 并让 App 重新拉取，绝不后写覆盖。
5. **机检字段防伪造**：`MACHINE_KEYS`（`ai_review`/`sync_score`/`face_score`/`est_json`/`est_ver`/`timings`/`paused`/`status`/`credits_cost`/`credits_refunded`/`ai_label`/`work_id`/`user_id`/`id`/`preview_url`/`video_url`/`cover_url`/`suggest_json`/`created_at`/`updated_at`）由机检管线独占写入，任何用户侧 PATCH **静默剥除**。清单以 `api/mv.js` 为唯一真源。
6. **上传防线**（`config.upload`）：语音 m4a/wav ≤10MB ≤60s；图片 jpg/png ≤8MB；人格 wav/m4a/mp3 时长 20–40s；`consent='true'` 前置（PIPL）；魔数实测 + `sha256` 去重 + 72h TTL。`multipart` 路由必须声明 `raw:true` 与匹配的 `limitMb`，否则会被 JSON 分支的 1MB 上限先截断（§8 R-10）。
7. **分页**：列表用不透明 `cursor`（`util.encodeCursor/decodeCursor`）+ `limit` 上限 50（admin 侧另限 500/1000）。
8. **响应字段只增不改**：新增字段不通知即发布是允许的；**改名或删除字段属于破坏性变更**，必须走 §9 新版本号 + App 兼容期。

### 2.3 `/admin/*` 与内置路由正式入约

历史 v1–v5.0 **完全没有登记 `/admin/*`**（27 条 + 控制台 HTML + 登录），这是已知黑洞。本节起它们与 `/healthz`、`/f/*`、`/ws` 一起受契约约束，条目见 `routes.json`：

- `POST /admin/login` 是**唯一公开的运营入口**；其余 `/admin/*` 一律 `requireAdmin`。
- 例外登记：`GET /v1/admin/assistant/metrics` 是挂在 `/v1` 前缀下的 admin 路由（`C-API-ADMIN-ASSISTANTMETRICS-READ-071`）。**新条目一律用 `/admin/*` 前缀**，不再往 `/v1` 里塞管理端点。
- `GET /admin`（控制台 HTML）当前不鉴权：处置建议见 §8 R-03。
- 运营中心三个高危动作 —— `POST /admin/config/app`（改定价）、`POST /admin/config/features`（改灰度）、`POST /admin/config/routing`（改模型端点）—— 必须留 `ops_events` 审计（已有 before/after），且**视为资金/供给侧高危面**：建议加二次确认与 `reason` 必填（§8 R-15）。

---

## 3. WSS 事件（`/ws?token=<access_token>`）

- 单端点、文本帧、JSON、**服务端单向下发**；客户端只允许 `{type:'ping'}`。握手期无有效 token 直接断（401 语义），非 `/ws` 前缀或非 upgrade 直接销毁连接。
- 支持分片帧与 ping/pong/close；单帧上限 1MB，掩码强制（`src/server/index.js`）。
- **事件全集（6 种，机器可读枚举见 `routes.json` 的 `C-API-CORE-WSS-CONNECT-104`）**：

| type | 载荷 | 发射点（`core/bus.js`） |
|---|---|---|
| `job.progress` | `job_id, progress(0-100), note` | `jobProgress` |
| `job.done` | `job_id, result, error:null`（成功）**或** `job_id, result:null, error:{code,message}`（失败） | `jobDone` / `jobError` 共用同一 type |
| `intent.card` | `intent_id, status` | `intentCard` |
| `credit.delta` | `delta, balance_after` | `creditDelta` |
| `mv.progress` | `project_id, status?, progress?, note` | `mvProgress`（剧组通告板唯一推送源） |
| `assistant.event` | `seq, event{id,seq,type,payload,created_at}` | `l2assistant/core.js publish`（经 `bus.push`） |

**纪律**

1. **WSS 永不替代 REST 真相**。断线后以 `GET /v1/assistant/events?after_seq=` 补发 + `GET /v1/jobs/:id` 兜底；`assistant_events` 只做补发，不做事件溯源。
2. 历史文档称"五种事件"，实为 **6 种**（`assistant.event` 从未登记）→ §8 R-17 处置：本档转正，代码不动。
3. `job.done` 用一个 type 承载成功/失败，**消费端必须以 `error` 字段判成败**，不得以 `result` 是否为 null 猜测。
4. `mv.progress.note` 必须过 `rules/mv_lexicon.sanitize`；`progress` = 已完成镜（`clipReady|synced|locked`）占比取整。

---

## 4. 执行器拉单协议（executor → API，全部 `X-Executor-Token`）

六端点（`routes.json` 的 `C-API-EXEC-*`）：`register` / `poll` / `jobs/:id/progress` / `jobs/:id/complete` / `jobs/:id/fail` / `heartbeat`。

| 约定 | 真值 | 来源 |
|---|---|---|
| long-poll 挂起 | 25s（`engine.pollHoldMs`），另有 2s 安全轮询兜底 | `config.engine` |
| 租约 | 10min（`engine.leaseMs`），`heartbeat` 续租；过期由 `sweep()`（30s）回收 | `config.engine` / `core/engine.js` |
| 最大尝试 | `engine.maxAttempts=3`：`attempts<3` 回队重试，否则 `failed` + 全额退款 | `config.engine` |
| 单 job 时限 | 见 §5 lane 表（per-type 覆盖优先） | `src/server/lanes/index.js timeoutOf()` |
| complete 体积 | `engine.maxUploadMb + 2`（JSON body 默认 1MB 不适用） | `config.engine` / `api/executor.js` |
| 幽灵 poll 防线 | 挂起期间 socket 已销毁 → 放弃派发，不把 job 租给死执行器 | `core/engine.js poll()` |
| 夜间档 | `queue_mode='night'` 的 `mv_*` job 仅在本机钟窗口内出队；窗口内 night 优先；night 挂起**不得阻塞**其后 normal（防队头饿死） | `core/engine.js queuedDispatchable` |

**协议不变量**

1. `poll` 返回 `{job:{id,type,payload,lease_expire_at}|null}`；**`type` 决定 payload 形状与产物逻辑名**，见 §5。执行器不得猜字段，服务端不得偷偷加必填字段。
2. `complete` 用 `multipart`：文件部件任意数量，`result` 字段是 **JSON 字符串**，其中 `files` 为 `{逻辑名: 上传字段名}`；服务端落 `var/out/<yyyy-mm>/` 并按 `*_url` 回填。非 multipart → `BAD_REQUEST`。
3. `progress` / `complete` / `fail` 都受租约归属校验：job 的 `executor_id` 与本次身份不符 → `FORBIDDEN`。
4. `fail` 的 `message` 必须过 `sanitizeEngineNames`（面向用户回显的最后一道净化）。
5. **系统自动返工的唯一凭证通道**：`POST /v1/mv/shots/:id/jobs` 带 `initiated_by:'system'` 时改判 `X-Executor-Token`（`timingSafeEq`），不符 → `FORBIDDEN`；系统补拍 `cost=0` 且 `payload.initiated_by='system'`。这条双凭证语义正式入约（§8 R-11）。
6. `register` 下发 `nodes`（各 kind 的 `engine/endpoint/status`）给执行器 —— 这是**内部面**，禁止任何 App 侧复用；其内容含真引擎名，属管理员/执行器可见（§8 R-02 同源）。
7. job 类型 ↔ lane 映射的唯一真源是 `src/server/lanes/index.js`；未知类型兜底 `ffmpeg`，但**新增类型必须同时登记** `LANES` 与执行器侧 `ROUTE/KNOWN_LANES`，否则 V13 契约断言失败。

---

## 5. lane 与 job payload

### 5.1 lane 表（**诚实版**，与代码逐字对齐）

唯一真源：`src/server/lanes/index.js` 的 `LANES`。`ladder` 列如实描述代码实现，不再写"计划中的降档"。

| lane | types | 超时 | `ladder()` 实现 |
|---|---|---|---|
| `music` | `music` | 480s | **恒等**（`{...payload}`） |
| `intent` | `intent_voice` / `intent_image` / `intent_text` | 90s | **恒等** |
| `ffmpeg` | `transcode` / `dsp` / `mv_preview` / `mv_compose` | 120s；per-type 覆盖：`mv_preview`、`mv_compose` 各 600s | **恒等** |
| `imgspark` | `mv_cast_image` / `mv_storyboard` | 900s | **恒等** |
| `vidspark` | `mv_cast` / `mv_cast_video` / `mv_shot` | 3600s | **恒等** |
| `lipsync` | `mv_lipsync` | 1800s | **恒等** |
| `align` | `mv_align` | 120s | **恒等** |

### 5.2 关于"降档"的唯一口径（**取代历史承诺**）

> **`Status: SUPERSEDED`（原 v2.3 / v2.6 的 ladder 承诺段作废）**
> 旧文写的 `steps 8→4 恒定 turbo`、`帧网格≤362 / steps 恒 4`、`推理步数 30→20 一次` 是**设计意图**，不是实现。代码里 7 个 `ladder()` 全部是恒等函数，`ladderNext` 确实被调用（`core/engine.js` 的 `requeueOrFail` 里，`attempts<maxAttempts` 时对 payload 走一次 ladder）。旧文与代码不符，故整段改判为 `SUPERSEDED` 并移入归档，不再作为验收依据。

**现行口径（计费诚信决定，非缺陷）**：

1. **重试保真重跑**：失败重试使用与首次**完全相同**的参数（含 seed 之外的全部维度）。用户为 `count` / `sec` / 每镜 / 每口型付过钱，重试不得少交付。
2. **最多三次，仍败全额退款**：`attempts` 耗尽 → `failed` + `credits_cost` 全额 `refund`（账本 `reason='refund'`），绝不"降级交付且不退款"。
3. **减负只降技术档位，不降计费交付维度**：若日后引擎侧需要减负（例如 persona clone 的 fast/full 两档、同参 OOM 的保护），允许的旋钮只有：采样步数、CFG、内部 tile/分块策略、超分开关、精度档位。**禁止**动：候选数 `count`、时长 `sec`、镜头数、是否做口型、是否出封面/波形。
4. **同参 OOM 不重试**（铁律）：识别为环境性失败时直接 `failed`+退款或走明示降级，不做静默降档。
5. **明示降级才算降级**：任何"少做了一件事"必须能在产物里被验证 —— `mv_shots.flags_json` / sidecar `degraded_shots`、`candidates.meta.degraded`、`work` 侧 `format:'wav'` 直发等，并汇入 `GET /v1/mv/projects/:id/report` 的 `degraded_shots`。静默降级＝违约。
   - 已备案的合法降级：口型两次未达标 → 该镜转空镜 + 字幕（`mv.progress.note` 明示、不扣分）；`transcode` 子任务永久失败 → 父 job 仍 `done`，候选保 wav master（`format:'wav'`、`waveform_url:null`、`meta.degraded:true`）**且不退款**（DEV-TXFAIL 裁决：生成本身成功、产物真实可播）。

### 5.3 job payload 与产物逻辑名

字段级定义**不在本文手抄**：请求侧字段见 `routes.json` 的 `request`，job 载荷与产物逻辑名以下表 + `core/engine.js` 的 `complete*` 分发器为唯一真源。

| job type | lane | 关键载荷（要点） | `result.files` 逻辑名 / 回填 |
|---|---|---|---|
| `music` | music | `mood,tags,lyrics,bpm,sec,count,seed_base,instrumental,persona{ref_abs_path,cover_strength,clone_mode}|null,candidates[{seq,seed_delta}]` | 每候选音频 → `candidates.audio_master`；派生 `transcode` 子 job |
| `transcode` | ffmpeg | `{src, targets:["mp3","peaks"]}` | `<name>.mp3`(320k) / `<name>.peaks.json`(400 点) → `*_playback` / `waveform_url`；永久失败走 DEV-TXFAIL |
| `dsp` | ffmpeg | `{op, src, params}`（trim/fade/pitch/tempo/concat/slice） | 产物音频 → `*_url` |
| `intent_voice` / `intent_image` / `intent_text` | intent | `{upload_path}`（text 走卡面原地重编译） | `complete(result=IntentCard JSON)`；LLM 不可达 → 词典启发式，`confidence<0.5` + `degraded:1` |
| `mv_cast` | vidspark | `{gender,desc,portrait_path,cast_method,seed}`（**方案一默认 `i2v_first_frame`**：原图 I2V 首帧锁脸） | `cast_video` + `frame_1..N` + 逐帧 facegate 分数 → `mv_characters.frames_json/viewrefs_json` |
| `mv_cast_image` | imgspark | `{gender,desc,portrait_path,anchor_refs[],seed,cast_method}` | `cast_image_1..3` + `face_scores[]`（**遗留分支：已证伪，仅显式启用**） |
| `mv_cast_video` | vidspark | `{cast_image,seed,motion}` | `cast_video` + `frame_1..13`（遗留分支） |
| `mv_storyboard` | imgspark | `{shots:[{id,desc,camera,cast_ids,background}], viewrefs:{char:[url]}}` | `board_<shotId>` ×N → `mv_shots.storyboard_url` |
| `mv_shot` | vidspark | `{shot:{first_frame,refs[],motion,singing,lyric}, project_kind, seed, tier, initiated_by, origin}` | `clip_<shotId>` → `mv_takes`；演唱镜自动派 `mv_lipsync` 子 job |
| `mv_lipsync` | lipsync | `{video, audio_master, win{start_sec,dur_sec}, shot_id, take_id}` + `result.sync_score`(0-1) | `synced_<shotId>`；`sync_score < mv.syncThreshold(0.6)` → 系统免费补样 ≤2 次，仍不过 → 空镜+字幕 |
| `mv_align` | align | `{audio_master, lyrics, structure}` | `result.timings=[{line,start,end}]` → `script_json.timings` |
| `mv_preview` | ffmpeg(600s) | `{board_urls[], audio_master, seg_sec}` | `preview` → `mv_projects.preview_url` |
| `mv_compose` | ffmpeg(600s) | `{takes:[{video,start_sec,strip_audio,segment?,xfade?,degraded?}], audio_master, title, subtitles?}` + sidecar `{subtitles,music,ai_label,degraded_shots}` | `mv_video` + `cover` → `mv_projects.video_url/cover_url` |

**成片附加字段（原"v2.12 增补批注"，本档起独立成 §5.3.1，编号补齐）**：`takes[].segment`（相邻不同值→该边界加 xfade）、`takes[].xfade`（强制淡入淡出）、`takes[].degraded[]`（汇入 `sidecar.degraded_shots`）、`subtitles`（`string[]` 或 `[{line|text,start,end}]`，有片名卡自动 +2s 平移）、`takes[].dur_sec` / `mv_align.duration_sec`（ffprobe/ASR 缺席时的时长兜底，默认按 `shot.sec`）。

**定脸方案（cast_method）**：白名单 `i2v_first_frame`(默认) / `h3_image_cast` / `ref2va` / `likeness_lora`，真源 `core/store.js` 的 `CAST_METHODS`/`CAST_METHOD_DEFAULT`。新增方案只追加、**默认不可被静默切换**；逐项目/逐角色回滚靠显式 `cast_method` 列。

---

## 6. 助手与治理

### 6.1 收敛结果：一套白名单、一套票、一套上下文

`v5.0` 已把三套助手收敛到 `src/server/l2assistant/core.js` 的**一份 19 项白名单**。历史三份旧表（MV 7 项 / 音乐 7 项 / 统一助手 10 项）**全部删除并移入归档**，其运行时残留（`l2mv/governance.js`、`l2music/governance.js` 各自的 `TOOLS`）定性为**兼容层**，只服务 `/v1/mv/assistant/*` 与 `/v1/music/assistant/*` 两条旧入口，**不得再新增工具**。

**治理不变量（对 19 项全部成立）**

- 实体 id 只来自服务端校验过的 `context.refs`（≤12，去重，属主校验）；**文本/LLM 给出的 id 一律不参与解析**。
- 一切写操作（免费写与付费写）**先确认票、后执行**；只读工具直接执行。付费动作额外受 `assistant_actions` 闸门。
- **花钱大门不可票据直执**：`works/generate`、`mv/boot` 级动作永不进票面（`mv.executeTicketAction` 以正则硬拒 boot）。
- 票：`pending → executing → succeeded|failed|reconciling|compensated`，`denied|expired` 为终态；TTL 60s；五连校验（`hash`+`ver`+TTL+owner+一票一次）在**同一事务内 CAS**；重复 `confirm` 返回既有 ticket/job，不重派、不重复扣费；`reconciling` 严禁盲目重放。
- 注入红线：命中 → `meta.rejected:true` + 人话拒答 + 审计 `injection_suspect`，**不给任何执行意图**；白名单外工具 → `FORBIDDEN`(403)。模式清单唯一真源 `src/server/l2/governance_core.js`（≥11 条，含聊天模板控制标记与"索要系统提示"两类）。
- 助手回复在确认前只能说"已提交确认/已开始执行"，不能说"已完成"。
- 审计与记忆只存**已执行结果摘要**（`chat_messages.role='result'`），不落原始模型指令。

### 6.2 工具总表（19 行，唯一权威）

来源：`src/server/l2assistant/core.js` 的 `TOOLS` + `PAID_ACTIONS` + `WRITE_ACTIONS`；`readOnly` 直接执行，`WRITE_ACTIONS` 走确认票，`PAID_ACTIONS` 另受 `assistant_actions`。

| # | 工具 | 域 | free / paid | 确认票 | 所需实体类型（refs） | 计费（`AC.credits()` 项） |
|---|---|---|---|---|---|---|
| 1 | `assistant.context` | 助手 | free | 否（只读） | 任意（固化 refs/surface） | — |
| 2 | `assistant.task_query` | 助手 | free | 否（只读） | 无（可含 `job`） | — |
| 3 | `assistant.ticket_query` | 助手 | free | 否（只读） | 无 | — |
| 4 | `library.search` | 助手 | free | 否（只读） | 无（`q` ≤50） | — |
| 5 | `work.explain` | 音乐 | free | 否（只读） | `work` | — |
| 6 | `music.query_status` | 音乐 | free | 否（只读） | `work` \| `job` | — |
| 7 | `music.set_title` | 音乐 | free 写 | **是** | `work` | 0 |
| 8 | `music.set_card` | 音乐 | free 写 | **是** | `intent` | 0（落 `gen_params`，影响后续 `generate` 计费参数） |
| 9 | `music.adjust_params` | 音乐 | **paid** | **是** | `work` | `adjust` |
| 10 | `music.regenerate` | 音乐 | **paid** | **是** | `work` \| `intent` | `per_candidate × count` |
| 11 | `music.cover` | 音乐 | **paid** | **是** | `work` + `persona` | `cover` |
| 12 | `music.extend` | 音乐 | **paid** | **是** | `work` | `extend` |
| 13 | `mv.set_title` | MV | free 写 | **是** | `project` | 0 |
| 14 | `mv.set_brief` | MV | free 写 | **是** | `project` | 0 |
| 15 | `mv.set_queue_mode` | MV | free 写 | **是** | `project` | 0（改 `normal|night`，影响夜间档派发） |
| 16 | `mv.script_suggest_edit` | MV | **⚠ free / paid 冲突未裁决** | **是** | `project` | 0（只挂 suggest 草稿，不 `ver++`）；**`[需 lead 裁决]`** |
| 17 | `mv.shot_reorder` | MV | **paid** | **是** | `project` + `shotIds`（全列去重，≤64） | 票面估价 `storyboard×N + compose`（本次不扣，落账在后续制作） |
| 18 | `mv.shot_delete` | MV | **paid** | **是** | `shot`（仅未成片镜） | 票面估价 `compose`（同上） |
| 19 | `mv.shot_reshoot` | MV | **paid** | **是** | `shot`（`reason` ≤120，含"动作"触发运动改写） | `mv.shot` |

**`ref` 类型合法集**：`work | intent | job | project | shot | persona | image`（`l2assistant/core.js` 的 `REF_TYPES`）。其中 `image` 的契约地位尚未对齐 —— 见 §8 R-06。

### 6.3 唯一未决口径：`mv.script_suggest_edit` 是 free 还是 paid

| 位置 | 声明 |
|---|---|
| `src/server/l2assistant/core.js`（统一助手，**现行入口**） | `expensive: false` |
| `src/server/l2mv/governance.js`（旧 MV 入口，兼容层） | `expensive: true` |
| 两者 `est()` | 一致：`{credits: 0, minutes: 2}` |
| 旧 v4 工具表 | "free + confirm" |
| 旧 v5 表 | "免费写" |

**影响面**：`expensive` 决定该动作是否受 `assistant_actions` 付费闸门限制（见 `l2mv/facade.js` / `l2music/facade.js` 的 `if (!def.expensive)` 分支）。两端口径不一 ⇒ 同一句话在统一助手能出票、在旧 MV 助手可能被闸门拦下。

**建议唯一口径（`[需 lead 裁决]`）**：定为 **free + confirm**，即
1. 以 `l2assistant/core.js` 的 `expensive:false` 为准，把 `l2mv/governance.js` 改为 `false`（兼容层向统一层对齐）；
2. 理由：该动作**不产生任何扣费**、不改 `script_ver`、只挂 suggest 草稿，采纳与否由 `POST /v1/mv/projects/:id/suggest/apply`（人点）决定 —— 属"AI 出主意、人拍板"，归 free；
3. 但**保留确认票**（它是写操作，会覆盖 `suggest_json`），并保留 `est.minutes=2` 作为 ETA 提示；
4. 裁决后同步改：`l2mv/governance.js`、本表第 16 行、`routes.json` 对应条目的 `credits` 字段。

---

## 7. 数据模型与迁移

唯一真源：`src/server/core/store.js` 的 `MIGRATIONS`（`schema_version` 表驱动，追加新版本即可）。

### 7.1 规模（**按代码实测，修正 brief 中的估计**）

| 项 | 实测 |
|---|---|
| `CREATE TABLE` | **33** 张：32 张业务表 + 1 张 `schema_version`（由 `init()` 建，不在 `MIGRATIONS` 内） |
| 迁移版本 | **15**（`version: 1…15`） |
| `ALTER TABLE … ADD COLUMN` | **29** 条（跨 v2/v4/v7/v9/v11/v12/v13/v14/v15） |
| 索引 | 与建表同批（`idx_*` 前缀），列级约束见 store.js |

> ⚠ `brief` 里的"18 张表 + 28 条 ALTER"与实测不符：真实是 **32(+1) 张表 / 29 条 ALTER / 15 个迁移版本**。归档前请以 `store.js` 复核，不要按 18 写任何校验脚本。

### 7.2 表清单（32 张业务表，按域）

| 域 | 表 |
|---|---|
| 账号与鉴权 | `users`, `sessions`, `sms_codes`, `admins` |
| 账本 | `credit_ledger` |
| 作品线 | `works`, `candidates`, `jobs` |
| 意图线 | `intent_cards` |
| 人格与上传 | `personas`, `uploads` |
| 治理与运营 | `reports`, `audit`, `executors`, `app_config`, `feature_flags`, `ops_events` |
| 模型供给 | `model_nodes`, `model_defaults` |
| MV（二期） | `mv_projects`, `mv_characters`, `mv_shots`, `mv_takes`, `mv_tickets`, `mv_chat_sessions`, `mv_chat_messages` |
| 统一助手（v4/v5） | `chat_sessions`, `chat_messages`, `chat_tickets`, `assistant_events`, `assistant_metrics` |

### 7.3 迁移纪律

1. **只追加**：新列一律新 `version` + `ALTER TABLE … ADD COLUMN`，禁止改历史 `sql` 文本（历史块已被线上库执行过，改动会导致新库与老库结构分叉）。
2. **禁止破坏性变更**：不删列、不改类型；SQLite 的 `DEFAULT` 语义变化要靠新列 + 回填。
3. **幂等**：`CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` + 确定性 id（如 `mn_<kind>`、`ad_admin`）保证重启不重复播种。
4. **业务写与事件同事务**：`assistant_events` 与业务写同一个 `store.tx`，提交后再 `bus.push`（`l2assistant/core.js withEvents`）。WSS 丢发不影响 REST 一致性。
5. **`uploads` 三类 `kind` 受 CHECK 约束**（`voice|image|persona|mv_portrait|assistant`），新增类别必须同步改 CHECK 与清理任务。
6. `jobs` 三态查询索引 `idx_jobs_poll(status,type,created_at)` 是拉单性能命脉，重建表时不得省略。
7. **待清理残留**（迁移遗留，非缺陷但必须登记）：`mv_projects.script_draft_json`（v12 起废弃，改用 `chat_*`）、`chat_tickets.scope='music'` 与 `mv_tickets` 双份票表（旧入口兼容期保留）。

---

## 8. 已知偏差登记册

**规则**：每条必须写「现状 / 证据（文件路径）/ 处置建议 / 状态」；证据**只写文件**，不写行号。`状态 ∈ 待修码 / 待改文 / 待裁决 / 已并发修复(待复核) / 已处置`。

| # | 现状（契约 ↔ 实现） | 证据文件 | 处置建议 | 状态 |
|---|---|---|---|---|
| **R-01** | `GET /v1/app/config` **匿名**下发 `routing.{music,llm,mv}.engine`，把真引擎名与许可模型名交给可被任意人请求的端点，直接违反 §0.6 用户面纪律；同一响应还含全量积分表与 8 个功能开关命中结果 | `src/server/api/appconfig.js`、`src/server/core/modelnodes.js`（`routingForApp`） | ①`routingForApp()` 去掉 `engine` 字段（App 只需 `node_id/locked`，或连 `node_id` 都不给，改发中性 `model_options.label`）；②`model_options` 的 SQL 不再 `SELECT engine`；③该端点补"匿名可取、但只含展示所需"白名单校验；④`routes.json` 已标注，验收加断言"响应体不含任何 `NODE_META.engine` 值" | 待修码 |
| **R-02** | 引擎名净化黑名单与 §0.2 真值表不同源：缺 comfy/comfyui、arcface/insightface、echomimic、sensevoice-ts、许可模型名等；且它只被用在错误信息上 | `src/server/core/util.js`（`sanitizeEngineNames`）、`src/server/core/modelnodes.js`（`NODE_META`） | 净化表由 `NODE_META` 派生（单一来源），并补常见变体；对所有"可能带上游原文"的出口（executor `fail`、上游 ASR `/healthz`、LLM 回复摘要）统一过净化 | 待修码 |
| **R-03** | `/admin/*`（27 条）+ 控制台 HTML **完全不在历史契约内**；`GET /admin` 与 `POST /admin/login` 不鉴权即返回运营控制台 | `src/server/index.js`、`src/server/api/admin.js`、`src/server/admin/index.html` | 本档 §2.3 正式入约；`GET /admin` 加 `requireAdmin`（或 IP 段白名单 + `no-store` 保留）；内置默认账号必须轮换（登录侧已加固，见 R-08） | 待修码 |
| **R-04** | LLM 端点与模型名**两处不一致**：`config.js` 的 `llmVlmUrl` 缺省仍是历史端口（应 `8090`），`llmVlmModel` 缺省 `qwen38-fp4` 而 `etc/spark.env` 写 `Inkling2-Mini:vision` | `src/server/config.js`、`etc/spark.env`、`src/server/core/modelnodes.js` | ①`config.js` 缺省改 `http://127.0.0.1:8090/v1`；②模型名只留一处真值并**以运行时 `/v1/models` 为准**，文档与种子值只作展示；③`modelnodes` 的 `llm` 种子 `engine` 同步；④`scripts/verify_routes.mjs` 加"文档内不得出现作废 LLM 端口"的扫描 | 待裁决 + 待修码 |
| **R-05** | `GET /v1/health/speech` 设计为公开自检，但把上游 ASR `/healthz` 的 `device`、`model_loaded` **原样透传**给匿名调用方，且无 `allowRate` | `src/server/api/intent.js` | 只回 `{ok, reason, checked_at}`；`device/model_loaded` 移到 admin 侧（`GET /admin/model-nodes/health`）；补匿名限流 | 待修码 |
| **R-06** | `POST /v1/assistant/image` **已上线**，但历史 v4 的 REST 清单里没有它、v5 又声明"图片引用属阶段三、本版本不实现"；`REF_TYPES` 已含 `image`，`assistant_images` 表未建（现借 `uploads.kind='assistant'`） | `src/server/api/assistant.js`、`src/server/l2assistant/core.js`、`src/server/core/store.js` | 二选一并写死：①承认已实现 → 本档 §2 与 `routes.json` 转正、补 `image` ref 语义与 TTL/PIPL 条款、明确不落 `assistant_images`；②真要缓发 → 路由加 `assistant_images` 开关并默认 404。**建议①**（代码与 App 已在用） | 待裁决（建议改文） |
| **R-07** | 声音人格样本经 `U.saveToOut` 落 `var/out` ⇒ 声纹（个人生物特征素材）走**永久公开**的 `/f/*`，与 `var/uploads` 的 72h 私有暂存纪律相悖 | `src/server/api/personas.js`、`src/server/index.js`（`serveFile`）、`src/server/core/util.js` | 人格样本改存 `var/uploads`（`kind='persona'`）+ 私有读代理（带属主校验的签名 URL），或至少设 TTL；`personas.voice_ref` 相应改语义 | 待修码 |
| **R-08** | 执行器/管理员/固定验证码的**仓库内公开默认值**曾在 prod 直接可用 | `src/server/config.js`、`src/server/api/admin.js`、`src/server/core/security.js`、`etc/spark.env` | **本轮并发修复已处置**：`MB_DEV_OTP` 缺省关闭、口令 scrypt 加盐 + 登录限流 + 令牌 12h 过期、`assertBootable` 在 `MB_ENV=prod` 拒绝启动。剩余：①默认账号仍可能未轮换（应强制首启改密）；②`admins.token` 明文单列、无独立登出；③`MB_WORKER_TOKEN` 已有审计项但 worker 侧需闭环 | 已并发修复(待复核) |
| **R-09** | §1 名义"单一来源 `config.js`"，运行时真值实为 `app_config` 运营快照（`POST /admin/config/app` 改后即生效） | `src/server/core/appconfig.js`、`src/server/api/admin_ops.js` | 本档 §1 已改为"声明处 = `config.js`，运行时真值 = `app_config`"；禁止任何文档抄价目表（含历史 745⚡/400⚡/760⚡ 三处算例，已删） | 已处置（本档） |
| **R-10** | `POST /v1/assistant/image` 未声明 `raw:true` / `limitMb` ⇒ 走 JSON 分支的 **1MB** body 上限，先于"图片 ≤8MB"生效；同形问题需全表复核 | `src/server/api/assistant.js`、`src/server/index.js`（`maxBytes` 计算） | 补 `raw:true, limitMb: upload.imageMaxMb + 2`；`scripts/verify_routes.mjs` 加规则"凡解析 `ctx.raw` 的路由必须声明 `raw:true` 且 `limitMb ≥ 其业务上限`" | 待修码 |
| **R-11** | `POST /v1/mv/shots/:id/jobs` 同时承载用户凭证与 `initiated_by:'system'` + `X-Executor-Token` 双凭证语义，历史契约只当它是用户端点 | `src/server/api/mv.js`、`src/server/api/executor.js` | 本档 §4.5 正式入约；建议长期拆成 `POST /executor/mv/shots/:id/jobs`（执行器专用）避免"用户面端点带内部凭证" | 待改文（长期待修码） |
| **R-12** | `GET /v1/assistant/bootstrap` 的 `capabilities` 固定 6 字段中 `voice` **硬编码 false**，而端侧语音（v3.2）已上线 | `src/server/l2assistant/facade.js`、历史 v5"固定 6 字段"条款 | 由真实开关推导（端侧语音可用性或 `featureOn('assistant_chat_music')` 等），并在 `routes.json` 写清每个 capability 的判定源 | 待修码 |
| **R-13** | `POST /admin/model-nodes` 可写任意 `endpoint`，`probe` 会以服务端身份发起 GET ⇒ SSRF 面（含内网元数据地址） | `src/server/api/modelnodes.js`、`src/server/core/modelnodes.js`（`httpProbe`） | 端点白名单（仅允许的 host/端口段或私网拒绝列表）+ 探测超时与并发上限（已有 3s/并发 8，需补协议与重定向限制） | 待修码 |
| **R-14** | `POST /admin/credits/adjust` 直接 `appendLedger`，无余额下限校验 ⇒ 可把余额调成负数，破坏"余额非负"隐含不变量 | `src/server/api/admin_ops.js`、`src/server/core/store.js` | 显式允许负余额需写 `reason` 并留 `ops_events`；或禁止使 balance<0。同时给"扣款"与"发放"不同权限位 | 待裁决 |
| **R-15** | 定价/灰度/模型端点三个高危动作无二次确认，`reason` 也非必填 | `src/server/api/admin_ops.js`（`configSet` / `featuresSet` / `setRouting`） | `reason` 必填 + 双人复核（或 24h 延迟生效）+ `ops_events` 保留期书面化 | 待裁决 |
| **R-16** | `core/appconfig.js` 的 `setFlag` 与 `rollback` 用 **`throw U.ApiError(...)`（少写 `new`）** 抛类构造器 ⇒ 实际抛 `TypeError`，被 `index.js` 兜底成 **500 `INTERNAL`**，而契约要求 400 `BAD_REQUEST`（实测确认：`Class constructor ApiError cannot be invoked without 'new'`） | `src/server/core/appconfig.js`、`src/server/core/util.js`（`ApiError` 是 `class`） | 改成 `throw new U.ApiError(...)`；加 lint 规则"ApiError 必须 `new`"；回归：`POST /admin/config/features` 传未知 key 断言 400 | 待修码 |
| **R-17** | 历史 §3 称 WSS"五种事件"，实际 6 种（`assistant.event` 从未登记） | `src/server/core/bus.js`、`src/server/l2assistant/core.js` | 本档 §3 转正为 6 种；补 `assistant.event` 的载荷与补发协议说明；`test/acceptance` 加事件全集断言 | 已处置（本档） |
| **R-18** | `GET /v1/works?public=1` 分支**完全跳过鉴权**（可匿名枚举全站公开作品：标题/歌词/mood/genres/bpm/音频 URL），且无独立限流 | `src/server/api/works.js`（`listWorks`） | 若"公开广场"是产品需求 → 建独立只读端点 `GET /v1/public/works` 并裁剪字段（不给 `lyrics` 全文）、补限流；否则要求带 token | 待裁决 |
| **R-19** | 参数域漂移：同一 `music.set_card` 的 `mood` 上限，统一层 60 字、旧音乐层 20 字；`mv.shot_reshoot.shot_id` 的 `kind` 两层写法不同（`entity/of:'shot'` vs `shotId`） | `src/server/l2assistant/core.js`、`src/server/l2music/governance.js`、`src/server/l2mv/governance.js` | 兼容层参数域由统一层导出（单一来源），或加校验脚本比对三表逐字段一致 | 待修码 |
| **R-20** | 僵尸条款：v2.4 仍保留 `mv_cast_image` / `mv_cast_video` 定价与 payload，而两者在 v2.3/v2.4 自述"遗留分支，**已证伪**，仅显式启用"；v2.7"未决（align 0 还是 5）"实际已按 5 落地 | `src/server/config.js`（`mv.credits`）、`src/server/api/mv.js`、`src/server/prompts/*` | 已证伪分支加 `Status: DEPRECATED`（保留实现以便逐项目回滚），定价保留但从"对外报价"文案剔除；v2.7 未决项标 `RESOLVED(align=5)` 后随旧文归档 | 待改文 |
| **R-21** | 幂等命中后的退款 `ref_type` 与扣分时不一致（扣分 `ref_type='work'`+`ref_id=workId`，退款用 `ref_type='dsp'`），按账本核算的对账脚本会漏配 | `src/server/api/works.js`（`dsp`） | 退款使用与扣分完全相同的 `(ref_type, ref_id)`；`test/acceptance` 加"扣分/退款成对"账本断言 | 待修码 |

---

## 9. CHANGELOG（一行一个版本号，每个版本号恰好出现一次）

**规则**：本表是版本号 ↔ 归档锚点的唯一映射。本表共 **43 行 = 43 个真实版本号**，每个恰好一次。
（实测口径：2026-11-26 22:34 快照的 `CONTRACTS.md` 为 859 行 / 91,865 B，含 **47 个带版本号的标题** → 去掉两个结构性标题（`# v2 · MV 契约增量`、`### v4 工具与确认边界`）→ 45 个唯一 token → 计重后 **43 个 `vX.Y(.Z)` 版本号**；`v2.19`、`v3.2` 各重复一次故计 2 次。⚠ 与 brief 的"46 块 / 44 去重"不一致；且 `CONTRACTS.md` 在 23:35 已被并发修改（现 93,129 B），归档前按当时 HEAD 重测。）

`状态` 列含义：**收敛**＝内容已并入本档；**归档**＝纯历史，只留在 `docs/archive/contract-v1-v5.md`；**重编号**＝原号有冲突，按新号引用；**RESERVED**＝号位空缺但有意保留，不回填。

> 归档目标文件：`docs/archive/contract-v1-v5.md`（待建，步骤见 `docs/archive/README.md`）。归档时每个版本号必须成为**唯一**锚点 `#v<版本号>`；冲突号在归档文件里以"新号为主标题、旧号为别名"落地。

### 9.1 v1（基线）

| 版本号 | 原位置（章节名，不写行号） | 状态 | 说明 |
|---|---|---|---|
| `v1` | 文档标题「冻结契约 v1」+ §0–§5 | 收敛 | 标题自称"v1"而正文已到 v5.0 → 本档改名为「生效契约」，不再以 v1 自称；`§5 文件归属` 属施工边界，移入 `CONTRIBUTING.md` |

### 9.2 v2.x（MV 二期增量）

| 版本号 | 原位置 | 状态 | 说明 |
|---|---|---|---|
| `v2.0` | 范围与纪律 | 归档 | 二期范围已大幅超出原 N0 闭环 |
| `v2.1` | REST（`/v1/mv/*`） | 收敛 | 条目进 `routes.json`（`C-API-MV-*`） |
| `v2.2` | WSS 增量 | 收敛 | 见 §3（含转正 `mv.progress` / `mv.ticket`） |
| `v2.3` | `mv_*` job payload | 收敛 + **`SUPERSEDED`** | payload 表进 §5.3；**ladder 降档承诺整段作废**（§5.2） |
| `v2.4` | `config.mv.credits` 积分口径 | 收敛 | 价目表删除（§1）；已证伪分支加 `DEPRECATED`（R-20） |
| `v2.5` | `uploads kind='mv_portrait'` | 收敛 | §0.5 |
| `v2.6` | lane 注册 | 收敛 + **`SUPERSEDED`** | 以 §5.1 的 7 lane 诚实表取代旧 5 lane 表；旧 ladder 纪律列作废 |
| `v2.7` | 约定与未决 | 归档 | 其中"align 0/5 未决"→ `RESOLVED(align=5)`；"本期交付边界/延期项"已由后续版本落地；`mvModelLicense` 移入 §0.6 + 法务待核 |
| `v2.8` | 派单·报价·开机·建议（wave-2） | 收敛 | §4 / §5.3 |
| `v2.8.1` | 派单（先扣后派单） | 收敛 | §1 + §2.2 规则 1 |
| `v2.8.2` | 剧本建议（LLM 可选，不装忙） | 收敛 | §0.6 LLM 可选性 |
| `v2.8.3` | 报价快照 `est_json` / `est_ver` | 收敛 | §2.2 规则 4 |
| `v2.8.4` | 计费口径补充 | 收敛 | §1 |
| `v2.8.5` | WSS 形状转正 | 收敛 | §3 |
| `v2.8.6` | 机检字段防伪造 | 收敛 | §2.2 规则 5 |
| `v2.9` | 剧本编译（server 内，免费） | 收敛 | §5.3 |
| `v2.10` | 剧本校验与卡审（规则机检） | 收敛 | §2.2 / `AI_REVIEW_*` 错误码 |
| `v2.11` | 预算护栏（D13/S10） | 收敛 | `BUDGET_EXCEEDED`（§0.3） |
| **`v2.12`** | **无章节**（历史上只以 v2.3 代码块内"增补批注"存在，却被测试注释当作契约条款引用：`test/acceptance/v14_mv_instrumental.test.js` 11 处 + `test/acceptance/v15_mv_lipsync.test.js` 1 处 + `docs/runbook-dev.md`） | **重编号 → `v2.12` 补建章节** | **处置：把该批注从 §5.3 代码块抽出，立为独立小节 §5.3.1（成片片段/xfade/降级标记/字幕/时长兜底），号位补齐**。上述测试注释改引用 `§5.3.1` 或 `routes.json` id，不再引用裸版本号 |
| `v2.13` | 对话助手（治理门面） | 收敛 | §6（旧 7 工具表删除） |
| `v2.13.1` | 助手 REST | 收敛 | `routes.json` `C-API-MV-ASSISTANT-*` |
| `v2.13.2` | 工具白名单 + 参数域 | 收敛 | §6.2（19 项统一）；参数域单一来源待修（R-19） |
| `v2.13.3` | GET detail 横幅字段 | 收敛 | `routes.json` `C-API-MV-PROJECT-READ-044` |
| `v2.14` | 确认票生命周期 | 收敛 | §6.1（TTL 60s / 五连 / 一票一次） |
| `v2.14.1` | 预算双熔断（助手侧） | 收敛 | §6.1 |
| `v2.14.2` | WSS 登记形状转正 | 收敛 | §3 |
| `v2.15` | 审计与记忆口径 | 收敛 | §6.1 / §7.3 |
| `v2.15.1` | 剧本→镜行同步物化批注 | 归档 | 自述"原文保留为历史" |
| `v2.16` | jobs type 增补 `align` | 收敛 | §5.3 |
| `v2.17` | 助手端点错误码增补 | 收敛 | §0.3 |
| `v2.18` | 非计算收尾批注（N1-5/N2-5） | 归档 | 夜间档/幽灵 poll 已进 §4；批注本身留档 |
| **`v2.19`** | **两处冲突**：① v2.1 章内的「定脸方案点（cast_method）」（2026-11-26）；② v2 末段的「音乐线意图卡点改落库」（2026-11-24，v1 §2 的三处引用指向它） | ① **重编号 → `v2.23`**；② **保留 `v2.19`** | **裁决依据**：v1 §2 的三处引用（意图卡点改 / 卡面编辑纪律 / generate 参数优先级）都指向 ②，保留 ② 可让既有引用零改动；① 是最新追加、外部引用最少，顺延到新号 `v2.23`。② 内容并入 §2/§5（意图卡点改），① 内容并入 §5.3「定脸方案」+ `routes.json` 的 `C-API-MV-JOBS-CREATE-048` |
| `v2.20` | 制片助手可见性与 `assistant_chat` 判定源修正 | 收敛 | `routes.json` `C-API-MV-PROJECT-READ-044` 的 `assistant.*` 字段 |
| `v2.21` | AI 卡审下发 + 音画报告真聚合 | 收敛 | `routes.json` `C-API-MV-REPORT-READ-045` |
| `v2.22` | AI 辅助增强（基调/运动改写/人像预检） | 收敛 | §0.6 + `C-API-MV-TONE-*` / `C-API-MV-PORTRAIT-PRECHECK-*` |
| **`v2.23`**（**新号**） | 原第二处 `v2.19`「定脸方案点」 | **重编号（新）** | 见上；归档文件里以 `v2.23` 为主标题、`v2.19(旧·定脸)` 为别名 |

### 9.3 v3.x / v4.0 / v5.0

| 版本号 | 原位置 | 状态 | 说明 |
|---|---|---|---|
| **`v3.0`** | **不存在**（v2.22 直接跳到 v3.1） | **RESERVED** | 显式登记为空缺，避免被当成"漏归档"；不回填 |
| `v3.1` | 跨模块音乐助手 | 收敛 | §6（旧音乐 7 工具表删除；兼容层见 §6.1） |
| `v3.1.1` | 音乐助手 REST | 收敛 | `routes.json` `C-API-MUSIC-*` |
| `v3.1.2` | 工具白名单（恰 7 项）+ 三域映射 | **归档 + 取代** | 被 §6.2 的 19 项总表取代；`l2music/governance.js` 标兼容层 |
| `v3.1.3` | 确认票与会话（`chat_*` scope='music'） | 收敛 | §6.1 / §7.3 |
| `v3.1.4` | 审计 kind（V17 断言面） | 归档 | 审计 kind 清单改由 `store.log` 调用点自动生成 |
| `v3.1.5` | 落地文件与验收 | 归档 | 文件归属类内容统一去 `CONTRIBUTING.md` |
| `v3.2` | **两处冲突**：①「创作选择项目录下发（曲风/心情/风格点缀）」（2026-11-24）；②「端侧语音：本机管手感、服务端管准」（2026-11-25） | ① **保留 `v3.2`**；② **重编号 → `v3.3`** | **裁决依据**：按追加时间序，① 在先 → 保留原号；② 顺延到 `v3.3`。① 内容（词典唯一真源、`tags` 口径、`style_options` 下发）并入 §2 与 `routes.json` 的 `C-API-ADMIN-CLIENTCONFIG-READ-082`；② 内容（端侧/服务端分工、`GET /v1/health/speech`、IntentCard 诚实化字段、端侧模型按需下载）并入 §0.6 + §3 + R-05 |
| **`v3.3`**（**新号**） | 原第二处 `v3.2`「端侧语音」 | **重编号（新）** | 归档文件以 `v3.3` 为主标题、`v3.2(旧·端侧语音)` 为别名 |
| `v4.0` | 统一创作助手（全局入口/跨域上下文/可恢复会话） | 收敛 | §2 / §6 / §7；其中"图片本期不实现"与代码冲突 → R-06 |
| `v5.0` | 统一端侧多模态全场景业务助手 | 收敛 | §6.2 的 19 行总表即其唯一版本；三处旧工具表删除 |

### 9.4 重编号落地清单（给 lead 的一次性动作）

1. `docs/archive/contract-v1-v5.md` 中：`v2.19` 主标题 = **音乐线意图卡点改**；新增 `v2.23` 主标题 = **定脸方案点**（别名 `v2.19-旧-定脸`）。
2. `v3.2` 主标题 = **创作选择项目录下发**；新增 `v3.3` 主标题 = **端侧语音**（别名 `v3.2-旧-端侧语音`）。
3. 为 **`v2.12`** 建独立小节（内容取自原 v2.3 代码块批注 = 本档 §5.3.1），并在归档文件顶部索引里注明"曾长期缺章"。
4. 登记 `v3.0 = RESERVED`。
5. 全库搜索裸版本号引用（含 `test/**` 注释、`docs/*.md`、`src/**` 注释），改为「本档 §n」或 `routes.json` 的 `C-API-*` id；**不留 `.js:行号`**。
6. 替换后删除 `CONTRACTS.md` 里所有 `SUPERSEDED` 段落正文（只在归档文件保留），本档顶部 `Supersedes` 指向归档文件。

---

## 附：本档自检清单（lead 审替前逐条打勾）

- [ ] `contract/routes.json` 与 `src/server/api/*` 的路由表逐条一致（`scripts/verify_routes.mjs`）
- [ ] 本档与 `routes.json` 无字段级冲突（冲突以 `routes.json` 为准）
- [ ] 全文无明文凭据/令牌/口令/验证码/内网账号或内网 IP（需要指代时只写环境变量名 + "值不入文"）
- [ ] 全文无 `.js:行号` 形式引用
- [ ] 全文无手抄价目表与算例（745⚡/400⚡/760⚡ 已不存在）
- [ ] 全文只出现 §0.2 表内的真值端口与真模型名；作废 LLM 端口 0 次出现
- [ ] §6.2 恰好 19 行；`mv.script_suggest_edit` 标 `[需 lead 裁决]`
- [ ] §7.1 的 33/29/15 与 `core/store.js` 当前状态一致（并发修复后需复核）
- [ ] §9 每个版本号出现且仅出现一次；`v2.12` 已补章、`v2.23`/`v3.3` 已立号、`v3.0` 已标 RESERVED
- [ ] `scripts/verify.sh` 通过；归档步骤见 `docs/archive/README.md`
