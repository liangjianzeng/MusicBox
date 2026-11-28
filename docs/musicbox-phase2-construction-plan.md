# MusicBox · 二期施工计划（MV 创作 · 排程与验收细则）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-phase2-construction-plan.md |
| 日期 | 2026-11-23 |
| 输入 | [musicbox-phase2-mv-plan.md](musicbox-phase2-mv-plan.md)（规划+决策 §11）、[musicbox-phase2-architecture-design.md](musicbox-phase2-architecture-design.md)（架构基线）、一期施工计划（套件模式/env 纪律/skip 纪律照搬） |
| 回答 | 何时做、谁做、怎么验：施工原则 / 环境就绪 / Spike 细则 / 里程碑与关键路径 / WBS（DoD+依赖）/ 验收套件细则 / 施工风险 / 外部事项 / 首日清单 |
| 裁决次序 | 契约 v2 > 架构 > 本计划；实测数据回写覆盖设计常数 |

---

## 1. 六条施工原则

1. **契约先行**：CONTRACTS.md **v2**（素材=架构 §5/§6 + mv-plan §4.4/§5）评审冻结后才并行开工；任何接口改动「改契约→改码→回归 V13–V16」，禁止先码后约。
2. **mock 先行、真机后置**：`EXECUTOR_MOCK=1` 下 mv_* 全 type 产真实可用假产物（架构 §4.3），V13/V16 在 CI（无 Spark）恒绿是每次合入的门槛；质量类断言全部放 V14/V15 真机侧。
3. **Spike 前置**：SP-MV-1（口型横评，全案最大风险）**Day1 启动**，与 N0 穿插跑；每个 Spike 有量化通过线与不达标出口动作（§3），未过关不得进入依赖它的 WBS 项。
4. **验收驱动**：V13–V16 断言清单先登记（红/skip）再施工，套件绿 = 里程碑出口门；skip 必须写明缺失前置（一期纪律），禁止为变绿放宽断言。
5. **资金路径人工过目**：凡触碰积分账本、报价/扣费/退款、确认票签发的代码（`credits.*`、`enqueue` 计费、`mv_budget`、tickets），合入前必须主会话人工过目——一期 DEV-LADDER-PAY 教训的一期纪律延续。
6. **共宿主零改动**：对 `:8188`/`:8090`/ACE-Step/SearXNG 只发请求只读观测；代码层不提供 `/free`；executor 单并发 + ram_free 水位挂起（架构 §1.2）。任何 Spark 侧部署动作前先跑 §2 环境自检。

---

## 2. 环境就绪清单

### 2.1 DGX Spark（Ubuntu 24.04 aarch64 · 施工方 B 负责，需宿主协调项标 E#）

| # | 项 | 检查命令 / 动作 | 通过线 |
|---|---|---|---|
| S1 | Node ≥22 arm64 | `node -v`（无则官方 tarball 装 `/opt/musicbox/node`，**不动系统 node**） | v22.x+ |
| S2 | ffmpeg aarch64 | `ffmpeg -version`（无则静态构建或 `apt install ffmpeg`；验收能力探测同一期：能编 libmp3lame 才算数） | 含 libmp3lame/drawtext/xfade/zoompan |
| S3 | NVMe 容量 | `df -h /opt/musicbox` | 剩余 ≥150G（takes 72h 滚动 + lipsync 权重 ~10–16G + 帧缓存） |
| S4 | uv venv ×3 | `uv venv var/venv-lipsync / venv-facegate / venv-asr`（python 3.11–3.12，**各自独立，勿污染剧场环境**） | 各自 `import torch/insightface/funasr` 成功 |
| S5 | lipsync 权重 | ModelScope / hf-mirror 拉 EchoMimicV3-Flash + SyncNet 权重 → `var/models`（E2） | 离线可加载 |
| S6 | systemd 五单元 | `deploy/spark/*.service` + `/etc/musicbox/spark.env`（架构 §1.3） | `systemctl status` 五单元 active；83xx `ss -ltn` 仅 127.0.0.1 |
| S7 | 端口复核 | `ss -ltn` 对架构 §1.1 避让清单 + 8390/8391/8395 | 无冲突 |
| S8 | 共宿主基线快照 | 记录 `:8188/system_stats`、`:8090/models`、剧场任务常态耗时 | 留档 `deploy/spark/baseline.md`（SP-MV-4 对照用） |
| S9 | tailnet 可达 | 开发机 `curl http://<spark>:7900/healthz`（部署后） | 200 |

### 2.2 开发/CI 机（Windows）

- Node ≥22（验收自举 server）；ffmpeg（PATH / `MB_TEST_FFMPEG` / `test/acceptance/tools/ffmpeg/`，一期三供法不变）。
- Flutter（`C:/src/flutter`）+ Android SDK（真机 K90 无线 adb 已通）。
- CI 命令不变：`node --test --test-concurrency=1 "test/acceptance/*.test.js"`；V13/V16 须无 Spark、无 ffmpeg（fail 方向）也可全绿。

### 2.3 外部依赖排期挂钩

Inkling-2-Mini 上 `:8090`（E4，宿主排期）不阻塞任何 N0/N1 施工——LLM 是增强不是依赖（ADR-MV-9）；它只 gate N2 的助手开闸。

---

## 3. Spike 细则（N0 期间穿插；量化通过线 + 不达标出口）

> 口径与 mv-plan §7 一致；此处补执行细节。全部产物落 `spikes/SP-MV-*/`（施工方 B 归属），结论回写 EVIDENCE 风格记录并更新架构 §8 常数。

| Spike | 内容 | 通过线（量化） | 不达标出口 | 依赖 |
|---|---|---|---|---|
| **SP-MV-1 口型横评**（Day1 起，最高优先） | 同一演唱镜画面（SP-MV-3 产）× 真实歌曲段 → EchoMimicV3-Flash / MuseTalk / LatentSync(仅调测对照) 各跑；产出 `mv-lipsync-svc` FastAPI 原型（`src/workers/mv_lipsync/`） | SyncNet 置信 ≥ 三跑最高者且 ≥0.6；sustained note 大张幅不失真（盲看 3 段）；Spark 单镜 ≤5min；峰值内存 ≤16GB；aarch64 torch 可跑 | 首选降级 MuseTalk；两者皆不过 → 歌唱形态改「侧背远景+字幕」为主叙事（mv-plan FR-607 形态升主线），N2 重排 | S4/S5；与 S4 并行启动 |
| SP-MV-2 对齐精度 | 10 首真曲（一期曲库抽检+外部歌）master → SenseVoice 时间戳 → 规则对齐 vs 人工标注 | 逐句 ±150ms 内 ≥90%；全句漏配 0 | 换 faster-whisper alignment（CPU）重测；再不过→对齐降级「段落级窗」并收紧字幕逐句为整段字幕 | S4 asr venv |
| SP-MV-3 演唱镜 i2v 质量 | REF2VA `sings` IR × 10 镜（男女各 5）→ facegate 打分 + 口部可用性人工评 | face_score≥0.6 占比 ≥80%；口部遮挡 ≤20%；手部穿帮 ≤20% | 调 IR 模板（提示词/帧网格）；仍不过 → 演唱镜首帧改用定妆抽帧垫图强化身份 | SP-MV-4 的 cast 链 |
| SP-MV-4 定妆复刻+共宿主 | cast→FL2VA→抽帧→facegate 全程，与剧场任务**同时在跑** | 无 OOM；双方任务互不致死；`ram_free` 水位曲线留档且 MusicBox 挂起线（20G）有效 | 互扰超标（对方任务失败率上升/我方 p90 劣化 >30%）→ 启用逃生口 `:8288`（共 models 目录，executor 换 `MB_COMFY_URL`） | S6–S9 |
| SP-MV-5 Inkling 冒烟 | `:8090` 换装 Inkling-2-Mini 后：剧本编译/意图理解 vs qwen38-fp4 双跑 | JSON 契约合格率 ≥95%（30 次编译）；剧本盲评不劣于现档 | 继续用现模型跑辅助（规则兜底本就独立）；`mv_assistant.chat` 不开闸（D4） | E4（宿主排期） |
| SP-MV-6 助手治理红队 | 对 l2mv 门面做对抗样本集：注入红线 11 条、白名单外工具、参数注入（塞 project_id/ver/机检字段）、票重放/过期/篡改 | 全部拦下且审计留痕；0 条到达执行层 | 补红线正则/白名单后复测；样本集固化进 V16 | N2-3 门面骨架 |

**Spike 即验收**：每个 Spike 结束提交 `spikes/SP-MV-*/REPORT.md`（数据+结论+常数回写清单），主会话过目后在 §5 对应 WBS 行解除依赖标记。

---

## 4. 里程碑与关键路径

| 里程碑 | 目标（出口门） | 净工期 | 施工方配比 |
|---|---|---|---|
| **N0 · 无口型闭环**「定妆能看」 | tab→选曲→选角双通道→定妆照+视频→拍板固化；**V13 全绿（mock）+ Spark 部署（§2.1）完成** | ~1.5 周 / 8 人日 | A 2 · B 3 · C 3 |
| **N1 · 纯音乐 MV 全链**「能出一部片」 | 剧本/分镜/样片/报价/开机/通告板/成片 + 辅助 v1 规则版；**V14 真机全绿 + 内测轨道（D10）** | ~2 周 / 11.5 人日 | A 3.5 · B 3.5 · C 3 · D 1.5 |
| **N2 · 歌唱 MV**「口型对上」 | 对齐/口型/质量门/兜底/双人 + 助手对话版灰度 20%；**V15+V16 全绿 + 公测包** | ~2.5 周 / 13 人日 | A 4.5 · B 3.5 · C 2 · D 3（SP-MV-1/2/6 通过后） |

**关键路径**：`N0-1 契约冻结 → SP-MV-1 → N2-2（lipsync svc+runner）→ N2-1（父子链/质量门）→ V15`。
次关键：`SP-MV-4 → N0-3（真机 cast 链）`；`SP-MV-2 → N2-1`；`SP-MV-3 → N1-2（storyboard IR 定稿）`。
非关键（可延迟不阻塞）：SP-MV-5 → 仅 gate N2-3 的 `mv_assistant.chat` 开闸；双人（D3/N2-4）可推至公测前。

**并行策略**（一期 CONTRACTS §5 归属不变）：A=server、B=executor+workers+deploy+spikes、C=app、D=tests 四路并行，接口只认契约 v2；D 的套件与 A/B 同步写（mock 红→绿即进度）。

---

## 5. WBS 细则（DoD / 依赖 / 出口断言）

### N0 · 无口型闭环（8 人日）

| # | 施工方 | 内容 | 人日 | 依赖 | DoD（合入门槛） |
|---|---|---|---|---|---|
| N0-1 | A | CONTRACTS v2 冻结（mv-plan §4.4/§5 + 架构 §5/§6 合入）；`store.js` MIGRATIONS v3 DDL（架构 §5）；`config.js` 新增 `credits.mv/mv_enabled/comfyUrl/mvBudgetDefault/est 常数表` | 0.5 | — | v2 评审通过并冻结；DDL 建表+索引可跑；一期 V1–V12 回归零红 |
| N0-2 | A | `api/mv.js`：projects CRUD-lite / image（魔数+sha256+consent 前置+72h TTL）/ cast confirm（viewRefs 拍板固化）/ GET 聚合 | 1.5 | N0-1 | V13-①②⑤⑥⑦⑨⑩ 绿；一期 `POST /v1/intent/image` 防线复用点有测试 |
| N0-3 | B | `lib/comfy.js`（模板加载+tmpl_sha16+注入+轮询+/view，**无 /free**）；templates `h3-image-cast`/`h3-fl2va`；`lanes/mv.js` cast_image/cast_video runner（含抽帧）+ facegate 客户端；mock 分支 | 2 | N0-1；真机部分 SP-MV-4 | mock 下 V13-⑧ 路由断言绿；真机 1 次定妆全链跑通（留档截图/耗时） |
| N0-4 | B | `workers/mv_facegate`（/score /swap，insightface onnx）+ systemd 五单元 + `spark.env` + ram_free 水位挂起 | 1 | §2.1 S1–S9 | `ss -ltn` 仅回环；剧场共存观察无互扰（SP-MV-4 数据）；水位挂起演练有效 |
| N0-5 | C | MV tab + 向导壳（步骤条/退出续作）+ step① 选曲 + step② 选角**双通道并列**（拍照/上传 + AI 生成歌手；consent+授权勾选门禁）+ step③ 定妆（3 候选→视频播放→13 帧格勾选→拍板）；`video_player` 接入+降级海报 | 3 | N0-1（契约）；联调 N0-2/3 | 真机 K90：tab→定妆视频可播→confirm 固化；游客态 MV 入口隐藏/引导注册 |

### N1 · 纯音乐 MV 全链（11.5 人日）

| # | 施工方 | 内容 | 人日 | 依赖 | DoD |
|---|---|---|---|---|---|
| N1-1 | A | 剧本编译 `prompts/mv_script.js`（LLM→重试 1→确定性分场模板兜底+如实标注）+ `mv_validator.js` + `mv_aireview.js`；`suggest`/`suggest/apply`（挂草稿 ver CAS）；lanes 登记 storyboard/preview/compose；`estimate`+`boot`（est_ver CAS+enqueueOnce 逐镜+预算核验）+ 自动 compose 收口 | 2.5 | N0-* | V13-③④（报价未 accept 不扣分/补拍零扣）绿；:8090 离线时剧本仍出（兜底标注）不报错 |
| N1-2 | B | `lib/h3ir.js`（FL2VA/REF2VA 六段式+sings 变体+validateIR）；storyboard（edit 只换背景壳+swap×2）/preview（zoompan 轮播）/compose（§4.2 filter 基线全量：剥音轨/归一/xfade/铺 master/drawtext 字幕/片名/封面/AI 角标）runner；mock 产物桩（可播 mp4/合法 png） | 2.5 | N0-3；IR 定稿 SP-MV-3 | mock 下 V13-⑪（mp4 可播/时长）绿；真机 8 镜纯音乐片产出且 V14 白盒断言（音轨 SHA=master、9:16、角标在）绿 |
| N1-3 | C | step④ 镜卡竖列（长按改词/删镜/调序/景别 chips+「让它改改」）、step⑤ 样片→报价卡→开机、step⑥ 通告板 TaskChip+位次/ETA、mv_detail+首映礼、曲库「用这首拍 MV」入口 | 3 | N1-1 契约 | 真机走完 N1 全流程一镜到底；杀进程重进状态完好（V14-断点续作项） |
| N1-4 | A | 辅助 v1（规则版）：基调建议 chips、让它改改规则改写、运动描述正则表、诊断卡 chips→job 映射（全部复用既有 type）；审计三态 `initiated_by` | 1 | N1-1 | V16 语言净化+机检字段防伪造子项绿；LLM 离线时辅助点横幅如实呈现 |
| N1-5 | B | 夜间档（queue_mode 双过滤）+ takes TTL sweep 并入一期作业 + lane 耗时/队列位次指标 | 1 | N1-2 | nightly 任务 00:00–08:00 派发演练；指标进 `/healthz` |
| N1-6 | D | `v14_mv_instrumental.test.js`（真 Spark，skip 纪律 §6.3）+ V13 补齐 + helpers/FakeExecutor `_mv*` 分支（§6.2） | 1.5 | N1-1/2 | N1 出口门：V13 全绿（CI）+ V14 真机全绿；内测包发 D10 轨道 |

### N2 · 歌唱 MV + 助手（13 人日）

| # | 施工方 | 内容 | 人日 | 依赖 | DoD |
|---|---|---|---|---|---|
| N2-1 | A | `mv_align` 集成（timings 三分用：唱段分配/切窗/字幕）；**mv_shot→mv_lipsync 父子链**（父租约延长、finalizeMvClipParent、attempts<3 回队降档）；SyncNet 质量门+自动免费补样 ≤2；兜底降级（B-roll+字幕，明示）；`GET report` | 2 | SP-MV-2 | V15-①③④ 绿；补拍 `credits_cost=0` 且通告板明示 |
| N2-2 | B | `workers/mv_lipsync`（EchoMimicV3-Flash + SyncNet 自检，懒加载/空闲 10min 释放）；`workers/mv_asr`（时间戳扩展）；lipsync/align runner（切窗 ±0.2s 余量） | 3 | **SP-MV-1**（关键路径） | 真机单镜口型 ≤5min；`/healthz {weights_loaded}` 懒加载可验；V15-② sync_score 分布 ≥80% 过阈 |
| N2-3 | A | `l2mv/` 治理门面：工具白名单 7 项/参数域/注入红线/确认票（TTL60s+hash+ver CAS+一票一次）/预算双熔断（1200⚡、>120% paused 仅人工恢复、助手代发超限 session broken）/记忆只记执行结果；assistant REST | 2.5 | N1-4；SP-MV-6 复测通过 | V16 全项绿（mock 可跑）；`mv_assistant.chat` 默认 false，灰度系数可配 |
| N2-4 | C | `assistant_sheet`（bottom-sheet，服务端下发可见性）、通告板诊断卡（flags.reason_history 单一真源）、音画报告页、双人扩展（characters[] 对唱，D3） | 2 | N2-3 | 灰度关时入口不可见；双人片可出；报告页含对齐/同步分布 |
| N2-5 | B | 降级演练脚本（kill :8390 模拟挂→B-roll 链自动接管）+ 成片带宽观测埋点（E5 素材） | 0.5 | N2-2 | 架构 §11 三条降级演练全部可复现并留档 |
| N2-6 | D | `v15_mv_lipsync.test.js` + `v16_mv_assist.test.js` 全量（11 条注入样例、白名单、票生命周期、预算、LLM 离线、lexicon CI、防伪造） | 3 | N2-1..3；SP-MV-6 样本集 | N2 出口门：V15+V16 全绿；公测包 |

> 人日含 15% 缓冲已折入（对照 mv-plan §8：8 / 11.5 / 13）。每里程碑收尾做一次**全量回归**（V1–V16 + nightly）与架构 §8 常数刷新。

---

## 6. 验收套件细则（`test/acceptance/`，续编 V13–V16）

### 6.1 文件划分（施工方 D 独占）

| 文件 | 覆盖 | 运行环境 |
|---|---|---|
| `v13_mv_contract.test.js` | V13 全清单（mv-plan §9 行 1：幂等/报价未 accept 不扣分/取消全额退/补拍零扣/ai_label/TTL+consent/laneOf 路由/mock mp4 可播） | **CI 恒绿**（mock，无 Spark 无 GPU） |
| `v14_mv_instrumental.test.js` | V14（真 Spark：定妆过门→剧本合格率→样片→报价→12 镜→成片断言 时长=歌长±0.5s/**音轨 SHA=master**/9:16/AI 角标；断点续作；单并发共存） | 真机（skip 纪律 6.3） |
| `v15_mv_lipsync.test.js` | V15（对齐 ±150ms ≥90%、sync_score ≥阈值 ≥80%、免费补样 ≤2、兜底不阻塞、尾段漂移 ≤±80ms） | 真机 |
| `v16_mv_assist.test.js` | V16（白名单/参数注入/红线 11 条/票生命周期/预算熔断/LLM 离线不装忙/lexicon CI/防伪造） | **CI 恒绿**（mock） |

> **登记状态（2026-11-24 二期末）**：四文件全部落库。V13 16/16 绿（含 V13-⑯ PATCH→mv_shots 同步）；V14 15 用例（4 mock 绿 + 11 真机 skip 带前置）；V15 8 用例（3 mock 绿 + 5 真机 skip；曾以缺陷探针挡住 `completeMvLipsync` INSERT 11 值 vs 10 列，已修复转正）；V16 9/9 绿。全量 mock 套件 **105 tests · 50 pass · 0 fail · 55 skip**。真机前置 env：`MB_SPARK_COMFY / MB_TEST_LIPSYNC_URL / MB_TEST_FACEGATE_URL / MB_TEST_SYNCNET_TOOL / MB_TEST_MV_WORK_ID / test/fixtures/mv_align_samples/`。

### 6.2 `helpers.js` / FakeExecutor 改造清单

- FakeExecutor 增 `_mv*` 分支（与 executor mock 同语义，保证「不依赖 src/executor」的套件自治纪律）：`cast_image`→3 张合法 png + face_scores；`cast_video`→桩 mp4 + 13 帧 png；`storyboard`→逐镜 png；`mv_shot`→桩 clip mp4；`mv_lipsync`→透传 + `sync_score=0.95`；`mv_align`→按歌词行数均匀 timings；`preview/compose`→桩 mp4（lavfi testsrc2+正弦音；无 ffmpeg 用内置最小合法 mp4 字节桩）。
- 自举 env 追加：`mv_enabled=1`、`MB_COMFY_URL=http://127.0.0.1:1`（断言 mock 路径不触网）、LLM 端点指向不可达（断言 suggest→`NOT_READY`、剧本走兜底）。
- 白盒只读扩展：`mv_projects/mv_characters/mv_shots/mv_takes/mv_tickets` + ledger（reason 含 `mv_*`/`refund`）；不变量断言：Σdelta==balance、tickets 无过期 pending、**成片音轨文件 SHA==母 work master**（mock 下桩字节一致即可）。
- 每套件独立 server（`MB_PORT` 7901+ 自动空口、`MB_VAR_ROOT=var-test/…`）——一期自举模式零改动沿用；`--test-concurrency=1` 不变。

### 6.3 真机前置与 skip 纪律（照搬一期）

- V14/V15 前置探针：`MB_SPARK_COMFY` 可达 + `/healthz` lipsync 权重在位 + ffmpeg 能力探测；任一缺失→显式 `skip`（消息写明缺哪项），**fail 方向恒执行**；断言清单在 skipped 状态也保持登记。
- `MB_TEST_FORCE_NO_FFMPEG=1` 增加 compose 失败方向演练：成片 job failed + 全镜已扣积分按契约退款路径核对。

#### 6.3.1 定妆/选角判词的**主角像**（钉死资产，2026-11-28 登记）

| 项 | 值 |
|---|---|
| env 名 | `MB_TEST_CAST_PORTRAIT`（缺省即仓库内这份，不填也能跑） |
| 缺省路径 | `test/acceptance/fixtures/mv_lead_portrait.jpg` |
| 像素 / 字节 | 1280×2783（竖幅）/ 318,739 B |
| **sha256** | `e8bf45a872773e66c4c26fdd15c9895b3bd71111d09e6789f5b294562f1b7c2d` |
| 来源 | 2026-11-28 用户指定为主角（原话「给你主角，写入测试计划，别跑着忘了」） |

- **为什么必须钉死**：`cast_image` ×3 与 `cast_video` 13 帧的 `face_score` 是**与这张参考脸对照**得出的（facegate ArcFace 余弦）。参考脸一换，"3 候选至少一张 ≥0.6 过门"和"帧间身份不漂移"两条断言就失去基准 —— 变成"跟谁像？"的玄学。所以判词启动即校验 sha256，**换脸必须同时改这里**（登记=可追溯，禁止判词内部私自生成人脸）。
- **不许用生成脸充当参考脸**：让 ComfyUI 现生成一张脸再拿它当参考去 gate 自己，是恒真式（引擎自己复刻自己，分数必然高）。参考脸必须是仓外来源、入库固化的真人像。
- 落盘位置：判词 boot 后把它复制进本次 `var-test/<runId>/uploads/`，以 `portrait_path` 传参（facegate 侧还要落在其 `ROOTS` 白名单内，见 `mv.js` 的 `resolveSrc`/`facegateScore`）。

---

## 7. 施工风险登记（区别于 mv-plan §10 产品风险，这里只管「建不起来」）

| 风险 | 级 | 对策 |
|---|---|---|
| aarch64/CUDA 上 EchoMimicV3 依赖装不动（torch 构建、算子） | ★★★ | SP-MV-1 **Day1** 暴露；出口=MuseTalk（依赖更轻）或 CPU 慢档验证契约；再不行 N2 降级形态先行（§3 出口） |
| 仓库未 git 化（当前非 git 仓库），并行施工无合并基线 | ★★★ | **开工前置项**：`git init` + 一期基线 tag `v1-baseline` + `.gitignore`（var/、builds/、key.properties、venv 全不入仓）；四施工方按目录归属提交，杜绝互踩 |
| Spark 为共享宿主，权限/重启受宿主排期牵制 | ★★ | 全程用户态部署（/opt/musicbox 自有目录、venv 自建、systemd user unit 或宿主代配）；宿主协调项集中 E1–E3 一次性提出 |
| 契约 v2 冻结后仍漂移（四路并行最常见事故） | ★★ | 冻结评审会一次过；改动走 PR 式「契约先行」；V13 把契约形状钉死（字段级断言），漂移即红 |
| 真机套件单轮 ~2h，拖慢迭代 | ★ | V13/V16 每合入必跑（分钟级）；V14/V15 nightly + 里程碑前手动全量；真机项按 6.3 探针自动 skip |
| 单人人日超支（agent 辅助下 8/11.5/13 偏乐观） | ★★ | 缓冲已折 15%；里程碑出口门允许「N2 延期、N1 先上架」（产品风险表既定对策，纯音乐不依赖口型） |
| 一期回归被二期改动破坏（engine/store/config 是共享热点） | ★★ | MIGRATIONS 只增表不改列；engine 分流新函数不改 `finalizeMusicParent` 原路径；每合入跑 V1–V12 全量 |

---

## 8. 外部依赖与协调事项（E 清单，尽早一次性提出）

| # | 事项 | 需要谁 | 期限挂钩 | 影响 |
|---|---|---|---|---|
| E1 | Spark 侧 ACE-Step 1.5 端点/端口登记入共享台账 | 宿主 | N3 前即可 | 二期 MV 不依赖；仅 N3 音乐 lane 并机候选 |
| E2 | NVMe 容量确认（≥150G）+ lipsync/SyncNet 权重下载通道（hf-mirror/ModelScope 白名单） | 宿主 | **Day1**（SP-MV-1 前置） | 卡口型主线 |
| E3 | H3 Community 许可法务预审（营收门槛/区域/UI 标注/托管防滥用）+ 隐私政策人脸条款（PIPL） | 法务 | **公测（N2 出口）前** | 内测不阻塞；公测硬门 |
| E4 | Inkling-2-Mini 部署 `:8090` 窗口 + `/models` 变更通知 | 宿主 | N2-3 开闸前 | 不阻塞施工（ADR-MV-9）；SP-MV-5 冒烟后才开助手 |
| E5 | 成片带宽/CDN 评估（MV mp4 10–20MB/部 vs 音频，N1 内测起量） | 宿主/VPS | N1 内测前 | 先 Nginx 直发 + `var/out` 清理；超限再上 CDN |
| E6 | Play 内测轨道（内部测试人员名单/条款文案） | 发起人 | N1 出口门（D10） | N1 内测发布 |

---

## 9. 首日工作清单（Day 1，按序）

1. `git init` + `.gitignore` + tag `v1-baseline`（§7 前置项，30 分钟）。
2. Spark 环境自检 §2.1 S1–S8 全跑一遍并留档 `deploy/spark/baseline.md`（缺项当场列成宿主协调单，含 E2）。
3. **CONTRACTS v2 草案评审冻结**（架构 §5/§6 + mv-plan §4.4/§5 合入，N0-1）——四路并行的发令枪。
4. **SP-MV-1 启动**：venv-lipsync 建起、权重拉取（E2）、单镜口型首轮横评开跑（当天至少出 EchoMimic 权重能否在 GB10 加载的结论）。
5. V13/V16 套件骨架 + FakeExecutor `_mv*` 分支登记为红（验收驱动，先红后绿）。
6. 三个非阻塞后台活：E3 法务单发出、E6 内测材料准备启动、E5 带宽预估初稿。

> Day 1 结束时应有：契约 v2 冻结、Spark 自检留档、lipsync 可用性初判、V13/V16 红骨架——四项齐即 N0 正式开工。
