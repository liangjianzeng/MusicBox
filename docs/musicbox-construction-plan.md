# MusicBox · 施工方案（WBS · 排程 · 验收）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-construction-plan.md |
| 日期 | 2026-11-23 |
| 输入 | [musicbox-architecture-design.md](musicbox-architecture-design.md)（施工基线）、[musicbox-assessment-and-plan.md](musicbox-assessment-and-plan.md)（产品方案） |
| 人力口径 | 1 人主导 + AI agent 协作施工（代码由 agent 批量产出，人做架构裁决/验收/真机把关）——工期按此口径；括号内为纯人工传统口径 |

---

## 1. 施工策略（五条原则）

1. **契约先行**：API 契约与 IntentCard schema 先冻结（架构文档 §5），端云并行施工不互相等待；
2. **Spike 前置**：五个技术预研（§3）在 M0 期间穿插完成，**最高风险（意图链路"懂不懂"）最先验证**——它若不达标，M1 方案回炉，不影响 M0 交付；
3. **每期可上架**：M0 末出可内测 APK；验收套件（§5）V1–V12 全绿才进下一期；
4. **AI 施工分工纪律**（继承剧场协作经验）：骨架/契约/验收套件人写或人审；视图/worker 样板代码 agent 批量做；**任何扣积分/删除/上传路径必须人工过目**；
5. **不动剧场主线**：`:8190` 服务只读复用，X-Theater 仓库零改动。

## 2. 工具链与环境（本机已核实）

| 组件 | 状态 |
|---|---|
| Node | v25.2.0 ✓（`node:sqlite` 稳定） |
| Flutter | `C:/src/flutter` ✓（打包走既有 flutter-build skill） |
| GPU | 5060 Ti 16G（ACE-Step :8190 已在跑）＋ DGX Spark 128G（M1 部署 vLLM） |
| 待装 | Android SDK/签名 keystore（M0 W0）；Spark 上 vLLM + Qwen3-8B/Qwen3-VL-4B 权重（M1 前置，~30GB 盘）；ffmpeg 二进制（执行器机） |
| 公网 | VPS（2C4G，Ubuntu）+ 域名 + TLS（M0 W5 部署日购） |

仓库骨架：`MusicBox/src/app`（Flutter）、`src/server`（API）、`src/executor`（拉单 daemon）、`src/workers/*`（8191 SenseVoice / ffmpeg 脚本）、`test/acceptance/`（V 套件）。

## 3. 技术预研 Spike（各 0.5–1 天，结论回写架构文档）

| # | Spike | 验证什么 | 风险位 |
|---|---|---|---|
| SP1 | **意图链路原型**：手机录 3 段真实语音→SenseVoice→Qwen3 编译→对比 mood/genre 假设质量 | "懂不懂"——全案最大风险 | ★★★ |
| SP2 | Spark vLLM 双模型部署（Qwen3-8B + Qwen3-VL-4B） | 显存/并发/首 token 延迟 | ★★ |
| SP3 | ACE-Step :8190 批量 3 候选实测（30s 与 4min 两档） | 排队预算与积分定价基线 | ★★ |
| SP4 | flutter_soloud 变调变速听感 | 端侧预览可行性与质量 | ★ |
| SP5 | audio_service 锁屏/后台/杀进程恢复（真机） | 原生播放栈地基 | ★ |

## 4. WBS 与里程碑

### M0 · 生成闭环 + 原生体验 —— 里程碑：**可内测 APK**（净 ~2 周 / 传统 15 人日）

| WBS | 内容 | 工期 |
|---|---|---|
| M0-1 | 服务端骨架：index/store(node:sqlite 迁移)/engine 雏形/bus/audit + 部署脚本 | 1d |
| M0-2 | 账号+积分：guest/phone auth、ledger 复式记账、不变量测试 | 1d |
| M0-3 | 任务引擎+执行器：租约拉单协议、executor daemon、music lane 接 :8190（搬剧场 postMusic 协议） | 2d |
| M0-4 | works API：generate/adopt/筛选/评分/详情；审核软门接入 | 1.5d |
| M0-5 | ffmpeg lane：wav→mp3 转码、波形 JSON 预生成 | 1d |
| M0-6 | Flutter 骨架：Riverpod、主题、API client、WSS 重连 | 1.5d |
| M0-7 | 创作台 UI：Simple/Custom、chips/滑杆、批量 3 候选、进度页、揭晓动画 v0 | 2d |
| M0-8 | 播放器：just_audio+audio_service、迷你播放条、锁屏控制、A/B 快切 | 2d |
| M0-9 | 作品库+详情：网格/筛选/评分/离线缓存（drift） | 1.5d |
| M0-10 | VPS 部署（Nginx/TLS/静态面）+ 真机验收 V1–V5 + 签名 APK | 1.5d |

### M1 · 多模态灵感线 + 创作工具 —— 里程碑：**简约级/标准级可内测**（净 ~3 周 / 传统 25 人日）

| WBS | 内容 | 工期 | 依赖 |
|---|---|---|---|
| M1-1 | SenseVoice 服务 :8191（FunASR FastAPI） | 1.5d | SP1 |
| M1-2 | Spark vLLM 部署（Qwen3-8B + Qwen3-VL-4B）+ 健康探活 | 2d | SP2 |
| M1-3 | intent lane：/intent/voice、/intent/image 端到端；IntentCard 编译 prompts（含 mood→tags 词典移植） | 2.5d | M1-1/2 |
| M1-4 | 澄清 Agent：answer 状态机（≤2 轮）、open_questions 编译规则、adjust 自然语言→参数 delta 解析 | 2d | M1-3 |
| M1-5 | App 录音/拍照入口 + 上传（同意弹窗/TTL） | 1.5d | M1-3 契约 |
| M1-6 | 意图卡 UI（可点改）+ 选择题组件（推荐项/跳过） | 2.5d | M1-4 |
| M1-7 | 微调对话 UI：候选页"说一句改一点"→ variation A/B 并排 | 2d | M1-4 |
| M1-8 | 声音人格：登记/列表/选用/从作品提取（两段式克隆协议复用） | 2.5d | — |
| M1-9 | 谱系动作：extend/cover/variation + seed-pack 分享（JSON/二维码）+ 谱系树 UI | 2.5d | M1-8 |
| M1-10 | DSP API+UI：trim/fade/pitch/tempo/concat/slice、导出 MP3/WAV、封面合成 | 2d | — |
| M1-11 | 简约级对话壳（首页灵感拍立得）+ 档位切换 + 偏好记忆 v1 | 1.5d | M1-6 |
| M1-12 | 验收 V6–V9 + 内测包 | 1d | 全部 |

### M2 · 深度工作台 + 社区玩法 —— 里程碑：**公测版**（净 ~3 周 / 传统 20 人日）

| WBS | 内容 | 工期 |
|---|---|---|
| M2-1 | 歌词编辑器（结构标记/AI 扩写/押韵）+ 深度级全参数工作台 | 3d |
| M2-2 | 视频意图：关键帧抽取→VLM 多帧理解、时长对齐、"给视频配乐"工作流 | 2.5d |
| M2-3 | 社区：feed/关注/点赞/评论 + 审核与举报闭环 | 4d |
| M2-4 | 翻唱链：授权开关、谱系溯源页、fork 署名 | 2.5d |
| M2-5 | 挑战+积分商店：每日挑战、听歌赚分、订阅分层（支付渠道另定） | 2.5d |
| M2-6 | 分发：切片+封面+波形可视化导出、系统分享面板、AI 标注随片 | 1.5d |
| M2-7 | 推送评估落地（FCM 或厂商通道）+ 公测合规包 | 1.5d |
| M2-8 | 验收 V10–V12 | 1d |

**汇总**：净工期 ~8 周（三里程碑），传统口径 60 人日；M0/M1 之间唯一硬依赖是 SP1 结论。

## 5. 验收体系（V 套件，验收驱动施工）

| 套件 | 断言 | 期 |
|---|---|---|
| V1 账号与账本 | Σledger==balance；幂等键重复请求不双扣；游客→绑定手机不丢作品 | M0 |
| V2 生成闭环 | 同参数并发 5 请求只 1 job；OOM→降档梯子逐级生效；失败呈现真实错误码+自动 refund | M0 |
| V3 播放器 | 锁屏控制/后台连播/杀进程恢复队列；WSS 断网 30s 自动重连不重复通知 | M0 |
| V4 曲库 | 筛选正确性；离线缓存 LRU 上限；弱网详情页降级 | M0 |
| V5 M0 真机端到端 | 冷启动→生成→揭晓→采纳→锁屏播放→导出，全程无缺口 | M0 |
| V6 语音意图 | 10 段标注语音：情绪标签命中≥7；意图卡字段完整；60s 上限硬校验 | M1 |
| V7 图像意图 | 10 张场景图：mood/scene 合理率抽评；OCR 图内文字可用 | M1 |
| V8 澄清纪律 | 轮次≤2/简约级≤1；每题有推荐项+可跳过；高置信零提问；adjust 识别成功率≥80%，不识别必追问不瞎猜 | M1 |
| V9 人格与谱系 | persona 登记到选用全链；variation 同 seed 改单参数可验证（A/B 仅预期维不同）；seed-pack 复刻产物一致 | M1 |
| V10 DSP | 变调不变速/变速不变调分别可验证；导出格式/命名规范；波形与音频对齐 | M1 |
| V11 合规与隐私 | prompt 审核软门拦截样例；AI 角标全出现在作品页与分享物；上传物 72h TTL 清理验证；举报链路可用 | M2 |
| V12 社区回路 | 挑战投稿→榜单→翻唱谱系→积分结算→切片分发全链贯通 | M2 |

## 6. 风险登记

| 风险 | 等级 | 对冲 |
|---|---|---|
| SP1 意图链路"不懂"（情绪/场景→音乐参数映射平庸） | ★★★ | Spike 最先做；兜底=澄清选择题承担分歧（架构为此设计）；极端情况 mood 词典人工扩容（剧场 MOOD_TAGS 移植即底座） |
| GPU 抢卡（App 高峰 vs 剧场生产 vs Spike） | ★★ | lane 已分机（music=5060Ti / intent=Spark）；VPS 队列天然缓冲；剧场错峰配额（评估 D6） |
| 单点 VPS（API+存储同机） | ★★ | 起步可接受；日备 SQLite+音频；用户量>1k 时对象存储+CDN 拆分 |
| 音频带宽费用 | ★★ | mp3 320k 播放档为主、wav 仅导出；切片 ≤30s；公测前上 CDN |
| 国内上架合规周期（软著/App 备案/隐私检测） | ★★ | 先 Google Play 内测轨道；软著与备案 M0 期间并行办理（材料就绪即提交） |
| SenseVoice 端侧预期 | ★ | M1 云侧起步，端侧化 M3 承诺 |
| agent 批量代码质量 | ★★ | V 套件先行（验收驱动）；资金路径人工过目纪律（§1-4） |

## 7. 需要提前启动的外部事项（与 M0 并行）

1. 域名购买 + ICP 备案（国内 VPS 必须，周期 1–3 周）；
2. 软著申请（材料=源码前后 30 页+文档，AI 辅助整理，周期可加急）；
3. Google Play 开发者账号（$25）+ 商店素材（图标/截图/隐私政策）；
4. 隐私政策与用户协议初稿（语音/图像用途限定条款，§8 安全设计对齐）。

## 8. 开工顺序建议（第一步清单）

```
第 1 天   SP1 意图链路原型（借剧场机器跑通：录音→SenseVoice→Qwen3→tags）   ← 最高风险先验证
第 1-2 天 M0-1/M0-2 服务端骨架+账号账本（agent 可并行施工）
第 2-3 天 SP3/SP5（ACE-Step 批量实测；audio_service 真机验证）+ M0-3 执行器
此后按 WBS 顺序推进，每周五跑当周 V 套件回归
```
