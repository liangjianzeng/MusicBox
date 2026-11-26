# MusicBox · MV 收尾路线（MV 肯定要做，怎么做）

> 2026-11-26 制定。前提：MV **继续做**，但先解决"六个从未就位的硬前置"，而不是继续加功能。
> 配套：总体检见 [musicbox-rescue-refactor-plan.md](./musicbox-rescue-refactor-plan.md)。

## 0. 起跑线（本机实测，不是文档里的）

| 项 | 状态 | 证据 |
|---|---|---|
| LLM `:8090` | ✅ 活着，`/v1/models` → `qwen38-fp4` | 实测；但 `etc/spark.env:31` 写 `Inkling2-Mini:vision`，与 `spark.env.example:36` 矛盾 |
| ComfyUI `:8188` | ❌ 未运行 | `ss -ltn` 无监听；`run/comfyui.pid` 死进程 |
| lipsync `:8390` | ❌ 未运行 + **权重从未拉取** | `MB_LIPSYNC_MODELS=var/models` 下只有 `facegate/`；证据文件记 `weights_loaded:false` |
| mv_asr `:8391` | ❌ 未运行（证据记"进程死/降级"） | 逐句 ±150ms 对齐通过率**从未有数据** |
| facegate `:8395` | ❌ 未运行，但权重在（`var/models/facegate` 601M，`buffalo_l`） | 实测 |
| `h3-image-edit` 模板 | ❌ `manifest.json` 仍 `placeholder: true` | 实测（4 个模板里唯一占位的那个） |
| worker ROOTS 默认值 | ❌ 仍是 `/opt/musicbox/var,E:/Work/MusicBox/var` | `mv_lipsync/app.py:13`、`mv_asr/app.py:13-14` |
| 真机 C1 音乐 | ✅ 稳定（唯一真正稳的能力） | deploy/spark 取证 |
| 真机 C2 定妆 | ⚠️ `status=done` 但 **保脸 FAILED**，`face_scores=[0.0036,-0.0302,0.0802]`，**3 候选里混进 1 名男性** | `realdevice-verify-c1c2c3-1126v2.md` |
| 真机 C4–C7 分镜/口型/对齐/成片 | ❌ **0 次通过**，项目终态 `status=failed`，15 镜退 675⚡ | 同上 |
| 真机计费 | ⚠️ 被短路（余额灌到 1,000,050、预算 1,000,000） | `realdevice-test-plan-c1c2c3-1126.md:12` |
| 真机人像合规链 | ❌ C2 用 **H3 生成的定妆图**冒充真人 → 真人像→facegate→consent 从未验证 | `realdevice-verify-c1c2c3-1126.md:17-21` |

**一句话判断**：MV 的"非算力项"确实写完了（六步向导、报价、CAS、治理、降级分支都在），但**一条片从没真机跑通过**。所以路线不是"再写功能"，是"把一条片跑通且可复现"。

---

## M0 · 先定义"一条片跑通"是什么（1 天，最先做）

现在最大的问题不是没做完，是**"通过"没有可比判据** —— 同一批 C2/C3 三份文档给出 ✅/✅/❌，判据从 `status=done` 一路软化到肉眼。

**产出**：`deploy/spark/mv-film-acceptance.md` + `test/acceptance/v24_mv_fullfilm.test.js`（mock 可跑部分）

目标片型（先只做一种，别贪）：**纯音乐 · 8 镜 · 单主演 · normal 档**，从 `boot` 到成片。判据必须量化：

| 维度 | 判据 | 工具 |
|---|---|---|
| 成片存在 | `/f/*.mp4` 可下载、HTTP 200、`ffprobe` 可解析 | ffprobe |
| 时长 | `|成片时长 − Σshot时长| ≤ 0.5s` | ffprobe |
| 分辨率/帧率 | 与 `MB_MV_ASPECT_RATIO` 声明一致 | ffprobe |
| 音画同源 | 音轨 SHA256 与交付音频一致（防"贴错歌"） | sha256 |
| 口型 | 每镜 `sync_score ≥ 阈值`，且阈值来自 M1-① 的真实分布而非拍脑袋 | mv_asr/facegate |
| 保脸 | 每镜抽 3 帧过 facegate，均值 ≥ M3 定的线 | facegate |
| 合规 | `ai_label=true`、字幕过禁词、用户面字符串无引擎型号名 | lexicon CI |
| 账本 | `Σdelta == balance` 且 报价快照 hash 与实际扣费一致 | 白盒只读 DB |

**纪律：`status=done` 一律不算通过。** 任何一项不过 = 该轮记 `blocked`，不允许记 ✅。这是本轮抢救最重要的一条。

---

## M1 · 引擎就位（3–5 天，**最长链路的起点，今天就该开跑**）

| # | 任务 | 完成判据 | 备注 |
|---|---|---|---|
| ① | **lipsync 权重拉取 + 定档横评**（`spikes/SPMV1_lipsync_bench.md`） | EchoMimicV3-Flash vs MuseTalk 各 5 条真镜的 `sync_score` 分布 + 墙钟耗时；据此把 `config.mv.syncThreshold`（现 0.6）用数据定档 | 这是二期最大风险项，**SP-MV-1 至今零产物**；权重不在 = `:8390` 永远起不来 |
| ② | **mv_asr 对齐精度**（`spikes/SPMV2_align_precision.md`） | `test/fixtures/mv_align_samples/` ≥10 段真人声，逐句误差 ≤150ms 通过率 ≥90% | 现在 `:8391` 是死的，V15 的 5 个 skip 全卡在这 |
| ③ | **`h3-image-edit` 模板落地** | `manifest.json` 该项 `placeholder:false`，且分镜换景 20 例通过 | D16 的关键路径；不做就得显式改走 img2img+蒙版并把契约改掉 |
| ④ | **worker env 去历史包袱** | ROOTS 默认值不再含 `/opt/musicbox`、`E:/Work`；`worker --help` 缺配置时明确报错而不是静默 503 | 这是"文档三套环境真值"的代码侧根源 |
| ⑤ | **worker 健康端点统一 `/healthz`** | 四个 worker 同名端点；`core/modelnodes.js` 的多路径轮询兜底删除 | 现在 `/health` vs `/healthz` 混用 |

M1-①② 可以并行，但都要**先于**任何"MV 功能再开发"。

---

## M2 · 吞吐与恢复力（1 周）——不做这个，"夜间档跑不完"就是必然

现状（逐行读过）：执行器主循环 `await running` **完全串行**；`mv_lipsync` 用**一把全局锁**包住 `subprocess.run(timeout=1800)`；心跳每 60s 无脑续租，与 runner 是否卡死无关 → 租约清扫永远看不到过期，`maxAttempts=3` 永不触发。

**后果**：一条 3600s 的 `mv_shot` 能把 music/intent 队列全堵死；卡死的任务既不失败也不退款，永久占位。

| # | 任务 | 完成判据 |
|---|---|---|
| ① | 执行器 **per-lane 并发池**（vidspark=1 / imgspark=2 / ffmpeg=2 / lipsync=1 / align=2），并保证 MV 长任务**不饿死**音乐线 | 并发跑 1 条 8 镜 MV + 3 个音乐 job，音乐 p95 排队 < 60s |
| ② | 心跳携带 **runner 存活证明**（单调序号/last_tick），服务端记 `last_progress_at`，有心跳但超 `lane.timeoutOf` 无推进即 `fail`+`refund` | 注入一次 runner 死锁，30min 内 job 自动 failed 且全额退款（写进 V23） |
| ③ | `complete` 改**流式上传**，去掉 220MB 全量 Buffer（执行器读盘拼大 Buffer + 服务端 `readBody` 全量缓冲） | 4×240s WAV（≈170MB）转码上传期间 RSS 峰值 < 400MB |
| ④ | worker **拆全局锁**：加载期锁 + 推理信号量 + 队列；lipsync `subprocess` 超时必须 `<` 执行器 lane 超时（现在都是 1800s，同值即竞态） | 两个 lipsync 请求并发不互相串行化；超时不出现"执行器先放弃而 worker 还在跑" |
| ⑤ | **墙钟时间实测回写 `config.mv.est`**（含缺失的 `mv_cast`） | 报价误差 < ±30%；删掉文档里手抄的 745⚡/400⚡/760⚡ 算例 |

量化验收：**"8 镜纯音乐片 boot→成片"的墙钟时间必须有一个可复现数字**，并据此判断夜间档 `[0,8)` 是否够。

---

## M3 · 保脸闭环（1 周）

真机 blocker 的真实形态是：3 个候选里**混进 1 名男性**、`face_scores≈0`、后端 `face_scores` 落库为 **null**。

| # | 任务 | 完成判据 |
|---|---|---|
| ① | **选角阶段按 gender 过滤**（根因修复，不是事后挑） | 指定 female 时 3 候选全部 female；`mv_characters` 落库带 gender 校验 |
| ② | `face_scores` **真正落库**（现在返回 null）+ 每镜抽帧评分可查 | 白盒断言 `frames_json`/`face_scores` 非空且与 worker 返回一致 |
| ③ | **用真实分布定通过线** | SP6 实测三场景均值只有 **0.29–0.38**、最低 **−0.06**；用这个分布定阈值并写进契约，**废除"首帧 0.9972 锁脸成立"这类同义反复断言**（首帧就是输入原图本身，任何实现都恒真） |
| ④ | 失败降级链真机验证 | 连续 2 次不过 → B-roll + 字幕，成片仍存在且 `note` 说人话；系统补拍恒 0 分（计费诚信） |
| ⑤ | 真人像 + consent + facegate 预检 **真机验证** | 不再用 AI 生成图冒充真人；PIPL consent 缺失时明确 400 |

---

## M4 · 计费与合规真值回归（3 天）

| # | 任务 | 完成判据 |
|---|---|---|
| ① | **禁止灌余额**：真机跑真实 50 分日额；需要补分只能走 `/admin/credits/adjust`（留审计行），不得白盒 `appendLedger` | 取证文档里出现 `1000050`/`budget_credits:1000000` 即判该轮无效 |
| ② | 报价快照 → 实际扣费一致性；预算护栏 120% 生效 | 报价 745⚡（示例）时，超预算必暂停并给横幅；账本 `Σdelta==balance` |
| ③ | 取消/失败/补拍三类退款路径的 CAS 与查重（见抢救方案 P1-2） | V23 套件含"cancel 与 fail 叠加只退一次"断言 |
| ④ | `mv_cast` 定价与 `est` 表补全 | 契约、config、真机算例三处一致（现在三处不同价） |

---

## M5 · 灰度开闸（最后做，别提前）

- **先补跑 SP-MV-5**：剧本编译 ≥95% JSON 合格率 —— 这个前置**早已被满足却从未执行**（LLM 早就在了）。跑完再开 `assistant_chat`。
- `assistant_actions`（助手付费写闸门）在 V21/V23 全绿后灰度 0.2。
- **MV 套件进闸门**：`bash scripts/verify.sh --full` 必须包含 `MB_MV_ENABLED=1` 的 mock 套件，不再让 42% 的暗码游离在回归之外。

---

## 与总抢救方案的衔接

- MV 域按 **P3-2** 从主进程摘出：`MB_MV_ENABLED=0` 时**不装载**（而不是装载后 404），把暗码从主干构建里拿掉，日常回归只跑音乐线。
- M0/M2/M4 的所有新断言统一进 **V23/V24** 并被 `scripts/verify.sh` 覆盖。
- 顺序建议：**M0 → M1（并行开工，最长链路）→ M2 → M3 → M4 → M5**。M1 可以今天就启动（拉权重、跑横评不需要等任何代码）。

> 如果只能做一件事：**今天就去拉 lipsync 权重并启动 SP-MV-1 横评**。它是唯一"外部依赖 + 长耗时 + 阻塞成片"的项，其余都能在本地推进。
