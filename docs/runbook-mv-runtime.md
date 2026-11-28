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
