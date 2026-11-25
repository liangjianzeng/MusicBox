# MusicBox · 二期 MV 创作方案（产品 · 技术 · 施工）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-phase2-mv-plan.md |
| 日期 | 2026-11-23 |
| 输入 | 一期三文档（评估/架构/施工）+ CONTRACTS.md v1；X-Theater 剧场实现调研（流程/引擎/合规/AI 辅助实证）；DGX Spark 实机勘探（SURVEY/EVIDENCE，2026-11-21/22）；发起人三期指示（①二期后台 Linux 部署直接上 DGX，5060 Ti 扛不住二期模型算力；②MiniMax 全家桶首选、Spark 上已有 ACE-Step 1.5、其他模型暂不考虑、LLM 助手待 :8090 vLLM 换装 Inkling-2-Mini 后启用；③MusicBox 是纯独立项目仅做安卓手机端，借鉴剧场经验但外部 ComfyUI 等算力与模型共用）+ 终局裁决（共用 :8188、EchoMimicV3-Flash 首选、N1 单主演、选角双通道硬性要求、其余照准建议——§11） |
| 范围 | MV 产品定义 / 创作流程 / 引擎矩阵 / 数据模型 / API 契约增量（草案）/ 执行器扩展 / App 扩展 / 部署拓扑 / **AI 辅助体系（二期重点）** / 积分口径 / Spike / WBS / 验收 V13–V16 / 风险 / 待拍板 |
| 状态 | **决策已全部落定（§11，2026-11-23）**；CONTRACTS.md 升 v2 冻结后端云并行施工。架构细节见 [musicbox-phase2-architecture-design.md](musicbox-phase2-architecture-design.md)，排程与验收细则见 [musicbox-phase2-construction-plan.md](musicbox-phase2-construction-plan.md) |
| 前置 | 一期调测收尾不阻塞二期设计；N0 开工只需契约冻结 |

---

## 0. 结论速览（TL;DR）

1. **产品**：底部导航新增第 5 个 tab「MV」，入口 = 曲库选一首已完成的歌（或详情页「用这首拍 MV」），走「**选角 → 定妆 → 剧本 → 分镜 → 开机 → 成片**」六步；**歌唱曲（lyrics 非空）与纯音乐（instrumental）双形态**——前者歌手出镜演唱且口型必须对上已制成曲音轨（二期核心技术难点），后者按剧本表演性质拍摄、成片铺已制曲、无口型要求。
2. **算力与引擎（发起人定调）**：二期一切重算力放 **DGX Spark（Ubuntu 24.04 aarch64，GB10，121GB 统一内存）**；模型首选 **MiniMax 全家桶**（H3-Image 生图/定妆/分镜 + H3 FL2VA/REF2VA i2v 拍摄，Spark 热集已就位、剧场实测全绿），**Wan/LTX 等其他视频模型暂不考虑**。MiniMax 体系无「给定音频驱动对口型」能力，**口型同步引擎（EchoMimicV3-Flash 首选 + MuseTalk 兜底）是二期唯一新增模型**（Apache/MIT，可商用），以 Spike 实测定档。
3. **借鉴剧场，不耦合剧场**：纯独立项目，零代码依赖；**复用三层**——①流程与纪律（八阶段「先案头后生产」、样片优先、报价卡、试妆试镜身份链、facegate 评分门、重拍 chips、免费自动重试）；②协议范式（ComfyUI 四元组锁 tmpl_sha16、h3ir 六段式 IR、降级梯子、worker_type 诚实标注）；③**算力与模型共用**（Spark 上的 ComfyUI `:8188` 队列、H3/LTX/TE 权重热集、`:8090` vLLM LLM 端点、Spark 上的 ACE-Step 1.5）。剧场服务器与代码零改动，沿用「只读复用」红线。
4. **部署**：二期 MusicBox 后台（server `:7900` + 执行器）整体部署到 **Spark（Linux）**；5060 Ti 只保留一期现状（ACE-Step `:8190` 共用 + 开发调测机），二期不新增任何模型。App 仍连同一 API（VPS/Nginx 前置不变），**安卓手机端是唯一前端**。
5. **口型主链路（本方案核心设计）**：分镜时按歌词↔时间窗逐镜分配唱段 → `mv_align` 音轨强制对齐出逐句时间戳 → 角色镜 i2v 只拍「对镜演唱」表演画面（原生声画丢弃）→ 按镜头时间窗切已制曲音轨 → lip-sync 引擎按指定音频驱动口型 → 合成时全片统一铺已制曲 master。辅以前置依赖：**歌词↔时间轴强制对齐**（SP-MV-2）。
6. **AI 辅助体系（二期重点，§5）**：剧场实证的核心结论是**「辅助好不好用，关键不在模型，在治理层」**——工具白名单、昂贵动作确认票（hash/TTL/一票一次）、注入红线、预算熔断、「拍板权在人、助手只引路」、一切 LLM 点 fail-open + 诚实标注，全部照搬骨架；六步向导逐步落辅助点（选角导演人像预检 / 编剧「改一版」建议 / 卡流多人格 AI 审 / 制片主任报价护栏 / 后期制片诊断卡 / 音乐监制音画报告）+ 手机端 bottom-sheet「制片助手」对话（7 工具白名单 MVP）。**重拍 chips→诊断卡→系统动作**的反馈翻译层在剧场是未落地的设计态（仅原型），**二期领先实现**（§5.3）。
7. **节奏**：Spike 前置（SP-MV-1 口型质量 = 全案最大风险）→ **N0 无口型闭环**（tab→选曲→上传人像→定妆照+定妆视频，~1.5 周）→ **N1 纯音乐 MV 全链**（剧本/报价/开机/合成 + 辅助 v1，~2 周）→ **N2 歌唱 MV**（对齐+口型+质量门 + 助手对话版，~2.5 周）。验收续编 **V13–V16**，mock 先行真机后置（一期纪律）。

---

## 1. 现状输入（二期开工的地基）

### 1.1 一期现状（调测中，不阻塞二期设计）

| 资产 | 状态 | 二期用法 |
|---|---|---|
| server（零依赖 Node ≥22、任务引擎/租约拉单/积分账本/审核软门/WSS） | 主体已落，V1/V2/V4/V8/V11 套件绿 | 全量承载 MV 任务类型；契约升 v2 |
| 执行器拉单 daemon + lanes（music/intent/ffmpeg） | mock+真机双模跑通 | 新增 imgspark/vidspark/lipsync/align lane |
| App（底部 4 tab、三档创建 shell、ProgressPage 双通道进度、曲库/详情/迷你播放条） | 一期调测 | 加 MV tab；进度页/积分预检/上传范式直接套用 |
| ACE-Step `:8190`（5060 Ti，剧场只读共用） | 一期音乐生成在用 | 二期 MV 不依赖（音乐已制成）；Spark 上的 ACE-Step 1.5 为后期并机项 |
| SenseVoice `:8191`（5060 Ti，CPU） | 一期意图在用 | 歌词对齐引擎迁 Spark sidecar（§4.7.2） |
| qwen38-fp4 `:8090`（Spark vLLM，OpenAI 兼容） | 一期意图编译在用 | MV 剧本/分镜编译 LLM；**Inkling-2-Mini 换装后经同端点启用 AI 助手**（§4.2.4） |

### 1.2 DGX Spark 实机清单（SURVEY/EVIDENCE 2026-11-21/22 勘探 + 发起人确认）

| 项 | 值 |
|---|---|
| 主机 | GX10（ASUS 版），Ubuntu 24.04 LTS aarch64，内核 7.0.0-nvidia，CUDA 13.0，驱动 580.178.04 |
| 内存/存储 | 统一内存 121GB（Total VRAM 124544MB）；内置 NVMe 916G（余 ~536G）；外置 SSD `/mnt/models-ssd`（root 所有，只读用） |
| ComfyUI | `~/ComfyUI` v0.45.0-40（commit `1e719279f`），venv Python 3.12 + torch 2.12.1+cu130，**`:8188 --listen 0.0.0.0` 已生产运行（剧场在用，`start_comfyui.sh` 幂等）**；custom nodes：ComfyUI-LTXVideo、ComfyUI-Open-H3-Regenerate-2K |
| H3 权重热集（NVMe） | fl2va / ref2va / image 各 20G `int8_convrot`；TE `qwen3vl_32b_nvfp4_awq` 15G；TE-LLM `qwen3.5_9b_w4a8` 6.9G；video/audio/image VAE；fl2v turbo 4/8step + ref2v turbo 4step LoRA；regen2k 精修套件 |
| 实测（裸 POST /prompt 冒烟） | h3-image-cast 定妆照 1024² **14.91s/图**；h3-fl2va 768×1344·5.17s **286.5s/镜**；h3-ref2va 保脸 **260.4s/镜**（turbo4，TE+DiT 动态分页无 OOM，原生声画直出） |
| 其他在机 | `:8090` vLLM qwen38-fp4（ctx 262144；**即将换装 Inkling-2-Mini**）、`:8080` SearXNG、`:3080` open-webui、**ACE-Step 1.5（发起人确认已在机，端口待登记）**、LTX-2.5/Music3-Comfy/DeepSeek 等冷集（SSD 软链） |
| 共用纪律 | 共宿主机**绝不改动他人服务**；端口避让已占用清单（22/53/2222/3080/3350/3389/5201/8080/9230/11000/17670/45893/55319/64038/8085/8088/8089/8188/8090）；热权重 NVMe、同族常驻不 `/free`；SSH：`Windows OpenSSH → DgxSpark`（tailnet） |

### 1.3 剧场可借鉴清单（流程/纪律/协议——只借方法，不引代码）

| 剧场资产 | 实证 | MV 侧对应 |
|---|---|---|
| 八阶段流水线 + 锁定门（立项→剧本→选角定妆→美术→分镜→关键帧→拍摄→合成） | `docs/theater-product-master-plan.md` §4.3 | MV 六步流程（§3）即其「音乐 MV 化」裁剪版：美术域并入分镜、无租户/剧集概念 |
| 试妆试镜身份链：上传照→cast_init→FL2VA 定妆视频 5.17s→抽帧→ArcFace 逐帧评分→用户拍板固化 viewRefs→「选角度帧+只换背景壳」出分镜图 | `docs/h3-diagram-2-identity.html`、EVIDENCE §4（D6 决策） | MV 定妆流完整复刻（§4.7.1）——**发起人「上传图片→i2v 定妆视频」的剧场原型已验证** |
| song 锚点 + IR「sings」分支（跨镜统一旋律/伴奏/人声）、原生声画 close-mic lip-synced | `api/episodes.js /song`、`adapters/h3ir.js` | 借 IR 结构做「演唱表演镜」；但 MV 要求对口型到**指定音轨**，原生唱段不可指定 → 必须 post-hoc lip-sync（§4.7） |
| ComfyUI 适配器纪律：模板 sha16 四元组锁、`<KEY>` 占位注入、产物识别、ensureFree 只观测 | `adapters/comfy.js` | 移植为 MusicBox `executor/lib/comfy.js`（**永不 `/free`**，§4.5） |
| 报价卡「预计 X 分钟 · 约 Y 分 · 拍 N 镜」+ 样片优先（最贵算力在批准后）+ 预算护栏 + 免费自动重试 ≤2 | `docs/theater-ux-design.md` §3.5、master-plan 护栏 | 全数继承（§2.3 体验纪律），预算维度=积分+分钟双口径 |
| 重拍原因 chips（脸不像/动作不对/…）→ 系统动作翻译；「脸不像」先诊断卡禁静默重扣 | `theater-ux-design.md` §3.4/§6 | MV 重拍交互（§3 步 6），同镜同因 ≥2 强制免费 |
| 规避策略：口型不达标期「画外音+空镜+字幕」（FR-607） | master-plan FR-607 | 口型失败兜底形态（§4.7.4） |
| `/api/studio/mv/build`：选曲+≤12 图→ffmpeg zoompan 轮播 MV | `api/library.js` | **免费预览样片**档（§3 步 5「先看片」），零 GPU 成本 |
| 语音/人脸 PIPL 纪律：consent、72h TTL、最小化 | 一期 contracts §8 + `consent.dart` | 人像上传全套继承 + 「AI 生成歌手」免人脸选项 |
| 制片助手**治理层**：工具白名单 31 项、注入红线（11 条正则+账本留痕）、参数域黑名单键、预算熔断（>120% 会话 broken）、昂贵动作确认票（hash/TTL60s/ver CAS/一票一次）、「拍板权在人，助手只引路」（芯片只描述状态、拍板动作绝不进芯片） | `src/server/l2/{facade,governance,adapter,advisor}.js`、`client/js/views/copilot.js` | MV 助手 MVP 的治理骨架（§5.2） |
| 卡流**多人格 AI 审**：先规则机检（编剧/观众/选角导演/摄影/制片等视角+每卡 rubric），LLM 在线时同人格叠加 `llm_findings`，engine 标签随实态诚实标注 | `dag/workers/aireview.js`、`prompts/index.js buildAireviewSys` | MV 剧本/开机卡审（§5.1④⑤） |
| **suggest 与拍板解耦**：建议只挂草稿不 ver++，apply 才落卡重审；LLM 离线明确 NOT_READY 不装忙 | `api/cards.js:1354-1403`、`l2/tools.js:425-444` | 剧本「让它改改」（§5.1④） |
| **报价/护栏**：分档单价按实测均值（快速≈3min/镜、高价值≈5min/镜）、estimate_ver hash→开机 CAS、>120% 预算 paused 需人工恢复 | `api/episodes.js:22-103`、`rules/budget.js`、`dag/engine.js:308-350` | 报价卡与预算护栏（§3⑤、§5.1⑤） |
| **语言纪律**：单一禁词表（take/seed/prompt/i2v/模型名正则…）＋服务端出话强制 sanitize＋客户端二次幂等过滤＋CI 扫 `/state` | `rules/langlint.js`、`api/state.js:5`、`util.js:54-66` | `rules/mv_lexicon.js`（§5.4） |
| **scriptgen fail-open**：LLM 不可达→工内重试 1 次（带首轮输出回显收紧）→占位分场+FALLBACK_NOTE 如实标注，流程绝不卡死；键名别名容错解析 | `dag/workers/scriptgen.js:11-13、148-225` | mv_script 编译同纪律（§5.1④） |

**剧场两处「设计领先于实现」的缺口 = 二期领先补齐点**：① lipsync lane 是 TODO（EchoMimicV3-Flash 选型未接线），剧场靠原生声画规避台词口型，而 MV 的「演唱对口型」不可规避——二期唯一必须新建的引擎能力（§4.7）；② **反馈翻译层（重拍 chips→系统动作、「脸不像」诊断卡、同因 ≥2 升人工/免费）在剧场生产代码中仅存在于设计与 html-prototype**（`theater-ux-design.md` §3.4 vs `html-prototype/screens-2.js:72,135`；生产实际=自由文本打回+失败梯子）——二期自研落地（§5.3），这恰是手机端「一句话重拍」体验的胜负手。

### 1.4 许可与商用口径（对齐剧场 ADR-001 §4-8 白名单纪律）

| 引擎 | 协议 | 义务 | 定位 |
|---|---|---|---|
| MiniMax-H3（视频）/ H3-Image（生图） | MiniMax Community | 年营收门槛需书面授权；商用 UI 显著标注「MiniMax H3」；区域排除；禁训练他模 | **内测/自产首选**（发起人定调）。继承剧场做法：`license{model:"MiniMax-H3 Community",usage:"attribution"}` + `meta.ai_label`；用户面引擎名仍「自部署·高品质」（契约 §0 纪律不破） |
| EchoMimicV3-Flash | Apache-2.0（剧场选型记录） | — | 口型首选（SP-MV-1 定档） |
| MuseTalk | MIT | — | 口型快档/兜底 |
| LatentSync | license 两处不一致 | **禁商用链路** | 仅调测对比档（剧场 ADR 同判） |
| SenseVoice / ACE-Step / qwen 系 | 可商用 / MIT / Apache | — | 一期既有用序不动 |
| Inkling-2-Mini（:8090 待部署） | 待运维核 | — | 剧本/分镜 LLM 助手（§4.2.4） |

**公测/商业化前合规动作**（登记备忘，对齐剧场「一期自部署内测、二期商业化再触发授权」分期纪律）：营收/托管义务核对 → 购权或切 Apache 档；UI 标注义务与契约「引擎名不上用户面」的冲突届时按剧场 EVIDENCE §4 先例处理。

---

## 2. 产品定义（安卓手机端 · MV 创作）

### 2.1 一句话与边界

**「给好歌配大片」：曲库里任何一首已完成的歌，30 秒提交、离线等待、回来验收一部竖屏 9:16 的 AI 主演 MV。**

- **输入**：曲库作品（adopted work；`lyrics` 非空=歌唱曲，`instrumental`/lyrics 空=纯音乐）+ 可选自拍人像 1–2 张 + 可选一句话创意。
- **输出**：mv 作品（mp4 竖屏 + 封面 + AI 角标 + 许可双标记），挂在曲库「MV」过滤页与 MV tab 的作品区。
- **不做**（二期）：横屏/多画幅、真人跳舞全身动作模仿（Animate 档）、多语言字幕、时间线手工剪辑器、iOS/桌面/Web（**只考虑安卓手机端**）、社区分发（一期 M2 的分享面板顺带支持 mp4）。

### 2.2 双形态（发起人口径的产品化）

| | 🎤 歌唱曲（lyrics 非空） | 🎵 纯音乐（instrumental） |
|---|---|---|
| 内容主线 | **选定男/女歌手演唱演绎形式**：主演对镜演唱为骨架 + 剧情空镜穿插（B-roll 占比 ~40%） | **按 MV 剧本的表演性质**：男女主剧情表演/情景演绎，无演唱义务 |
| 口型 | **硬要求：口型对上已制曲演唱段**（§4.7） | 无口型要求；成片统一铺已制曲音轨 |
| 选角 | 1–2 人（男/女，可对唱双人） | 1–2 人（男女主）；也允许 0 人（纯空镜 MV，风光/意象流） |
| 剧本编译 | 逐镜分配唱段（歌词句 ↔ 时间窗），副歌必给主演对镜 | 按 mood/歌词意境（无词则 prompt/标题）生成情景分场 |

### 2.3 体验宪法（借剧场六条，改写成安卓 MV 场景）

1. **用户说创意，剧组干活**：用户只回答卡片问题（选候选/点确认/给一句话），永不出现 prompt/seed/i2v/lip-sync/LoRA 等词（契约 §0 语言纪律 + 剧场人话原则：take→「重拍」、定妆→「角色试镜」）。
2. **样片优先**：最贵算力只花在用户批准之后——先出 **免费预览样片**（分镜图轮播 × 已制曲混音，ffmpeg-only，~1–2 分钟），用户点「开机开拍」才进 i2v 拍摄。
3. **报价诚实**：开机前必出报价卡「**预计 X 分钟 · 约 Y ⚡ · 拍 N 镜**」；预计耗时按 lane 队列深度 + 实测均值（340s/镜 × 镜数 + 口型与合成附加）动态算；排队位次实时推。
4. **提交即离开**：安卓长任务纪律——MV 制作是 30–120 分钟级异步工程，提交后可杀 App，完成靠 **一期既有通知栈**（WSS 前台 + 前台服务通知）拉回验收；进度墙做成「剧组通告板」（每镜 TaskChip 5 态）。
5. **永不失控**：任何时刻可暂停/取消（canceled 未拍镜全额退）；重拍原因 chips 一键发起；**同镜同因系统自动补拍 ≤2 次且免费**（剧场纪律），同因 2 次不过诚实呈现+人工兜底入口（report）。
6. **抽卡仪式感**：成片揭晓复用一期「卡带翻转」视觉语言 → MV 版「首映礼」动画（片名+主演+海报，点击拉幕播放）。
7. **拍板权在人，辅助只引路**（治理条款，§5）：定妆确认/报价/开机/验收永远是用户手动按钮，助手永不代拍板；昂贵动作必过**确认票**（人话报价+TTL 60s+一票一次）；项目级**预算护栏**（默认 1200⚡，>120% 自动暂停待人工调高）；一切辅助产物**诚实标注**（规则/LLM 叠加），禁静默重扣、禁虚构「模型意见」。

### 2.4 入口与导航（App 挂点已实证）

- **底栏第 5 tab「MV」**（`Icons.movie_creation`）：`root_shell.dart` IndexedStack + NavigationBar 各加一项。MV tab = 「我的 MV」列表（进度中/已完成）+ 顶部「＋ 新 MV」向导入口。
- **曲库详情页** `_moreActions` 加「用这首拍 MV」（`work_detail_page.dart:215-280` 同构扩展）+ 主操作行加同名按钮 → 直达向导步 2。
- **播放器页**（可选）「给这首歌拍 MV」顺路入口。
- MV 作品点击 → MV 详情（播放器 = 一期 video 复用 + 谱系：关联母 work、种子包只读展示）；曲库网格按 `kind=mv` 显示封面卡。

---

## 3. MV 创作流程（六步 · 手机向导）

```
① 选曲 ── ② 选角 ── ③ 定妆 ── ④ 剧本/分镜 ── ⑤ 预览样片→报价→开机 ── ⑥ 拍摄/口型/合成 → 成片验收
   曲库      上传/拍照    i2v 定妆     LLM 可编辑卡流     免费样片+确认      异步·进度墙
   （锁定门：②③④ 每步有确认门，未过不进下一步；⑤ 是计费门——报价卡 accept 才扣分开机）
```

**① 选曲**：曲库列表/详情页发起；带出歌名/时长/mood/歌词（有则）/是否纯音乐。已制曲 = 唯一音轨真源（成片音轨 = audio master，不用模型再唱一遍——这是与剧场原生声画路线的分水岭）。

**② 选角**：N1 单主演（男或女，1 人）；**(a) 拍照/上传照片**（consent 弹窗「仅用于本次角色生成，不用于训练」+ 72h TTL，一期范式）与 **(b) AI 生成歌手**（不传真人照，H3-Image 原创脸——降 PIPL 面与入口门槛）**为发起人明确要求的两条硬通道，向导默认并列露出、不分主次**；(c) 复用已有角色（角色卡沉淀，§4.3 `used_by`）为增值项。含真人脸成片强制「本人或已获授权」勾选。N2 起支持双人（可对唱，D3）。

**③ 定妆**（复刻剧场试妆试镜流，发起人点名「i2v 生成定妆视频」）：
- `mv_cast_image`：H3-Image cast（864×1536 半身棚拍 3 候选，~15s/图）——传照者带 identity reference，AI 脸者按性别+风格描述生成；
- `mv_cast_video`：选中定妆照 → **H3 FL2VA 定妆视频**（736×1312·124 帧/5.17s·turbo4，多角度自然转头+表情，~290s）→ ffmpeg 抽 ~13 帧 → **facegate 逐帧 ArcFace 评分**（传照模式对上传照；AI 脸模式对定妆照互评）→ 用户在帧格里勾选「满意角度」→ **拍板固化 viewRefs 帧库**（后续分镜/拍摄的身份真源，「人是本体、背景是壳」纪律）。

**④ 剧本/分镜**：
- `mv_script`（LLM 编译，秒级免费）：输入 = 歌曲元数据+歌词/结构+mood/bpm+主演+用户一句话创意 → 输出结构化分场分镜 `script{scenes[], shots[]}`，每镜 = {seq, sec, kind(演唱镜/剧情镜/空镜), 景别/运动, 出场角色, 画面描述, **(歌唱曲)唱段歌词句+时间窗**}；镜数建议 8–16（时长驱动：45s 歌 ≈ 10–14 镜，副歌必配主演对镜演唱）。
- 剧本卡可整卡重生成、单镜改文字、删镜、调序、换景别 chips；**分镜关键帧** `mv_storyboard`：剧情/空镜 = H3-Image t2i；**角色镜 = H3-Image edit「人物完全不变…只替换背景与环境」（从 viewRefs 选姿态帧）**——身份保真主路；低分兜底 inswapper `/swap` ×2（剧场门）。
- **分镜衔接（「分镜衔接」点名项）**：镜头边界对齐乐句点（mv_align 时间戳）；相邻镜用「A 镜尾帧 + B 镜关键帧」作 FL2VA 双条件出首帧（剧场 transition 范式，H3 FL2VA 即可，不需 LTX）；其余硬切（MV 主流语法，卡点在副歌进奏）。

**⑤ 预览样片 → 报价 → 开机**：
- 免费档（每项目一次）：分镜关键帧 × 已制曲 → ffmpeg zoompan 轮播样片（1.5–6s/图，剧场 `/api/studio/mv/build` 同法），「非正式画面」水印——**用户先看片再掏分**。
- 报价卡：「预计 X 分钟 · 约 Y ⚡ · 拍 N 镜（含 M 镜对口型）」→ accept 才批量派单（幂等：重复点同 job）。

**⑥ 拍摄 → 口型 → 合成 → 成片**（异步，进度墙=剧组通告板）：
- `mv_shot`×N：角色镜 H3-REF2VA（viewRefs refs≤3 保脸 + 演唱表演 prompt「对镜歌唱、唇随旋律自然开合」），剧情镜 H3-FL2VA（关键帧为首帧）；**拍摄产物原生声画丢弃**（合成期剥离，防串音）；
- （歌唱曲）`mv_lipsync`：按镜头唱段时间窗从 master 切音频 → lip-sync 引擎驱动主演口型 → **sync 自检分**（SyncNet 置信），<阈值自动补样 ×1（免费）；
- `mv_compose`：best-take 归一 → 转场 → **全片铺已制曲 master（唯一音轨）** → 可选歌词字幕（逐句时间戳 drawtext，默认开）→ 片名卡 + AI 角标水印 → mp4；
- 完成通知 → 「首映礼」揭晓 → 采纳（mv 作品入库）/ 重拍单镜（chips → 诊断卡 → 系统动作，§5.3）。

**每步 AI 辅助点速览**（实现细则与治理见 §5，此处只标「谁在哪一步帮你什么」）：

| 步 | 辅助人格 | 帮你什么 | 拍板权 |
|---|---|---|---|
| ① 选曲 | 🎵 音乐监制 | 依据歌词/mood 给「画面基调建议」3 chips（如：雨夜霓虹/公路日出/海边回忆） | 用户可全无视 |
| ② 选角 | 🎭 选角导演 | 人像质量预检（正脸/光线/遮挡→人话提示重拍建议）；风格服装建议 | 定妆确认手动 |
| ③ 定妆 | （克制不主动）| 帧格只标注 facegate 分与「更像你的角度」排序，不评美丑 | 勾选+拍板手动 |
| ④ 剧本/分镜 | 🖋 编剧 + 🎬 分镜师 | 整卡「让它改改」、单镜导演阐述改写、节拍硬校验（首镜钩子/副歌给主演/唱段全覆盖）、卡流 AI 审 | 「改一版」只挂草稿，采纳才生效 |
| ⑤ 报价开机 | 📋 制片主任 | 报价卡（实测均值估价）、预算护栏、档位建议 | **开机永远手动** |
| ⑥ 拍摄成片 | 🎥 摄制组 + ✂️ 后期 + 🎵 音乐监制 | 进度/位次/ETA 人话、重拍 chips→诊断卡→动作、音画对齐报告（句点命中/sync 分布/字幕健康） | 重拍走确认票（用户发起计费时） |

---

## 4. 技术方案

### 4.1 部署拓扑（二期整体上 Spark · Linux；共算力不共代码）

```
┌ 公网 VPS（一期既有，不动）────────────────────────────┐
│ Nginx：TLS/WSS/限流 → 回源 Spark :7900（tailnet 隧道）│
└──────────────▲───────────────────────────────────────┘
               │ HTTPS（App REST/WSS；executor 拉单）
┌ DGX Spark（Ubuntu 24.04 aarch64 · GB10 · 121GB）———— 二期生产主场 ─┐
│ [MusicBox 新增，systemd 托管]                                        │
│  musicbox-api    :7900  Node≥22 arm64，零 npm 依赖，var/ 落 NVMe     │
│  musicbox-exec  ──────── 拉单 daemon，lanes=imgspark,vidspark,       │
│                          lipsync,align,ffmpeg；**单机单并发纪律**     │
│  mv-lipsync-svc :8390   EchoMimicV3-Flash（懒加载/用后释放）          │
│  mv-facegate    :8395   ArcFace /score /swap（insightface，CPU 可）   │
│  mv-asr         :8391   SenseVoice CPU sidecar（对齐用，~2G 权重）    │
│ [共用（他人所有，只调用绝不改动）]                                    │
│  ComfyUI        :8188   ★ 与剧场共队列；H3 全家桶热集；MusicBox       │
│                         executor 只 POST /prompt + 读 /system_stats， │
│                         **永不 /free / 永不 kill**（逃生口=自有       │
│                         :8288 实例共 models 目录，见 D1）             │
│  vLLM           :8090   LLM（qwen38-fp4 → Inkling-2-Mini 换装）      │
│  ACE-Step 1.5   :待登记  Spark 已在机（二期 MV 不用；音乐 lane        │
│                         整体并机时切 MB_MUSIC_URL，5060 Ti 退役调测）  │
└─────────────────────────────────────────────────────────────────────┘
┌ 5060 Ti（一期现状保留）───────────────────────────────┐
│ ACE-Step :8190（剧场共用）＋ executor(music,intent,ffmpeg) ＋ 开发调测 │
└─────────────────────────────────────────────────────────────────────┘
```

**部署要点**：
1. Node 22 arm64、ffmpeg aarch64（`apt` 或 johnvansickle 静态件）、server/executor 同机双 systemd unit（模板续 `deploy/vps/systemd/` 风格，新增 `deploy/spark/`）；`/etc/musicbox/spark-executor.env` 存端点与 token。
2. **拉单架构不变**（ADR-MB-4）：server 与 executor 同机仍走 HTTP 拉单——保留租约/回队/降档全部语义，且未来可把 executor 拆去别的 GPU 机零改动；公网暴露面仍只有 VPS。
3. **内存预算与仲裁**（121GB 统一内存、共宿主机）：MusicBox executor **单并发**（一次一 job，天然串行）；lipsync/facegate/asr 懒加载+空闲释放（一期 ACE-Step 纪律）；ComfyUI 模型加载交给 :8188 队列 + 同族常驻纪律；executor 领单前探测 `/system_stats.ram_free`，低于阈值挂起等待（观测不干预）。真机预算表 = SP-MV-4 交付物。
4. 上传物落 Spark `var/uploads`（NVMe）；成片走一期 `/f/*` 静态面（生产 Nginx 接管），带宽成本进风险表。
5. 5060 Ti 一期不动：V1–V12 回归仍可在开发机跑（mock 模式与 Spark 无关）。

### 4.2 引擎矩阵（MiniMax 全家桶首选；其余暂不考虑）

| 能力 | 首选（Spark 已在/将部署） | 档位 | 实测锚点 |
|---|---|---|---|
| 生图（定妆照/分镜关键帧/AI 脸） | **MiniMax-H3-Image**（`h3-image-cast` / edit「只换背景壳」/ t2i free） | int8_convrot 热集 | 14.91s/图（EVIDENCE 冒烟） |
| i2v（定妆视频/剧情镜首帧驱动） | **MiniMax-H3 FL2VA**（turbo 4-step） | int8_convrot 热集 | 286.5s/镜 @736×1312·5.17s |
| i2v 角色镜（保脸+演唱表演） | **MiniMax-H3 REF2VA**（refs≤9，取 viewRefs≤3） | 同上 | 260.4s/镜，subject reference 保脸 |
| IR 构造 | **h3ir 范式移植**（FL2VA 三字段 / REF2VA 六段式 + `<d>` 唱段 + 帧长 `5+17k` 网格；禁字幕/水印/多格） | MusicBox `executor/lib/h3ir.js` | 剧场全链实证 |
| 口型同步（**MiniMax 体系外唯一新增**） | **EchoMimicV3-Flash**（Apache，~12GB，剧场选型未接线）→ SP-MV-1 定档；**MuseTalk**（MIT）快档/兜底；LatentSync 仅调测 | `:8390` 常驻懒加载 | 待测 |
| 歌词↔时间轴对齐 | **SenseVoice**（CPU，转写+时间戳）+ 规则对齐 | `:8391` | 待测（SP-MV-2） |
| 质量门 | facegate ArcFace（`:8395` /score /swap-inswapper）+ SyncNet sync 分（lipsync-svc 内） | onnx CPU | 剧场 gate 0.6 标定沿用 |
| 合成 | **ffmpeg**（executor ffmpeg lane 视频扩展，§4.5-4） | CPU | 一期基建 |
| 剧本文案 LLM | **`:8090` vLLM**：现阶段 qwen38-fp4（编译兜底可用）；**AI 助手（对话改稿/创意扩写）待 Inkling-2-Mini 部署后启用**（D4） | OpenAI 兼容端点，`MB_LLM_VLM_MODEL` 跟随 `/models` | 一期 intent 同构 |

**明确暂不引入**：Wan2.2、LTX-2.5、CogVideoX、S2V-14B（S2V 作为 N3 观察项：若 lip-sync 双引擎 SP 实测都不达标，再议「音频驱动整片」路线，不阻塞二期）。协议纪律：白名单照旧，新增仅 EchoMimic(Apache)/MuseTalk(MIT)。

### 4.3 数据模型（server `core/store.js` MIGRATIONS version 3+；works 保持音频语义，MV 独立资源）

```sql
mv_projects(id PK, user_id, work_id REFERENCES works, title, kind 'vocal'|'instrumental',
  status 'drafting'|'casting'|'scripting'|'previewed'|'shooting'|'composing'|'ready'|'failed'|'canceled',
  brief, cast_json, script_json,            -- 剧本=结构化源（镜卡逐字段），逐版本 ver++
  preview_url, video_url, cover_url, subtitle_json,
  est_json,                                  -- 报价快照 {shots,minutes,credits}
  credits_cost INT, credits_refunded INT, ai_label INT DEFAULT 1,
  license_model, license_usage, created_at, updated_at);
mv_characters(id PK, project_id, gender 'm'|'f', name, source 'upload'|'ai'|'reuse',
  portrait_upload, cast_image_url, cast_video_url,
  viewrefs_json,                             -- 拍板固化帧库（身份真源，同剧场 st.viewRefs 语义）
  embedding_ref, confirmed_at);
mv_shots(id PK, project_id, seq INT, kind 'singing'|'story'|'broll', sec REAL,
  lyric_from, lyric_to,                      -- 唱段句窗（歌唱曲）
  desc, camera, cast_ids, first_frame_url, storyboard_url,
  status 'draft'|'boardReady'|'clipReady'|'synced'|'locked'|'stale',
  best_take_id, rerolls INT, flags_json);
mv_takes(id PK, shot_id, job_id, engine_tier 'quality'|'fast', video_url,
  lipsynced INT DEFAULT 0, sync_score REAL, face_score REAL,
  origin 'auto'|'user_reshoot', ai_label INT, created_at);
-- jobs 复用一期表：type ∈ mv_*；shots 与 job 1:N（重拍=新 job，rerolls++）
```

**幂等/计费纪律**照一期：`idem_key=hash(user+project+shot+attempt类)`；先扣后派单、失败 engine 自动 refund；系统自动补拍（`initiated_by=system`）`credits_cost=0`。

### 4.4 API 契约增量（CONTRACTS v2 草案——先改契约后码）

```
# MV（新增 api/mv.js，routes 注册进 index.js 模块数组）
POST /v1/mv/projects          {work_id, brief?, characters:[{gender, source:"upload"|"ai", name?, image_id?}]}
                              → 201 {project}                      # 免积分
POST /v1/mv/image             multipart(file; jpg/png ≤8MB; consent 前置) → 200 {image_id}   # 72h TTL 同 intent
POST /v1/mv/projects/:id/cast/confirm  {character_id, cast_image_url}      → 200 {character}
POST /v1/mv/projects/:id/jobs {type:"cast_image"|"cast_video"|"script"|"storyboard"|"preview"|"shoot"|"compose",
                               params?}                              → 202 {job_id, credits_charged, idempotent}
PATCH /v1/mv/projects/:id     {brief?, script_json?, ver}            → 200 {project}   # 剧本编辑 CAS（ver 失配 409 重审）
POST /v1/mv/shots/:id/jobs    {type:"reshoot"|"resync"}              → 202 {job_id}    # chips 参数在 params.reason
POST /v1/mv/projects/:id/cancel                                       → 200 {refunded}
GET  /v1/mv/projects/:id      → 200 {project, characters[], shots[], takes 简}
GET  /v1/mvs                  ?mine=1&cursor → 200 {items:[mv], next_cursor}
GET  /v1/mvs/:id              → 200 {mv}          # 成片详情（含母 work 简卡 = 谱系）
# mv 形状
mv = {id, work_id, title, kind, status, poster_url, video_url, duration_sec, ai_label,
      cast:[{gender,name,thumb_url}], est:{shots,minutes,credits}, created_at}

# WSS 增量（契约 §3）
{type:"mv.progress", project_id, progress, note, shots:[{id,status}]}   # 剧组通告板数据源
# job.progress/job.done 语义不变；拍一镜=一个 mv_shot job，项目进度=jobs 聚合

# 执行器（契约 §4）新增 job payload —— lane: imgspark/vidspark/lipsync/align/ffmpeg
type="mv_cast_image" {gender,desc,portrait_path?,anchor_refs[],seed}          → files{cast_image:png×3}
type="mv_cast_video" {cast_image,seed,motion}                                  → files{cast_video:mp4, frames:[]→服务端抽帧}
     # executor: h3-fl2va(turbo4) → ffmpeg select 抽 13 帧 → facegate /score 逐帧 → result.frames=[{url,score}]
type="mv_storyboard" {shots:[{id,desc,camera,cast_ids,background}], viewrefs{char:[]}}
     # 角色镜=h3-image-edit 只换背景壳（viewRef 姿态帧垫图）；空/剧情镜=t2i → files{board_<id>:png}
type="mv_shot"       {shot{first_frame,refs[],motion,singing,lyric}, project_kind, seed, tier}
     # 角色镜→h3-ref2va；剧情镜→h3-fl2va；files{clip_<id>:mp4}（原生声画保留，compose 剥离）
type="mv_lipsync"    {video, audio_master, win{start_sec,dur_sec}}
     # ffmpeg 切窗音频 → :8390/lipsync{video,audio} → files{synced_<id>:mp4} + result.sync_score
type="mv_align"      {audio_master, lyrics, structure}                         → result.timings=[{line,start,end}]
type="mv_preview"    {board_urls[], audio_master, seg_sec}                     → files{preview:mp4}（zoompan 轮播，免费）
type="mv_compose"    {takes[{video,start_sec,strip_audio}], audio_master, title, subtitles?}
     # → files{mv_video:mp4, cover:png}（片名卡/字幕/AI 角标/首帧封面）
# ComfyUI 模板：模板 JSON 入 MusicBox 仓 templates/ + manifest tmpl_sha16 锁（四元组纪律移植）

# AI 辅助（契约 v2 增补，治理细则 §5.2）
POST /v1/mv/projects/:id/suggest   {note}                    → 200 {suggest} | 409 NOT_READY（LLM 离线不装忙）
POST /v1/mv/projects/:id/suggest/apply {suggest_id, ver}     → 200 {project}   # 建议挂草稿不 ver++，apply 才落盘重审
POST /v1/mv/assistant/messages     {session_id?, text, chips:[{type:"project",id}]}
                                                               → 200 {session_id, reply}|{ticket}|{intent, clarify}
POST /v1/mv/tickets/:id/confirm    {ver, hash}               → 200 {executed}  # TTL60s/一票一次/CAS
POST /v1/mv/tickets/:id/deny                                   → 200 {ok}
GET  /v1/mv/projects/:id/report     → 200 {align_report, sync_dist, phrase_hit, degraded_shots[]}
# 机检字段（face_score/sync_score/ai_review）只读，PATCH 白名单外拒写（§5.5）
```

### 4.5 执行器扩展（`src/executor`，范式全继承）

1. `lib/comfy.js`（新）：剧场 `adapters/comfy.js` **协议移植**——读 `templates/<name>.json`、校验 `manifest.tmpl_sha16`（漂移抛 `COMFY_TMPL_DRIFT`）、`<KEY>` 注入、`POST /prompt` → 轮询 `/history` → `/view` 拉产物；**删 ensureFree 的 /free 调用，只留 `GET /system_stats` 观测**；`/upload/image` 传垫图。
2. `lib/h3ir.js`（新）：六段式 IR 构造器移植，`sings` 分支改写为「表演+对口型预备」语义（不要求模型自己唱准——音轨后驱动）。
3. `lanes/mv.js`（新）：上表 8 个 type 的 runner；错误码族 `COMFY_UNREACHABLE/COMFY_HTTP/COMFY_TIMEOUT/COMFY_QUEUE/LIPSYNC_UNREACHABLE/ASR_UNREACHABLE/FFMPEG_MISSING`；同参数 OOM 不重试铁律。
4. `lanes/ffmpeg.js`（扩）：视频侧——抽帧（`select=not(mod(n,k))`）、切窗音频、剥音轨（`-an`）、zoompan 轮播、concat 归一（`scale+pad` 到 736×1312/24fps/aac48k）、xfade 转场、amix 铺 master、drawtext 字幕、片名卡、封面首帧。
5. server `lanes/index.js`：`imgspark/vidspark/lipsync/align` 注册（timeoutMs：3600s 拍摄 / 900s 生图 / 1800s 口型 / 120s 对齐；ladder：turbo4 steps 恒定，降档只降非计费维度——**计费诚信纪律**）；executor `ROUTE/KNOWN_LANES/pickRunner` 三处登记 + `--lanes`。
6. mock 模式（契约 §0）：`EXECUTOR_MOCK=1` 下 mv_* 产**真实可播假 mp4**（ffmpeg lavfi testsrc+正弦音；无 ffmpeg 则内置 H.264 基线字节桩）与假 timings——保证 V13 无 Spark 全绿。

### 4.6 App 扩展（安卓唯一前端）

| 页面 | 内容 | 复用 |
|---|---|---|
| `mv_page.dart`（tab 主页） | 我的 MV 列表（进度中置顶）＋「＋ 新 MV」 | 曲库网格卡范式 |
| `mv_wizard_page.dart` | 六步向导（步骤条+卡流；每步可退出续作，进度存 project） | create_page 分段范式 |
| 选角步 | 男女主卡 ×（拍照/相册/AI 脸）；consent 门禁 | `voice_capture.dart` ImagePicker+consent |
| 定妆步 | 3 候选定妆照 chips → 定妆视频播放 → 13 帧格勾选（像不像分 chips）→ 拍板 | 一期揭晓页 |
| 剧本步 | 镜卡竖列（景别/描述/唱段徽标），长按改词/删镜/调序；整卡重生成 | Pro shell 表单 |
| 开机步 | 样片播放器（「非正式画面」角标）→ 报价卡（预计 X 分钟·约 Y ⚡）→「开机开拍」 | consent/primary_button |
| `mv_progress_page.dart` | 剧组通告板：每镜 TaskChip 5 态（排队/开拍/对口型/合成/完成）+ 位次与 ETA + 「提交即离开」提示 | ProgressPage 双通道（轮询+WSS `mv.progress`） |
| 成片揭晓 | 「首映礼」→ video 播放 + 采纳入库 + 分享面板（一期 M2 切片顺带） | RevealPage 动画语言 |
| MV 详情 | 播放器 + 母 work 谱系卡 + 重拍入口（单镜 chips） | work_detail_page |

`api_client.dart` 增 `mvImage/mvProject/mvJobs/mvProjectGet/mvWorks`；`credit_guard.dart` 增 `kCreditMv*`；video 播放一期 just_audio 换 `video_player`/`chewie`（新增依赖仅视频面）。

### 4.7 关键技术点

#### 4.7.1 身份一致性链（剧场已验证，直接复刻）
上传照/AI 脸 → `cast_init` 定妆照 → FL2VA 定妆视频 → 抽帧 → **ArcFace 评分门（gate 0.6 + yaw/pitch 惩罚）** → 用户帧格拍板固化 **viewRefs** → 分镜「只换背景壳」edit（低分 → inswapper /swap ×2 → 仍不过 `IDENTITY_GATE_FAIL` 诚实报错）→ 拍摄 REF2VA（viewRefs≤3 垫图）。双人：两角色各一条链，合镜时 IR `subject_definitions` 双人定义 + 文字锚（剧场 cast[1] 范式）。

#### 4.7.2 演唱口型对齐（本方案核心，双支柱）
- **支柱一：歌词↔时间轴强制对齐**（`mv_align`）：SenseVoice 带时间戳转写 master 人声 → 与 work.lyrics 逐句匹配（标点/分段归一 + LLM 兜底对齐）→ `timings[{line,start,end}]`。它是三处公共真源：①分镜唱段分配；②lip-sync 音频窗切取；③字幕。**不达标则口型永远对不准**——SP-MV-2 独立验收（逐句误差 ≤±150ms，抽检 90%）。
- **支柱二：post-hoc lip-sync**（`mv_lipsync`）：i2v 拍摄「对镜演唱表演」画面（不约束其原生音频；compose 剥音轨）→ 按镜头时间窗切 master 音频段（含 0.2s 上下文余量，接缝淡入淡出防吃字）→ EchoMimicV3-Flash 按**指定音频**驱动口型 → **SyncNet sync 自检**（阈值门 + 自动免费补样 ×1）。
- 备选（不进二期主力，N3 观察）：Wan2.2-S2V-14B「音频驱动整片」Apache 干净，但 Spark 吞吐存疑（80GB 档）且画面可控性弱于 i2v+后对口型路线。
- **失败兜底（剧场 FR-607 经验）**：某镜口型 2 次不过 → 自动降级「侧面/背面/远全景 + 表情演绎 + 字幕」——绝不让整片卡死；`sync_score` 全片均值进 sidecar 供质量观测。

#### 4.7.3 分镜衔接与音乐性
镜界=乐句点（timings 驱动，副歌进奏强制换镜）；相邻镜「A 尾帧 + B 关键帧」FL2VA 双条件首帧（运动连续性）；关键动效（甩镜/转场）ffmpeg xfade 只在段落界用；B-roll 穿插节奏 verse 慢切 / chorus 快切（剧本编译规则，词典化：`MOOD_CUT_RHYTHM`）。

#### 4.7.4 吞吐与排队（Spark 单卡现实）
锚点：生图 15s、拍摄 ~290s/镜、口型 2–4 分钟/镜（待 SP-MV-1 实测）、合成 ~3 分钟。45s 歌 12 镜歌唱 MV ≈ **95–115 分钟 GPU**（纯音乐 8 镜 ≈ 45 分钟）。对策：报价卡诚实 ETA + 队列位次推送 + 夜间闲时优先（用户可选「不急，夜间制作」折扣档——对齐剧场夜间队列）+ executor 单并发保内存安全。

---

## 5. AI 辅助体系（二期重点）

> **剧场实证的第一性结论**（`l2/` 治理层 9 文件 + `aireview.js` + `langlint.js` 调研实录）：对话式 AI 辅助能不能用，取决于**治理层**而非模型强弱——助手「能办事」的关键是白名单+参数域+预算熔断+确认票+「拍板权在人」；所有 LLM 点 fail-open + 诚实标注，规则兜底必须独立撑起闭环。MusicBox 一期已具同款地基（`prompts/intent.js` 的 chatCompletionWithRetry/extractJson/词典兜底、`prompts/adjust.js` 的 LLM+20 余条启发式双通道、澄清纪律服务端强制），二期 MV 辅助**复用这套范式做「小而确定」的白名单辅助，不做通用 agent**。

### 5.1 六步向导的辅助点（人格化，规则打底、LLM 叠加、全部白名单）

| 步 | 辅助点 | 输入→输出 | 实现（LLM 优先/规则兜底） | 治理属性 |
|---|---|---|---|---|
| ① 选曲 | 音乐监制·画面基调建议 | work（lyrics/mood/bpm/genre）→ 3 组基调 chips + 一句话理由 | `prompts/mv_assist.js buildToneSuggest`（音乐总监人格；离线→mood→基调词典 `MOOD_TONE` 确定性映射） | 只读 |
| ② 选角 | 选角导演·人像预检 | 上传照 → 正脸/光照/遮挡/分辨率四项人话反馈 + 重拍引导 | facegate 检测 + 规则分档（**LLM 只润色措辞，分数永远机检**） | 只读 |
| ③ 定妆 | 帧格排序（克制） | 抽帧 → facegate 分排序 +「更像你的角度」标星，**不评美丑、不写观感意见** | 纯机检 | 只读 |
| ④ 剧本 | 编剧·「让它改改」 | 现剧本+用户 note → 修改建议挂 `script.suggest`（**不 ver++**），「采纳」才落盘 ver++ 重审（剧场 suggest 纪律） | `buildScriptSuggest`；**LLM 离线 → 409 NOT_READY**，前端退回手动编辑（不装忙） | 建议≠拍板 |
| ④ 剧本 | 编剧·结构化硬校验 | 镜数↔时长、首镜钩子、副歌必配主演对镜、唱段全覆盖（每句歌词有镜可唱）、cast 引用合法、sec 钳制 | 确定性校验器（`mv_validator.js`，借 scriptgen 容错解析：键名别名/枚举外丢弃/独角回填） | 只读（warn 不 fail） |
| ④⑤ 卡流 | 多人格卡审 | 剧本卡/开机卡就绪 → findings（每条=真实规则检查结果，**绝不虚构模型意见**；LLM 在线追加 `llm_findings`），engine 标「规则机检」/「LLM 审查＋规则机检」 | `mv_aireview` job（`initiated_by=system, free:true`，pending 卡免重派） | 只读+免费 |
| ⑤ 开机 | 制片主任·报价护栏 | shots×档位×实测均值（生图 15s/拍摄 290s/口型 ~240s/合成 180s，常数表随真机刷新）→ `est{minutes,credits}`；**estimate_ver hash → 开机 CAS**；项目预算护栏默认 1200⚡，>120% paused（人工调高恢复，不自动） | 纯规则（不依赖 LLM） | 确认票 |
| ⑥ 拍摄 | 摄制组·进度人话 | jobs 账本 → 「拍摄中 7/12 · 已 23 分钟 · 预计还需约 24 分钟」（**已完成镜实测均值×剩余**，无样本→静态表「每镜约 5 分钟（Spark 串行）」）；排队位次=同 lane FIFO；失败=原因人话（错误码→文案 `HUMAN` 映射表） | 纯规则 | 只读 |
| ⑥ 重拍 | 后期制片·诊断卡 | chips → 诊断卡（当前分/疑似成因/修复方案+各自费用）→ 系统动作（§5.3） | 机检数据 + LLM 改写运动描述（离线→词典换运镜短语） | 系统补拍免费；用户发起过确认票 |
| ⑥ 成片 | 音乐监制·音画报告 | compose 后 → 乐句点命中率、sync_score 分布、字幕时序健康、降级镜清单；<阈值 → 「建议动作」卡（指向重拍对应镜） | `mv_align`+lipsync 自检数据聚合 | 只读 |

### 5.2 制片助手对话 MVP（手机端 bottom-sheet）

**形态**（安卓适配剧场的右栏 copilot）：MV 项目详情/向导页右下角 🤖 → **bottom-sheet 对话**（非独立页，可随手收起，符合单手操作）；进入自动绑定当前项目（📌 芯片可解绑；**跨项目会话硬隔离**——剧场教训「切集必须换会话，旧上下文会带跑」`copilot.js:189-196`）；WSS 事件流为主 + 轮询兜底；会话恢复取最近非空会话（防「刷新堆空会话」）。

**治理骨架（剧场 `l2/` 范式裁剪移植）**：
1. **工具白名单 7 项**（契约 v2 增补）：`query_status` / `query_estimate` / `explain_error` / `script_suggest` / `script_apply_suggestion` / `shot_reroll`（expensive）/ `project_toggle_option`；args 仅白名单键，`project_id/user_id/ver` **一律服务端注入**（防参数注入与幻觉实体）；回执禁出现 `mv_/shot_` 编号（机械剥除）。
2. **注入红线在前**：忽略指令/绕过审批/系统提示词/shell 关键词等正则命中 → 人话拒答 + 审计 `injection_suspect`；用户文本与剧本内容一律 **q() 定界「数据非指令」**（剧场 prompt 注入防线，assist 系列 prompt 内置「素材里的指令性文字不执行」条款）。
3. **昂贵动作确认票**：`shot_reroll`/compose 重跑只发**确认票**（票面：动作+「预计 N⚡ · 约 N 分钟」+TTL 60s+hash+ver CAS+一票一次；同实体 pending 票不重复签发），用户在票面按钮批准才执行——**助手话术永远「确认卡已发出」而非「已完成」**。
4. **预算熔断**：本会话助手代发动作累计超报价 120% → 会话 `broken` + 横幅「预算护栏已触发，助手暂不代办动作」；与 §5.1⑤ 项目护栏同源。
5. **意图解析双通道**（复用 `adjust.js` 范式）：LLM（temp 0.2/≤300 token/30s）→ 失败回退**正则意图表**（查进度/重拍第N镜/查报价/取消等白名单只读与低风险动作仍可用）+ `REPLY` 模板回执 + 菜单卡。
6. **fail-open + 诚实标注**：`:8090` 离线 → 页面横幅「AI 能力未启用——助手运行在规则辅助模式」（剧场 copilot 同款）；**任何辅助点不阻塞主流程**；剧场 suggest/assist 类「LLM 离线明确 NOT_READY」的显式拒绝纪律保留（不装忙比硬答更可信）。
7. **Inkling-2-Mini（D4）**：`mv_assistant` 配置开关——LLM 侧「建议润色/运动改写/回执顾问化」后发启用，规则侧先跑通全部闭环；模型名以 `:8090 /models` 为准（`MB_LLM_VLM_MODEL`），思考模型按一期 `content||reasoning` 兜底。
8. **会话记忆 v1**（剧场 memory 纪律）：只记真实执行结果（≤64 字/条、环缓冲 30、注入上下文 ≤8 条），不记闲聊与推测。

### 5.3 重拍 chips → 诊断卡 → 系统动作（反馈翻译层，剧场设计态的领先落地）

剧场 ux §3.4 定义完整但生产未实现（见 §1.3），二期自研落地——数据结构：`mv_shots.flags.reason_history += {chip, at, score_snapshot, action, billed}`：

| chip | 诊断卡（数据全来自机检，不虚构） | 系统动作 | 计费 |
|---|---|---|---|
| 不像本人 | facegate 当前分 + 疑似成因（参考帧遮挡/角度偏/换脸兜底已触达） | 换 viewRefs 高分帧重拍 → inswapper /swap×2 → 2 次不过 `IDENTITY_GATE_FAIL` 转 report | 系统补拍免费 ≤2 |
| 不像在唱 | sync_score + 口部遮挡率（lipsync 自检） | 自动补样×1；仍不过 → 换 B-roll+字幕降级并**明示**（§4.7.2 兜底） | 系统免费 |
| 动作不对 | 该镜运动描述快照 | **LLM 改写运动描述**重拍（离线→词典换运镜短语） | 用户发起=计费（过确认票） |
| 景别不对 | 当前景别枚举 | 该镜景别 chips 改 → 重拍 | 用户发起=计费 |
| 节奏太慢 | 镜 sec ↔ 乐句点映射图 | **回剧本改镜时长，不改视频**（文本编辑免费；改后受影响镜标 stale） | 免费（文本） |
| 太贵了 | 报价明细行 | 减镜/取消剩余镜（未拍全额退）/（N3 有 fast 档时）降档建议 | — |

**铁律**：同镜同因 ≥2 次自动转 report 人工通道，**禁静默重扣费**（剧场 ux §3.4 明文，此处首次成为生产代码）；系统发起的补拍一律 `initiated_by=system, credits_cost=0` 且在通告板明示（一期 refund/账本诚信纪律同源）。

### 5.4 语言纪律（把契约 §0「引擎名不上用户面」做成可执行代码）

- **单一禁词表** `src/server/rules/mv_lexicon.js`（剧场 langlint 移植）：`take→重拍历史 / seed→复刻编号 / prompt→导演阐述 / i2v→开机拍摄 / lipsync→口型校准 / 抽帧→选镜 / LoRA→签名档`；模型名正则（MiniMax|H3|EchoMimic|MuseTalk|SenseVoice|ACE-Step|ComfyUI|vLLM|GGUF|nvfp4|int8|MXFP8…）→「自部署·高品质档」；ASCII 词带词边界，CJK 子串直替。
- **三层净化**：服务端一切用户面出话（助手回执/卡 note/错误文案/WSS note）强制 `sanitize()`；App 端二次幂等过滤；**V16 CI**：GET /v1/mvs* 全部字符串值断言 clean + 正常文案不误伤（防「mistake 含 take」式假阳）。
- H3 商用「UI 显著标注」义务与本条的冲突处理仍走 §1.4 备忘（meta.ai_label 元数据路线 + 公测前法务）。

### 5.5 辅助元数据与审计（诚实标注纪律）

一切辅助产物挂 `assist:{mode:"rule"|"llm+rule"|"off", ts, persona}`；审计记录 `initiated_by: user|system|assistant` 三态；**机检结论（ai_review/sync_score/face_score）只允许机检管线写入**，请求体注入即剥（剧场 `delete payload.ai_review` 防伪造「机检通过」纪律）；V16 断言这些字段不可被 PATCH 伪造。

---

## 6. 积分口径（config.credits 扩展；可调，先扣后派单+失败 refund）

| 项 | 值 | 说明 |
|---|---|---|
| mv_script / mv_preview | **0** | 案头与样片免费（样片优先的体验前提） |
| mv_align | **5** | 歌词↔时间轴对齐（v2 勘误 2026-11-24：原 0→5，对齐架构 §6 与契约 v2 定价表） |
| mv_cast_image | 10/角色 | H3-Image ×3 候选 |
| mv_cast_video | 20/角色 | 定妆视频+抽帧评分 |
| mv_storyboard | 5/镜 | 关键帧 |
| mv_shot | **40/镜**（quality） | H3 拍摄；fast 档 15 留作 N3 |
| mv_lipsync | 20/镜（仅歌唱曲演唱镜） | |
| mv_compose | 10 | |
| 系统自动补拍 | **0**（≤2 次，`initiated_by=system`） | 剧场免费纪律 |

示例：歌唱曲 45s·12 镜（8 演唱镜）≈ 10+20+60+480+160+5+10 = **745 ⚡**（单主演，含 align 5）；纯音乐 8 镜 ≈ **400 ⚡**。对照每日免费 50 → MV 是「深度玩法/付费向」定位，定价与免费额度关系列 D5 待拍板（可选：注册送大额体验券/首支 5 折）。

---

## 7. Spike 预研（N0 期间穿插；SP-MV-1 最高风险先打）

| # | 内容 | 通过标准 | 产出 |
|---|---|---|---|
| **SP-MV-1** | **口型引擎横评**：同一演唱镜画面 × 真实歌曲段 → EchoMimicV3-Flash vs MuseTalk vs LatentSync(调测档) 三跑 | SyncNet 置信 ≥ 对比基线； sustained note 大张幅不失真；Spark 单镜耗时 ≤5min；内存 ≤16GB | 选型定档 + `mv-lipsync-svc` 原型（runtime 脚本入 `src/workers/lipsync/`） |
| SP-MV-2 | 歌词↔时间轴对齐精度 | 10 首抽检逐句 ±150ms 内 ≥90% | `mv_align` runner + 词典/归一规则 |
| SP-MV-3 | 「对镜演唱表演」i2v 质量：REF2VA 演唱 prompt 的口部可用性、手部穿帮率、保脸分 | face_score≥0.6 ≥80%；口部遮挡 ≤20% | 演唱镜 IR 模板定稿 |
| SP-MV-4 | 定妆流复刻 + **共宿主内存预算**：cast→FL2VA→抽帧→facegate 全程与剧场 :8188/`:8090` 并发共存 | 无 OOM；与剧场任务互不致死；ram_free 水位曲线 | 部署 runbook + 单并发纪律验证 |
| SP-MV-5 | Inkling-2-Mini 接入冒烟（:8090 换装后）：剧本编译质量 vs qwen38-fp4 | JSON 契约合格率 ≥95%；剧本盲评不劣于现档 | AI 助手开闸评估（D4） |

---

## 8. WBS 与里程碑（概览）

> **权威排程（含每项 DoD/依赖/施工方/回归节点/关键路径）已迁至 [musicbox-phase2-construction-plan.md](musicbox-phase2-construction-plan.md) §3–§5**，本文只留里程碑概览，避免双处漂移。

| 里程碑 | 目标 | 净工期（1 人 + agent） | 出口门 |
|---|---|---|---|
| **N0 · 无口型闭环**「定妆能看」 | MV tab→选曲→选角（**双通道：拍照/上传 + AI 生成歌手**，D6）→定妆照+定妆视频（facegate 评分→拍板固化） | ~1.5 周（8 人日） | V13 全绿（mock）+ Spark 部署完成 |
| **N1 · 纯音乐 MV 全链**「能出一部片」 | 剧本/分镜/免费样片/报价卡/开机/进度墙/成片 + **辅助 v1（规则版）** | ~2 周（11.5 人日） | V14 真机全绿 + 内测轨道发布（D10） |
| **N2 · 歌唱 MV**「口型对上」 | 对齐/lip-sync（**EchoMimicV3-Flash**，D2）/SyncNet 门/兜底降级/双人（D3）+ **辅助 v2（对话版灰度 20%，D11）** | ~2.5 周（13 人日） | V15+V16 全绿 + 公测包 |
| N3（观察项） | fast 档、S2V 档、角色卡社区、音乐 lane 并机 Spark（D7）、分享切片 | 按数据决策 | — |

**Spike 前置**：SP-MV-1（口型横评，全案最大风险）、SP-MV-2（对齐精度）、SP-MV-3（演唱镜 i2v 质量）、SP-MV-4（定妆复刻+共宿主内存预算）、SP-MV-5（Inkling-2-Mini 冒烟）、SP-MV-6（助手治理红队）——细则见施工计划 §3。

---

## 9. 验收（续编 V13–V16，验收驱动施工；套件模式仿一期：自举 server + FakeExecutor 加 `_mv*` 分支）

| 套件 | 断言（节选） | 期 |
|---|---|---|
| **V13 MV 契约与账本**（mock Spark 可全跑） | 幂等：同参重复 shoot 只一 job 只扣一次；报价卡未 accept 不扣分；取消未拍镜全额 refund；系统补拍零扣（`credits_cost=0`）；mv 产物 `ai_label` 恒 1；人像上传 72h TTL 白盒验证 + consent；`laneOf` 新类型正确路由；mock mp4 可播 | N0 |
| **V14 纯音乐 MV 全链**（真 Spark） | 选曲→定妆（facegate 过门）→剧本（JSON 契约合格率）→样片先出→报价卡→12 镜→成片 mp4（时长=歌长 ±0.5s、音轨=master SHA 一致、竖屏 9:16、AI 角标在）；断点续作（App 杀进程后 project 状态完好）；单并发不 OOM 且与剧场任务共存 | N1 |
| **V15 歌唱 MV 口型**（真 Spark） | 对齐抽检逐句 ±150ms ≥90%；演唱镜 sync_score ≥阈值占比 ≥80%；sync 不过自动免费补样 ≤2；兜底降级镜不阻塞成片；全片音画不同步漂移 ≤±80ms（尾段实测） | N2 |
| **V16 AI 辅助与治理**（mock 可全跑） | 白名单外工具到不了执行层；参数注入（请求体塞 project_id/ver/机检字段）必剥除或拒写；注入红线样例集 11 条全拒答且审计 `injection_suspect`；确认票生命周期（签发→同实体不重复→TTL60 过期→hash/ver 失配拒执行→一票一次）；预算熔断 >120% 会话 broken + 横幅；LLM 离线：suggest→NOT_READY 不装忙、助手回退规则模式横幅可见、主流程（定妆→拍摄→成片）零阻塞；`mv_lexicon` CI：/v1/mvs* 返回全串 clean + 白名单正常文案零误伤；系统补拍 `credits_cost=0` 且通告板明示 | N2 |
| 回归 | V1–V12 每期全绿才收口（一期纪律） | 全部 |

> 套件文件划分、helpers.js/FakeExecutor 改造清单、真机前置与 skip 纪律见施工计划 §6。

---

## 10. 风险登记

| 风险 | 等级 | 对冲 |
|---|---|---|
| **口型质量不达标**（歌唱曲是主卖点，SP-MV-1 全案最大风险） | ★★★ | 双引擎横评 + SyncNet 门 + 免费补样 + 兜底「侧背远景+字幕」形态；极端情况 N2 延期 N1 先上架（纯音乐 MV 不依赖口型） |
| 歌词对齐不准 → 口型/字幕全歪 | ★★ | SP-MV-2 先测；SenseVoice 不达标则换 faster-whisper alignment（仍 CPU 可跑） |
| Spark 吞吐（12 镜 ≈ 1.5–2h/MV）体验崩 | ★★★ | 样片优先（先免费看片）+ 诚实 ETA/位次推送 + 「提交即离开」通知拉回 + 夜间档；单卡排队天然缓冲（拉单架构） |
| 共宿主内存/队列冲突（剧场 :8188、:8090、ACE-Step 同机） | ★★ | MusicBox executor 单并发 + 懒加载释放 + `ram_free` 观测挂起；逃生口=自有 ComfyUI `:8288` 共 models 目录（D1）；绝不 /free/kill 铁律入 executor 代码审查清单 |
| H3 许可义务（商用 UI 标注/营收门槛/区域）与契约「引擎名不上用户面」冲突 | ★★ | 内测口径继承剧场先例（license 元数据+meta.ai_label，用户面匿名化）；公测前法务核（§1.4 备忘），必要时切 Apache 档（届时另行拍板） |
| 人脸/肖像 PIPL（敏感个人信息） | ★★ | consent（限定用途+不训练）/72h TTL/一键删除；**AI 生成歌手**选项分流（D6，推荐默认露出）；成片含真人脸需用户显式勾选「本人或已获授权」 |
| Inkling-2-Mini 未就位/换装抖动（LLM 单点影响全部辅助点） | ★ | **辅助体系设计前提=「LLM 是增强不是依赖」**：规则侧独立撑起闭环（§5.1 每点都有规则兜底列）；suggest/润色类离线显式 NOT_READY；助手降「规则辅助模式」横幅可见；剧本编译走确定性分场模板兜底；换装冒烟 SP-MV-5 后才开闸（D4），`/models` 跟随模型名 |
| 视频带宽/存储（成片 30–100MB，takes 更多） | ★★ | takes TTL 72h 清理（仿 asset_drafts）；成片限流播放 720p 档；公测前 CDN |
| App 视频栈（新增 video 依赖）拖包体/兼容 | ★ | video_player 官方件；低端机解码失败降级「海报+音频预览」 |
| 一期调测未收口双开战线 | ★★ | 文件面隔离（契约 §5 归属表 + MV 全新增文件为主）；每周五全量回归；N0 不碰 works/intent 既有路径 |
| 助手误操作/提示注入（对话式辅助的固有风险） | ★★ | 剧场治理层全套移植（§5.2）：白名单+参数域+注入红线+确认票+预算熔断+拍板权在人；V16 专项断言；LLM 幻觉实体（编造 shot_id/数字）→args 白名单键+服务端注入+回执机械剥编号 |
| AI 辅助范围膨胀（做成通用 agent 拖垮工期） | ★★ | 白名单 7 工具封顶（§5.2），新工具必须过契约评审；「规则先行、LLM 后开」次序（D4）；copilot 剧场有 9 文件治理层的前车之鉴——按裁剪版执行 |
| 诊断卡/chips 自研无剧场生产先例（剧场仅设计态） | ★ | 数据结构从简（flags.reason_history 单一真源）；每 chip 的系统动作全部映射到既有 job 类型，不发明新执行路径；V16 覆盖 |

---

## 11. 决策清单（已裁决 · 2026-11-23）

> 裁决来源：「发起人拍板」= 当日会话明示；「照准建议」= 发起人授权「其他按照你建议最优选择」。**本表即定案**，改动需再走裁决。

| # | 决策点 | 裁决 | 来源 |
|---|---|---|---|
| D1 | ComfyUI 形态 | **与剧场共用 `:8188` 队列**（只发任务+观测，永不 /free/kill）；逃生口=自建 `:8288` 共 models 目录，SP-MV-4 互扰超标才启用（executor 仅换 base_url） | 发起人拍板 |
| D2 | 口型引擎 | **EchoMimicV3-Flash 首选**（剧场选型，Apache）+ MuseTalk（MIT）兜底，SP-MV-1 横评锁定权重档；二期唯一新增模型 | 发起人拍板 |
| D3 | 主演规模 | **N1 单主演；双人（可对唱）N2 交付**（REF2VA 双人锚剧场已验） | 发起人拍板 |
| D4 | AI 助手启用时点 | 规则版辅助点随 N1 上；对话式改剧本/创意扩写**跟随 Inkling-2-Mini 上 :8090**（SP-MV-5 冒烟过后开 `mv_assistant` 开关） | 照准建议 |
| D5 | 积分定价与体验 | §6 定价表照案 + 「新用户首支 MV 5 折券」；订阅含 MV 留公测 | 照准建议 |
| D6 | 选角通道 | **「AI 生成歌手」与「拍照/上传照片」双通道都是硬性要求**，向导默认并露；含真人脸成片强制授权勾选 | 发起人拍板（明确要求） |
| D7 | 音乐 lane 并机 Spark | N3 再做（二期不依赖，避免与一期回归搅动） | 照准建议 |
| D8 | MV 存储形态 | 独立 mv 资源（§4.3/架构 §5），曲库按 kind 过滤展示 | 照准建议 |
| D9 | 预览样片额度 | 每项目 1 次免费 + 重出 5⚡ | 照准建议 |
| D10 | 公测范围 | N1 完成发内测轨道（纯音乐 MV），N2 完成上公测（歌唱 MV） | 照准建议 |
| D11 | 助手对话版发布 | N1 只上规则版；N2 对话版灰度 20% 起观察；`mv_assistant.chat=false` 可整体关闭不影响主流程 | 照准建议 |
| D12 | 反馈翻译层完整度 | N2 全量 6 类 chips+诊断卡；N2 吃紧降级序：先保「不像本人/不像在唱/太贵了」 | 照准建议 |
| D13 | 预算护栏 | 项目级默认 1200⚡，>120% 暂停仅人工调高恢复；助手代发动作单独 120% 熔断 | 照准建议 |

---

## 12. 调研与证据来源

- **一期基线**：`docs/musicbox-assessment-and-plan.md`、`docs/musicbox-architecture-design.md`、`docs/musicbox-construction-plan.md`、`CONTRACTS.md`；App/服务端触碰文件清单见本次 Explore 调研（root_shell/create shells/work_detail/engine/lanes/api_client/acceptance 模式）。
- **剧场实证（流程/引擎）**：`X-Theater/docs/theater-product-master-plan.md`（八阶段/卡流/护栏）、`theater-ux-design.md`（体验宪法/报价卡/重拍 chips/§7 语言表/§12 lint）、`theater-infer-backend-adr.md`（白名单/许可/毕业机制/Spark 定位）、`theater-mode-plan.md`、`docs/h3-diagram-2-identity.html`（身份链）、`src/server/dag/engine.js`、`dag/adapters/comfy.js`+`h3ir.js`、`dag/workers/{t2v,compose,tts,lipsync}.js`、`api/{episodes,library,postprod}.js`、`runtime/facegate/server.py`。
- **剧场实证（AI 辅助层，2026-11-23 专项调研）**：治理层 `src/server/l2/{facade,adapter,governance,tools,advisor,llmintent,modeA,modeB,memory}.js`（白名单 31 工具/注入红线/确认票 hash·TTL60·verCAS·一票一次/预算熔断/「拍板权在人」芯片纪律/会话记忆只记执行结果）；多人格卡审 `dag/workers/aireview.js`（规则机检+LLM 叠加、engine 诚实标签、AIREVIEW_RUBRIC）；suggest `api/cards.js:1354-1403`（挂草稿不 ver++）；scriptgen `dag/workers/scriptgen.js`（fail-open+占位如实标注+工内重试回显）；assist 族 `prompts/index.js`（buildScriptgenSys/buildAssistLyricsSys/buildAssistImageSys/buildSuggestSys）+`prompts/validate.js`；报价/护栏 `api/episodes.js:22-103`+`rules/budget.js`+`dag/engine.js:308-350`；语言纪律 `rules/langlint.js`+`api/state.js:5`+`client/js/util.js:54-66`+`test/cases/V8_state_langlint.js`；copilot 前端 `client/js/views/copilot.js`（芯片按状态推导/hint 横幅/审批面板/跨会话边界）；LLM 基建 `src/server/llm/llm.js`（在线监视/不自动拉起/显存互斥闸）；**未实现项实证**：重拍 chips/诊断卡/同因计数仅存在于 `theater-ux-design.md §3.4` 与 `docs/html-prototype/screens-2.js`。
- **一期 AI 地基**：`src/server/prompts/intent.js`（chatCompletionWithRetry/extractJson/词典兜底/澄清纪律强制）、`prompts/adjust.js`（LLM+20 余条启发式双通道/不识别必追问）、`api/intent.js`（answer 状态机）、`core/rules.js`（审核软门）。
- **Spark 实机**：`X-Theater/runtime/spark-evidence/SURVEY.md`（硬件/端口/权重台账/脚本）、`EVIDENCE.md`（H3 三模板真跑计时/10/10 回归/许可合规范式/LTX multishot 冒烟）。
- **引擎公开资料**：MiniMax-H3/H3-Image（ModelScope Comfy-Org 镜像 + LICENSE 条款）、MuseTalk（TMElyralab，MIT，实时中文口型）、LatentSync（bytedance，Apache 文本但许可双源不一致→调测档）、EchoMimic（antgroup，V3-Flash 选型见剧场 ADR）。
- **待补登记**：Spark ACE-Step 1.5 端口/实例信息、Inkling-2-Mini 换装时间与模型名（:8090 `/models` 为准）。
