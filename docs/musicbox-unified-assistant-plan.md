# MusicBox · 统一端侧多模态全场景 AI 助手 — 评估与重构方案（契约 v5.0 草案）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-unified-assistant-plan.md |
| 日期 | 2026-11-26 |
| 输入 | 现有三套助手（音乐 v3.1 / MV 制片 v2.13 / 统一 v4.0）代码与契约；端侧语音栈（Sherpa-ONNX ASR/VITS TTS）；二期 AI 辅助体系 §5 治理范式 |
| 目标 | **一个、端侧多模态、全场景**的业务 AI 助手，替代当前三个并行助手 |
| 状态 | **决策已拍板（2026-11-26）：D-1=A / D-2=薄壳 / D-3=服务端 VLM / D-4=V21 绿后灰度开** — Phase 0 + 1 + 2 + 3 + 5 已落地（Phase 4 按 D-1=A 跳过；见 §0.5） |

---

## 0. 结论速览（TL;DR）

1. **现状是"三套助手"而非"一个助手"**：音乐助手（`l2music`，`/v1/music/assistant/messages`，7 工具）、MV 制片助手（`l2mv`，`/v1/mv/assistant/messages`，7 工具）、统一创作助手（`l2assistant`，`/v1/assistant/*`，10 工具）三套并行。统一版（v4.0）工具集是前两者的**严格子集**（10 vs 14 个不同动作），实际能力比任一旧助手都弱，且三套各自有独立的会话表、票据表、注入红线、熔断逻辑——**治理逻辑重复实现了三遍**。
2. **唯一已落地的"端侧多模态"样板是 MV 制片助手页**（`src/app/lib/features/mv/assistant_sheet.dart`）：端侧 Sherpa ASR 听 + 端侧 VITS TTS 念（失败回落在线）+ 项目/镜头上下文 chips + 完整治理。音乐助手页与统一助手页**完全没有语音进出**。这是本次重构要复制、而不是从零设计的资产。
3. **"端侧"的正确边界**：端侧负责**感知与交互**（听/说/打字/拍照、本地规则解读、离线可用）；服务端保持**业务权威**（计费、派单、积分账本、GPU 执行、LLM 增强）。**不要把整个 LLM 搬到端侧**（见 D-1）——建议端侧 LLM 作为可选增强，不作为架构必需。
4. **全场景 = 19 个工具的统一白名单**（音乐 7 + MV 7 + 统一 5 只读/解释类），一张工具表、一套 `gateTool`、一套确认票、一套预算熔断、一套注入红线。
5. **重构分五步**：契约 v5.0 冻结 → 后端合一（扩展 l2assistant 到 19 工具，废弃 l2music/l2mv 独立会话与票据表，迁移存量票）→ 端侧语音到统一面（复制 MV sheet 的语音层）→ 多模态上下文（图片 ref）→ UI 合一（单一 AssistantDock，旧 sheet 降级或移除）。每步都有独立验收，**主流程零阻塞**（与 D11 纪律一致）。

### 0.5 实施状态（2026-11-26）

| Phase | 状态 | 说明 |
|---|---|---|
| Phase 0 · 契约 v5.0 | ✅ 完成 | `CONTRACTS.md` 增补 v5.0：19 工具白名单、票规则（全写走确认票、付费受 `assistant_actions` 闸）、功能开关收敛、`capabilities` 固定 6 字段、`image` ref 与 v14 迁移均预留 Phase 3 |
| Phase 1 · 后端合一 | ✅ 完成 | `l2assistant/core.js` 扩展至 19 工具（TOOLS / PAID_ACTIONS / WRITE_ACTIONS）；`facade.js` 的 ruleInterpret / sanitizePlan / prepareWrite / executeConfirmed 覆盖全部新动作；`l2/governance_core.js` gateTool 新增 `shotId` / `shotIds` 实体类型；跨域动作复用 `l2music.executeMusicTicketAction` / `api/mv.executeTicketAction` 既有内核（未重写 l2music / l2mv / api）；Phase 1 为 schema-neutral（v14 迁移留 Phase 3）；`v21_unified_full_scenario.test.js` 全绿，V16 / V17 / V19 零回归 |
| Phase 2 · 端侧语音 | ✅ 完成 | 抽出共享语音层 `features/assistant/assistant_voice.dart`（`AssistantVoiceController` + `AssistantVoiceButton`），统一 surface 聊天 tab 支持长按听 → 松手回显 → autoSpeak 朗读（复用 MV sheet 的 talkError 文案：无模型给「本机识别…下载模型」明确引导）；`assistant_voice_test.dart` 6 用例，全量 64 个 Flutter 测试绿，V13/V16/V17 零回归 |
| Phase 3 · 图片多模态 | ✅ 完成 | `image` ref（core.js `resolveRefs`/`imageRow`）+ 服务端 VLM 描述（facade.js `describeImage`，fail-open）+ 72h TTL + PIPL consent；`POST /v1/assistant/image` 上传（size/ext/magic/sha256 去重）；端侧统一 surface 拍照按钮；`v22_image_multimodal.test.js` 6/6 绿，V13/V16/V17/V19/V21 零回归，Flutter 66 测试绿 |
| Phase 4 · 端侧 LLM | ⏭ 跳过 | D-1=A（服务端 LLM + 端侧规则兜底），除非改判 B 才执行 |
| Phase 5 · UI 合一 | ✅ 完成 | 旧 music / mv sheet 入口降级为薄壳（D-2）：`showMusicAssistant`→统一 surface（`music`+work/intent ref）、`showMvAssistant`→统一 surface（`mv`+project/shot ref）；统一 surface 新增 `initialSurface`/`initialRefs` 预绑定；`assistant_test.dart` +2 薄壳用例，Flutter 全量 68 绿，MV/音乐零回归；旧 sheet 遗留代码留 Phase 6 清理 |
| Phase 6 · 回归收口 | ✅ 完成 | 全量回归 V1–V22 绿（125 pass / 0 fail）；新增 V21-⑯ lexicon CI 覆盖统一助手回执（引擎名/黑话不外泄）；确认统一助手所有回执路径（chat / 读工具 / 错误 / LLM）经 `core.cleanText`→`lex.sanitize` 净化。旧 sheet 死代码（Phase 5 遗留）仍保留，待后续清理 |

> **本期（Phase 0 + 1 + 2 + 3 + 5 + 6）验收**：服务端全量回归 V1–V22 绿（125 pass / 0 fail，含 `v21` 9/9（新增 ⑯ lexicon CI）、`v22` 6/6）；`v16`（11/11）、`v17`（13/13）、`v19`（14/14）、`v13` 隔离全绿；Flutter 端全量 69 个测试绿（含 `assistant_voice_test.dart` 6、`assistant_test.dart` 12（含 2 薄壳预绑定 + 1 拍照入口）、MV 相关零回归）。已知 `v1`/`v17` 存在**既有** sqlite 直接写入竞合（`database is locked`，与本次改动无关，原代码同样间发）。

---

## 1. 现状盘点

### 1.1 三套助手对照

| 维度 | 音乐助手 | MV 制片助手 | 统一创作助手 |
|---|---|---|---|
| 契约 | v3.1（2026-11-24） | v2.13（2026-11-24 wave-3） | v4.0（2026-11-25） |
| 服务端 | `src/server/l2music/{facade,governance,execute}.js` | `src/server/l2mv/{facade,governance}.js` | `src/server/l2assistant/{facade,core}.js` |
| 入口 | `POST /v1/music/assistant/messages` | `POST /v1/mv/assistant/messages` | `POST /v1/assistant/messages` 等 |
| 工具（7 / 7 / 10） | query_status, set_title, set_card, adjust_params, regenerate, cover, extend | set_title, set_brief, set_queue_mode, script_suggest_edit, shot_reorder, shot_delete, shot_reshoot | assistant.context, assistant.task_query, assistant.ticket_query, library.search, music.query_status, music.set_title, music.set_card, music.adjust_params, work.explain, mv.shot_reshoot |
| 会话模型 | 每会话绑定**一个 subject**（work 或 intent） | 每会话绑定**一个 project** | **全局用户会话** + `surface` + `refs`（work/intent/job/project/shot/persona） |
| 会话表 | `chat_tickets` scope=`music`（会话在 `chat_sessions`? 见 1.3） | `mv_chat_sessions` | `chat_sessions`（scope='global'） |
| 票据表 | `chat_tickets` scope=`music` | `mv_tickets` | `chat_tickets` scope=`assistant` |
| 事件流 | 无（只记结果摘要） | 无 | **有**（`assistant_events` + WSS `assistant.event` + 指标表） |
| LLM 增强灰度 | `assistant_chat_music` | `assistant_chat` | `assistant_chat_music` |
| 付费动作闸门 | 无独立闸（直接发票） | 无独立闸 | `assistant_actions`（**默认关**） |
| App 页面 | `features/create/music_assistant_sheet.dart`（748 行） | `features/mv/assistant_sheet.dart`（659 行） | `features/assistant/assistant_surface.dart`（563 行，`AssistantDock` 全局悬浮） |
| **端侧语音进出** | ❌ 无 | ✅ 有（ASR 听 + VITS 念 + 播放协调） | ❌ 无 |
| 图片上下文 | ❌ | ❌（选角照片走独立流程） | ❌ |

### 1.2 功能开关现状（`src/server/core/appconfig.js` FLAG_KEYS）

| 开关 | 含义 | 默认 |
|---|---|---|
| `music_assistant` | 音乐助手总闸 | 关（`config.music.assistant.enabled`） |
| `assistant_chat_music` | 音乐助手 LLM 增强灰度 | 关（灰度 0.2） |
| `assistant_chat` | MV 助手 LLM 增强灰度 | 关（`config.mv.assistant.chat.grayscale`） |
| `assistant_core` | 统一助手总闸 | **开** |
| `assistant_actions` | 统一助手付费动作 | **关** |

> 四个开关控制三套助手的不同面，**同一能力（LLM 增强）有三个不同的开关**，运营与灰度管理复杂。

### 1.3 端侧语音栈现状（已在仓，可直接复用）

| 能力 | 实现 | 状态 |
|---|---|---|
| ASR（听） | `sherpa_onnx` 1.13.8 + `sherpa_asr.dart`：Streaming Zipformer zh-int8（实时）/ SenseVoice zh-en-ja-ko-yue（转写） | 模型按需下载（`speech_model_manager.dart`，首次使用确认后下载） |
| TTS（念） | `sherpa_onnx` VITS zh-ll（端侧）+ `edge_tts`（在线回落） | `speech_service.dart` 统一入口，`speak()` 带播放协调（暂停/恢复） |
| 使用点 | 仅 `mv/assistant_sheet.dart`（语音进出）+ `create/voice_capture.dart`（创作录音）+ `me/speech_settings_page.dart` | — |

> **结论**：端侧多模态的"听/说"能力已具备且经过 MV 助手页验证，只是没有被统一助手和音乐助手复用。

---

## 2. 诊断：为什么现在"不好"

1. **三个入口、三套治理**：同一套已验证的治理范式（白名单 + 参数域 + 注入红线 + 确认票 hash/TTL/ver + 预算熔断 + 拍板权在人）被**复制了三次**（`l2music/governance.js`、`l2mv/governance.js`、`l2assistant/core.js` 各自维护自己的注入正则、票生命周期、熔断）。改一处规则（如新增一条注入红线），要改三处；三处必然漂移。
2. **统一助手能力倒退**：v4.0 统一版只有 10 个工具，**缺少音乐线的 regenerate/cover/extend 和 MV 线的 set_brief/set_queue_mode/script_suggest_edit/shot_reorder/shot_delete**——用户切到统一入口后反而"做不了事"。这是"统一"名实不符的直接原因。
3. **会话模型分裂**：音乐/MV 助手是"一个会话绑一个对象"（切对象就要新会话），统一助手是"全局会话 + refs"。前者上下文浅，后者跨对象但**没有语音、没有图片**。用户体验上两套语义不一致。
4. **无端侧语音（除 MV）**：统一助手和音乐助手只能打字。而项目已投入端侧 ASR/VITS 与"模型按需下载"机制，**能力闲置**。
5. **无多模态输入**：助手只接受 `text`。音乐创作有语音（ASR）、拍照（选角）等输入，但都走独立流程，助手不知道它们的存在。用户无法"看一眼照片问助手"或"口述给助手"。
6. **LLM 依赖没有清晰的端云分工**：当前 LLM 增强全在服务端（:8090），离线时整体退到规则模式。规则模式能跑但**意图覆盖窄**（正则在 3–7 条），体验落差明显。缺少"端侧轻量理解 + 服务端深度理解"的分层设计。

---

## 3. 目标架构

### 3.1 设计原则

1. **一个对话、一个白名单、一套治理**：统一助手（l2assistant）是唯一对话入口与唯一治理核心；l2music/l2mv 的治理逻辑**并入** l2assistant（工具白名单合并、共享 gateTool/票/熔断/注入），各自的**执行动作**继续复用 `l2music/execute.js` 与 `api/mv.js` 的既有派单原语（不重写计费/派单内核）。
2. **端侧感知 + 服务端权威**：
   - 端侧：听（ASR）、说（TTS）、打字、拍照、**本地规则解读**（离线可用）、上下文管理。
   - 服务端：LLM 增强解读（可选）、工具门控、确认票、计费、派单、积分账本、任务执行。
3. **离线可降级**：无网时助手仍能跑规则模式（听 → 本地规则 → 只读操作本地缓存 / 写操作排队等网后走票）。LLM 点 fail-open（现有纪律），**主流程零阻塞**。
4. **拍板权在人**：昂贵动作一律确认票，助手只"建议"，不声称完成（现有纪律全保留）。
5. **全场景 = 19 工具白名单**（§3.3）。

### 3.2 分层图

```
┌───────────────────────── Flutter App（端侧） ─────────────────────────┐
│ AssistantDock（全局，替代 3 个 sheet）                                  │
│   ├── 感知层（端侧）                                                    │
│   │    听: sherpa ASR   说: sherpa VITS / edge_tts   打字   拍照        │
│   │    （复制 mv/assistant_sheet.dart 的语音层 → 统一 surface）        │
│   ├── 本地解读层（端侧）                                                │
│   │    规则意图表（全 19 工具的规则兜底，离线可用）                      │
│   │    可选：端侧小 LLM（D-1 决策）                                      │
│   ├── 上下文层                                                         │
│   │    surface + refs（work/intent/job/project/shot/persona/image）    │
│   └── 状态层：assistant_state.dart（会话/消息/票/事件）                  │
└─────────────────────────────┬─────────────────────────────────────────┘
                              │ REST / WSS（HTTPS）
┌─────────────────────────────▼─────────────────────────────────────────┐
│ Server :7900（业务权威）                                               │
│   /v1/assistant/*  (统一 API，v5.0)                                    │
│   ├── 解读增强：LLM(:8090) 可选 → 失败落规则                            │
│   ├── gateTool：19 工具白名单 + 参数域 + 实体归属（统一）                 │
│   ├── 确认票：chat_tickets scope='assistant'（统一，迁移旧票）            │
│   ├── 预算熔断 + 注入红线（统一，一套正则）                              │
│   ├── 执行：l2music.executeMusicTicketAction / api/mv.executeTicketAction│
│   └── 事件：assistant_events + WSS assistant.event + 指标               │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ 拉单
┌───────────────────────────────▼───────────────────────────────────────┐
│ Executor + GPU engines (unchanged)                                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.3 统一工具白名单（19 个）

| 工具 | 域 | 付费 | 说明 |
|---|---|---|---|
| assistant.context | — | 免费 | 查当前已核验上下文 |
| assistant.task_query | — | 免费 | 查任务/进度 |
| assistant.ticket_query | — | 免费 | 查确认票 |
| library.search | 曲库 | 免费 | 搜作品 |
| work.explain | 作品 | 免费 | 解释作品字段/血缘 |
| music.query_status | 音乐 | 免费 | 查作品/意图卡状态 |
| music.set_title | 音乐 | 免费 | 改标题 |
| music.set_card | 音乐 | 免费 | 调意图卡 |
| mv.set_title | MV | 免费 | 改片名 |
| mv.set_brief | MV | 免费 | 改简介 |
| mv.set_queue_mode | MV | 免费 | 切白天/夜间档 |
| music.adjust_params | 音乐 | **付费** | 自然语言微调 |
| music.regenerate | 音乐 | **付费** | 重新生成候选 |
| music.cover | 音乐 | **付费** | 人格翻自 |
| music.extend | 音乐 | **付费** | 续长 |
| mv.script_suggest_edit | MV | **付费** | 剧本改一版（挂草稿） |
| mv.shot_reorder | MV | **付费** | 重排镜头 |
| mv.shot_delete | MV | **付费** | 删镜头 |
| mv.shot_reshoot | MV | **付费** | 重拍镜头 |

> 只读工具**直执**（免费），写工具**免费直执或发确认票**（昂贵动作走票），与现有 `expensive` 标记完全一致。

### 3.4 多模态输入模型

| 模态 | 端侧 | 服务端 | 进入助手的方式 |
|---|---|---|---|
| 语音（听） | Sherpa ASR → text | — | ASR 结果填入 `text`（MV sheet 已实现） |
| 文本 | 键盘 | — | `text` |
| 图片（选角/参考） | ImagePicker 拍照 | VLM(:8090)/facegate 分析 | 新 `image` ref 类型；助手可"基于这张照片"提问；照片上传走既有 `/v1/mv/image` 或新增统一上传 |
| 语音（说） | Sherpa VITS TTS | — | 助手回执念出（MV sheet 已实现） |

> **图片理解**建议走服务端 VLM（已有 :8090 端点 + facegate），端侧只做拍照与展示。纯端侧 VLM 在安卓上质量/包体代价高，不作为必需（见 D-3）。

### 3.5 端侧 LLM 决策（D-1，关键分歧点）

| 方案 | 描述 | 优点 | 缺点 | 推荐 |
|---|---|---|---|---|
| **A. 服务端 LLM + 端侧规则（默认）** | 保持现状：LLM 在 :8090，端侧跑规则兜底 | 质量高、开发量小、已验证 | 离线时意图覆盖窄 | **推荐为默认** |
| B. 端侧小 LLM（llama.cpp/端侧模型） | 端侧跑小 LLM 做意图解析，完全离线对话 | 真离线、隐私、低延迟 | 包体大、安卓端侧小 LLM 工具调用质量不稳、与规则兜底并存两套逻辑、维护成本 | 作为可选增强（N3 观察项） |
| C. 端侧 LLM 为主 + 服务端增强 | 端侧小 LLM 先理解，复杂点交给服务端 LLM | 兼顾离线与深度 | 最复杂，两套 LLM 编排 | 不推荐 |

> **建议**：先落地 A（保证统一 + 端侧语音 + 全场景 + 离线规则兜底），把架构设计成"解读层可插拔"（端侧规则 / 端侧 LLM / 服务端 LLM 三档可切换），端侧 LLM 在 N3 再评估。这样**不阻塞**当前目标，也保留用户"端侧"诉求的升级路径。

---

## 4. 重构方案（五步）

### Phase 0 · 契约 v5.0 冻结（先改契约后码，项目铁律）
- 在 `CONTRACTS.md` 增补 **v5.0**：统一助手工具白名单（19 个）、`image` ref 类型、多模态消息体（`text` + 可选 `image_ref`）、统一票据（scope='assistant' 为唯一，`music`/`mv` 为迁移态）、功能开关收敛（`assistant_core` + `assistant_actions` + `assistant_chat` 三键，废弃 `music_assistant`/`assistant_chat_music` 的独立语义）。
- 明确"端侧 LLM 可插拔"接口（解读层契约），为 B 方案留位。
- **输出**：CONTRACTS.md v5.0 段 + `docs/musicbox-unified-assistant-plan.md`（本文）。

### Phase 1 · 后端合一（核心）
- **扩展 `l2assistant`**：把 19 个工具并入 `l2assistant/core.js` 的 `TOOLS` 白名单；`prepareWrite`/`executeConfirmed` 覆盖所有 19 个动作（免费写直执、昂贵写发票；付费动作调用 `l2music.executeMusicTicketAction` / `api/mv.executeTicketAction` 既有内核，**不重写**）。
- **合并治理**：`gateTool`/`isInjection`/`fuseCheck`/票生命周期 收敛到 l2assistant；`l2mv/governance.js` 与 `l2music/governance.js` 的公共逻辑抽取到共享模块（如 `l2/governance_core.js` 已有，扩展之），两旧模块退化为薄适配层或移除。
- **会话/票据统一**：
  - 新会话走 `chat_sessions`（scope='global'，surface+refs）；统一助手新票写入 `chat_tickets(scope='assistant')`（本阶段已完成）。
  - 存量 `mv_tickets` / `chat_tickets(scope='music')` 迁移到 `chat_tickets(scope='assistant')`（迁移脚本 + 迁移版本）：**延后至灰度上线阶段（D-4）**。原因：既有 v12 迁移明确「不触碰 MV 表（V13/V16 零回归）」，立即迁移会移动 MV 存量票并破坏 V13/V16；须待统一助手成为主入口、旧入口降级为薄壳（Phase 5）后，再在双写窗口迁移、旧表只读保留再删。本阶段不改 l2music/l2mv/api（零回归铁律）。
- **功能开关收敛**：`assistant_core`（总闸）+ `assistant_actions`（付费）+ `assistant_chat`（LLM 增强，统一一个键，废弃 `assistant_chat_music`）。
- **API**：`/v1/assistant/messages` 接受 `context.refs` 含 `image` 类型；新增/复用图片上传。
- **验收**：扩展 `v19_unified_assistant.test.js` → **V21 统一助手全场景**（19 工具白名单、跨域动作、票迁移、注入红线、熔断、离线规则模式）。

### Phase 2 · 端侧语音到统一面 ✅ 已完成（2026-11-26）
- 把 `mv/assistant_sheet.dart` 的语音层（`_startTalk`/`_stopTalk`/`_speak`/`_coord` + `SpeechService`）抽取为共享 `AssistantVoiceController` + `AssistantVoiceButton`（`features/assistant/assistant_voice.dart`），**接入 `assistant_surface.dart`** 聊天 tab 的输入区。
- 统一 surface 现在支持：长按听 → 实时回显 → 松手写终稿；`autoSpeak` 开时助手回复自动朗读（TTS 优先端侧 VITS，失败回落 edge_tts，`speech_service` 已支持）；无模型时给明确引导（复用 MV sheet 的 `talkError` 文案：「语音输入用的是本机识别，请先到『我的 · 语音能力』下载模型，或直接用打字」）。
- 其它 surface（音乐 / MV / 曲库）的语音层归并到统一 surface 属 Phase 5 薄壳迁移（D-2），本阶段不改动 MV sheet（V13/V16/V17 保持绿）。
- **验收**：Dart 测试 + 手动：统一助手可"听-说"（端侧模型），无模型时给明确引导（复用 MV sheet 的 `talkError` 文案）。→ `assistant_voice_test.dart` 6 用例绿，Flutter 全量 64 绿。

### Phase 3 · 多模态上下文（图片） ✅ 已完成（2026-11-26）
- `REF_TYPES` 增加 `image`；`resolveRefs` 新增 `image` 分支（`SELECT * FROM uploads WHERE id=? AND user_id=? AND expire_at>?`，仅认本用户且未过 72h TTL）；新增 `imageRow(resolved)` 取图行；`contextSummary` 增 `image: '图片'` 标签。
- 助手消息体支持图片 ref；带图时 `facade.js` 的 `describeImage(row)` 用服务端 VLM（OpenAI 兼容 `image_url` base64）给出 1-3 句客观描述，注入 `llmInterpret` 上下文（`图片描述：…`）；**fail-open**：VLM 不可达或读图失败都返回 null，只用用户文字，绝不阻断。
- 新增 `POST /v1/assistant/image`（`api/assistant.js`）：PIPL consent=`true` 前置、20/h 限频、≤8MB、jpg/jpeg/png 扩展名 + magic byte 双重校验、sha256 去重、72h TTL、`kind='assistant'`；返回 `image_id`。未改 `api/mv.js`（V13/V16/V17 零回归）。
- UI：统一 surface 聊天 tab 增拍照按钮（`ImagePicker` 拍照 → 上传 → 挂到待发送消息的 `image` ref）；只传图不打字时自动带「请描述这张图」引导语。
- **验收**：V22（`v22_image_multimodal.test.js`，6/6 绿：图片 ref 归属跨用户拒绝、过期拒绝、VLM 离线降级只用文字、PIPL/consent 继承、`describeImage` fail-open）。

### Phase 4 · 可选：端侧 LLM（D-1 = B 时执行）
- 抽象"解读层"接口：`interpret(text, context, mode)` 可返回规则 / 端侧 LLM / 服务端 LLM 的结果。
- 端侧小 LLM（llama.cpp）作为可选 provider，默认关闭；灰度开关 `assistant_local_llm`。
- 仅当 D-1 拍板为 B 才执行；否则跳过。

### Phase 5 · UI 合一 ✅ 已完成（2026-11-26）
- 保留全局 `AssistantDock`（bottom bar，跨 tab），作为**唯一**助手入口。
- `showMusicAssistant`（`music_assistant_sheet.dart`）与 `showMvAssistant`（`mv/assistant_sheet.dart`）**降级为薄壳**：跳转统一 surface 并预绑定 surface/refs（music→`surface:'music'` + work/intent ref；mv→`surface:'mv'` + project/shot ref）。MV 详情页/向导页的"制片助手"入口随之打开统一 surface。
- 统一 surface 新增 `initialSurface`/`initialRefs`（`showGlobalAssistant`/`AssistantPanel`），`initState` 微任务注入 `assistantContextProvider`（薄壳注入对应 surface/refs；未注入则清空，保证每次打开上下文干净可预期）。
- 旧 sheet 的 `MusicAssistantSheet`/`MvAssistantSheet` 及 provider/models 暂留（`create_flow_sync_test.dart`/`mv_review_fixes_test.dart` 仍引用），待 Phase 6 清理。
- **验收**：`assistant_test.dart` 新增「薄壳预绑定：初始 surface/refs 注入统一 surface 上下文」「薄壳：未注入时上下文清空」2 用例全绿；全量 68 个 Flutter 测试绿，MV/音乐相关零回归。

### Phase 6 · 回归与收口 ✅ 已完成（2026-11-26）
- 全量回归 V1–V22 全绿（125 pass / 0 fail）：V13/V16/V17/V19/V21/V22 零回归，V1–V20 一期纪律保持。
- 新增 V21/V22 绿（V21 现 9/9，含新增 ⑯）。
- CI 语言纪律（mv_lexicon）覆盖统一助手回执：所有回执路径（chat / 读工具 / 错误 / LLM）经 `core.cleanText`→`lex.sanitize` 净化；新增 `v21` V21-⑯ lexicon CI 用例（脏标题下回执不含引擎名/黑话）绿。
- 遗留：Phase 5 旧 sheet 死代码（`MusicAssistantSheet`/`MvAssistantSheet` + provider/models，仍被 `create_flow_sync_test.dart`/`mv_review_fixes_test.dart` 引用）保留，待后续清理（删除需同步移除对应测试，属独立重构）。

---

## 5. 数据 / 迁移

| 变更 | 说明 |
|---|---|
| `chat_sessions` | 已有（scope='global'）。新增 `refs` 支持 `image` 类型。 |
| `chat_tickets` | 已有（scope='assistant'）。迁移 `mv_tickets` 与 `chat_tickets(scope='music')` 到 scope='assistant'。 |
| `mv_tickets` / `mv_chat_sessions` | 迁移后只读保留 1–2 个版本，再删（迁移脚本 + 备份）。 |
| `assistant_events` | 已有，统一事件流；旧 MV/音乐助手的历史结果摘要可迁入（可选）。 |
| `feature_flags` | 新增 `assistant_local_llm`（可选）；收敛旧键。 |

> **迁移纪律**：迁移脚本幂等、先备份、可回滚；迁移期间旧 API 仍可读写（双写窗口），迁移完成后再关旧表。

---

## 6. 风险与对冲

| 风险 | 等级 | 对冲 |
|---|---|---|
| 三套治理合并期间行为漂移（票/熔断语义变化） | ★★ | 合并前先用现有 V16/V17/V19 锁住行为；合并后 V21 断言全量；双写窗口 + 回滚 |
| 票据迁移丢单/重复扣费 | ★★ | 迁移脚本幂等 + 事务；迁移后旧票只读；计费唯一落点不变（dispatchMusic/executeMusicTicketAction） |
| 端侧 LLM（若选 B）包体/质量 | ★★ | 默认不开；N3 再评估；可插拔架构不强制 |
| 图片理解走服务端 VLM 的隐私/PIPL | ★★ | 继承既有 consent + 72h TTL；用户可拒绝；端侧只拍照不落库 |
| 统一 surface 承载 19 工具，意图歧义上升 | ★ | 规则兜底 + LLM 增强 + 确认票（付费动作必须用户拍板）；"不确定时 tool=null 追问"纪律保留 |
| UI 合一破坏现有 MV/音乐流程 | ★ | 旧 sheet 降级为薄壳（不删除）降低风险；分步灰度 |

---

## 7. 决策点（待发起人拍板）

| # | 决策 | 拍板结果（2026-11-26） |
|---|---|---|
| **D-1** | 端侧 LLM 是否必需 | ✅ **A**：服务端 LLM + 端侧规则兜底；架构留可插拔口，端侧 LLM 作 N3 可选增强 |
| **D-2** | 旧 music/mv 助手 sheet 处理方式 | ✅ **降级为薄壳**：保留入口，跳转统一 surface 并预绑定 surface/refs |
| **D-3** | 图片理解位置 | ✅ **服务端 VLM**：端侧只拍照，:8090 VLM/facegate 分析，继承 consent + 72h TTL |
| **D-4** | `assistant_actions`（统一付费动作）开启时点 | ✅ **保持关，V21 绿后灰度开** |

---

## 8. 与既有决策（二期 §11）的兼容

- 与 **D11**（N1 规则版、N2 对话版灰度 20%）一致：本方案 Phase 0–3 就是"规则版统一 + 对话版灰度"，可对齐 N2 节奏。
- 与 **D4**（Inkling-2-Mini 上 :8090 后开对话版）一致：LLM 增强仍走 `assistant_chat` 灰度，模型名以 `/models` 为准。
- 与 **D13**（预算护栏）一致：统一熔断沿用 120% 规则。
- 与 **V16** 治理断言一致：白名单外工具到不了执行层、参数注入必剥、注入红线全拒、票生命周期、LLM 离线不装忙——全部在 V21 继承。

---

## 9. 工作量与节奏（粗估，1 人 + agent）

| Phase | 内容 | 人日 | 依赖 |
|---|---|---|---|
| Phase 0 | 契约 v5.0 | 1–2 | — |
| Phase 1 | 后端合一 + 迁移 | 5–7 | Phase 0 |
| Phase 2 | 端侧语音到统一面 | 2–3 | Phase 1 |
| Phase 3 | 多模态图片 | 3–4 | Phase 1 |
| Phase 4 | 端侧 LLM（可选） | 5–8 | D-1=B |
| Phase 5 | UI 合一 | 2–3 | Phase 2/3 |
| Phase 6 | 回归 + V21/V22 | 3–4 | 全部 |

> 不含 Phase 4（可选）：约 **16–23 人日**，可拆成 2–3 个里程碑交付（Phase 0–1 → Phase 2 → Phase 3/5/6）。

---

*本文是评估稿。拍板 D-1/D-2/D-3/D-4 后，转入契约 v5.0 冻结与施工（先改契约后码）。*
