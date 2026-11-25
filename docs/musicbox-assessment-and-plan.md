# MusicBox · 专业 AI 音乐生成 App — 评估分析与实现方案

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-assessment-and-plan.md |
| 日期 | 2026-11-23 |
| 目标 | 比剧场模式「素材中心·音频域」更专业、更好玩、更可用的**安卓优先·跨平台** AI 音乐生成 App；双核心场景：文本创作 + **多模态意图理解（语音/图片/视频 → 对话式澄清 → 生成）**；三档分层体验（简约/标准/深度） |
| 方法 | X-Theater 代码库音乐链路盘点 + 业界三路调研（模型格局 / 移动技术栈 / 产品交互玩法，来源见 §10） |
| 状态 | 评估与方案（待拍板项见 §9 决策清单） |

---

## 1. 结论速览（TL;DR）

1. **底子比想象的好**：剧场模式音乐域的**云端能力已是准专业级**——ACE-Step 1.5 自部署（MIT 协议）、tags/歌词/BPM/种子/纯音乐全通道、两段式声纹克隆、3 候选抽卡池、1:N 挂接素材库、许可双标记、影子计费、AI 歌词扩写。**真正缺的是独立 App 形态的三大块**：原生移动体验（后台播放/推送/离线库）、面向"创作而非配剧"的专业工具（Remix/续写/变调/stem）、社区与玩法（翻唱链/挑战赛/积分经济）。
2. **推荐架构 = 端云协同**：Flutter 单代码库 App（Android 首发、iOS 同步）＋ 独立 Music API 服务（**复用 X-Theater 已验证的任务引擎/素材库/许可/计费范式与 :8190 ACE-Step 服务，不动剧场主线**）。
3. **模型选型延续 ACE-Step 1.5 为主线**（2026 年格局下它仍是"消费级硬件 + MIT 商用自由"的最优解：<4GB 显存、~20s 出 4 分钟整曲、19 语言、支持人声 LoRA），DiffRhythm 2（Apache）作快档备选，Demucs（MIT）承担 P2 stem 分离，RVC 生态承担翻唱变声。
4. **端侧结论**：完整音乐生成放手机**当下不现实**（3.5B 级扩散模型），但端侧可做三件事：DSP 级二次创作（变调/变速/裁剪/淡入淡出/循环）、实时律动预览（方向标 Magenta RealTime 2，2.4B 开源权重、~200ms 延迟）、以及轻量端侧模型（MNN/QNN 通道预留）。
5. **核心场景二 = 多模态意图理解 × 对话式澄清生成**：语音（SenseVoiceSmall 一次推理出转写+情绪+音频事件）/ 拍照·传图 / 录视频（Qwen3-VL，Apache-2.0，DGX Spark 可自托管）→ 编译为「意图卡」→ **至多两轮选择题式澄清**（永远带推荐项+跳过）→ 出候选后进入「微调对话」（更欢快/人声清楚点 → 映射 variation 控制变量重派，不整曲重抽）。生成从"一次性抽卡"升级为"被听懂的共创"。
6. **三档分层 = 同一引擎三个外壳**：✨ 简约级（多模态一键出歌、0 参数、≤1 问）、🎚 标准级（意图卡+轻参数+2 问以内）、🎛 深度级（全参数工作台）。渐进披露、可升档，不做三个 App。
7. **三期路线**：M0 生成闭环+原生播放器（~3 周）→ M1 多模态灵感线+创作工具（~5 周）→ M2 深度工作台+社区玩法（~4 周）→ M3 进阶（stem/端侧 ASR/实时 Jam/iOS 深化）。每期都有可上架的完整产物。

---

## 2. 现状评估：剧场模式音乐商场（素材中心·音频域）盘点

### 2.1 已有资产（可复用清单）

| 资产 | 位置 | 能力 | 复用价值 |
|---|---|---|---|
| ACE-Step 生乐服务 | 5060 Ti `:8190`（W-M） | tags+lyrics+caption+bpm+seed+instrumental 全通道；惰性加载；wav 产物+sidecar 元数据 | ★★★ 直接复用（协议不变） |
| 声纹克隆两段式 | `workers/music.js` | ①text2music 完整歌 → ②cover 变声（cover_strength 可调）；快档=风格迁移 0.2；失败诚实降级 | ★★★ 独立 App 的「声音人格」底座 |
| 任务引擎 | `dag/engine.js` + workers | 幂等派单、候选池、job 账本、事件总线、GPU 显存互斥（freeComfy） | ★★★ 范式复用（抽核新建，不并线） |
| 素材库 | `api/library.js` + `st.asset_lib` | 1:N 绑定、primary 互斥、评分、状态机 draft→approved→retired、反向索引 used_by | ★★ 语义模型直接移植 |
| 许可与账本 | 全链路 | license 双标记（model/usage）、影子计分、audit 全留痕、租户域校验 | ★★★ 合规骨架直接继承 |
| 候选池/回流 | `st.asset_drafts` | 3 候选/任务、TTL 清理、采纳/淘汰 | ★★★「抽卡」机制的现成后端 |
| AI 歌词扩写 | 副驾 assist_lyrics | 粘贴素材→按段标记规范结构化 | ★★ 移动端歌词助手的种子 |
| 提示词体系 | `prompts/`（六层） | mood→tags 词典、风格包 music_tags | ★★ 移动端风格预设底座 |

### 2.2 架构现状

```
Vue3 H5 SPA（免构建） ──HTTP── Node.js API（契约层）
                              ├─ DAG 引擎（任务账本/队列/事件）
                              ├─ workers: music→ACE-Step :8190 / compose / moderate / tts
                              └─ JSON store（asset_lib + drafts + audit + tenants）
硬件：5060 Ti 16G（开发调试）＋ DGX Spark GB10 128G（验收/自生产）
```

### 2.3 差距分析（对照"更专业·更好玩·更可用"）

**「更专业」差距（对标 Suno Studio 2.0 / Moises）：**

| # | 差距 | 现状 | 业界基准 |
|---|---|---|---|
| P1 | 无二次创作 | 采纳即终点，无法续写/改段/变调 | Suno Extend/Replace Section（一次两版任选）、Remaster |
| P2 | 无 stem 视图 | 整曲一个 wav | Suno Studio 2.0 分离 ~100 种乐器、MIDI 导出 |
| P3 | 无参考音频驱动 | 声纹克隆仅限"演唱音色" | Mureka V7 参考曲引导、Suno Studio reference 引风格 |
| P4 | 时长受限 | 15–180s（配乐口径） | Suno v5 可至 8 分钟整曲结构 |
| P5 | 无导出链 | 库内播放 | MP3/WAV/视频切片直发 TikTok/抖音 |

**「更好玩」差距（对标 Suno 社区 / 海绵音乐）：** 无 remix/翻唱谱系链、无每日挑战、无积分经济（影子计费是内部口径，非用户激励）、无社区 Feed/排行、无一键分发通路（海绵音乐可一键发抖音）。

**「更可用」差距（H5 SPA 的原生鸿沟）：** 无后台播放/锁屏控制/通知栏 MediaSession；无生成完成推送；无离线曲库缓存；无相册/文件系统集成；SSE/轮询在移动网络下体验弱；无原生分享面板。

**结构性差异（最重要的判断）**：剧场音乐域是**生产流水线的配属工序**——一切语义围绕"绑定场景、就绪门禁、服务成片"。独立音乐 App 的语义中心是**作品本身**（创作→编辑→分享→社区流转）。这不是把 H5 套壳进 WebView 就能补的，需要以作品为中心重建数据模型与交互（但后端机制可大量抽核复用）。

---

## 3. 业界主流调研（2026-11 快照）

### 3.1 商业竞品格局

| 产品 | 现状 | 关键能力 | 对我们的启示 |
|---|---|---|---|
| **Suno v5/v5.5** | 2026 持续迭代，**Studio 2.0（2026-08）= AI DAW**：多轨时间线、Advanced Split（~100 种乐器）、Warp Markers、MIDI 录制/导出、聊天式造插件、7 种效果器、32bit/48kHz 无限 stem 导出 | Personas（可公开的声音人格）、Voices（录一次全 App 用）、Custom Models（上传 6+ 首训专属模型）、My Taste、Daily Challenge、Listen & Rank 赚积分；免费 50 积分/天，Pro $10/2500 | **专业天花板已抬到"移动端 DAW"**；Personas+挑战赛+积分是"好玩"三件套 |
| **Udio** | 2025-10 与 UMI 和解后**禁用下载**，社区流失 | Remix/Mashup、Sessions 结构化工作流、remix 溯源链 | 教训：**下载/导出权是生命线**，不能步其后尘 |
| **Moises** | stem 分离+练习工具标杆 | 分离 5 stem、实时和弦检测、变调变速、A-B 循环、AI 加轨（补鼓/贝斯） | 「二次创作工具集」的交互金标准 |
| **BandLab** | 社交创作 | SongStarter 掷骰子、fork 翻唱自动署名、周 Top 50 | 社交闭环范式 |
| **海绵音乐（字节）** | 免费、1 分钟成曲、**一键发抖音**；豆包内默认出 3 首（抽盲盒） | 高峰排队是主槽点 | 国内分发通路与抽卡体验参照 |
| **天工 Mureka V7** | 参考曲/哼唱引导、声音克隆、**内置市场卖歌** | 80s 44.1kHz | 参考驱动+交易闭环参照 |
| **网易天音** | 全链路免费、4–5 分钟整曲（行业最长） | 「AI 歌曲激励金」签约分成 | 生成→发布→收益闭环的国内独有玩法 |

### 3.2 开源模型选型（自托管主线）

| 模型 | 协议 | 规格 | 判断 |
|---|---|---|---|
| **ACE-Step 1.5** | **MIT** | 3.5B 扩散；**<4GB 显存**；~4 分钟整曲 **~20s**；19 语言；**人声 LoRA 训练**；ComfyUI-AceMusic 生态；支持 AMD | ✅ **主线**。剧场已跑通，商用零协议负担；LoRA 人声=「声音人格」进阶路径 |
| DiffRhythm 2 | Apache-2.0 | 扩散直构、极快；长结构/歌词连贯性弱于自回归 | ✅ 快档备选（预览/抽卡第一轮） |
| YuE / YuE2 | 7B，**商用需单独授权** | 歌词对齐强 | ⚠ 不进商用链路（沿用剧场模型白名单纪律） |
| Stable Audio Open 1.5 | **年收入 <$1M 才免费** | 偏音效/短素材 | ⚠ SFX 域候选，注意营收门槛 |
| Demucs v4 (HTDemucs) | MIT | 4-stem 分离金标准；UVR5/MDX-Net 人声向补充 | ✅ P2 stem 域主线 |
| RVC | MIT 系 | 歌声变声标准件（分离→RVC→混回） | ✅ 翻唱/变声 worker |
| Magenta RealTime 2 | 开源权重 | 2.4B、**实时流式 ~200ms 延迟**、可嵌 App/DAW | 🔮 端侧/实时 Jam 的方向标（M3 评估） |

**协议纪律**：延续剧场 ADR-001 §4-8 白名单口径——商用链路只走 MIT/Apache 权重（ACE-Step、DiffRhythm、Demucs、RVC），YuE/Stable Audio Open 设门槛监控不进主力。

### 3.3 交互范式结论

- **创作流**：Simple（一句话）/ Custom（歌词+风格）双模式 + **批量 2–4 首候选 + 快决策**（Suno/豆包共识）是标准范式；Weirdness×Style Influence 双滑杆是主流控制面。
- **歌词**：`[Verse]/[Chorus]` 括号结构标记由 Suno 确立并社区扩展出 1000+ 元标签；剧场 ACE-Step 的段标记通道与此同构。
- **等待期体验**：进度可视化 + 完成推送 + 排队诚实提示（海绵的排队慢是最大差评源）。
- **好玩三件套**（Suno 验证）：**积分经济**（每日免费+任务赚分）、**创作谱系**（Remix/Cover 链可溯源）、**挑战赛**（Daily Challenge 入口上首页）。
- **移动 UX**：常驻迷你播放条、拖拽 seek、双片对比试听、生成物一键切片直发短视频。

---

## 4. 产品定位与差异化主张

**一句话定位**：口袋里的 AI 音乐工厂——「多模态灵感秒出歌 × 云端大模型整曲生成 × 端侧即时二次创作 × 谱系化社区」。

**双核心场景**（并列的产品主线，共享同一生成底座）：
- **A 文本创作线**：Simple/Custom → 候选 → 编辑 → 发布（M0 起）
- **B 多模态灵感线**：语音/图片/视频 → 意图卡 → 澄清对话 → 候选 → 微调共创（M1 起，简约级主场）——这是与所有竞品拉开身位的场景：Suno/海绵的输入仍以文字为主，"说一段话/拍一张照/录一段视频就懂我"在移动端是天然的体验跃迁。

四个差异化支点（每个都是竞品验证过、但无人组合成移动端一体体验）：

1. **专业下放**：把 Suno Studio 的专业范式（多候选、结构标记、声纹人格、stem 检视）以移动端可及的形态做出来，并保留**下载/导出自由**（Udio 的反例是前车之鉴）。
2. **抽卡×谱系**：剧场已验证的 3 候选池 → 升级为「抽卡 + Remix 谱系树」：每首作品可溯源头、可被翻唱、可分享种子（seed/prompt 打包），让"玩"发生在作品关系里而非孤立生成。
3. **先工具后社区**：M0/M1 是纯工具（零社交压力、冷启动不依赖社区内容），M2 再开社区层——避免"空社区冷启动死锁"（剧场素材中心 starter pack 同款教训）。
4. **意图即输入**：语音/图片/视频都是合法的"创作输入"，AI 先理解、再澄清、后生成——把业界调研确认的"多候选+快决策"范式前置一步为"多候选+慢理解+快微调"，贴切度即留存。

**明确不做**（一期）：实时协作多轨 DAW、训练用户私有整曲大模型、流媒体播放平台竞争（只做创作与分发出口）。

---

## 5. 技术方案

### 5.1 总体架构（端云协同）

```
┌─ Flutter App（Android 首发 / iOS 同步）───────────────────┐
│  创作台 / 作品库 / 播放器(后台+锁屏) / 社区Feed / 我的      │
│  端侧 DSP：变调·变速·裁剪·淡入淡出·循环·切片导出          │
│  端侧缓存：作品元数据+音频离线包（SQLite+文件沙箱）        │
└───────┬────────────────────────────────────────────────┘
        │ HTTPS(REST) + WSS(进度/事件推送)
┌─ Music API（独立服务，Node.js，复用剧场范式抽核）─────────┐
│  账号/积分账本 · 作品库(库条目+谱系树) · 审核门 · 审计      │
│  任务编排：幂等派单/候选池/失败降级（dag/engine 范式）     │
│  ├─ W-M  ACE-Step 1.5 worker（复用剧场 :8190 服务协议）   │
│  ├─ W-D  Demucs stem worker（P2 新增）                    │
│  ├─ W-R  RVC 翻唱/变声 worker（M1 后期）                  │
│  └─ W-L  LLM 歌词助手（复用剧场 prompts 范式）            │
│  存储：对象存储/本地盘音频 + SQLite→Postgres 演进线        │
└────────────────────────────────────────────────────────┘
```

**关键决策：新建独立服务而非并入 X-Theater**。理由：①剧场是租户制生产 SaaS，配属语义（场景绑定/就绪门禁）与 App 的作品语义互相污染；②剧场 JSON store 单机口径不适合对公网 App；但**范式全部照搬**（幂等派单、候选池、许可双标记、影子计费→真积分、audit、降级梯子），ACE-Step `:8190` 服务与协议原样共用（同一块 5060 Ti，错峰调度）。

### 5.2 端侧选型论证：Flutter

| 维度 | Flutter | React Native | 结论 |
|---|---|---|---|
| 渲染/波形/动效 | Impeller 自绘，帧率稳定（波形/频谱/卡带动画场景关键） | 依赖桥接的原生组件 | **Flutter** |
| 音频生态 | `just_audio`（事实标准播放）+ `audio_service`/`media_session`（后台/锁屏/通知栏）+ `record`（录制）+ `audio_waveforms`/`just_waveform`（波形） | expo-audio / react-native-audio-api 成熟度尚可但碎片 | **Flutter**（组合完整） |
| 2026 产业位 | ~46% 份额、两框架均为 production-grade；Flutter 启动快/内存略优，RN 包体略小 | — | 二选一皆可，音频+动效场景 Flutter 占优 |
| 团队/环境 | 本机已有 Flutter 工具链与打包技能（flutter-build skill 在册） | — | **Flutter** |

端侧推理预留：MNN（阿里，支持 Diffusion + QNN NPU 后端）/ ExecuTorch / LiteRT 走平台通道（Platform View 或 FFI），一期不实现，仅预埋模块边界（`native_bridge` 接口），M3 再评估 Magenta RT2 端侧化。

### 5.3 数据模型（作品为中心）

```js
// 云侧核心实体（沿用剧场 asset_lib 语义骨架，重心从"绑定"改为"谱系"）
Work {
  id, owner_id, title,
  status: draft|published|retired,      // 状态机沿用
  audio_ref, duration_sec, format,      // 音频对象
  meta: { mood, genres[], bpm, key, language, lyrics, structure[] },
  gen: { engine, seed, tags, params },  // 生成指纹（复刻/复用的种子包）
  lineage: { parent_id, kind: remix|cover|extend|variation, depth },
  persona_id,                           // 声音人格引用
  license: { model, usage },            // 许可双标记纪律继承
  credits_cost, created_at
}
Persona {          // 声音人格 = 剧场声纹克隆的产品化
  id, owner_id, name, is_public, voice_ref, lora_ref|clone_params,
  derived_from_work_id, use_count
}
CreditLedger { user_id, delta, reason: daily|gen|reward|purchase, ref_job_id }  // 影子计费→真积分
Job { id, type, payload, status, result_candidates[], cost, error_code }        // 幂等任务账本
```

端侧 SQLite：作品/播放历史/离线包/草稿箱镜像；同步策略＝元数据拉增量 + 音频按需缓存（LRU）。

### 5.4 API 面（契约先行，剧场 REST 风格延续）

```
POST /v1/auth/{register|login|refresh}
GET  /v1/me                     # 积分余额+当日免费额度
POST /v1/works/generate         # {mode:simple|custom, prompt, lyrics, tags, bpm, sec, count(1-4), persona_id} → 202 job
GET  /v1/jobs/:id               # 状态+候选（WSS push `job.progress`/`job.done`）
POST /v1/works/:id/{adopt|extend|remix|cover|variation}   # 谱系动作（extend/cover 后端重派任务链）
POST /v1/works/:id/persona      # 从作品提声纹人格
GET  /v1/works?mood&genre&bpm&q&mine   # 多维筛选（Epidemic 范式）
PATCH /v1/works/:id             # 元数据/评分/状态
POST /v1/personas               # 登记声纹（录音上传 20–40s）
POST /v1/feeds/:action{like|comment|report}   # M2 社区层
GET  /v1/challenges/today       # M2 每日挑战
```

合规三件套内建（Google Play AI 内容政策硬要求）：**应用内举报**（report 通道）、**输入/输出审核**（沿用剧场 moderate 规则机检做软门）、**AI 生成标注**（作品页固定角标 + 分享物带标注）。

### 5.5 生成与编排细节

- **批量候选**：generate 默认出 3 候选（ACE-Step <4GB 显存 → 5060 Ti 16G 可常驻，同参数不同 seed 并行/串行皆 ~1 分钟内完成 3×30s；整曲 4 分钟约 20s/首，实际按安全裕度排队）。
- **谱系动作的后端实现**：
  - extend：取原曲尾部 ~10s 作 src_audio + 结构续写段标记 → 两段拼接（FFmpeg）；
  - cover：剧场两段式声纹克隆直接复用（guide 完整歌 → cover 变声）；
  - remix：seed+tags 扰动重派（同谱系树挂 depth）；
  - variation：同 seed 改单参数（变 BPM/变 tags）——"控制变量抽卡"是专业感来源。
- **降级梯子**：沿用剧场纪律——OOM 同参数不重试、自动降档（时长/候选数）、失败诚实呈现错误码+重试按钮。

### 5.6 多模态意图理解管线（核心场景二的地基）

```
输入（语音 | 图片 | 视频） → 感知层（专用模型） → 语义层（LLM 编译） → 意图卡 → 澄清（§5.7） → 生成
```

**感知层（全部开源自托管，DGX Spark 承载，5060 Ti 错峰兜底）：**

| 输入 | 模型/方案 | 产出 | 协议 |
|---|---|---|---|
| 语音 | **SenseVoiceSmall**（FunASR 部署，一次推理同时出：转写文本 + **情绪标签** + 音频事件；中/粤/英/日/韩）+ FFmpeg 语速/能量特征 | 说了什么 + 说话时的情绪状态 + 环境音线索（雨声/掌声） | 可商用；模型小，CPU 可跑，端侧化预留（sherpa-onnx） |
| 图片 | **Qwen3-VL-4B**（Apache-2.0；场景/氛围/时间地点/主体；32 语种 OCR 可读图内文字） | 场景描述 + 氛围基调 + 文字线索 | Apache 商用自由 |
| 视频 | FFmpeg 关键帧抽取（4–8 帧）→ **Qwen3-VL 多帧/视频理解** → 场景叙事 + 镜头切换节奏（快切→节奏感）+ **视频时长 → 音乐时长硬约束** | 配乐意图卡（给视频配乐时 sec=视频长度，结构对齐高潮点） | 同上 |

**语义层（LLM 编译，复用剧场 `prompts/` 六层提示词体系 + `llm/` 基建）**：把感知输出编译为结构化**意图卡**：

```js
IntentCard {
  mood: [],            // 情绪假设（来自语音情绪标签/图像氛围/文本语义，带置信度）
  scene_desc,          // "黄昏码头送别" 一句话场景
  genre_hypotheses: [],// 3 个候选风格假设（供澄清选择题选项）
  vocal: song|instrumental|unknown,
  duration_hint,       // 视频配乐=视频时长；语音描述=默认 45s
  reference: { voice_id?, image_ref?, video_ref? },   // 溯源留痕
  confidence,          // 低→触发澄清；高→直接生成
  open_questions: []   // 预编译的澄清题（选项+推荐项）
}
```

**算力放置**：Spark（128G 统一内存）常驻 Qwen3-VL-4B + LLM 毫无压力；云 API 溢出档（Qwen-VL/GLM-4V-Flash 类）按剧场 ProviderAdapter 范式契约预留，只做峰值兜底。**全部自托管 = 用户语音/图片不出内网，天然降低隐私合规烈度**。

### 5.7 对话式澄清生成 Agent（"生成不是一次性的"）

**定位**：意图卡 `confidence` 低或多解时启动澄清轮；生成后候选页启动微调轮。复用剧场已验证的 L2 Agent 平台 + `llmintent` 工具表范式（副驾 assist_lyrics/generate_image 同构）。

**Agent 工具表**（新增 worker lane `intent`）：

| 工具 | 行为 |
|---|---|
| `understand_media` | 派感知任务（ASR/VLM），产出意图卡 |
| `propose_intent` | 意图卡呈现给用户（卡片可点改，改卡=改置信度） |
| `ask_choice` | 出 **1–3 道选择题**（每题 2–4 选项+推荐项高亮）：用途（发抖音/自听/给朋友）、有无人声、风格假设选一 |
| `generate_music` | 按意图卡派 3 候选任务 |
| `adjust_variation` | 候选后微调：映射为 variation（同 seed 改单参数）或 cover/extend（谱系动作），**不整曲重抽**——省 GPU、保留用户已认可的部分 |
| `save_preference` | 采纳时把意图卡+最终参数写入用户偏好档案（My Taste 等价物） |

**澄清纪律（防烦，体验的生死线）**：
1. **总轮次 ≤2、每轮 ≤2 题**（简约级 ≤1 题）；`confidence` 高时零提问直接生成——澄清是选项不是关卡；
2. 每题**永远带推荐项**（意图卡最可能假设）+"跳过直接生成"按钮——简约级可以全程零输入走完；
3. 问题用选择题不用开放题——移动端打字成本最高；
4. 候选后的反馈永远是**微调句**（"更欢快一点/人声再清楚点/前奏换钢琴"）→ `adjust_variation`，而不是重新抽卡。

**偏好记忆**：同用户第 2 次起，意图卡预填其历史偏好（默认人声/常用曲风），逐步逼近"零提问"——即 Suno My Taste 的多模态版。

---

## 6. 分期路线图（每期可上架）

### M0 · 生成闭环 + 原生体验（约 3 周，P0）

**目标**：装上 App 就能"输入想法 → 3 首候选 → 挑选 → 收藏 → 后台播放"的完整闭环。

| 模块 | 内容 |
|---|---|
| Flutter 骨架 | 路由/主题/深色模式、API 客户端（REST+WSS 重连）、账号（手机号/邮箱+游客态）、积分账本接入 |
| 创作台 v0 | Simple/Custom 双模式、心情×曲风×人声三维预设 chips、BPM/时长滑杆、批量 3 候选、进度页（进度可视化+完成本地通知） |
| 播放器 | just_audio + audio_service：全局迷你播放条、锁屏/通知栏控制、双候选 A/B 快切对比 |
| 作品库 | 网格列表、多维筛选（mood/genre/bpm）、评分收藏、元数据编辑、SQLite 离线缓存 |
| 云侧 | 独立 Music API 骨架 + ACE-Step worker 接入（复用 :8190）+ 审核软门 + 审计 |
| 验收 | 真机 Android：冷启动→生成→采纳→锁屏播放→杀进程恢复，全程无 H5 缺口 |

### M1 · 多模态灵感线 + 创作工具（约 5 周）

**目标**：说一段话/拍一张照 → AI 懂你 →（最多两问）→ 3 候选 → 微调对话 → 收下。简约级与标准级双外壳上线。

| 模块 | 内容 |
|---|---|
| 多模态意图管线 | SenseVoice worker（ASR+情绪+事件）、Qwen3-VL worker（图像理解）、意图卡编译（LLM）；创作台新增「按住说话」「拍一张/传图」双入口 |
| 澄清对话 Agent | `intent` lane 工具表（§5.7）、意图卡可点改 UI、选择题澄清组件（推荐项高亮+跳过）、候选后微调对话（映射 variation） |
| 声音人格 | 录音登记（20–40s）→ Persona 列表 → 生成时选用；从任意作品一键提取人格（复用剧场两段式声纹克隆） |
| 谱系动作 | extend / cover / variation（控制变量重抽）/ seed 分享包（导出 prompt+seed+参数 JSON/二维码）——`adjust_variation` 的动作底座 |
| 端侧 DSP | 变调变速（不破坏音质）、裁剪拼接、淡入淡出、循环点设置、导出 MP3/WAV、封面图合成 |
| 分层外壳 | ✨ 简约级（多模态入口即首页、0 参数）与 🎚 标准级（意图卡+4 滑块）双壳；偏好记忆 v1 |
| 验收 | ①语音："帮我写一首给女儿生日的歌"→意图卡（情绪：温暖/流派假设 3 个）→1 道选择题→3 候选→"人声再温柔点"→2 版 variation；②图片：拍黄昏码头→意图卡→候选；③全流程零文字输入可完成 |

### M2 · 深度工作台 + 社区玩法（约 4 周）

| 模块 | 内容 |
|---|---|
| 歌词编辑器（深度级） | 结构标记工具栏（[Verse]/[Chorus]/[Bridge]）、AI 扩写（复用剧场 assist_lyrics 范式）、押韵提示 |
| 视频意图 | 关键帧抽取+Qwen3-VL 多帧理解、视频时长→音乐时长对齐、「给这段视频配乐」工作流（成曲切片回填视频轨导出） |
| 社区 Feed | 关注流/流行榜、点赞评论、举报通道（商店合规件） |
| 翻唱链 | 公开作品"可被 remix/cover"授权开关、谱系溯源页（Udio 式 remix 链）、fork 自动署名 |
| 每日挑战 | 每日提示词挑战（Suno Daily Challenge 范式）、挑战榜、积分奖励 |
| 积分经济 | 每日免费积分（50/天量级）、任务赚分（听歌评分/挑战/邀请）、订阅分层（参考 Suno Pro $10/2500 定价锚点） |
| 分发通路 | 10/20/30s 切片+封面+可视化波形导出 → 系统分享面板（抖音/TikTok/微信）；AI 标注随片携带 |
| 验收 | 完整回路：视频配乐→挑战投稿→社区流转→翻唱链生长→积分结算→切片分发 |

### M3 · 进阶（1–2 月，按数据决策）

- **stem 分离域**：Demucs worker（5060 Ti 富余算力）→ 作品页 stem 检视/单独导出（Moises 范式），进阶订阅档；
- **实时 Jam 评估**：Magenta RealTime 2（2.4B 开源权重、~200ms）云端先行"电台模式"（参数驱动的无限流，Endel 范式），端侧化随 MNN/QNN 通道评估；
- **iOS 深化**：TestFlight 公测→上架；CarPlay/Android Auto；
- **人声 LoRA**：ACE-Step 1.5 LoRA 训练通道（Custom Models 等价物）。

---

## 7. 三档分层体验设计（✨ 简约级 / 🎚 标准级 / 🎛 深度级）

**架构原则：同一引擎、三个外壳**——不做三个 App，是同一数据模型与生成底座之上的**渐进披露**（progressive disclosure）。档位显性可切，且系统观察行为自动建议升档（简约级用户第 5 次创作后提示"解锁更多控制"）。

| 维度 | ✨ 简约级「灵感拍立得」 | 🎚 标准级 | 🎛 深度级 |
|---|---|---|---|
| 入口 | 首页大按钮：按住说话 / 拍一张 / 录一段 / 打一句话 | 同左 + 简明表单 | 全参数工作台（Custom） |
| 理解 | 多模态管线全自动，意图卡直接执行 | 意图卡 + 1–2 道澄清选择题 | 意图卡仅作预填，可整卡改写 |
| 提问 | ≤1 题，且可"直接生成"跳过 | ≤2 题 | 不主动问（参数自己给） |
| 控制 | **0 参数**：只挑候选 | mood/曲风/人声/时长 4 组 chips+滑块 | 歌词编辑/结构标记/BPM/seed/variation 实验台/人格全量 |
| 结果 | 3 候选 → 一键收下 | 候选 + 轻编辑（裁剪/变调/淡入淡出） | + 谱系动作/seed 分享/全格式导出 |
| 记忆 | 偏好静默学习（越用越准） | 偏好可见可改 | 全量参数可见可复用 |
| 底层差异 | 无 | 无 | 无——仅 UI 面暴露度不同 |

**设计纪律**：
1. 简约级是**多模态意图管线的主场**（§5.6/§5.7 的直接载体）——"说一句话就出歌"必须能在 3 次点击内完成（说话→揭晓→收下）；
2. 澄清轮次随档位递减（1→2→0），控制感随档位递增——两根曲线交叉处即标准级的定位；
3. 升档不降档体验：任何档位生成的作品在同一曲库互通，换档不换资产；
4. 深度级不是"专家特权"而是"解锁"：从简约级候选页常驻一个"自己改改"入口（意图卡直接转成标准级表单），保证成长路径不断裂。

---

## 8. 好玩机制设计清单（产品层浓缩）

1. **抽卡仪式感**：生成等待页做"唱片压制"动画 + 完成瞬间三张卡带翻转揭晓；连抽保底（第 N 次 4 候选）。
2. **控制变量实验台**：variation 一键"同曲改 BPM/改风格"并排 A/B——把专业人的工作流变成大众玩法。
3. **谱系树**：作品详情页可视化 remix/cover 家谱，"我的曲被翻唱了"推送=留回钩子。
4. **每日挑战**：低门槛命题（"把你今天的天气写成歌"）+ 榜单 + 积分；挑战结果自动进探索页候选。
5. **听歌赚分**：Listen & Rank 双片对比打分赚积分——既解决冷启动内容标注，又是留存机制。
6. **声音人格养成的收集感**：Persona 卡片化（音色指纹可视化）、公开人格被使用次数=创作者荣誉。

---

## 9. 合规与风险

| 风险 | 等级 | 对策 |
|---|---|---|
| 应用商店 AI 内容政策 | 中 | 三件套内建（§5.4）：举报/审核/AI 标注；关注 Google Play 2026-10-29 政策更新合规窗口 |
| 模型协议 | 低 | 主线全 MIT/Apache（ACE-Step/DiffRhythm/Demucs/RVC）；YuE/Stable Audio Open 不进商用链路（延续剧场白名单纪律） |
| 翻唱链版权 | 高 | remix/cover 仅限平台内生成物谱系（不做"上传他人商业歌曲改编"）；公开作品授权开关默认关；导出物带生成溯源信息 |
| 公网部署安全 | 中 | API 网关鉴权+限流；8188/8190 不出内网（沿用剧场红线）；上传音频类型/大小白名单校验 |
| 排队体验 | 中 | 5060 Ti 单卡并发有限：诚实排队位次推送 + 高峰降候选数（海绵音乐排队差评是前车之鉴）；DGX Spark 作为溢出容量 |
| 端侧模型预期管理 | 低 | 一期宣传口径固定为"云端生成"，端侧实时能力 M3 前不作承诺 |
| **语音/人脸生物识别隐私（多模态管线新增）** | 高 | 语音/照片/视频属 PIPL 敏感个人信息：上传前显式同意弹窗（用途限定"仅本次生成使用，不用于训练"）、上传物最短保存期+一键删除入口、自托管推理不出内网（§5.6）；情绪标签仅用于生成意图，界面不得呈现为"情绪诊断" |
| **AI 情绪/意图推断透明度** | 中 | 意图卡固定明示"AI 推测，可点改"；未成年人默认关闭情绪推断；澄清选择题不诱导采集与生成无关的个人信息 |

---

## 10. 待拍板决策清单

| # | 决策点 | 建议 |
|---|---|---|
| D1 | App 名称与定位（社区型 vs 工具型） | 按本方案"先工具后社区"，名定后注册域名/包名 |
| D2 | 后端部署形态：5060 Ti 直接公网暴露 vs 云 VPS 网关+内网穿透回源 | 建议 VPS 网关（鉴权/限流/CDN 前置），生成算力不出内网 |
| D3 | 账号体系：独立注册 vs 复用剧场租户 | 建议独立（面向 C 端轻注册：手机号+游客态） |
| D4 | 商业模式启动口径 | 建议免费积分制起步，订阅分层 M2 末期再定价 |
| D5 | iOS 是否随 M0 同步 | 建议 M0 Android 真机先行，iOS 骨架同步、公测随 M2 |
| D6 | 剧场 :8190 共享调度策略（App 高峰与剧场生产抢卡） | 建议错峰配额（如 App 侧每日 GPU 时片）+ Spark 溢出 |
| D7 | 意图理解算力放置：VLM/LLM 自托管（Spark）为主 vs 云 API 兜底 | 建议自托管主线（Qwen3-VL-4B 免费、隐私友好），云 API 仅峰值溢出档契约预留 |
| D8 | 默认档位：✨ 简约级 vs 🎚 标准级作为首页默认 | 建议简约级默认（多模态入口即首页），档位切换显性可寻 |
| D9 | 语音识别端云口径：云侧 SenseVoice（准、全） vs 端侧 sherpa-onnx（隐私/离线） | 建议 M1 云侧起步+同意弹窗明示转写用途，M3 评估端侧化（SenseVoice 模型小，端侧可行） |

---

## 11. 调研来源

**模型格局**
- ACE-Step 1.5（GitHub，MIT，<4GB VRAM，LoRA 人声）：https://github.com/ace-step/ACE-Step-1.5
- ComfyUI-AceMusic 集成讨论：https://www.reddit.com/r/comfyui/comments/1quxowm/finally_acestep_v15_is_here_after_6_months
- 开源模型 2026 横评（ACE-Step/DiffRhythm 2/YuE2/Stable Audio Open）：it-jim.com/blog/best-open-source-ai-music-generator（2026-05）、songcreator.pro/blog/best-open-source-ai-music-models（2026-09）
- Suno release notes（Voices/Custom Models/My Taste/stems/Studio 2.0/Daily Challenge）：https://suno.com/release-notes ；Studio 2.0：https://suno.com/blog/studio-2 ；定价：https://suno.com/pricing
- Udio 定价与 Sessions：https://www.udio.com/pricing 、https://www.udio.com/blog/two-minute-model-new-controls
- Moises 功能（stem/和弦/变调/AI 加轨）：https://moises.ai/features 、https://moises.ai/blog/latest/improvements-latest-releases
- Demucs：https://github.com/facebookresearch/demucs

**产品交互与玩法**
- Suno Personas/Voices：https://help.suno.com/en/articles/3484161 ；短视频切片直发：https://help.suno.com/en/articles/2565761
- BandLab SongStarter / fork 翻唱：https://www.bandlab.com/songstarter 、https://www.bandlab.com/products/ai-tools
- Endel 参数驱动无限流：https://endel.io
- 海绵音乐（抖音分发/3 首抽卡）：https://apps.apple.com/cn/app/id6502927127
- 天工/Mureka V7（参考曲/声音克隆/内置市场）：https://tiangong.cn/music 、https://www.beyondaitools.com/zh-hant/product/mureka-ai
- 网易天音（激励金分成）：https://tianyin.163.com

**移动技术栈与端侧**
- Flutter vs RN 2026：https://plus8soft.com/blog/react-native-vs-flutter 、https://www.bolderapps.com/blog-posts/react-native-vs-flutter-2026
- Flutter 音频包生态（just_audio/audio_service/record/audio_waveforms）：pub.dev Music & Audio 类目与包文档
- 端侧生成式推理（MNN Diffusion + QNN、ExecuTorch/LiteRT、Qualcomm NPU SD）：https://github.com/qualcomm/Stable-Diffusion-v2.1 与 MNN 官方仓库
- Magenta RealTime 2（2.4B 开源权重、~200ms 实时）：https://magenta.withgoogle.com/magenta-realtime-2 、https://huggingface.co/google/magenta-realtime-2
- Google Play AI 生成内容政策：https://support.google.com/googleplay/android-developer/answer/14094294 、2026-10 政策更新：https://support.google.com/googleplay/android-developer/answer/18100766

**多模态意图理解**
- SenseVoiceSmall（ASR+情绪+音频事件一次推理，中/粤/英/日/韩，可商用，FunASR 部署）：https://github.com/QwenAudio/SenseVoice 、https://huggingface.co/FunAudioLLM/SenseVoiceSmall
- emotion2vec（语音情绪表征模型，ACL 2024，开源可商用）：https://github.com/ddlBoJack/emotion2vec
- Qwen3-VL（Apache-2.0，图像+视频理解，256K 上下文，32 语种 OCR，4B 本地可跑）：https://github.com/qwenlm/qwen3-vl 、技术报告 https://arxiv.org/abs/2511.19342

**项目内证**
- X-Theater：`src/server/api/music.js`、`src/server/api/library.js`、`src/server/dag/workers/music.js`（ACE-Step 两段式声纹克隆/降级梯子）、`docs/theater-asset-center-plan.md`（素材中心五域）、`docs/theater-infer-backend-adr.md`（ADR-001 模型白名单/硬件定位/5060 Ti+Spark）
