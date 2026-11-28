# MV 真机运行现场登记（2026-11-28 点亮实录）

> 为什么要这份文件：D2「MV 必须做完」卡了很久，根因不是代码没写，而是**真机运行侧从来没落地过**，
> 而"谁在跑、跑在哪、用什么起的"没有任何一处写清 —— 于是每次排查都从零猜。本文件只登记**实测到的事实**
> （命令 + 返回），不登记愿望。任何一条变了，改这里，别改记忆。

## 1. 机器与角色（实测）

| 角色 | 机器 | 地址 | 怎么确认的 |
|---|---|---|---|
| Spark 运行机（= DGX） | 本机 `gx10-83xx`，Ubuntu，GPU **NVIDIA GB10** | tailnet `100.81.83.59`（`hostname -I`） | `deploy/spark/baseline.md:3` 登记 `DgxSpark`(100.81.83.59) |
| 引擎机 | Windows GeekPro | tailnet `100.100.140.75` | `scripts/geekpro/gp.py` 驱动（cmd.exe） |

## 2. 现在真的在跑什么（2026-11-28 12:1x 实测）

| 服务 | 位置 | 探针与返回（照抄） | 由谁常驻 |
|---|---|---|---|
| ACE-Step 音乐引擎 | GeekPro `:8190` | `GET /health` → 200 `{"service":"w-m-acestep"...}` | 计划任务 `MusicBoxAceStep` + Startup 项（见 runbook-dev） |
| **ComfyUI 0.46.0** | GeekPro `:8188`（绑 `100.100.140.75`） | `GET /system_stats` → 200，`comfyui_version:0.46.0`，设备 `cuda:0 NVIDIA GeForce RTX 5060 Ti`，`vram_free≈15.9GB` | **今晚新建**：`schtasks /tn MusicBoxComfyUI`（手动）+ `MusicBoxComfyUIBoot`（`/sc onlogon`）；命令 `cmd.exe /c cd /d E:\ComfyUI && E:\ComfyUI\venv\Scripts\python.exe main.py --listen 100.100.140.75 --port 8188 >> E:\ComfyUI\comfyui_boot.log 2>&1` |
| 剧场 facegate（ArcFace+姿态） | GeekPro `:8195` | `GET /health` → 200 `{"status":"ok","ref_loaded":false,"ref_file":"liangchen.png","gate":0.6}` | **今晚新建**：`schtasks /tn MusicBoxFacegate`，用 `E:\ComfyUI\venv`（含 fastapi/cv2/insightface/uvicorn）跑 `uvicorn server:app --host 100.100.140.75 --port 8195` |
| vLLM（剧本/VLM） | **Spark 本机** `127.0.0.1:8090` | `GET /v1/models` → 200 `{"data":[{"id":"qwen38-fp4"...}]}` | 由 DGX 侧常驻，MusicBox 不启停它 |
| 本机 ffmpeg | Spark | `ffmpeg -encoders` 含 `libmp3lame` ✓（V14 能力探测这一项已满足） | 系统包 |

GeekPro 侧 python：`E:\ComfyUI\venv` = Python 3.12.13 / **torch 2.11.0+cu128 / CUDA True**（`E:\Work\.venv` 的 torch 是 **CPU 版**，别拿它跑推理）。

## 3. 还缺什么，V14/V15 才会从 skip 变真跑（逐条实测，不是推测）

V14 真机用例的门是**三个探针全过**（`test/acceptance/v14_mv_instrumental.test.js:30-54`）：

| 探针 | 现在 | 缺口 |
|---|---|---|
| `MB_SPARK_COMFY` → `GET /system_stats` | ✅ 满足（上表） | — |
| ffmpeg 能力（libmp3lame） | ✅ 满足 | — |
| `MB_TEST_LIPSYNC_URL` → `GET /healthz` 且 `weights_loaded≠false` | ❌ **门铃此前装错门**：worker 只有 `/health` 且把 `loaded` 写死 `False` → 已修（`src/workers/mv_lipsync/app.py` 挂 `/healthz`，字段由 `weights_present()`/`command_ready()` 真算，判词 V42 钉住）；**仍缺权重与外部推理命令** | ①`/opt/musicbox/var/models` 是**空目录**（S5 权重从未下载）②`/etc/musicbox/spark.env` 不存在 → `MB_LIPSYNC_COMMAND`/`MB_LIPSYNC_SYNC_COMMAND` 从未配过 ③`/opt/musicbox/var/venv-lipsync` 只有 torch，EchoMimicV3-Flash 推理 runtime 未装 ④剧场那份 `runtime/lipsync/server.py` 的 `lipsync()` 是 **`raise RuntimeError("lipsync 引擎未接线")` 的桩**，且只有 `/health` |

其它已知事实：`venv-asr` 已装 **funasr 1.4.29 + modelscope 1.40.3**（SenseVoice 对齐只差权重）；五单元 `.service` 文件在 `deploy/spark/` 里写好了但**一个都没 install**（`systemctl list-unit-files | grep -E 'musicbox|mv-'` 空），83xx 段零监听。

**端口口径不一致要当心**：`src/executor/index.js:43` 与 `deploy/spark/mv-facegate.service` 登记 facegate 为 **:8395**，而剧场那份 facegate 实跑 **:8195**。判词侧用 `MB_TEST_FACEGATE_URL` 显式覆盖可绕开；两边真要长期共存，得把端口口径收一处（别靠"反正本地能连"糊过去）。

## 4. 复现今天的点亮（命令原样）

```bash
# ComfyUI（GeekPro，cmd.exe via gp.py）
GP_PASS=… python3 scripts/geekpro/gp.py -t 190 'schtasks /create /tn MusicBoxComfyUI /tr "cmd.exe /c cd /d E:\ComfyUI && E:\ComfyUI\venv\Scripts\python.exe main.py --listen 100.100.140.75 --port 8188 >> E:\ComfyUI\comfyui_boot.log 2>&1" /sc once /st 00:00 /f & schtasks /run /tn MusicBoxComfyUI'
# facegate（同机，借 E:\ComfyUI\venv 起 uvicorn，不改剧场一行代码）
GP_PASS=… python3 scripts/geekpro/gp.py -t 190 'schtasks /create /tn MusicBoxFacegate /tr "cmd.exe /c cd /d E:\Work\X-Theater\runtime\facegate && E:\ComfyUI\venv\Scripts\python.exe -m uvicorn server:app --host 100.100.140.75 --port 8195 >> E:\Work\X-Theater\runtime\facegate\facegate_mv.log 2>&1" /sc once /st 00:00 /f & schtasks /run /tn MusicBoxFacegate'
```

**`schtasks /run` 回"成功"只代表任务被拉起**，不代表服务在听（ACE-Step 上栽过一次）。验收只认实测：

```bash
curl -s http://100.100.140.75:8188/system_stats | head -c 200   # 200 且有 comfyui_version
curl -s http://100.100.140.75:8195/health                        # 200 且有 status/ref_loaded
curl -s http://127.0.0.1:8090/v1/models                          # vLLM 活着
```

## 四、选角 / 定妆这一腿（2026-11-28 补，lipsync 挂起期间先做这个）

### 实测到的事实

| 项 | 实测值（当天） |
|---|---|
| facegate | `http://100.100.140.75:8195/health` → 200 `{"status":"ok","ref_loaded":false,"ref_file":"liangchen.png","gate":0.6}`（**跑在 GeekPro**，借 `E:\ComfyUI\venv` 起 uvicorn，未改剧场代码） |
| ComfyUI | `http://100.100.140.75:8188/system_stats` → 200，RTX 5060 Ti，`vram_free ≈ 15.9 GB` |
| **端口口径分裂（现场必须显式覆盖）** | 我方 `src/executor/lanes/mv.js` 默认 `http://127.0.0.1:8395`、`deploy/spark/mv-facegate.service` 也登记 8395；剧场实跑在 **8195**。真机跑之前必须 `MB_FACEGATE_URL=http://100.100.140.75:8195` 显式指，**别信默认值** |
| Spark 内存（2026-11-28 13:0x） | `MemTotal 127.5 GB / MemAvailable 1.30 GB`，swap 已用 6.9 GB。`mv-lipsync.service` 自己登记 `MemoryMax=16G` → **这台起不动 lipsync**（`dsh-web` 全部 1.44 GB、zcode 全家 2.50 GB，全腾也不够）；`mv-asr`/`mv-facegate` 各 4G/3G |

### 判词资产：主角像（用户 2026-11-28 指定）

`test/acceptance/fixtures/mv_lead_portrait.jpg`，1280×2783，318,739 B，
sha256 `e8bf45a872773e66c4c26fdd15c9895b3bd71111d09e6789f5b294562f1b7c2d`。
env 名 `MB_TEST_CAST_PORTRAIT`，规则登记在施工计划 §6.3.1：**换脸必须同时改登记**，
且**不许拿引擎自己生成的脸当参考脸去 gate 引擎自己**（恒真式）。

### 怎么跑这两条判词

```bash
node --test test/acceptance/v43_cast_gate.test.js              # 服务端落库腿，4 条，秒级、无外部依赖
cd src/app && flutter test test/cast_gate_honesty_test.dart    # 端侧呈现腿，7 条
```

### 破坏验证记录（2026-11-28，跑在 `/tmp/mbgate` 被推送提交上）

| 控制 | 结果 |
|---|---|
| `step_look.dart` 门控横幅永远置 null | 端侧 **3 红** |
| 角标没打分时不再写「未验」 | 端侧 **2 红** |
| 模型退回 `'$e'` 拼字符串（服务端扩形状后端上变垃圾） | 端侧 **1 红** |
| `engine.js` 落库退回裸 URL 数组（事故前的样子） | V43 **3 红** |
| 脚手架恢复凭空发 0.90/0.83/0.76 | V43-④ **1 红** |
| 全部恢复 | 端侧 7/7、V43 4/4、全量 `pass=224 fail=0 skip=44` |

### 还没解决的（别当成已完成）

- **V14 真机的定妆段仍然进不去**：`test/acceptance/v14_mv_instrumental.test.js:55` 的 `realGate()` 只看
  `PRE.ok`，而 `PRE` 的探针（同文件 :30-54）把 lipsync（`MB_TEST_LIPSYNC_URL` → `/healthz` + `weights_loaded`）
  捆成**整条链**的前置；定妆其实只依赖 ComfyUI + facegate。lipsync 挂起期间 V14-① 定妆真机判词
  会一直 skip —— 这是门装错了，不是定妆没问题。**解法必须是"按用例拆前置门"，不许为了变绿删断言。**
- facegate `ref_loaded:false`：参考脸懒加载，真机第一次 `/score` 才会真加载；定妆真机判词要点名验证它。
- lipsync：按用户指令挂起（权重、runtime、`MB_LIPSYNC_COMMAND`、跨机文件传输都还没做）。
