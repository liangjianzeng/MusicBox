# DGX 全加载测试 + 小米13 客户端测试计划（2026-11-25）

> 口径变更（发起人指示）：**所有后端服务与部署物料迁移到 DGX Spark**，落 `/home/jianzengliang/MusicBox`；
> 5060 Ti 开发机只保留知识/调测历史（`:8190` 旧实例、`:8191` 旧 ASR 不再生产依赖）。
> 生产与全流程调测链路 = DGX 单机。本文档为运维留档，用户面零引擎名（契约 §0 纪律）。

## 0 实测前提（2026-11-25 11:2x 采样）

| 项 | 值 | 判读 |
|---|---|---|
| 主机 | `gx10-85f3` · Ubuntu 24.04.5 · aarch64 · node v22.23.5 · ffmpeg 6.1.1(libmp3lame/drawtext/xfade/zoompan) | 一期 S1/S2 通过线仍绿 |
| 内存 | 121Gi 总 / 17Gi 已用 / **103Gi 可用**；GB10 0% util | 资源已释放（vLLM 容器 `qwen38-fp4-8090` Exited 25min）→ 全加载窗口 |
| 磁盘 | `/` NVMe 345G 可用；`/mnt/models-ssd` 400G 冷集软链 | S3 通过线 ✓ |
| 监听 | 仅 `:3080`(open-webui) `:8080`(SearXNG) | `:8188/:8190/:8090/:7900/:83xx` 全部**未起** → 阶段 A 必起 |
| 生图/视频权重 | `~/ComfyUI/models`：H3-Image 20G · FL2VA 20G · REF2VA 20G · TE qwen3vl 15G · TE-LLM 7.3G · video VAE 5.2G · image VAE 1.2G · audio VAE 0.6G · turbo4/8step LoRA ~2G · Music3 DiT+TE(SSD) | 热集就位，ComfyUI 0.45.0 内置 `comfy/ldm/minimax` + `minimax_music` 节点 |
| 生乐权重 | `/mnt/models-ssd/musicgen-server/vendor/ACE-Step-1.5/checkpoints` 28G（v15-turbo / v15-xl-turbo / 5Hz-lm-1.7B / Qwen3-Embedding-0.6B）；venv py3.12.3 torch 2.10.0+cu130 | 已在机，无需拉 |
| 协议壳 | 剧场 `X-Theater/runtime/acestep/server.py`（`POST /music` 同步协议，惰性加载，响应后卸显存，单任务互斥） | 执行器 music lane 真源协议，迁移入 `~/MusicBox/services/acestep` |
| 部署现状 | `/opt/musicbox`（11-24 09:00 快照，缺 l2music/admin 线）· `~/MusicBox` 空 · systemd 单元 无 · `/etc/musicbox` 无 | 旧路径弃，按 §1 重新落 `~/MusicBox` |
| 客户端 | 小米13 `M2012K11AC` serial `8b1e8747` Android 13 · **USB 直连 device** · 本机网 `192.168.1.151` · `com.musicbox.musicbox` 已装 | Spark 网 `192.168.1.10` 同 /24 → 直 LAN 可达 |
| APK | `builds/MusicBox-v0.1.0+1-release-musicassist-lan.apk`（11-24 23:16，最新） | 阶段 C 装档；`--dart-define=MUSICBOX_BASE_URL` 或 App 内服务器设置 → `http://192.168.1.10:7900` |

**端口台账（DGX 单机）**：`7900` API · `8190` 生乐 · `8191` ASR · `8390/8391/8395` 口型/逐字/脸门（回环） · `8188` 生图生视频队列（共宿主，只发任务+只读观测） · `8090` 文本多模（可选，当前 Off，intent 自动走词典兜底）。

---

## 1 部署物料落 `/home/jianzengliang/MusicBox`

```
~/MusicBox/
  src/{server,executor,workers}     # 仓库工作树（含二期 MV 线 + 音乐助手 + admin 档案，0.6MB）
  deploy/spark/                     # 单元/env 模板
  services/acestep/
    server.py                       # 剧场协议壳（POST /music，8190）
    acestep-repo/                   # git clone --depth 1 ace-step/ACE-Step-1.5（7202bc3 档，剧场实测同）
    models -> /mnt/models-ssd/musicgen-server/vendor/ACE-Step-1.5/checkpoints
    venv   -> /home/jianzengliang/musicgen-server/.venv   # 复用（sys.path 注入优先，editable 旧路径不影响）
    out/                            # wav 产物
  var/{db,out,uploads,config,exec,logs}
  etc/{spark.env}                   # 六单元共用，chmod 600
  run/                              # pid 档
```

- 同步方式：`tar` 管道 over ssh（`src/{server,executor,workers}` + `deploy` + `test`），排除 `var/ node_modules .qoder src/app`。
- **不复制**：ComfyUI 本体与权重（`~/ComfyUI` 共宿主，ADR-MV-4 共用 `:8188`；逃生口 `:8288` 共 models 目录，仅互扰超标才启用）。
- 弃路径：`/opt/musicbox`（留读-only 对照，不写不删）。

## 2 阶段 A — 起服务（顺序 + 判定）

| # | 动作 | 判定 |
|---|---|---|
| A1 | 代码同步 → `~/MusicBox/src`；`node -c` 三入口自检（`server/index.js` `executor/index.js`） | `node --check` 无错；`executor --help` 打印 lane 表 |
| A2 | 生乐：`services/acestep/server.py` 起 `127.0.0.1:8190`（setsid nohup + pid 档） | `GET /health` → `handler_ready:false` 正常（惰性）；首 `/music` 触发加载 |
| A3 | 生图/视频：`bash ~/start_comfyui.sh`（幂等，端口占用则 abort 不杀） | `GET :8188/system_stats` 200；`GET /queue` 位次观测；**代码层无 /free** |
| A4 | 二期 worker 三件（venv 已在 `/opt/musicbox/var/venv-*` 迁拷）：`mv_asr :8391` `mv_facegate :8395` `mv_lipsync :8390`（懒加载+空闲释放） | 各 `GET /health` 200（lipsync 报 `weights_loaded:false` 正常） |
| A5 | API `:7900`（`MB_PUBLIC_BASE_URL=http://192.168.1.10:7900` `MB_MV_ENABLED=1`）+ 执行器（`--lanes music,intent,ffmpeg,imgspark,vidspark,lipsync,align`，`--concurrency 1` 语义=daemon 天然串行） | `GET /healthz` 200；执行器日志「已接入调度 … 通道=…」 |
| A6 | 后台档案扫：`POST /admin/model-nodes/probe-all` | music/comfy/asr 三件 200；83xx 三件 200；llm 红（如实，`:8090` Off） |

红线（照 ADR-MV-4/§1.2）：共宿主只发任务+只读观测；executor 领单前读 `ram_free`，`<20G` 则挂起；83xx 仅回环；禁词表用户面。

## 3 阶段 B — 全加载测试（三族同时驻，一次一发）

> 目标：音乐模型 + 生图族 + 生视频族**同时驻**，无 OOM，产物规格对，耗时留档。执行器单并发 ⇒ 天然串行发，但**不卸载**中间产物。

| # | 发 | 判定线 |
|---|---|---|
| B0 | 模板登记：跑 `h3-image-cast`/`h3-fl2va` 真机一次，回填 `templates/manifest.json`（`comfy_commit` `weights` `vram_profile` `evidence`，`placeholder:false`） | 真跑前 `tmpl_sha16` 与磁盘 hash 对（否则 `COMFY_TMPL_DRIFT` 拒跑） |
| B1 | **音乐**：`POST :8190/music {mood:"温暖",seconds:45,seed:424242,tags:"piano,strings"}` | 200 + `file` 落盘；`ffprobe` 时长 45±2s 立体声；`gen_seconds` 留档；`/health` 后 `handler_ready:true` |
| B2 | **图像**：ComfyUI `h3-image-cast`（864×1536，seed 派 +1） | png 魔数 + 尺寸对；耗时 ~15s 档留档；`/history` 产物名回填 |
| B3 | **视频**：ComfyUI `h3-fl2va`（FIRST_FRAME=B2 产物，736×1312，124f，turbo4 steps=4） | mp4 时长 5.17s ±0.2 / 24fps；耗时 ~290s 档留档 |
| B4 | **全加载采样**（B1→B2→B3 无 unload 之间，每发前后采样）：`free -g` · `nvidia-smi --query-gpu=memory.used` · `:8188/system_stats`（`ram_free` `memory_used_to_recreate`） · `:8190/health.vram` | 无 OOM/无 swap 抖动；`ram_free` 全程 ≥20G；三族驻合计 ≤预算（预期 H3 视频族 ~42G + 生图族 ~28G + 生乐 ~9G ≈ 80G ≤ 103G 可用） |
| B5 | 降级演练（可选，后 B4）：`:8188` 不可达 → job 回队诚实呈现；`:8390` 挂 → B-roll 降级链 | 不杀不吊死，错误码诚实 |

留档 → `deploy/spark/fullload-evidence.md`（耗时表 + 内存曲线 + 产物路径 + 判定）。

## 4 阶段 C — 小米13 客户端（按计划，一个个）

| # | 步骤 | 判定 / 证据 |
|---|---|---|
| C0 | 环境：`adb -s 8b1e8747` 直连；装 `musicassist-lan` APK（或 App 内服务器设置 → `http://192.168.1.10:7900`）；`curl` 从设备网 `192.168.1.10:7900/healthz` | 首页 loads（游客态 token 非空）；screencap 留档 |
| C1 | **音乐全链**：创作页 文本意图「给妈妈写首温馨生日歌」→ 3 候选 → 揭晓页 3 卡带 → 播放 + `adopt` | 服务端 job `queued→running→done` 耗时表；候选 `audio_url` 可播；禁词表零泄漏（UI 文案） |
| C2 | **图像全链**：MV tab → 选角 AI 脸 → 定妆照 3 候选（B2 同模板） | 3 张 png 可预览（App 内 image 解码）；facegate 评分门可见 |
| C3 | **视频全链**：定妆视频（B3 同模板）→ 抽 ~13 帧 → 帧格勾选 → 拍板固化 viewRefs | 视频可播（`video_player`，低端机则海报+音频降级）；帧格 13 项 |
| C4 | **口型+成片**（stretch）：分镜 → 拍摄 → 口型校准（`:8390`）→ 成片 compose + 字幕 + AI 角标 | `sync_score ≥0.6` 或诚实补拍/降级标注；成片可播 |

证据采集（每步骤）：`adb exec-out screencap -p` → `tmp/evidence/<ts>/Cn_*.png`；`adb logcat -s musicbox:*`；服务端 `journalctl`/nohup log 片段；`GET /v1/jobs/:id` 轮询耗时。

## 5 熔断与失败口径

| 现象 | 口径 |
|---|---|
| `ram_free <20G` | executor 挂起等待（观测不干预），连续 3 次低水位 → 观测指标上报，不杀共宿主 |
| 生乐 409（单任务互斥） | 排队诚实，ETA 加队列位次 |
| `COMFY_TMPL_DRIFT` | 拒跑（模板未登记），B0 先完成 |
| `:8188` 不可达 | `COMFY_UNREACHABLE` 快失败 → job 回队 → App 诚实呈现 |
| 客户端 404/断 WSS | 检查 `MB_PUBLIC_BASE_URL` 是否 LAN 可达 IP（127.0.0.1 真机全挂，一期实测） |

**执行顺序**：A1→A2→A3→A4→A5→A6 → B0→B1→B2→B3→B4 →（留档）→ C0→C1→C2→C3→C4。
每阶段全绿才下一；任一红则留档原因，不伪造数据。
