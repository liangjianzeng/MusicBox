# MusicBox 运营管理后端建设方案（摸底 + 规划）

> 版本：v1.0 ｜ 日期：2026-11-24 ｜ 状态：方案评审
> 关联：`docs/musicbox-assessment-and-plan.md`、`CONTRACTS.md`、服务端 `src/server` 现状摸底

---

## 0. 一句话结论

当前后端**只有面向 App 的业务接口（REST + WSS），没有独立的运营管理后端**：所有"运营"动作（改违禁词、调积分定价、开/关功能、灰度）都靠**登服务器改文件 + 重启**完成，APK 也没有任何"服务端下发配置"的通道。本方案补两块短板：

1. **运营后台（Admin Console）**：一个有权限分离的 Web 界面，管内容、管用户、看数据、审举报。
2. **APK 远程配置（Server-Driven Config）**：让运营能**不改代码、不重打包**就调整积分定价、功能开关、灰度、版本策略、公告——实现"对前端 APK 的统一运营管理"。

---

## 1. 现状摸底（结论摘要）

### 1.1 后端技术栈
- `src/server`：纯 Node.js（7900 端口），**手写路由**（无框架），SQLite（`node:sqlite`），`src/executor` 执行器做实际生成。
- 全部配置集中在 `config.js`，靠 `MB_*` 环境变量覆盖，**运行时无可改入口**。

### 1.2 已注册接口（全部面向 App 用户 / 执行器，无后台）

| 模块 | 接口 | 面向对象 |
|---|---|---|
| auth | guest / phone OTP / refresh / me | 用户 |
| works | generate / list / detail / adopt / patch / extend / cover / variation / adjust / dsp / report | 用户 |
| intent | voice / image / answer / generate | 用户 |
| personas | list / create / fromWork | 用户 |
| credits | getCredits | 用户 |
| executor | register / poll / progress / complete / fail / heartbeat | 执行器↔服务端 |
| mv | 完整 MV 链路 | 用户 |

**`/admin`、`/ops`、`/content` 类路由：零。Web 后台前端：零。**

### 1.3 仅有的两处"运营"触点
1. **审核词库** `var/config/moderation_words.txt` —— 静态文件，需登服务器手工改。
2. **`config.js` + 环境变量** —— 积分定价、生成参数、灰度开关（`MB_MV_ENABLED`、夜间档等）、`DEV_OTP`，均需改代码/重启。

### 1.4 APK 侧现状
- 服务器地址硬编码默认值 + 用户可在"我的"页自行修改。
- 启动时仅调 `/v1/me`、`/v1/credits`，**无应用级配置端点**。
- 无远程配置、无灰度、无版本策略、无公告通道 → **改任何运营参数都要重新打包发版**。

### 1.5 可复用的家底（建后台门槛低）
数据全在单机 SQLite，且已就绪：`audit`（全量操作日志）、`reports`（举报）、`credit_ledger`（账本）、`users`、`works`、`personas`、`mv_projects`。`server` 路由手写，加 `/admin/*` 接口成本很低。

---

## 2. 目标与非目标

### 2.1 目标
- 提供**有权限分离的运营后台**，覆盖内容审核、用户运营、积分经济、运营数据、审计消费。
- 提供 **APK 远程配置能力**，使运营能即时调整积分定价、功能开关、灰度、版本策略、公告，**无需重打包**。
- 完全复用现有 Node server + SQLite + Nginx 部署，**不引入新框架/新服务**，适配 DGX Spark 有限算力。

### 2.2 非目标（本期不做）
- 不改造用户端 App 的业务逻辑（生成/播放/MV 流程不动）。
- 不做复杂 RBAC/多租户（单人/小团队运营，角色够用即可）。
- 不做实时大屏/复杂 BI（先给核心指标看板，够用为先）。
- 不引入 Postgres（单机口径仍够用，演进线保留但本期不动）。

---

## 3. 总体架构

### 3.1 运营后台架构（复用现有 server）

```
┌───────────────────────────────────────────────────────────┐
│  运营/运维（浏览器）                                          │
│   Admin Console（单文件 vanilla SPA，无构建，/admin/*）       │
└───────────────┬───────────────────────────────────────────┘
                │ HTTPS（独立管理员凭证 / 可选 2FA）
                ▼
┌───────────────────────────────────────────────────────────┐
│  MusicBox Server（Node，7900，复用 store/auth/engine）        │
│                                                           │
│  ── 用户面路由（不变）──  /v1/auth /v1/works /v1/intent ...  │
│  ── 运营后台路由（新增）── /admin/*                         │
│     ├─ /admin/auth        管理员登录/会话                    │
│     ├─ /admin/moderation  词库 + 审核队列                    │
│     ├─ /admin/users       用户列表/详情/封禁/调额             │
│     ├─ /admin/credits     账本查询 + 定价 + 调额/退款         │
│     ├─ /admin/config      APK 远程配置 / 功能开关 / 灰度      │
│     ├─ /admin/versions    版本策略 / 公告                    │
│     ├─ /admin/metrics     运营看板                          │
│     └─ /admin/audit       审计日志查看                       │
│                                                           │
│  新增表：admins / app_config / feature_flags / ops_events   │
└───────────────────────────────────────────────────────────┘
```

### 3.2 APK 远程配置闭环（"统一运营管理 APK"的核心）

```
  运营在 Admin Console 改配置（定价/开关/灰度/版本/公告）
            │  写入 app_config + feature_flags（即时生效，免重启）
            ▼
  APK 启动 & 每次 /v1/me 时拉取 GET /v1/app/config（带版本号）
            │  本地缓存 + 与服务端 version 比对
            ▼
  按配置执行：积分定价 / 功能开关 / 灰度放量 / 强制或引导更新 / 公告
```

关键：**配置即代码的反面——配置即数据**。运营改的是数据库里的配置行，服务端读库下发，APK 拉取即生效，全程不碰代码、不重启。

---

## 4. 模块设计

### 4.1 内容审核（Moderation + Review）
**目标**：把"登服务器改词库 + 举报没人看"变成可视化运营。

- **词库管理**：在线编辑审核词库（等价于现 `moderation_words.txt` 格式，一行一词，支持 `re:` 正则行），保存即生效、留审计。
- **审核队列**：聚合 `reports`（举报）+ 可选的内容命中词记录，按类型（works/personas/mv）分 tab，支持通过/下架/驳回/批量操作。
- **接口**：`GET/POST /admin/moderation/words`、`GET /admin/moderation/reports?status=&kind=`、`POST /admin/moderation/reports/:id/decide`。
- **前端**：词库编辑器 + 举报处理列表。

### 4.2 用户运营（User Ops）
**目标**：运营能看人、管人、处理异常。

- 用户列表/搜索（id/手机号/昵称）、详情（注册时间、积分余额/流水摘要、作品数、MV 数）。
- 处置：封禁/解封（改 `users.status`）、人工调积分/退款（走复式账本，留痕）。
- 查看某用户作品/人格/MV（只读，跳转详情）。
- **接口**：`GET /admin/users`（分页/搜索）、`GET /admin/users/:id`、`POST /admin/users/:id/status`、`POST /admin/credits/adjust`（调额，带原因）。

### 4.3 积分经济（Credits Economy）
**目标**：账本可查、定价可调、经济健康可看。

- **定价配置化（APK 远程配置的一部分）**：免费额度、各动作积分（`per_candidate/adjust/extend/cover/dsp`、MV 各步）全部进 `app_config`，运营后台可改，**APK 即时生效，免重启**。
- **账本查询**：`credit_ledger` 分页/按用户/按 reason 检索，支持导出。
- **经济健康**：当日/近 7 日积分发放量、消耗量、净余额分布、异常账号（大额波动）。
- **接口**：复用 4.2 的 `adjust`；`GET /admin/credits/ledger`、`GET /admin/credits/summary`。

### 4.4 APK 远程配置 / 灰度（Server-Driven Config）—— 本期重点
**目标**：实现"对 APK 的统一运营管理"。

下发端点 `GET /v1/app/config`（**无需登录**，按设备/灰度身份返回，返回体带 `config_version`）：

```jsonc
{
  "config_version": 17,                 // 运营每次改配置 +1，APK 据此判断是否刷新
  "credits": {                          // 定价：改这里 = 改 config.js，但即时生效
    "daily_free": 50, "per_candidate": 15, "adjust": 10, ...
  },
  "features": {                         // 功能开关（灰度见下）
    "mv": { "enabled": true, "grayscale": 0.2 },
    "dsp": true, "persona": true
  },
  "version_policy": {                   // 版本策略
    "min_supported": "0.9.2",           // 低于此版本提示/禁止使用
    "recommended": "1.0.0",             // 建议升级到的版本
    "update_mode": "recommended",       // required(强制) / recommended(引导) / none
    "download_url": "https://...",      // 新版 APK 下载地址（如 required）
    "check_interval_sec": 3600
  },
  "routing": {                          // 模型节点与默认走向（§4.7，本期新增）
    "music": { "default": "ace-step-1.5", "locked": true },
    "image": { "default": "flux-fast",    "locked": false },
    "video": { "default": "echo-latest",  "locked": false },
    "mv":    { "default": "comfy-stable", "locked": false },
    "llm":   { "default": "qwen38-fp4",    "locked": false }
  },
  "announcement": {                     // 运营公告/Banner
    "visible": true, "text": "...", "style": "notice"
  },
  "moderation": { "enabled": true }     // 审核总开关（热开关）
}
```

**APK 侧模型选择逻辑**（默认后台指定、APK 可自选但回退后台默认）：
1. 若 APK 本地有用户/设备已设置的模型偏好，且后端未 `locked` → 用 APK 的（后端可在 `/admin/config/routing` 校验/拒绝不兼容项）；
2. 否则 → 用 `routing` 里后台 `default`；若该项 `locked:true`，APK 不可覆盖。
即：**未设置则后端指定，APK 可自行选择但受后端约束与回退。**

**灰度策略**：`feature_flags` 表支持按 `user_id`/设备 hash 百分比放量（如 MV 灰度 0.2），运营后台可动态调百分比，APK 拉取即生效。这比现在 `MB_MV_ENABLED` 环境变量全量开关更精细。

**版本策略**：APK 启动/周期性地 `/v1/app/config` 比对 `config_version` 与 `version_policy`：
- `min_supported` 不达标 → 弹"版本过低，请升级"（`required` 时禁用核心功能）。
- `recommended` 有新版 → 弹"发现新版本"引导至 `download_url`（`recommended` 时仅引导）。

**接口**：
- 下发：`GET /v1/app/config`（无鉴权，返回当前生效配置 + config_version）。
- 管理（Admin）：`GET/POST /admin/config/app`（整块编辑）、`GET/POST /admin/config/features`（开关/灰度）、`GET/POST /admin/config/versions`（版本策略）、`GET/POST /admin/config/announcement`。
- 历史：配置变更留 `ops_events`，可回滚到任一 `config_version`。

### 4.5 运营看板（Metrics Dashboard）
**目标**：核心指标可视化，先给"够用"的。

- 留存：DAU/MAU、新增用户、绑定手机率。
- 生产：生成量、成功率/失败率、各动作分布、平均耗时。
- 经济：积分发放/消耗、净余额、Top 消费动作。
- 系统：在线执行器数与心跳健康、队列深度、存储占用、错误 Top 码。
- **接口**：`GET /admin/metrics/overview?range=7d` 等（聚合查询 `users`/`jobs`/`credit_ledger`/`audit`，结果缓存缩短响应）。

### 4.6 审计消费（Audit Viewer）
**目标**：把现成但无人读的 `audit` 表变成可运营的工具。

- 按 `kind`/时间/操作人筛选，查看完整操作记录（含 obj JSON）。
- 关键处置（封禁/调积分/下架/改配置）本身也写 audit，形成闭环可追溯。
- **接口**：`GET /admin/audit?kind=&from=&to=`。

### 4.7 模型节点与默认路由管理（Model Node & Default Routing）—— 本期重点补充
**目标**：运营能在后台管理底层生成模型节点（音乐/图像/视频/MV/LLM/ASR）的可用性、优先级与故障转移，并**决定前端 APK 的默认走向**——APK 未自行设置模型时默认使用后台指定的模型与端点；APK 也可自行选择，但回退到后台默认（受 `locked` 约束）。

**现状模型节点（`config.js` 硬编码 + 执行器 lane 路由）**：
| 类型 | 节点 | 现状接入 |
|---|---|---|
| 音乐生成 | ACE-Step 1.5 | `musicUrl :8190`，executor 经 lane 调用 |
| 多模态 LLM/VLM | qwen38-fp4 | `llmVlmUrl :8193`，OpenAI 兼容 |
| 语音识别 ASR | SenseVoice | `senseVoiceUrl :8191` |
| MV 管线 | ComfyUI + facegate/lipsync/asr | `comfyBaseUrl :8188` + 独立 service |
| 执行器 | 按 lane 注册 | `executors` 表，engine 按 lane 派单 |

**后台管理功能**：
1. **节点注册表**：每个节点的 `kind`/`engine`/`endpoint`/`priority`（越小越优先）/`weight`（负载均衡）/`enabled`/`status`（healthy/unhealthy/unknown，按心跳刷新）/`last_seen`。
2. **默认走向**：每个生成类型（`music/image/video/mv/llm/asr`）指定默认节点 + `locked`（锁定后 APK 不可覆盖）。
3. **健康探测 + 故障转移**：后台可手动探测/自动按心跳标记 unhealthy；派单时按 priority→weight 选可用节点，unhealthy 自动降级。
4. **执行器 lane 映射可见**：`executors` 表的 lane/version/last_seen 可视化，便于确认哪个 executor 承接哪类模型。

**与现有路由的关系**：APK 按 `routing.default`（或 APK 自选且未 lock）发起生成 → engine 按 lane 路由到对应 executor → executor 调后台默认节点。`routing` 是"APK 该用哪个模型"的声明层，executor lane 是"服务端谁来做"的执行层，二者通过 `config_version` 与 lane 配置打通。

**接口**：
- 下发：`GET /v1/app/config`（含 `routing`，见 §3.2）。
- 管理（Admin）：`GET/POST /admin/config/routing`（默认走向 + locked）、`GET/POST /admin/model-nodes`（节点增删改查/启用禁用）、`POST /admin/model-nodes/:id/probe`（手动探测）、`GET /admin/model-nodes/health`（健康快照）。
- 变更留 `ops_events`，可回滚。

**APK 逻辑**（与 §3.2 一致）：本地有模型偏好且未 lock → 用 APK 的（可被后端校验拒绝）；否则用 `routing.default`；被 lock 则强制后台默认。

**已落地（2026-11-24 实现，端到端验证通过）**：
- 迁移：`model_nodes` / `model_defaults`（v5）、`admins`（v6）、`admins.token`（v7）。
- `core/modelnodes.js`：空表**确定性种子**（`mn_<kind>`，重启不重复；节点全部后台可配，不写死）；解析**优先默认节点、故障/禁用按 priority+weight 降级**；`pickNodeForJob` 实现"APK 自选 / 未设置回退后端 / 锁定强制默认"。
- 运营后台路由（需管理员登录）：`POST /admin/login`、`GET/POST/PATCH/DELETE /admin/model-nodes*`、`GET/POST /admin/config/routing`（默认+锁定）、`GET /admin/model-nodes/health`、`POST /admin/model-nodes/:id/probe`。
- `GET /v1/app/config`（无鉴权）：下发 `credits/routing/model_options/version_policy/announcement`，`config_version` 内容寻址。
- 执行器：`/executor/register` 返回 `nodes` 并**每 30s 热刷新**覆盖 cfg；music lane 支持 per-job `payload.music_endpoint/music_engine` 覆盖。
- APK：启动拉取远程配置；"我的 → 创作模型"可选择（后台锁定时禁用）；三个创作 shell 的 generate 携带 `model`。
- 服务端 `prompts/intent.js` 的 LLM 端点改走运行时节点解析（不再直读 config 硬编码）。

---

## 5. 数据模型（新增表，沿用 SQLite，不改动现有表）

```sql
-- 管理员（独立于用户体系）
CREATE TABLE IF NOT EXISTS admins(
  id TEXT PRIMARY KEY, username TEXT UNIQUE,
  password_hash TEXT, status TEXT DEFAULT 'active',
  last_seen TEXT, created_at TEXT);
-- 可选：admin_otp（2FA/短信验证码登录）

-- APK 远程配置（键值 + 版本，运营改配置即写入此处）
CREATE TABLE IF NOT EXISTS app_config(
  version INTEGER PRIMARY KEY,           -- 单调递增，config_version
  blob TEXT NOT NULL,                    -- 整份配置 JSON（credits/features/version/announcement/...）
  changed_by TEXT, reason TEXT,
  created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_app_config_ver ON app_config(version);

-- 功能开关 / 灰度
CREATE TABLE IF NOT EXISTS feature_flags(
  key TEXT PRIMARY KEY, enabled INT DEFAULT 0,
  grayscale REAL DEFAULT 0,               -- 0..1 放量比例
  target TEXT,                            -- 可选：灰度规则（如 "new_users"）
  updated_at TEXT);

-- 运营事件（配置变更可回滚、处置留痕）
CREATE TABLE IF NOT EXISTS ops_events(
  id TEXT PRIMARY KEY, kind TEXT, actor TEXT,
  target TEXT, before TEXT, after TEXT,
  created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_ops_events_kind ON ops_events(kind, created_at);

-- 模型节点（音乐/图像/视频/MV/LLM/ASR 生成端点）
CREATE TABLE IF NOT EXISTS model_nodes(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- music|image|video|mv|llm|asr
  engine TEXT NOT NULL,            -- ace-step-1.5 / qwen38-fp4 / sensevoice / comfy ...
  endpoint TEXT NOT NULL,
  priority INT DEFAULT 100,        -- 越小越优先
  weight REAL DEFAULT 1,           -- 负载均衡权重
  enabled INT DEFAULT 1,
  status TEXT DEFAULT 'unknown',   -- healthy|unhealthy|unknown（按心跳刷新）
  last_seen TEXT, updated_at TEXT, created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_model_nodes_kind ON model_nodes(kind, enabled);

-- 各生成类型的默认走向（APK 未设置则用此；locked=1 时 APK 不可覆盖）
CREATE TABLE IF NOT EXISTS model_defaults(
  kind TEXT PRIMARY KEY,           -- music|image|video|mv|llm|asr
  node_id TEXT NOT NULL,           -- 默认指向 model_nodes.node_id
  locked INT DEFAULT 0,
  updated_at TEXT, created_at TEXT);
```

> 说明：`model_defaults.node_id` 外键语义上指向 `model_nodes`；派单路由时按 `kind` 取默认节点，unhealthy 则按 `priority` 降级到下一个 `enabled` 节点。

> 设计取舍：`app_config` 用**整份快照**而非散字段，保证下发原子性、支持回滚到任意 `config_version`；`feature_flags` 单独成表便于细粒度灰度。

---

## 6. 分阶段实施

> **2026-11-24 落地进度：M0 / M1 / M2 全部实现并端到端验收通过。**
> 控制台地址：开发 `http://127.0.0.1:7900/admin/`；生产 `https://<域名>/admin/`（Nginx 已加运维 IP 白名单）。
> 登录：`MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD`（默认 admin/admin1234，首启打印告警）。
> 模块：运营看板 / 模型节点 / 运营配置（定价·版本策略·公告·审核开关·历史回滚）/ 功能开关（灰度）/ 内容审核（词库+举报队列）/ 用户运营（详情·封禁·调积分）/ 审计日志。

### M0 —— 运营后台地基 + 内容审核 + 用户运营（APK 零改动）
**交付**：
- `admins` 表 + `/admin/*` 路由 + 单文件 vanilla Admin Console（无构建，`/f/admin/index.html`）。
- 内容审核：词库在线编辑 + 举报队列处置。
- 用户运营：列表/搜索/详情 + 封禁/解封 + 人工调积分。
- 审计查看器。
- **模型节点注册表 + 健康**（`model_nodes`，纯服务端，APK 零改动）：节点增删改查、启用禁用、心跳健康、手动探测。
**验收**：运营用管理员账号登录，能改词库、审举报、封禁用户、看审计、管理模型节点，全程不登服务器。

### M1 —— 积分定价配置化 + APK 远程配置 + 灰度（需一次 App 更新）
**交付**：
- `app_config` + `feature_flags` + `ops_events` 表。
- 下发 `GET /v1/app/config`；管理端 `GET/POST /admin/config/*`。
- App 启动/`/v1/me` 时拉取配置并应用（定价、功能开关、公告）。
- 灰度放量（按 user hash 百分比）。
**验收**：运营在后台改免费额度/开关，**不重启、不重打包**，线上 APK 下次拉取即生效。

### M2 —— 版本策略 + 公告 + 运营看板
**交付**：
- `version_policy`（min/recommended/update_mode/download_url）+ App 更新检查/引导。
- 公告/Banner 下发。
- 运营看板（留存/生产/经济/系统四类指标）。
**验收**：运营能设"强制更新版本"并引导下载；能看七日核心指标。

> 建议 **M0 先上**（纯服务端、APK 零改动、最快堵住"举报没人看/改词库要登服务器"的痛点），**M1 再上**（需发版，但是一次性投入，之后所有运营参数都热生效）。

---

## 7. 部署与运维适配

- **复用现有部署**：Admin Console 是静态单文件，由现有 Nginx/`/f/*` 提供；`/admin/*` 路由复用现有 server，无需新进程。Spark/VPS 的 systemd 服务无需变更（仅代码/配置增量）。
- **安全**：
  - 管理员独立凭证（`admins` 表，密码 hash），**与用户 token 体系隔离**，建议强制 HTTPS + 可选 2FA/OTP。
  - `/admin/*` 加独立中间件（`requireAdmin`），失败 403，且**所有写操作写 audit + ops_events**。
  - 配置下发 `/v1/app/config` 走限流（复用现 `U.allowRate`），防刷。
- **性能**：看板聚合查询加短缓存（如 30–60s），避免大表全扫；`app_config` 下发走内存缓存 + 版本号，APK 拉取 O(1)。

---

## 8. 风险与注意事项

| 风险 | 应对 |
|---|---|
| 单机 SQLite 并发 | 运营后台写频率低，影响小；看板走缓存 |
| 配置下发被刷 | `/v1/app/config` 限流 + 本地缓存 + config_version 增量 |
| 改配置即全局生效 | `app_config` 快照 + `ops_events` 可回滚到任意 version |
| App 不更新拉不到新配置 | 配置本地缓存 + 周期性拉取 + 启动必拉 |
| 管理员凭证泄露 | HTTPS + 独立体系 + 可选 2FA + 全量审计 |
| 单文件 Admin Console 体验有限 | M0 先够用，后续可拆分为完整 SPA |

---

## 9. 待决策点

1. **Admin Console 形态**：M0 用无构建的**单文件 vanilla SPA**（最快、零依赖），还是直接上一个轻量框架？（推荐前者）
2. **管理员登录方式**：用户名密码，还是也要支持手机 OTP / 2FA？（推荐用户名密码 + 可选 2FA）
3. **APK 更新分发**：新版 APK 托管在哪（现有 Nginx 是否可挂下载）？`download_url` 由运营后台维护是否可行？
4. **灰度粒度**：MV 等灰度按 user hash 百分比是否够用，还是需要按更细标签分桶？
5. **看板时间范围与刷新率**：先给"近 7 日 + 实时刷新 60s"是否够用？

---

## 10. 已落地清单（2026-11-24，全部验收通过）

**控制台**：`GET /admin/`（服务端直出单文件 vanilla SPA，禁缓存）
模块：运营看板（用户/DAU·MAU/作品/任务成功率/积分经济/MV/举报/执行器/队列/存储，30s 缓存）· 模型节点 · 运营配置（定价·版本策略·公告·审核开关·历史回滚）· 功能开关（灰度按用户哈希分桶）· 内容审核（词库热编辑 + 举报队列下架/恢复/忽略）· 用户运营（搜索·详情·封禁踢线·人工调积分）· 审计日志 + 配置事件。

**服务端接口**（`/admin/*` 均需管理员 Bearer）：
- 鉴权：`POST /admin/login`
- 审核：`GET|POST /admin/moderation/words`、`GET /admin/moderation/reports`、`POST /admin/moderation/reports/:id/decide`
- 用户/积分：`GET /admin/users`、`GET /admin/users/:id`、`POST /admin/users/:id/status`、`POST /admin/credits/adjust`、`GET /admin/credits/ledger`
- 配置：`GET|POST /admin/config/app`、`GET /admin/config/history`、`POST /admin/config/rollback`、`GET|POST /admin/config/features`、`GET /admin/config/events`
- 模型节点：`GET|POST /admin/model-nodes`、`PATCH|DELETE /admin/model-nodes/:id`、`POST /admin/model-nodes/:id/probe`、`GET /admin/model-nodes/health`、`GET|POST /admin/config/routing`
- 看板/审计：`GET /admin/metrics/overview?range=`、`GET /admin/audit`

**APK 下发**：`GET /v1/app/config`（限流）→ `config_version / credits / routing / model_options / features(已按用户灰度判定) / version_policy / announcement / moderation`

**热生效范围（免重启免发版）**：积分定价（含 MV 定价）、审核词库与审核开关、功能开关与灰度（含 MV 总开关）、模型节点与默认走向/锁定、版本策略、公告。

**新增表**：`admins(+token)`、`model_nodes`、`model_defaults`、`app_config`、`feature_flags`、`ops_events`（迁移 v5–v8，全部 `IF NOT EXISTS`/幂等，旧库自动升级）。

**APK 侧行为**：启动拉取远程配置；强制升级门禁（required 且版本 < min_supported → 全屏阻断 + 下载地址）；引导升级（recommended 一次性弹窗）；公告 Banner（notice/warn/maint）；MV 未开放空态；"我的 → 创作模型"自选（锁定禁用）。

**验收记录**：词库写入即拦截、审核关即放行、举报下架/恢复、封禁即踢线、调积分入账、开关开→`/v1/mvs` 可达且 APK 可见、关→404 门控、版本策略下发、历史回滚、看板聚合、执行器节点热刷新——均通过；`flutter analyze` 无 error。

### 10.1 模型节点真实化（2026-11-24 二次修订）

首版播种只给了 `kind` 同名占位（`lipsync/facegate/mv_asr`），运营后台看不出"这是哪个真服务"，且健康判定用 `GET /` 把实际在线的 ACE-Step（:8190 根路径 404）误判为故障。现已按部署档案真实化（迁移 v9）：

| kind | 节点名称 | engine | 端点来源 | 真实身份 |
|---|---|---|---|---|
| music | 音乐生成 · ACE-Step 1.5 | `ace-step-1.5` | `MB_MUSIC_URL` | Spark 本机独显 5060 Ti :8190 |
| asr | 语音识别 · SenseVoice | `sensevoice` | `MB_ASR_URL` | 一期既有服务 :8191 |
| llm | LLM/VLM · 剧场托管 vLLM | `MB_LLM_VLM_MODEL` | `MB_LLM_VLM_URL` | OpenAI 兼容 `/v1`，模型名以 `/models` 为准 |
| comfy | 图像/视频 · 剧场 ComfyUI | `comfyui` | `MB_COMFY_URL` | 共宿主队列 :8188，逃生口 :8288（ADR-MV-4） |
| lipsync | 口型重绘 · EchoMimicV3-Flash | `echomimicv3-flash` | `MB_LIPSYNC_URL` | 自有 worker，懒加载 + 空闲 10min 释放 :8390 |
| facegate | 身份门禁 · ArcFace | `arcface-insightface` | `MB_FACEGATE_URL` | insightface onnx，CPU 常驻 :8395 |
| mv_asr | MV 时间戳对齐 · SenseVoice | `sensevoice-ts` | `MB_MV_ASR_URL` | funasr 独立进程，与 :8191 零改动并存 :8391 |

- **新增字段**：`label`（运营可读名）、`note`（宿主/进程/端口纪律）、`source`（`seed` 部署播种 / `manual` 后台新增）、`last_probe_at`、`last_probe_msg`。
- **播种幂等**：按确定性 id `mn_<kind>` 刷新档案，但保留运营改过的端点/优先级/权重/启停；真机启动时按 `/etc/musicbox/spark.env` 播种真值（LLM 自动为剧场 `:8090/v1`，非开发默认 `:8193`）。
- **健康三态**：按候选路径 `[/health, /healthz, /models, /]` 依次探测——`healthy`（某路径 2xx/3xx，显示命中路径）/ `degraded`（端口可应答 HTTP 但无健康路由，不再误报故障）/ `unreachable`（拒连、超时、非法地址，显示错误码）。
- **后台**：节点表显示名称+说明+来源+探测原因与时间；新增「全部探测」（`POST /admin/model-nodes/probe-all`）一次扫全拓扑。本机实测：ACE-Step `HTTP 200 /health` 可用、ComfyUI `HTTP 200 /models` 可用，其余 5 个 `ECONNREFUSED`（本机未起，判读正确）。

### 10.2 控制台登录加固与自检（2026-11-24）

事故：控制台为单文件 SPA，脚本驻留在已打开的标签页内存中。修复 `boot()` 缺 `show(true)` 后，**旧标签页仍执行旧脚本**，表现为"点登录没反应、刷新就进去了"（token 其实已写入 localStorage）。

整改（不再依赖"记得重开标签页"）：
- `PAGE_BUILD` 构建号 + 前台可见/获焦时比对服务端构建号，不一致自动重载 → 根治陈旧脚本驻留；
- 登录成功后 400ms 校验容器可见性，仍隐藏则 `location.reload()` 走冷启动路径 → 任何渲染异常都能自愈进入；
- 登录按钮 `LOGIN_BUSY` 互斥 + 置灰"登录中…" → 杜绝连点重复提交且永远有视觉反馈；
- 响应头 `no-store`；`window.onerror` / `unhandledrejection` 顶部红条可视化，无需 F12。

回归自检：`node src/server/admin/selftest.js`（零依赖 DOM 垫片真实执行页面脚本，7 项，含"人为删掉 `show(true)` 复现事故 → 必须自愈"用例）。
