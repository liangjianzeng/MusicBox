# MusicBox · AI 音乐创作 App（端云协同）

面向普通用户的"说一句话/拍一张照 → 得到一首歌"的音乐创作应用：Flutter 端 + Node 零依赖服务端 + 拉单式执行器（GPU 引擎在剧场侧只读复用）。**服务端/执行器零 npm 依赖**（只用 `node:` 内建，DB 用 `node:sqlite`，Node ≥22）。

## 三文档地图（先读这三个，再动代码）

| 顺序 | 文档 | 回答什么 |
|---|---|---|
| 1 | [docs/musicbox-assessment-and-plan.md](docs/musicbox-assessment-and-plan.md) | 做什么、给谁用、产品口径 |
| 2 | [docs/musicbox-architecture-design.md](docs/musicbox-architecture-design.md) | 怎么做：拓扑、服务端设计、API/序列 |
| 3 | [docs/musicbox-construction-plan.md](docs/musicbox-construction-plan.md) | 何时做谁做：WBS、里程碑、**§5 验收 V1–V12** |

**[CONTRACTS.md](CONTRACTS.md) = 冻结契约 v1，是多智能体并行施工的唯一接口真源**（REST/WSS/执行器拉单协议/积分口径/文件归属）。任何接口改动必须先改 CONTRACTS.md，再改代码，再回归 `test/acceptance/`。

## 快速开始

```bash
# 0) 前置：Node ≥22（本机 v25 ✓）；ffmpeg 二进制（执行器机，施工计划 §2 待装）
#    ffmpeg 三种供法任选：PATH；或环境变量 MB_TEST_FFMPEG=<绝对路径>；
#    或放到 test/acceptance/tools/ffmpeg/ffmpeg.exe（验收自带目录，git 忽略二进制）

# 1) 起服务端（:7900，运行时数据自建 var/）
node src/server/index.js

# 2) 起执行器（mock 模式：无 GPU 也产出有效正弦 wav，契约 §0）
EXECUTOR_MOCK=1 node src/executor/index.js

# 2b) 真机模式（2026-11-23 实测跑通的四件套，开发机即 5060 Ti 机）：
#     a. ACE-Step（剧场只读复用，venv 启动，惰性加载/用后释放显存）：
#        cd E:/Work/X-Theater/runtime/acestep && ./venv/Scripts/python.exe server.py     # :8190
#     b. SenseVoice worker（独立 venv，勿污染剧场环境；权重缓存在 var/models）：
#        MODELSCOPE_CACHE=E:/Work/MusicBox/var/models MB_ASR_DEVICE=cpu \
#          ./venv-asr/Scripts/python.exe src/workers/sensevoice/app.py                   # :8191
#        （依赖装法：uv venv venv-asr --python 3.12 && uv pip install --python venv-asr/Scripts/python.exe \
#          "torch --torch-backend cpu" funasr modelscope librosa soundfile fastapi uvicorn；
#          app.py 须 trust_remote_code=False——官方仓无 model.py，类由 funasr 内置）
#     c. server 与执行器带上真值端点（去掉 EXECUTOR_MOCK）：
#        MB_LLM_VLM_URL=http://192.168.1.10:8090/v1 node src/server/index.js
#        MB_LLM_VLM_URL=http://192.168.1.10:8090/v1 MB_FFMPEG=E:/Work/X-Theater/runtime/bin/ffmpeg.exe \
#          node src/executor/index.js --api http://127.0.0.1:7900 --token dev-executor-token --lanes music,intent,ffmpeg

# 3) 跑 App（Flutter 在 C:/src/flutter）
cd src/app && flutter run

# 4) 跑验收套件（真自举：另起 server 子进程 + 内置 fake executor，互不干扰）
node --test --test-concurrency=1 "test/acceptance/*.test.js"
```

验收套件要点（`test/acceptance/`，见 `helpers.js` 头注释）：

- **自举**：每套件独立起 `node src/server/index.js`（`MB_PORT` 从 7901 起自动找空口、`MB_VAR_ROOT=var-test/<套件-pid-rand>` 独立前缀、`MB_DEV_OTP=1` 固定验证码 888888、LLM/ASR 端点指向不可达地址以验证契约 §0 确定性兜底）。
- **内置最小 fake executor**（test/ 内自实现，不依赖 src/executor）：poll 领 music job 产正弦 wav→complete；transcode **双向自动选择**——ffmpeg 存在→真实转码（320k mp3 + peaks 400 点），缺失→fail(`FFMPEG_MISSING`)；缺 ffmpeg 时 done 方向用例显式 skip（V4/V8-⑤⑥/V11-②④ 的前置），fail 方向恒执行。可用 `MB_TEST_FORCE_NO_FFMPEG=1` 强制演练缺失方向。
  - ffmpeg 判定是**能力探测**（真做一段正弦 wav→mp3(libmp3lame) 编得动才算存在）：只做视频的精简构建（如某些 IDE 自带 ffmpeg）会被正确判为"缺失"，避免 done 方向假超时。
- **白盒只读 SQLite**（账本 Σdelta==balance、uploads TTL、审计检索）——契约未提供这些查询端点，属兜底检查（偏差清单见下）。
- 当前状态：`node --test test/acceptance/`（目录形式）在 Node 25 会被当模块路径解析而失败，**请用上面的 glob 形式**；`--test-concurrency=1` 避免多套件抢探测到的同一空口。

## 端口表

| 端口 | 服务 | 备注 |
|---|---|---|
| 7900 | Music API（server） | `MB_PORT` 覆盖；`/v1/*` REST、`/ws` WSS、`/f/*` 静态、`/healthz` |
| 7901–7997 | 验收套件 server | 每套件自动找空口（`MB_TEST_BASE_PORT` 改基座） |
| 8190 | ACE-Step 1.5 生乐服务 | 剧场现有，**只读复用**，`MB_MUSIC_URL` |
| 8191 | SenseVoice ASR（CPU） | 执行器同机，`MB_SENSEVOICE_URL` |
| 8090 | 多模态 LLM/VLM | DGX Spark 托管 qwen38-fp4（OpenAI 兼容，**实测真值 `http://192.168.1.10:8090/v1`**，见 CONTRACTS.md §0），`MB_LLM_VLM_URL`；不可达→服务端确定性启发式兜底 |

> **真机部署必配**：`MB_PUBLIC_BASE_URL` 必须设为**手机可达**的地址（如局域网 IP / Tailscale IP），
> 因为 `audio_url`/`audio_master_url`/`waveform_url` 全部由它拼接生成；留默认 `http://127.0.0.1:7900` 则真机播放必挂（2026-11-23 K90 实测坑）。

## 目录树

```
MusicBox/
├── CONTRACTS.md              # 冻结契约 v1（唯一接口真源）
├── README.md                 # 本页
├── CONTRIBUTING.md           # 贡献指南（五条铁律：先契约后代码/零依赖/计费诚信…）
├── LICENSE                   # Apache-2.0
├── SECURITY.md               # 漏洞报告与安全边界自述
├── docs/                     # 评估→架构→施工 三文档
├── src/
│   ├── server/               # 服务端（施工方 A）：index/config/api/core/lanes/prompts
│   ├── executor/             # 执行器 daemon + workers（施工方 B）
│   ├── app/                  # Flutter App（施工方 C）
│   └── workers/              # :8191 / ffmpeg worker 脚本（施工方 B）
├── test/acceptance/          # 验收 V 套件（施工方 D）+ 内置 fake executor
│   ├── helpers.js            # 自举/fake executor/HTTP 客户端/白盒 DB
│   ├── v1_credits.test.js    v2_generate.test.js    v4_library.test.js
│   ├── v8_intent.test.js     v11_compliance.test.js
│   └── v3_v5_v6_v7_v9_v10_v12.skipped.test.js   # 需真机/GPU/真 LLM：断言清单已登记，skip 待前置
├── deploy/                   # 部署脚本（施工方 B）
├── spikes/                   # SP1–SP5 预研（施工方 B）
├── var/                      # 正式运行时数据（server 自建：db/out/uploads/config/logs）
└── var-test/                 # 验收运行时数据（套件自动创建，可随时删除）
```

## 完成度与里程碑对照（2026-11-23）

| 里程碑 | 范围 | 状态 |
|---|---|---|
| M0 生成闭环 | server 骨架/auth+积分/任务引擎+执行器/works API/ffmpeg lane/Flutter 骨架/播放/曲库/VPS+真机 V1–V5 | server 主体已落（api/core/engine/lanes/prompts）；executor/app 施工中；V1/V2/V4/V8/V11 套件就绪 |
| M1 多模态+工具 | intent 线/澄清 Agent/意图卡 UI/微调/人格谱系/DSP/对话壳；V6–V9 | 服务端 intent/adjust 已具雏形；真机与 GPU 项 skip 登记在 skipped 套件 |
| M2 深度+社区 | 歌词编辑器/视频/社区/翻唱/挑战商店/分发；V10–V12 | 未开工；断言清单已登记（skipped 套件） |

待装环境（施工计划 §2）：Android SDK/keystore、Spark 权重（已由 DGX 托管 qwen38-fp4 替代自建 vLLM）、**ffmpeg 二进制（执行器机）**。

## 真机验收记录（2026-11-23 · 红米 K90 Ultra · release 签名包）

无线 adb（Tailscale 直达）+ `MB_PUBLIC_BASE_URL=<手机可达地址>` 全链路通过：

| 验收项 | 结果 | 证据要点 |
|---|---|---|
| 服务器设置页 → 游客首页 | ✅ | 静默游客登录，50 分到账；失败页可改地址重试 |
| 图片意图（真 VLM qwen38-fp4） | ✅ | intent_image 61s；置信度 82% 意图卡自动预填免澄清（办公桌→Lo-fi/Synthwave/电子） |
| 真 ACE-Step 3 候选生成 | ✅ | music job 83s → 3×45s 真曲；transcode×3 出 mp3+peaks；扣 45 分账本正确（daily_used 同步） |
| 揭晓页 | ✅ | 真波形渲染、时长/格式/AI 徽章、微调输入框 |
| 播放（audio_service） | ✅ | `media_session` PLAYING、buffered=整曲；产物 URL 走公网基址可下载 |
| 后台/锁屏播控 | ✅ | HOME+LOCK 后续播；媒体键 85 翻转 PLAYING↔PAUSED；MediaButtonReceiver 注册 |
| 三档模式 | ✅ | 傻瓜/标准/深度切换与标准档参数面板实操 |
| adopt → 曲库 | ✅ | adopt 200（ai_label/lineage/seed 完整）；白屏修复（audio_service 三件套，见 MainActivity/Manifest）后渲染正常 |

发布包：`builds/MusicBox-v0.1.0+1-release.apk`（**不入仓**，构建产物；`flutter build apk --release`，签名走 `android/key.properties`→外部 keystore，**密钥文件不入仓**）。

## 已知契约偏差（验收驱动清单，server 施工方处理）

**A. 契约未固化 → 测试钉死为环境约定**（server 现实现已对齐，建议回写 CONTRACTS.md）
- env 命名：`MB_PORT / MB_DEV_OTP / MB_VAR_ROOT / MB_EXECUTOR_TOKEN / MB_PUBLIC_BASE_URL / MB_LLM_VLM_URL / MB_MUSIC_URL / MB_SENSEVOICE_URL`（契约只写语义未定 env 名；测试同时传 `PORT/DEV_OTP` 兼容）。
- 审核词库路径固定为 `var/config/moderation_words.txt`（随 `MB_VAR_ROOT` 派生）；契约未固化词库路径。
- `POST /v1/works/:id/adopt` 的 `:id` 段被服务端忽略（实际按 `{candidate_id}` 定位）——契约该端点的路径语义待勘定。

**B. 行为与契约不符**（对应断言保持红/skip，不放宽）
- **DEV-TXFAIL**（✅ 2026-11-23 已裁决关闭）：transcode 连败置 failed 后父 music job 降级 **done**（wav master 直发、format='wav'、meta.degraded=true、不退款）曾与契约原文冲突。主会话裁决降级语义正确（生成本身成功、产物真实可播；转码失败属环境侧），已回写 CONTRACTS.md §2「降级语义」块，V2-⑤ 改断降级 done。**双方向回归全绿**：带 ffmpeg 28 过/0 红，`MB_TEST_FORCE_NO_FFMPEG=1` 18 过/0 红（余为环境前置 skip）。
- **DEV-CARD**（✅ 2026-11-23 真机验收时收口）：契约 §4 规定执行器编译 IntentCard 并 complete(result=IntentCard JSON)；server 曾把结果卡丢弃、二次调 LLM 重编译（真机实测字段漂移：执行器 conf 0.82 → 落库 0.78）。已改为 `completeIntent` **有效结果卡原样尊重**（normalizeCard 校验通过后直接使用），审计留痕 `intent.card.respected source=executor`；仅在结果卡无效时才回落 server 侧编译。真机双通道验证：语音（ASR"雨夜灯塔与过去和解"→ 治愈流行/民谣 + ≤2 题带推荐）与图片（测试卡图 → 合成器波/芯片音乐 conf 0.82）全链通过。
- **DEV-ADOPT-LINEAGE**（✅ 已证伪）：原观察（adopt 落库 lineage 恒 origin）出自缺 ffmpeg 机器上被 skip 的 done 路径之代码阅读，未运行。实测 adopt() 正确回读来源 job 的 `payload.lineage`（works.js），`scripts/e2e_smoke.mjs` 第 9 步运行时钉死：adjust 子代 `lineage={kind:'adjust', parent_id:母work, depth:1}` 且母 work `children_count≥1`，21/21 全过。
- **DEV-ADJUST-200**（✅ server 侧发现并已修）：adjust 成功曾回 202（沿用 generate 受理码），契约 §2 规定 200 `{understood:true, job_id}`；works.js 已改，由 V4-④、V8-⑤/⑥ 与 e2e 第 9 步三方钉死。
- **DEV-LIMIT**（✅ 已实现）：listWorks 支持 `limit`（1..50，默认 20），V4-⑤ 真实演练 cursor 分页不重不漏。
- **DEV-BODYLIMIT**（✅ 2026-11-23 真机验收发现并修复）：executor complete multipart 上限曾为 20+2MB——mock 正弦 wav 太小从未暴露；真机 45s 立体声 WAV≈8MB/候选，3 候选即超限，job 反复回队。`maxUploadMb` 改为可配（`MB_MAX_UPLOAD_MB`，默认 220，覆盖 4×240s≈170MB）。
- **DEV-LADDER-PAY**（✅ 2026-11-23 真机验收发现并修复）：重试降档梯子曾裁剪 `count`/`sec`——用户付 45 分（3 候选×45s）被静默降为 1 候选×半时长且**不退款**，违反账本诚信。修正：music ladder 改为恒等（重试保真重跑，至多 failed+全额 refund）；日后减负只降技术档位、不降计费交付维度。
- 用例侧勘误（2026-11-23 主会话复核）：V4-② 的 bpm 断言曾把 A(140)/C(120) 数值写反（服务端过滤本就正确）；V4-⑤ 与 V4-③ 存在顺序冲突（③ 将 B 置 private，⑤ 用例内先复位）——均已在测试内修正并注明。
- **DEV-LEDGER/DEV-TTL/DEV-AUDIT**（白盒兜底）：契约缺账本/uploads TTL/审计查询端点，验收只读 SQLite 核对；server 后续应提供受鉴权的查询面。

逐条现状见 `var-test/suite-*.log` 与 test/acceptance 各文件的断言消息（每条都写明违反的契约条目）。

## 许可证

[Apache-2.0](LICENSE)。贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)（契约先行、零依赖、计费诚信等五条铁律）；安全漏洞报告见 [SECURITY.md](SECURITY.md)。

运行时数据（`var/`：DB/令牌/音频产物/审核词库/模型权重）、签名密钥（`android/key.properties` 与 keystore）、构建产物（`builds/`、APK）与 Python venv **均不入仓**——克隆后按「快速开始」自建。
