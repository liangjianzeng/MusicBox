# MusicBox · 二期 MV 创作方案（产品 · 技术 · 施工）

| 项 | 内容 |
|---|---|
| 文档 | docs/musicbox-phase2-mv-plan.md |
| 日期 | 2026-11-23 |
| 输入 | 一期三文档（评估/架构/施工）+ CONTRACTS.md v1；X-Theater 剧场实现调研（流程/引擎/合规实证）；DGX Spark 实机勘探（SURVEY/EVIDENCE，2026-11-21/22）；发起人三期指示（①二期后台 Linux 部署直接上 DGX，5060 Ti 扛不住二期模型算力；②MiniMax 全家桶首选、Spark 上已有 ACE-Step 1.5、其他模型暂不考虑、LLM 助手待 :8090 vLLM 换装 Inkling-2-Mini 后启用；③MusicBox 是纯独立项目仅做安卓手机端，借鉴剧场经验但外部 ComfyUI 等算力与模型共用） |
| 范围 | MV 产品定义 / 创作流程 / 引擎矩阵 / 数据模型 / API 契约增量（草案）/ 执行器扩展 / App 扩展 / 部署拓扑 / 积分口径 / Spike / WBS / 验收 V13–V15 / 风险 / 待拍板 |
| 状态 | 待拍板（§10 决策清单）；拍板后 CONTRACTS.md 升 v2 冻结，端云并行施工 |
| 前置 | 一期调测收尾不阻塞二期设计；N0 开工只需契约冻结 |

---

## 0. 结论速览（TL;DR）

1. **产品**：底部导航新增第 5 个 tab「MV」，入口 = 曲库选一首已完成的歌（或详情页「用这首拍 MV」），走「**选角 → 定妆 → 剧本 → 分镜 → 开机 → 成片**」六步；**歌唱曲（lyrics 非空）与纯音乐（instrumental）双形态**——前者歌手出镜演唱且口型必须对上已制成曲音轨（二期核心技术难点），后者按剧本表演性质拍摄、成片铺已制曲、无口型要求。
2. **算力与引擎（发起人定调）**：二期一切重算力放 **DGX Spark（Ubuntu 24.04 aarch64，GB10，121GB 统一内存）**；模型首选 **MiniMax 全家桶**（H3-Image 生图/定妆/分镜 + H3 FL2VA/REF2VA i2v 拍摄，Spark 热集已就位、剧场实测全绿），**Wan/LTX 等其他视频模型暂不考虑**。MiniMax 体系无「给定音频驱动对口型」能力，**口型同步引擎（EchoMimicV3-Flash 首选 + MuseTalk 兜底）是二期唯一新增模型**（Apache/MIT，可商用），以 Spike 实测定档。
3. **借鉴剧场，不耦合剧场**：纯独立项目，零代码依赖；**复用三层**——①流程与纪律（八阶段「先案头后生产」、样片优先、报价卡、试妆试镜身份链、facegate 评分门、重拍 chips、免费自动重试）；②协议范式（ComfyUI 四元组锁 tmpl_sha16、h3ir 六段式 IR、降级梯子、worker_type 诚实标注）；③**算力与模型共用**（Spark 上的 ComfyUI `:8188` 队列、H3/LTX/TE 权重热集、`:8090` vLLM LLM 端点、Spark 上的 ACE-Step 1.5）。剧场服务器与代码零改动，沿用「只读复用」红线。
4. **部署**：二期 MusicBox 后台（server `:7900` + 执行器）整体部署到 **Spark（Linux）**；5060 Ti 只保留一期现状（ACE-Step `:8190` 共用 + 开发调测机），二期不新增任何模型。App 仍连同一 API（VPS/Nginx 前置不变），**安卓手机端是唯一前端**。
5. **口型主链路（本方案核心设计）**：分镜时按歌词↔时间窗逐镜分配唱段 → `mv_align` 音轨强制对齐出逐句时间戳 → 角色镜 i2v 只拍「对镜演唱」表演画面（原生声画丢弃）→ 按镜头时间窗切已制曲音轨 → lip-sync 引擎按指定音频驱动口型 → 合成时全片统一铺已制曲 master。辅以前置依赖：**歌词↔时间轴强制对齐**（SP-MV-2）。
6. **节奏**：Spike 前置（SP-MV-1 口型质量 = 全案最大风险）→ **N0 无口型闭环**（tab→选曲→上传人像→定妆照+定妆视频，~1.5 周）→ **N1 纯音乐 MV 全链**（剧本/报价/开机/合成，~2 周）→ **N2 歌唱 MV**（对齐+口型+质量门，~2 周）。验收续编 **V13–V15**，mock 先行真机后置（一期纪律）。

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

**剧场最大缺口 = MV 最大难点**：剧场 lipsync lane 是 TODO（EchoMimicV3-Flash 选型未接线），一期靠原生声画规避台词口型；MV 的「演唱对口型」不可规避——这是二期唯一必须新建的引擎能力（§4.7）。

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

**② 选角**：选「男/女主演」各 0–1（合计 1–2）；每个角色三选一：**(a) 上传照片 / 拍一张**（consent 弹窗「仅用于本次角色生成，不用于训练」+ 72h TTL，一期范式）；**(b) AI 生成歌手**（不传真人照，H3-Image 原创脸——降 PIPL 面与入口门槛，推荐默认露出）；**(c) 复用已有角色**（角色卡沉淀，见 §4.3 mv_characters 复用 `used_by`）。

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
- 完成通知 → 「首映礼」揭晓 → 采纳（mv 作品入库）/ 重拍单镜（chips：脸不像/动作不对/不像在唱/景别不对/节奏不对 → 诊断卡→免费补拍或重派）。

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
| 合成 | **ffmpeg**（executor ffmpeg lane 视频扩展，§4.5.4） | CPU | 一期基建 |
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

## 5. 积分口径（config.credits 扩展；可调，先扣后派单+失败 refund）

| 项 | 值 | 说明 |
|---|---|---|
| mv_script / mv_preview / mv_align | **0** | 案头与样片免费（样片优先的体验前提） |
| mv_cast_image | 10/角色 | H3-Image ×3 候选 |
| mv_cast_video | 20/角色 | 定妆视频+抽帧评分 |
| mv_storyboard | 5/镜 | 关键帧 |
| mv_shot | **40/镜**（quality） | H3 拍摄；fast 档 15 留作 N3 |
| mv_lipsync | 20/镜（仅歌唱曲演唱镜） | |
| mv_compose | 10 | |
| 系统自动补拍 | **0**（≤2 次，`initiated_by=system`） | 剧场免费纪律 |

示例：歌唱曲 45s·12 镜（8 演唱镜）≈ 10+20+60+480+160+10 = **740 ⚡**（单主演）；纯音乐 8 镜 ≈ **400 ⚡**。对照每日免费 50 → MV 是「深度玩法/付费向」定位，定价与免费额度关系列 D5 待拍板（可选：注册送大额体验券/首支 5 折）。

---

## 6. Spike 预研（N0 期间穿插；SP-MV-1 最高风险先打）

| # | 内容 | 通过标准 | 产出 |
|---|---|---|---|
| **SP-MV-1** | **口型引擎横评**：同一演唱镜画面 × 真实歌曲段 → EchoMimicV3-Flash vs MuseTalk vs LatentSync(调测档) 三跑 | SyncNet 置信 ≥ 对比基线； sustained note 大张幅不失真；Spark 单镜耗时 ≤5min；内存 ≤16GB | 选型定档 + `mv-lipsync-svc` 原型（runtime 脚本入 `src/workers/lipsync/`） |
| SP-MV-2 | 歌词↔时间轴对齐精度 | 10 首抽检逐句 ±150ms 内 ≥90% | `mv_align` runner + 词典/归一规则 |
| SP-MV-3 | 「对镜演唱表演」i2v 质量：REF2VA 演唱 prompt 的口部可用性、手部穿帮率、保脸分 | face_score≥0.6 ≥80%；口部遮挡 ≤20% | 演唱镜 IR 模板定稿 |
| SP-MV-4 | 定妆流复刻 + **共宿主内存预算**：cast→FL2VA→抽帧→facegate 全程与剧场 :8188/`:8090` 并发共存 | 无 OOM；与剧场任务互不致死；ram_free 水位曲线 | 部署 runbook + 单并发纪律验证 |
| SP-MV-5 | Inkling-2-Mini 接入冒烟（:8090 换装后）：剧本编译质量 vs qwen38-fp4 | JSON 契约合格率 ≥95%；剧本盲评不劣于现档 | AI 助手开闸评估（D4） |

---

## 7. WBS 与里程碑（1 人 + agent 协作口径；括号=传统人日）

### N0 · 无口型闭环 —— 「定妆能看」　净 ~1.5 周（8 人日）
| WBS | 内容 | 工期 |
|---|---|---|
| N0-1 | CONTRACTS v2 冻结（§4.4/§4.5 草案转正）+ config/lanes 注册 + mock 假 mp4 桩 | 1d |
| N0-2 | server `api/mv.js`：projects/image/jobs/cancel + `completeMv*`（仿 completeDsp 回填+入库）+ MIGRATIONS v3 | 1.5d |
| N0-3 | executor `lib/comfy.js`+`lib/h3ir.js`+`lanes/mv.js`（cast_image/cast_video + 抽帧 + facegate）+ 模板入库 sha16 锁 | 2d |
| N0-4 | App：MV tab + 向导壳（步①②③：选曲/选角上传/定妆）+ consent/TTL 复用 | 2.5d |
| N0-5 | Spark 部署（systemd/Node/ffmpeg/`deploy/spark/` 脚本）+ V13 套件真机跑 | 1d |

### N1 · 纯音乐 MV 全链 —— 「能出一部片」　净 ~2 周（10 人日）
| WBS | 内容 | 工期 |
|---|---|---|
| N1-1 | `mv_script` LLM 编译（prompts/ 新增 mv 模板 + 确定性分场模板兜底）+ 剧本编辑 PATCH/CAS | 2d |
| N1-2 | `mv_storyboard`（edit 只换背景壳 + t2i）+ viewRefs 链 + swap 兜底 | 1.5d |
| N1-3 | `mv_preview` 样片 + 报价卡 + `mv_shot`×N 批量派单/进度墙（mv.progress） | 2.5d |
| N1-4 | ffmpeg `mv_compose`（concat/xfade/铺 master/字幕/片名卡/封面）+ 成片入库/首映礼/重拍 chips | 2.5d |
| N1-5 | V14 真机（真 Spark）+ 回归 V1–V13 | 1.5d |

### N2 · 歌唱 MV —— 「口型对上」　净 ~2 周（10 人日）
| WBS | 内容 | 工期 |
|---|---|---|
| N2-1 | `mv_align`（SenseVoice sidecar + 对齐规则）（SP-MV-2 结论） | 1.5d |
| N2-2 | `mv-lipsync-svc`（:8390，SP-MV-1 定档引擎）+ `mv_lipsync` runner + SyncNet 自检门 | 3d |
| N2-3 | 剧本演唱镜规则（唱段分配/副歌对镜/B-roll 穿插）+ 镜界卡乐句点 | 1.5d |
| N2-4 | 兜底降级链（侧背远景+字幕）+ sync 质量观测 sidecar + V15 | 2.5d |
| N2-5 | 公测包（AI 标注/合规文案/隐私政策增补人脸条款复核）+ 回归 | 1.5d |

**N3（观察项，按数据决策）**：fast 档（LTX-2.5 属「暂不考虑」需再拍板）· S2V 音频驱动档 · 角色卡社区复用 · 音乐 lane 并机 Spark（5060 Ti 退役调测）· 分享面板 mp4 切片。

---

## 8. 验收（续编 V13–V15，验收驱动施工；套件模式仿一期：自举 server + FakeExecutor 加 `_mv*` 分支）

| 套件 | 断言（节选） | 期 |
|---|---|---|
| **V13 MV 契约与账本**（mock Spark 可全跑） | 幂等：同参重复 shoot 只一 job 只扣一次；报价卡未 accept 不扣分；取消未拍镜全额 refund；系统补拍零扣（`credits_cost=0`）；mv 产物 `ai_label` 恒 1；人像上传 72h TTL 白盒验证 + consent；`laneOf` 新类型正确路由；mock mp4 可播 | N0 |
| **V14 纯音乐 MV 全链**（真 Spark） | 选曲→定妆（facegate 过门）→剧本（JSON 契约合格率）→样片先出→报价卡→12 镜→成片 mp4（时长=歌长 ±0.5s、音轨=master SHA 一致、竖屏 9:16、AI 角标在）；断点续作（App 杀进程后 project 状态完好）；单并发不 OOM 且与剧场任务共存 | N1 |
| **V15 歌唱 MV 口型**（真 Spark） | 对齐抽检逐句 ±150ms ≥90%；演唱镜 sync_score ≥阈值占比 ≥80%；sync 不过自动免费补样 ≤2；兜底降级镜不阻塞成片；全片音画不同步漂移 ≤±80ms（尾段实测） | N2 |
| 回归 | V1–V12 每期全绿才收口（一期纪律） | 全部 |

---

## 9. 风险登记

| 风险 | 等级 | 对冲 |
|---|---|---|
| **口型质量不达标**（歌唱曲是主卖点，SP-MV-1 全案最大风险） | ★★★ | 双引擎横评 + SyncNet 门 + 免费补样 + 兜底「侧背远景+字幕」形态；极端情况 N2 延期 N1 先上架（纯音乐 MV 不依赖口型） |
| 歌词对齐不准 → 口型/字幕全歪 | ★★ | SP-MV-2 先测；SenseVoice 不达标则换 faster-whisper alignment（仍 CPU 可跑） |
| Spark 吞吐（12 镜 ≈ 1.5–2h/MV）体验崩 | ★★★ | 样片优先（先免费看片）+ 诚实 ETA/位次推送 + 「提交即离开」通知拉回 + 夜间档；单卡排队天然缓冲（拉单架构） |
| 共宿主内存/队列冲突（剧场 :8188、:8090、ACE-Step 同机） | ★★ | MusicBox executor 单并发 + 懒加载释放 + `ram_free` 观测挂起；逃生口=自有 ComfyUI `:8288` 共 models 目录（D1）；绝不 /free/kill 铁律入 executor 代码审查清单 |
| H3 许可义务（商用 UI 标注/营收门槛/区域）与契约「引擎名不上用户面」冲突 | ★★ | 内测口径继承剧场先例（license 元数据+meta.ai_label，用户面匿名化）；公测前法务核（§1.4 备忘），必要时切 Apache 档（届时另行拍板） |
| 人脸/肖像 PIPL（敏感个人信息） | ★★ | consent（限定用途+不训练）/72h TTL/一键删除；**AI 生成歌手**选项分流（D6，推荐默认露出）；成片含真人脸需用户显式勾选「本人或已获授权」 |
| Inkling-2-Mini 未就位/换装抖动 | ★ | 剧本编译走确定性分场模板兜底（一期 LLM 可选性纪律）；助手 flag 开闸（D4），`/models` 跟随模型名 |
| 视频带宽/存储（成片 30–100MB，takes 更多） | ★★ | takes TTL 72h 清理（仿 asset_drafts）；成片限流播放 720p 档；公测前 CDN |
| App 视频栈（新增 video 依赖）拖包体/兼容 | ★ | video_player 官方件；低端机解码失败降级「海报+音频预览」 |
| 一期调测未收口双开战线 | ★★ | 文件面隔离（契约 §5 归属表 + MV 全新增文件为主）；每周五全量回归；N0 不碰 works/intent 既有路径 |

---

## 10. 待拍板决策清单

| # | 决策点 | 建议 |
|---|---|---|
| D1 | ComfyUI 形态：与剧场共用 `:8188` 队列 vs MusicBox 自建 `:8288` 共 models 目录 | **先共用 :8188**（发起人已许共算力；省显存省盘），SP-MV-4 若互扰则切 :8288（executor 仅换 base_url） |
| D2 | 口型引擎定档 | EchoMimicV3-Flash 首选（剧场选型）+ MuseTalk 兜底，SP-MV-1 横评后锁定；**这是二期唯一新增模型**（MiniMax 体系无对口型能力）——请确认 |
| D3 | 双人可对唱 MV 是否 N2 内交付 | 建议 **N1 单主演、N2 顺双人**（REF2VA 双人锚剧场已验）；砍则双人→N3 |
| D4 | AI 助手（对话式改剧本/创意扩写）启用时点 | 跟随 Inkling-2-Mini 上 :8090（SP-MV-5 冒烟过后开 `mv_assistant` 开关；此前仅结构化剧本卡+模板兜底） |
| D5 | 积分定价（§5 表）与免费体验策略 | 建议定价表照案 + 「新用户首支 MV 5 折券」拉新；付费位（订阅含 MV 分）留公测 |
| D6 | 「AI 生成歌手」（免真人照片） | 建议开且默认露出（降门槛+降 PIPL 面）；含真人脸成片强制授权勾选 |
| D7 | 音乐 lane 并机：Spark 上的 ACE-Step 是否接管（5060 Ti 纯调测化） | **N3 再做**（二期 MV 不依赖；动它要重跑 V2 全回归，别和二期搅一起） |
| D8 | mv 独立资源 vs works 扩 kind | **独立 mv 资源**（§4.3），曲库按 kind 过滤展示（音频 work 形状已被契约/端侧多处钉死，动它回归面大） |
| D9 | 预览样片免费档每项目 1 次是否够 | 建议 1 次免费 + 重出 5⚡（防白嫖轮播图） |
| D10 | 公测范围 | 建议 N1 完成即发内测轨道（纯音乐 MV），N2 完成上公测（歌唱 MV）——对齐一期「Google Play 内测先行」口径 |

---

## 11. 调研与证据来源

- **一期基线**：`docs/musicbox-assessment-and-plan.md`、`docs/musicbox-architecture-design.md`、`docs/musicbox-construction-plan.md`、`CONTRACTS.md`；App/服务端触碰文件清单见本次 Explore 调研（root_shell/create shells/work_detail/engine/lanes/api_client/acceptance 模式）。
- **剧场实证**：`X-Theater/docs/theater-product-master-plan.md`（八阶段/卡流/护栏）、`theater-ux-design.md`（体验宪法/报价卡/重拍 chips）、`theater-infer-backend-adr.md`（白名单/许可/毕业机制/Spark 定位）、`theater-mode-plan.md`、`docs/h3-diagram-2-identity.html`（身份链）、`src/server/dag/engine.js`、`dag/adapters/comfy.js`+`h3ir.js`、`dag/workers/{t2v,compose,tts,lipsync}.js`、`api/{episodes,library,postprod}.js`、`runtime/facegate/server.py`。
- **Spark 实机**：`X-Theater/runtime/spark-evidence/SURVEY.md`（硬件/端口/权重台账/脚本）、`EVIDENCE.md`（H3 三模板真跑计时/10/10 回归/许可合规范式/LTX multishot 冒烟）。
- **引擎公开资料**：MiniMax-H3/H3-Image（ModelScope Comfy-Org 镜像 + LICENSE 条款）、MuseTalk（TMElyralab，MIT，实时中文口型）、LatentSync（bytedance，Apache 文本但许可双源不一致→调测档）、EchoMimic（antgroup，V3-Flash 选型见剧场 ADR）。
- **待补登记**：Spark ACE-Step 1.5 端口/实例信息、Inkling-2-Mini 换装时间与模型名（:8090 `/models` 为准）。
