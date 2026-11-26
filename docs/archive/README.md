# docs/archive/ —— 归档计划（**仅计划，本目录当前只有本 README，未移动任何文件**）

| 字段 | 值 |
|---|---|
| Status | `DRAFT-FOR-REVIEW` |
| Date | 2026-11-26 |
| Owner | lead |
| 前置 | `docs/CONTRACTS.next.md` 被审通过并替换 `CONTRACTS.md` |
| 触发 | lead 说"开始归档" |
| 本目录预期终态 | `contract-v1-v5.md`、`README.md`（本文件）、`spark-evidence/`、若干带 `SUPERSEDED-BY` 头的历史文档 |

> **本文件不做任何移动**。所有 `git mv` 必须等 lead 批准并确认前置满足后执行。
> 一句话原则：**先补契约，再归档**。契约没收敛完就归档，等于同时存在两份"生效契约"——施工方会照旧文里已被证伪的条款施工（最典型：v2.3/v2.6 的 ladder 降档承诺，代码里 7 个 `ladder()` 全是恒等函数）。

---

## 1. 待归档清单

### 1.1 契约本体（最高优先，唯一真源）

| 现路径 | 目标 | 头部标记 | 说明 |
|---|---|---|---|
| `CONTRACTS.md` | `docs/archive/contract-v1-v5.md` | `SUPERSEDED-BY: docs/CONTRACTS.next.md` + `Status: ARCHIVED 2026-11-26` | 归档时**必须同时**完成 `docs/CONTRACTS.next.md` §9.4 的重编号落地（`v2.23`、`v3.3`、补章 `v2.12`、`v3.0 = RESERVED`），使 **43 个真实版本号**（会话开始 22:34 快照实测：859 行 / 91,865 B；47 个含版本号的标题 → 去掉两个结构性标题 token `# v2 · MV 契约增量`、`### v4 工具与确认边界` → 45 个唯一 token → 计重后 **43 个 vX.Y(.Z) 版本号**）各成一个唯一锚点。⚠ 与 brief 的「46 块 / 44 去重」不一致，且 `CONTRACTS.md` 在 23:35 已被并发修改（现 93,129 B）—— 归档前以当时 HEAD 重测 |

### 1.2 `docs/*.md`

图例：**归档** = 整篇移入 `docs/archive/`；**保留** = 留在 `docs/`（现行有效，只加状态头）；**拆分后归档** = 先把仍有效的唯一真源内容迁出，再归档。

| 文件 | 处置 | 头部 `SUPERSEDED-BY` | 归档前必须先做的事（否则=丢信息） |
|---|---|---|---|
| `docs/musicbox-assessment-and-plan.md` | **归档** | `docs/CONTRACTS.next.md` | 摘出仍在引用的"未做项"清单进 `docs/runbook-dev.md` 或施工计划，避免评估结论随归档失联 |
| `docs/musicbox-construction-plan.md` | **归档** | `docs/CONTRACTS.next.md` | ⚠ 一期"真机遗留"清单（§3/§6.3）是 `CONTRACTS` 与 runbook 的引用目标 —— 必须先整体迁到 `docs/runbook-dev.md`「上线前必做」 |
| `docs/musicbox-phase2-construction-plan.md` | **归档** | `docs/musicbox-phase2-architecture-design.md` + `docs/CONTRACTS.next.md` | ⚠ 同上：二期真机遗留、灰度批次表先迁出 |
| `docs/musicbox-phase2-mv-plan.md` | **拆分后归档** | `docs/CONTRACTS.next.md` | ①§6 定价表 → 已判为与契约漂移（`align` 0/5 之争已 `RESOLVED(align=5)`），归档前在该节标 `SUPERSEDED`，禁止再被当报价依据；②§1.4 模型许可（`mvModelLicense`）是**法务待核**内容，先迁到独立 `docs/license-review.md`（新文件，非归档）；③V13–V22 验收断言面先落到 `test/acceptance/*` 的注释引用（改为引 `routes.json` id，不引裸版本号） |
| `docs/musicbox-unified-assistant-plan.md` | **归档** | `docs/CONTRACTS.next.md` §6 | 其 10 工具旧表已被 §6.2 的 19 行总表取代；归档前确认 §6.2 覆盖全部 19 项（已覆盖），并把"阶段一/二/三"路线图摘到 issue/待办，别让它随归档消失 |
| `docs/musicbox-operations-management-plan.md` | **拆分后归档** | `docs/runbook-dev.md` | ⚠ 历史上含默认管理员明文凭据（曾专门提交移除过）；**归档前必须再扫一遍凭据/内网地址**（见 §3 闸门）。可观测口径、备份/巡检流程若仍有效 → 迁 `docs/runbook-dev.md` |
| `docs/musicbox-architecture-design.md` | **保留（加状态头）** | — | 仍是拓扑/组件真源；但头部必须写明："端口/端点/模型名以 `docs/CONTRACTS.next.md` §0.2 实测真值为准；本文历史端口叙述作废" |
| `docs/musicbox-phase2-architecture-design.md` | **保留（加状态头）** | — | lane/executor/报价仍是真源；头部写明"lane 与 ladder 以 `CONTRACTS.next` §5.1/§5.2 为准，本文旧降档叙述 `SUPERSEDED`" |
| `docs/musicbox-mv-face-preservation-plan.md` | **保留（加状态头）** | — | 定脸方案（方案一 I2V 首帧）结论已进契约 §5.3；本文留作实验依据（SP6 实测）。⚠ 当前权限 `0600` 且含实机细节 → 先清洗再决定是否放宽权限 |
| `docs/musicbox-rescue-refactor-plan.md` | **不归档（活跃文档）** | — | ⚠ 正在被并发编辑（本轮核对时 mtime 仍在变动）；仅加"凭据复扫 + 0600 权限复核"两项待办 |
| `docs/runbook-dev.md` | **保留（新建不久）** | — | 运行手册是归档动作的**接收方**：所有"真机遗留/上线前必做"都迁到这里；不要归档 |

> 目录新建：`docs/archive/spark-evidence/`（承接 §1.3）。

### 1.3 `deploy/spark/` 真机证据（`realdevice-*` 与 `fullload-*`）

这些是**某一轮验收的快照**，不是契约。规则：**每类只留最新一轮在原地**，其余进 `docs/archive/spark-evidence/`，头部标 `SUPERSEDED-BY: <保留的那一份>` + `Status: EVIDENCE-ARCHIVED (<轮次日期>)`。

| 组 | 原地保留（最新） | 建议归档 | 备注 |
|---|---|---|---|
| 真机测试计划 | `deploy/spark/realdevice-test-plan-c1c2c3-1126.md` | `realdevice-test-plan-1125r2.md`、`realdevice-test-plan-1126r1.md` | ⚠ `1125r2` 经扫描含凭据/内网信息，**清洗前不得移动**（移动会把它带进更常被浏览的目录） |
| 真机验证报告 | `deploy/spark/realdevice-verify-c1c2c3-1126v2.md` | `realdevice-verify-c1c2c3-1126.md` | ⚠ 两者 mtime 在本轮仍在变动（有 agent 在写）→ 等落笔再归档 |
| 设备分报告 | `deploy/spark/realdevice-verify-c1c2c3-device1-1125.md`（若还有 device2/3 则同组一起看） | 被后续轮次取代者 | 同上，先确认没有 agent 在写 |
| 满载证据 | `deploy/spark/fullload-evidence.md` | `fullload-evidence-1125r2.md`、`fullload-test-plan.md`（计划类可留） | `fullload-evidence-1125r2.md` 权限 `0600`，同样先清洗 |
| 基线/README | `deploy/spark/baseline.md`、`deploy/spark/README.md` | 不归档 | `README.md` 是 LLM 端点内网实值的登记处，属现行运行手册性质 → 与 `docs/runbook-dev.md` 去重，避免两处端口真值（契约 §0.2 R-04 同源问题） |

**不建议归档**：`deploy/spark/*.service`、`deploy/spark/bin/`、`deploy/spark/services/`、`deploy/spark/spark.env.example`、`deploy/vps/` —— 都是可执行部署物，归档=移出部署路径。

---

## 2. 归档顺序（严格串行，每步一个 commit，可 `git mv` 回退）

```
Phase 0  冻结与体检（不移动文件）
  0.1  确认无 agent 正在写 §1 清单内文件（mtime/未提交改动）——本轮已发现多个文件在并发修改
  0.2  跑 scripts/verify.sh + scripts/verify_routes.mjs，取基线
  0.3  跑 §3 凭据扫描闸门，产出"待清洗清单"（含权限 0600 的清单）

Phase 1  契约收敛（硬前置，未完成不得进入 Phase 2）
  1.1  lead 审 docs/CONTRACTS.next.md → 裁决 §8 待裁决项（R-04 / R-06 / R-14 / R-15 / R-18）
  1.2  CONTRACTS.next 替换 CONTRACTS.md；CONTRACTS.md 旧文 → docs/archive/contract-v1-v5.md
  1.3  执行 CONTRACTS.next §9.4 的重编号落地（v2.23 / v3.3 / 补章 v2.12 / v3.0 RESERVED）
  1.4  验证：归档文件内 43 个版本号各一次、无重复、无缺号未登记（v2.12 有章 / v2.23 与 v3.3 立号 / v3.0 RESERVED）

Phase 2  真源迁出（防"归档即丢失"）
  2.1  一期/二期"真机遗留"与"上线前必做" → docs/runbook-dev.md
  2.2  模型许可（mvModelLicense / 许可归因）→ docs/license-review.md，挂法务待办
  2.3  V13–V22 验收断言面：test/acceptance 注释里的"契约 vX.Y" → 改引 docs/CONTRACTS.next.md §n 或 contract/routes.json 的 C-API-* id
  2.4  仍在用的定价/报价口径确认只从 config.js + app_config 取（禁止再从 plan 文档抄）

Phase 3  清洗（先清洗后移动，顺序不可反）
  3.1  移除待归档文件内的明文凭据/令牌/口令/验证码/内网地址与内网账号 → 改环境变量名（"值不入文"）
  3.2  移除 .js:行号 形式引用（CONTRACTS 侧已清零；其余文档同样清）
  3.3  0600 文件逐个定性：确属敏感 → 留原地（deploy/）或迁 runbook 加密段，不进 docs/archive/；
       不属敏感 → 修正权限为 0644 后随归档放宽可读性

Phase 4  移动（git mv，一次一类，各自 commit）
  4.1  docs/musicbox-assessment-and-plan.md、musicbox-construction-plan.md、
       musicbox-phase2-construction-plan.md、musicbox-unified-assistant-plan.md
  4.2  docs/musicbox-phase2-mv-plan.md、musicbox-operations-management-plan.md
  4.3  mkdir docs/archive/spark-evidence/ → 移 §1.3 表右列文件
  4.4  给每个被移动文件加统一头部（见 §4 模板）

Phase 5  断链修复与收尾
  5.1  全库搜索 docs/<被移文件> 引用（README.md、CONTRIBUTING.md、SECURITY.md、docs/*、src/**、test/**、deploy/**）→ 改指归档路径或新目标
  5.2  重跑 scripts/verify.sh；重跑 §3 扫描（应零命中）
  5.3  在 docs/README 索引（若无则建）列"现行文档 / 归档文档"两栏
```

---

## 3. 归档闸门（机器可检，未过不得移动）

```bash
# A. 凭据与内网信息扫描（命中清单必须为空，或逐条 lead 签字豁免）
grep -rlE "(password|passwd|口令|token|令牌|验证码|secret)[^)]{0,20}[=:][[:space:]]*[A-Za-z0-9._\-]{6,}" docs deploy README.md etc
grep -rlE "\b([0-9]{1,3}\.){3}[0-9]{1,3}\b" docs deploy/spark/*.md | grep -v '127\.0\.0\.1'   # 内网/公网 IP 字面量

# B. 行号级引用（应清零）
grep -rnE "[A-Za-z0-9_/.-]+\.(js|dart|sh|mjs|env):[0-9]+" docs deploy/spark/*.md CONTRACTS.md

# C. 契约双主（归档中途致命）：生效契约必须只有一份
ls docs/CONTRACTS*.md CONTRACTS.md 2>/dev/null

# D. 裸版本号引用（归档后应改为章节/路由 id 引用）
grep -rn "契约 v[0-9]" src test docs deploy --include=* | grep -v docs/archive/

# E. 权限审计（0600 文档不得进 docs/archive/）
find docs deploy -name '*.md' -perm 600
```

---

## 4. 归档头部模板（每个被移动的文件顶部加，勿改正文）

```markdown
> **Status**: ARCHIVED —— 本文不再是接口真源，仅作历史依据。
> **SUPERSEDED-BY**: docs/CONTRACTS.next.md（接口/计费/lane/助手/数据模型的唯一真源）
> **ARCHIVED-AT**: 2026-11-26 ｜ **ARCHIVED-BY**: lead ｜ **REASON**: 契约收敛重写（v1–v5.0 → 生效契约）
> **STILL-AUTHORITATIVE-FOR**: <仅当本文有未被契约覆盖的事实性内容时填写；否则写 "nothing">
> **DO-NOT**: 不得据本文取价格、端口、模型名、lane 降档参数、接口字段。
```

---

## 5. 风险登记（为什么必须"先补契约再归档"）

| # | 风险 | 触发后果 | 缓解 |
|---|---|---|---|
| **A1** | **双契约并存**：契约未替换就把 `CONTRACTS.md` 移走（或反之，归档了旧文却仍有人引用生效副本） | 施工方按旧文施工：最典型是照 v2.3/v2.6 的"steps 8→4 / 30→20"降档写重试逻辑 ⇒ **少交付不退款**，直接违反计费诚信（DEV-LADDER-PAY） | Phase 1 未过不进 Phase 2；归档 commit 与替换 commit 相邻，PR 标题带 `CONTRACT-CUTOVER` |
| **A2** | **归档即丢失**：真机遗留、许可归因、验收断言面只存在于 plan 类文档 | 上线前必做项无人再看见；模型许可失去依据；V13–V22 断言失去可追溯出处 | Phase 2 迁出先于 Phase 4 移动，逐条对表 |
| **A3** | **凭据入库扩散**：待归档文件含口令/令牌/内网地址，`git mv` 后进入更易被浏览、且**历史里删不掉**的目录 | 敏感信息在 `docs/archive/` 长期可读，且 git 历史永久保留 | Phase 3 清洗先于 Phase 4；`0600` 文件默认不归档；历史重写（`filter-repo`）风险高，须 lead 单独决策 |
| **A4** | **断链**：`README.md`、`CONTRIBUTING.md`、代码/测试注释、`docs/*` 互引指向旧路径 | 新人按坏链找不到真源，回头又抄旧价目表 | Phase 5.1 全库搜索改链；CI 加"坏链扫描" |
| **A5** | **并发编辑踩踏**：本轮核对时 `docs/musicbox-rescue-refactor-plan.md`、`etc/spark.env`、`src/server/config.js`、`src/server/api/admin.js`、`core/security.js`、`core/store.js` 均在被并发修改（部分文件 mtime 在核对期间仍在变） | 归档 commit 夹带他人未完工改动；或契约数字（表数/ALTER 数/端口默认值）当场失真 | Phase 0.1 冻结检查；归档 commit 只碰白名单路径；契约数字标"按代码实测"并留复核项 |
| **A6** | **重编号半途而废**：只归档不改号 | `v2.19`/`v3.2` 仍在归档文件里各出现两次、`v2.12` 仍"有号无章"，`test/acceptance` 里的"契约 v2.12"注释继续指向不存在的章节 | Phase 1.3/1.4 为硬闸门，验收标准是"43 个版本号各一次且可跳转" |
| **A7** | **证据归档掉正在产出的轮次**：`realdevice-verify-*` 仍在写 | 丢当轮真机结论，且 C1/C2/C3 验收口径断档 | 只归档"已被取代"的轮次；移动前确认文件已停止修改 |
| **A8** | **权限连带变化**：0600 → 归档后 0644 | 内容比原先更广泛可读 | Phase 3.3 逐个定性；敏感者不归档 |
| **A9** | **`docs/archive/` 变成第二真源** | 有人引归档里的旧 lane 表/旧工具表 | 每个归档文件必带 §4 头部 `DO-NOT`；`docs/` 索引只把 `CONTRACTS.next.md` 标为"接口真源" |

---

## 6. 归档完成的判定（DoD）

1. `docs/` 只剩现行文档：`CONTRACTS.next.md`（或已改名替换 `CONTRACTS.md`）、两份架构设计、定脸方案、runbook、（新建）license-review、本 README。
2. `docs/archive/contract-v1-v5.md` 内 43 个版本号一一对应唯一锚点；`v2.12` 有章、`v2.23`/`v3.3` 已立号、`v3.0` 标 `RESERVED`；`v2.3`/`v2.6` 的 ladder 段标 `SUPERSEDED`。
3. §3 五个扫描全绿（凭据、行号引用、双契约、裸版本号、0600）。
4. 全库无指向已移动文件的坏链；`scripts/verify.sh` 通过。
5. `git log` 里每个归档 commit 只含 `git mv` + 头部注入，可单独 revert。
