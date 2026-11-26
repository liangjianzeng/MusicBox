# MusicBox 部署 Runbook · Windows / 5060 Ti 历史口径（归档）

```
Status: LEGACY / Superseded-by: docs/runbook-dev.md / Date: 2026-11-26
```

> **这份文件是历史归档，不是操作手册。不要照它敲命令。**
> 现在的环境是 DGX Spark 单机（Linux/arm64，`/home/jianzengliang/MusicBox`），照做请用
> **[docs/runbook-dev.md](runbook-dev.md)**。本文存在的唯一理由：这些 Windows/5060 时代的绝对路径、
> venv 装法和 `ffmpeg.exe` 约定仍然散落在 README 与 worker 代码默认值里，一旦有人照着做会浪费半天，
> 所以把它们**原样收在一处并逐条标注作废**。
>
> 来源：[README.md](../README.md) 「快速开始」（2026-11-23 口径，开发机 = 5060 Ti Windows 机）+
> `src/workers/*` 里的 Windows 默认值。口径变更依据：
> [deploy/spark/fullload-test-plan.md](../deploy/spark/fullload-test-plan.md) 文首「**所有后端服务与部署物料迁移到
> DGX Spark**；5060 Ti 开发机只保留知识/调测历史，不再生产依赖」。

---

## 1. 原文照录（README「快速开始」· 2026-11-23）

以下为逐字收录，未做改写；唯一改动是把命令行里的执行器令牌明文换成占位符
（历史原文写的是代码内那个公开默认值，见 §4 第 5 行）。

````markdown
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
#          node src/executor/index.js --api http://127.0.0.1:7900 --token <MB_EXECUTOR_TOKEN> --lanes music,intent,ffmpeg

# 3) 跑 App（Flutter 在 C:/src/flutter）
cd src/app && flutter run

# 4) 跑验收套件（真自举：另起 server 子进程 + 内置 fake executor，互不干扰）
node --test --test-concurrency=1 "test/acceptance/*.test.js"
```
````

其中「验收套件要点」（同一节的下半段）仍然有效，属通用口径，不在归档范围：
自举起 server（`MB_PORT` 从 7901 起找空口、`MB_VAR_ROOT=var-test/<套件-pid-rand>`、`MB_DEV_OTP=1` 固定验证码、
LLM/ASR 指向不可达地址以验证契约 §0 兜底）、内置最小 fake executor、ffmpeg **能力探测**、白盒只读 SQLite、
以及「目录形式在 Node 25 会被当模块路径解析，**必须用上面的 glob 形式**」。当前实测基线见
[runbook-dev.md §3.4](runbook-dev.md)。

---

## 2. 逐条作废对照

| 历史（Windows / 5060 Ti） | 现状（DGX Spark 单机） | 出处 |
|---|---|---|
| 开发机 = 5060 Ti Windows 机 | `gx10-85f3` Linux/arm64，**生产与全流程调测链路 = DGX 单机** | fullload-test-plan 文首 |
| `E:/Work/X-Theater/runtime/acestep` + `venv/Scripts/python.exe server.py`（`:8190`） | `services/acestep/server.py`（`venv`→`~/musicgen-server/.venv`，`models`→`/mnt/models-ssd/.../checkpoints`），起法 `bash bin/start_acestep.sh` | runbook-dev §4 |
| `E:/Work/X-Theater/runtime/bin/ffmpeg.exe`（`MB_FFMPEG=`） | `/usr/bin/ffmpeg` 6.1.1（含 libmp3lame/drawtext/xfade/zoompan），`MB_FFMPEG=ffmpeg` 即可 | runbook-dev §1.1 |
| `test/acceptance/tools/ffmpeg/ffmpeg.exe`（验收自带目录） | 目录约定仍在（git 忽略二进制），但本机走 PATH，无需自带 | runbook-dev §8 第 1 行 |
| `E:/Work/MusicBox/var/models` + `MODELSCOPE_CACHE=...`（SenseVoice 权重缓存） | `~/MusicBox/var/models`；`MODELSCOPE_CACHE` 属旧口径，现由 `MB_FACEGATE_ROOTS` 等既有键管目录白名单 | runbook-dev §1.4 |
| `./venv-asr/Scripts/python.exe src/workers/sensevoice/app.py`（`:8191`） | `bash bin/start_workers.sh asr1`（`var/venv-asr/bin/python`，已就位） | runbook-dev §1.4 / §4 |
| `uv venv venv-asr --python 3.12 && uv pip install --python venv-asr/Scripts/python.exe "torch --torch-backend cpu" funasr modelscope librosa soundfile fastapi uvicorn` | **同一条装法在 Linux 上等价可用**（`/usr/local/bin/uv` 在位，`var/venv-asr` 已是这么来的）；但三个 worker venv 已建好，**正常开发不需要重装**。若确需重建，把 `Scripts/python.exe` 换成 `bin/python`、路径换成 `~/MusicBox/var/venv-*` | runbook-dev §1.4 |
| `app.py 须 trust_remote_code=False——官方仓无 model.py，类由 funasr 内置` | 仍然成立的**知识**（与平台无关），保留在这里以免丢失 | — |
| `MB_LLM_VLM_URL=http://192.168.1.10:8090/v1` | 同机改为 `http://127.0.0.1:8090/v1`；`192.168.1.10` 现在就是本机自己，等价但没必要绕外网 | `etc/spark.env:30` |
| `C:/src/flutter` + `cd src/app && flutter run` | **本机未安装 flutter**；`builds/` 无 APK。真机侧见 runbook-dev §6.3（blocked） | runbook-dev §6.3 |
| `--token <MB_EXECUTOR_TOKEN>`（历史原文把代码默认令牌直接写在命令行上） | 令牌必须显式设置且**不出现在命令行**（`pgrep -af` 会打印出来）；用 `source etc/spark.env` 后 `"$MB_EXECUTOR_TOKEN"` 或让其回落读环境变量 | runbook-dev §3.1 / §7 |
| `/opt/musicbox`（`phase2-architecture-design.md` 口径 + systemd 五单元） | 已明文弃用（「留 read-only 对照，不写不删」）；但**仍作为 worker 代码默认值活着**：`MB_MV_ASR_ROOTS`/`MB_LIPSYNC_ROOTS`/`MB_FACEGATE_ROOTS` 的默认值都是 `/opt/musicbox/var,E:/Work/MusicBox/var` —— 后半截就是这份 Windows 时代的残留 | fullload-test-plan §1；`src/workers/*/app.py` |

---

## 3. 为什么这些残留还会咬人（读代码时注意）

`src/workers/mv_asr/app.py:13-15`、`src/workers/mv_lipsync/app.py:12-14`、`src/workers/mv_facegate/app.py:16-18`
的文件路径白名单默认值里同时挂着 `/opt/musicbox/var`（旧 Linux 部署位）与 `E:/Work/MusicBox/var`（本文件的历史现场）。
`etc/spark.env` 目前只给 facegate 补了 `MB_FACEGATE_ROOTS`，`mv_asr` 与 `mv_lipsync` 没补 ——
于是这两个 worker 的 `/health` 返回 200、实际收单一律 403「路径不在允许目录」。
**这就是"归档里的路径"在今天还能咬人的具体位置**，完整处置见
[runbook-dev.md §5.2 B-3](runbook-dev.md)。

同理，`deploy/spark/README.md` 与 `deploy/spark/baseline.md` 里出现的 `:8090/models`
是同一个时代的措辞残留：vLLM 真正的清单端点是 **`/v1/models`**（裸 `/models` 返回 404，2026-11-26 实测）。
`bin/status.sh` 已按此修正；读旧文档时请自行把 `/models` 读成 `/v1/models`。

---

## 4. 本文的维护约定

| 规则 | 说明 |
|---|---|
| 只追加，不改写历史 | 本节以下可以更新；§1 的原文照录**永远保持 2026-11-23 原样**（除了令牌占位符化这一处安全处理） |
| 不作为验收依据 | 任何验收/发布的判据只认 [CONTRACTS.md](../CONTRACTS.md) + `test/acceptance/` + [runbook-dev.md](runbook-dev.md) |
| 迁移完成后可删 | 当 README「快速开始」的 Windows 段被收编、且 worker 代码默认值不再含 `E:/` 与 `/opt/musicbox` 时，本文件可归档删除 |

变更记录：2026-11-26 首版（从 README「快速开始」收编 Windows 口径并逐条标注作废）。
