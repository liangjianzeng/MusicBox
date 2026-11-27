# MusicBox 开发 Runbook · 当前真实环境（DGX Spark 单机）

```
Status: CURRENT（可照做）
Applies-to: gx10-85f3 · Linux 7.0.0-1025-nvidia · aarch64 (Ubuntu 24.04.5) · NVIDIA GB10 · 192.168.1.10
Repo-root:  /home/jianzengliang/MusicBox   （= bin/*.sh 里的 BASE="$HOME/MusicBox"）
Date: 2026-11-26   采样时刻: 22:3x–22:5x CST（本文所有「实测」均为本次采样）
Supersedes: README「快速开始」的 Windows 段、deploy/spark/baseline.md 的端口/端点结论
历史口径见: docs/runbook-windows-legacy.md（LEGACY，只读归档，勿照做）
```

> **本页只写「现在照着敲就能跑」的东西。** 产品口径看 `docs/musicbox-assessment-and-plan.md`，接口真源看
> [CONTRACTS.md](../CONTRACTS.md)，部署物料看 [deploy/spark/README.md](../deploy/spark/README.md) 与
> [deploy/vps/SETUP.md](../deploy/vps/SETUP.md)（那是 VPS 上线路径，不是本机开发路径）。
> 本文**不新增任何环境变量**；全部键名都是代码里已经读取的既有键。

---

## 1. 当前实态快照（2026-11-26 实测）

### 1.1 主机与工具链

| 项 | 实测值 | 判读 |
|---|---|---|
| 主机 | `gx10-85f3` · Ubuntu 24.04.5 · aarch64 · 20 核 · 121Gi RAM | 就是 DGX Spark 本机，**不再 SSH 到别的机器** |
| 网址 | LAN `192.168.1.10` / Tailscale `100.81.83.59` / docker `172.17.0.1` | 手机可达地址用 `192.168.1.10`（同 /24）或 Tailscale IP |
| 仓库 | `/home/jianzengliang/MusicBox`（工作树，含 `src/` `bin/` `test/`） | 所有 `bin/*.sh` 以此为 `$BASE` |
| Node（仓内） | `$BASE/node` → `/opt/musicbox/node` → `v22.23.5` | `bin/start_*.sh` 用的就是它 |
| Node（PATH） | `/home/jianzengliang/.node_versions/node-v25.2.0-linux-arm64/bin/node` → `v25.2.0` | 手敲 `node` 走这个；两者都 ≥22，混用无碍 |
| ffmpeg | `/usr/bin/ffmpeg` = `6.1.1-3ubuntu5+esm15` | 含 `libmp3lame`/`drawtext`/`xfade`/`zoompan`，验收能力探测通过 ✓ |
| Python / uv | `/usr/bin/python3`；`/usr/local/bin/uv` ✓ | 三个 worker venv 已就位（见 1.4） |
| adb | `/usr/bin/adb`，`adb devices` = `8b1e8747 device`（红米 M2012K11AC · Android 13 · USB） | 真机用（§6） |
| flutter | **未安装**（`flutter: 未找到命令`） | App 构建/`flutter run` 不在本机，见 §6 blocked |
| 磁盘 | `/` 916G 总 / **325G 可用**；`/mnt/models-ssd` 931G / **508G 可用** | S3 通过线（≥150G）仍绿 ✓ |
| 内存 | `free -g`：121 总 / 117 已用 / **可用 ≈4G** | ⚠ vLLM 常驻占大头 → **直接卡住 MV 全载**（§5） |
| GPU | `NVIDIA GB10`，util 93–96%，`nvidia-smi --query-gpu=memory.used` 返回 `N/A` | GB10 统一内存：显存即内存，**判可用只能看 `free`，`nvidia-smi` 的 memory 列是 N/A** |

### 1.2 端口 / 服务实态（这是最容易骗自己的一节，以 `ss` 为准）

| 端口 | 服务 | 实态 | 备注 |
|---|---|---|---|
| **7900** | Music API（server） | **DOWN** | `run/api.pid` 是死进程；端口空闲，可直接起 |
| **8090** | 多模态 LLM/VLM —— docker 容器 `qwen38-fp4-8090`（image `eugr/spark-vllm-b12x`，`vllm serve --served-model-name qwen38-fp4`） | **UP（当前唯一在听的）** | `GET /v1/models` → 200 `{"object":"list","data":[{"id":"qwen38-fp4",...,"max_model_len":262144}]}`；`GET /models` → **404**。宿主侧自查：`docker ps --format '{{.Names}}\t{{.Status}}'` |
| **8188** | ComfyUI 生图/生视频队列（共宿主） | **DOWN** | 权重齐：`~/ComfyUI/models` 128G（H3 图/视频族 + TE + VAE + LoRA）；`~/ComfyUI/venv/bin/python` 在位 |
| **8190** | ACE-Step 1.5 生乐 | **DOWN** | `services/acestep/{server.py,venv,models}` 符号链接均在位（venv→`~/musicgen-server/.venv`，models→`/mnt/models-ssd/.../checkpoints`） |
| **8191** | SenseVoice ASR（一期转写） | **DOWN** | `var/venv-asr`（→`/opt/musicbox/var/venv-asr`，py3.12.3）在位 |
| **8288** | ComfyUI 逃生口（自建实例） | DOWN / 未启用 | 仅 `:8188` 互扰超标才启（ADR-MV-4） |
| **8390** | MV lipsync（EchoMimicV3-Flash） | **DOWN + BLOCKED** | venv 在位，但**权重未拉**且 `MB_LIPSYNC_COMMAND`/`MB_LIPSYNC_ROOTS` 未落（§5 blocked） |
| **8391** | MV mv_asr（SenseVoice 时间戳对齐） | **DOWN + 半残** | venv 在位可起，但 `MB_MV_ASR_ROOTS` 未落本仓 `var/` → 起了也会 403（§5） |
| **8395** | MV facegate（ArcFace/insightface） | **DOWN** | 权重齐：`var/models/facegate/models/buffalo_l/` 5 个 onnx ✓；`MB_FACEGATE_ROOTS` 已在 `etc/spark.env` 落本仓 `var/` ✓ |

`run/*.pid` **8 个全部 DEAD**：`acestep api comfyui executor mv_asr mv_facegate mv_lipsync sensevoice`。
—— 上一轮留下的死 PID 档，`bin/*.sh` 的幂等判断靠 pid 存活而不是文件存在，所以**直接重跑起服脚本即可**，无需手工清档。

### 1.3 ⚠ LLM 模型名三处口径不一致（照做前必读）

| 位置 | 值 | 谁在用 |
|---|---|---|
| `etc/spark.env:31` | `MB_LLM_VLM_MODEL=Inkling2-Mini:vision` | **运行时真生效的那个**：`bin/start_*.sh` 与 `bin/start_workers.sh` 都会 `source` 它 |
| `deploy/spark/spark.env.example:36` | `MB_LLM_VLM_MODEL=qwen38-fp4` | 模板 / 文档口径（还带着 11-25「LLM 未起」的注释，已过期） |
| `:8090/v1/models` 实测 | `qwen38-fp4` | **唯一客观真值** |

**判定规则（本页采用，写死）：以 `etc/spark.env` 为准（它是运行时），并以 `/v1/models` 的实际返回值为准。**
`spark.env.example` 只是模板，与 `etc/spark.env` 冲突时**以 `etc/spark.env` 为准**；而 `etc/spark.env` 与
`/v1/models` 冲突时，**以 `/v1/models` 为准**并去改 `etc/spark.env`（不要改代码，也不要新增键）。

为什么必须手查：模型名不对时**不会报错**——intent lane 只是静默降级为本地词典启发式（链路不断、confidence 变低），
于是「LLM 档到底有没有生效」这件事会长期没人知道。自查：

```bash
curl -s http://127.0.0.1:8090/v1/models | head -c 200     # 看 data[0].id
grep -n '^MB_LLM_VLM_MODEL=' ~/MusicBox/etc/spark.env     # 看运行时用的名字
```

两个不一致 = intent/剧本/助手全部走规则档，别把它当成「模型效果差」。

### 1.4 权重 / venv 落位

| 资产 | 路径 | 状态 |
|---|---|---|
| ComfyUI 图/视频族 | `~/ComfyUI/models`（128G） | ✓ 就位（`h3-image-cast`/`h3-image-broll`/`h3-fl2va` 三模板的 weights 全部在列） |
| facegate（buffalo_l） | `var/models/facegate/models/buffalo_l/{det_10g,2d106det,1k3d68,w600k_r50,genderage}.onnx` | ✓ 就位 |
| lipsync（EchoMimicV3-Flash） | `var/models` 下**只有 facegate** | ✗ **权重未拉**（E2 遗留） |
| ACE-Step  checkpoints | `services/acestep/models` → `/mnt/models-ssd/musicgen-server/vendor/ACE-Step-1.5/checkpoints` | ✓ 就位 |
| venv × 3 | `var/venv-asr` `var/venv-facegate` `var/venv-lipsync`（软链到 `/opt/musicbox/var/*`） | ✓ 三个 `bin/python` 都可执行（py3.12.3） |
| ComfyUI 模板 | `src/executor/templates/manifest.json`：`h3-image-cast`/`h3-image-broll`/`h3-fl2va` `placeholder:false`；**`h3-image-edit` 仍 `placeholder:true`**（`weights:[]`、`comfy_commit:null`） | 见 §5 blocked |

### 1.5 两条自查命令（开工前先贴这两条）

```bash
# ① 全服务状态 + 端点自检 + 内存 + 最近日志（只读，不干预）
bash ~/MusicBox/bin/status.sh

# ② 端口真值速查（比 status.sh 的进程档更可信：它只看 ss）
ss -ltn | grep -oE ':(7900|8090|8188|8390|8391|8395)' | sort -u
```

预期（2026-11-26 实态）：② 只回 `:8090`；① 的 `== 端口` 段只有一行 `:8090`，`== 端点自检` 段除
`LLM :8090 /v1/models  200` 外全是 `000ERR`，`== 进程（pid 档）` 八行全 `DEAD`。
和这个不一致，说明有人在你之前动过机器——先查清楚再往下做。

---

## 2. 动手前先跑、提交前必跑：零依赖质量闸门

```bash
cd ~/MusicBox
bash scripts/verify.sh              # 快检（秒级）：语法 + 工作区卫生 + 路由/契约对账 + 起服冒烟
bash scripts/verify.sh --full       # 加上全量验收套件（约 1 分钟）
bash scripts/verify.sh --repeat 20  # 全量验收 × 20，查 flake（P1-1 门票：全绿）
```

退出码 `0` 才可发布/入仓；非 0 禁止。**纪律：开工前先跑一次快检，把当时的红项记下来当基线；提交前
`--full` 必须全绿，且红项数量不得比基线多。**

当前（2026-11-26 22:4x）快检基线：

| 步 | 结果 | 说明 |
|---|---|---|
| 1/5 语法（78 文件） | ✓ | |
| 2/5 工作区卫生 | ✓ | 凭据扫描干净；已改 0 / 未跟踪仅子代理产物（旧快照曾攒 30 改 / 43 未跟踪，已由 13 个主题提交收敛） |
| 3/5 路由与契约对账 | ✓ | 曾红 2 项，均已按 append-only 纪律真修（不是放宽断言）：`v2.12` 补正式章节；`v3.2`/`v2.19` 重号 → 端侧语音改 `v3.3`、定脸方案点改 `v2.23`（引用已随语义 retarget）。纪律保留：**闸门红了去修缺陷，不许改闸门或断言换绿** |
| 4/5 起服冒烟 | ✓ | `/healthz 200`、载荷 `{"ok":true,...}`；「启动日志无明文凭据」为 ✓（P0-3 已修：明文口令不再入日志、`MB_ENV=prod` 下存在不安全默认值直接退出码 2 拒启） |
| 5/5 全量验收 | 跳过（需 `--full`） | 实测见 §3.4 |

---

## 3. 从零起一条最小可跑链路（server + mock 执行器 + 验收）

**本节命令本次实测通过**：端到端 `scripts/e2e_smoke.mjs` **21/21 全绿**（3 候选 mp3 1.2MB + peaks 400 点 + adopt + adjust 谱系）。

### 3.1 三个坑先避开

1. **`MB_VAR_ROOT` 与 `MB_VAR_DIR` 必须同源。** server 读 `MB_VAR_ROOT`、executor 读 `MB_VAR_DIR`；
   只改前者会复现 `SRC_MISSING 转码源文件不存在`（本次实测踩过一次：mock 出的 wav 落在临时 var，转码却在仓内 `var/` 找）。
   `etc/spark.env` 把两个键都写成了同一个绝对路径，照抄即可。
2. **令牌不要写死在命令行。** `pgrep -af` 会把 `--token <明文>` 整个打印出来。`source etc/spark.env` 后用
   `"$MB_EXECUTOR_TOKEN"`，或干脆不传 `--token`（执行器会回落读 `MB_EXECUTOR_TOKEN` 环境变量）。
3. **验收必须用 glob 形式**：`node --test --test-concurrency=1 "test/acceptance/*.test.js"`。
   目录形式 `node --test test/acceptance/` 在 Node 25 会被当模块路径解析而失败（README 已记）。

### 3.2 终端 A — 服务端（:7900）

```bash
cd ~/MusicBox && set -a; . etc/spark.env; set +a         # 25 行 MB_* 赋值一次性全量导出（与 bin/start_*.sh 同源）
MB_VAR_ROOT=~/MusicBox/var MB_VAR_DIR=~/MusicBox/var \
MB_PORT=7900 MB_ENV=dev MB_DEV_OTP=1 \
node src/server/index.js 2>&1 | tee /tmp/mb-api.log
```

预期（本次实测原样）：

```
(ExperimentalWarning: SQLite is an experimental feature ...)
2026-11-26T21:57:24.586Z [MusicBox] 服务端已启动 http://0.0.0.0:7911 ；产物 /f/* ；WSS /ws ；健康 /healthz
```

> 注意监听地址打印的是 **`0.0.0.0`**（`MB_BIND` 默认全网卡），不是 `127.0.0.1`；端口取 `MB_PORT`。
> 比对这行时别因为 host 不同就判"起错了"——真正要看的是 `/healthz` 是否 `"ok":true`。

另开一个 shell 验：

```bash
curl -s http://127.0.0.1:7900/healthz
# {"ok":true,"ts":"2026-11-26T14:48:02.542Z","online":0,"mv_metrics":{...,"lanes":{"music":{"queued":0,"leased":0}, ...}}}
```

`"ok":true` 即通过。`online` 是 **WSS 在线 App 客户端数**（不是执行器个数），无客户端时就是 `0`，别当成执行器没连上。
`mv_metrics` 段只有在 `MB_MV_ENABLED=1` 时才出现（`etc/spark.env` 目前就是 1）。

### 3.3 终端 B — mock 执行器（无 GPU 也出真产物）

```bash
cd ~/MusicBox && set -a; . etc/spark.env; set +a
MB_VAR_ROOT=~/MusicBox/var MB_VAR_DIR=~/MusicBox/var \
EXECUTOR_MOCK=1 node src/executor/index.js \
  --api http://127.0.0.1:7900 --token "$MB_EXECUTOR_TOKEN" \
  --lanes music,intent,ffmpeg 2>&1 | tee /tmp/mb-exec.log
```

预期：

```
[执行器] 启动：API=http://127.0.0.1:7900 通道=music,intent,ffmpeg 数据目录=/home/jianzengliang/MusicBox/var [MOCK]
[执行器] 已接入调度：执行器 ex_xxxxxxxxxxxxxxxx 通道=music,intent,ffmpeg（mock） 节点=music,asr,llm,comfy,lipsync,facegate,mv_asr
```

「数据目录」那行**必须**和你给 server 的 var 同一个路径（§3.1 第 1 条）。

### 3.4 终端 C — 验收

#### 3.4.0 一条命令跑完所有整改判据（推荐先跑这个）

```bash
node scripts/verify_remediation.mjs              # 约 2.5 分钟，35 项一张表
node scripts/verify_remediation.mjs --quick      # 只跑静态+从零链路+LLM 三面（约 1 分钟）
node scripts/verify_remediation.mjs --ticket     # 追加 P1-1 门票 verify.sh --repeat 20（约 30 分钟）
node scripts/verify_remediation.mjs --music      # 追加真机音乐链（需 GeekPro ACE-Step 已按 §6 ① 绑 Tailscale 起好）
```

输出是「整改项 → 判据 → 实测数字 → 结论」的表，退出码即判据。它和三件套（`verify.sh` / 验收 / 冒烟）的关系是**编排而不是替代**：
它自己去跑 `verify.sh --full`、逐个复跑 10 个整改套件、再从空 var 起服跑完整冒烟、最后打本机 LLM 三面。

三条设计上的硬规矩（都是被坑过之后写进去的，别为了变绿去改它们）：
1. 套件类判据要求 `fail==0` **且 `pass>=minCases`** —— 删套件或偷偷砍用例都会判红；
2. 跑不了的东西记 **BLOCKED** 并写明前置条件（真机 GPU、真人像 C2、跨机音乐链），**绝不记 PASS**；
3. 全程不碰仓内 `var/`，从零链路一律 `/tmp` 隔离 var。

**2026-11-27 实测**：`合计 35 项：PASS=32 INFO=1 BLOCKED=2`，退出码 0；两个 BLOCKED 是 C2 真人像
（本机 :8395/:8390/:8188 未跑）与跨机音乐链（需 GeekPro），均为环境未就绪而非代码不成立。


```bash
cd ~/MusicBox
node scripts/e2e_smoke.mjs http://127.0.0.1:7900        # 端到端 21 项，秒级~十几秒
```

预期 `总计 21/21 通过`（guest→扣 45 分→幂等→job done→3 候选 mp3+peaks→mp3 1.2MB→peaks 400 点→adopt→adjust 谱系）。

> **产物 URL 的取件口径（2026-11-27 起）**：`audio_url` / `waveform_url` 是服务端按 `MB_PUBLIC_BASE_URL`
> 拼出来的**绝对地址**。换端口/换机跑冒烟时，脚本会自动按命令行 base 回捞并在结尾如实提示改写次数
> （实测 `已按 base 回捞 2 次`）。**公网可达性是另一件事**，要按 §6 的公网口径单独验，不要混进冒烟结论。
> 踩过的坑：旧版脚本直接 fetch 绝对地址，在 7911 上跑却去连 `192.168.1.10:7900`，`ECONNREFUSED` 把排查方向整个带偏。

**2026-11-27 P0-8 从零复跑记录**（`MB_VAR_ROOT/MB_VAR_DIR=/tmp/mb-p08/var`、`MB_PORT=7911`、`MB_ENV=dev MB_DEV_OTP=1`）：
`/healthz` → `{"ok":true,...,"audit_failures":0,"credit_violations":0,"mv_metrics":{...}}`；
执行器首行 `数据目录=/tmp/mb-p08/var [MOCK]` 与 server 同源（§3.1 第 1 条）；
`node scripts/e2e_smoke.mjs http://127.0.0.1:7911` → **总计 21/21 通过**（mp3 1,202,721B / peaks 400 点 / adjust 谱系 depth=1）；
整套跑完 `/tmp/mb-p08/var` 37M，**仓内 `var/` 未被写入**。

```bash
cd ~/MusicBox
node --test --test-concurrency=1 "test/acceptance/*.test.js"    # 215 例（170 pass + 45 skip），闸门同口径实测 ~2 分钟
```

本次实测：`tests 172 / pass 126 / fail 1 / cancelled 0 / skipped 45 / duration 59.8s`。
唯一那条红是 **V1-⑥ `database is locked`**（已知 flaky，见 §8 第 3 行），不是新问题。
**记住这组数当基线**：改完代码再跑，pass 掉了就是回归。

### 3.5 停服

```bash
# 手敲起的：Ctrl-C 即可。用 bin/ 脚本起的：
cd ~/MusicBox
for n in api executor; do
  p=$(cat run/$n.pid 2>/dev/null); [ -n "$p" ] && kill "$p" 2>/dev/null && echo "stopped $n pid=$p"
done
ss -ltn | grep -E ':(7900) ' || echo "7900 free"
```

别用 `pkill -f "src/server/index.js"`：它会把你自己那条命令行（含这个字符串）也匹配上，连 shell 一起 SIGTERM。

---

## 4. 常驻起服：`bin/` 脚本（Linux 版，本机就这一套）

| 脚本 | 端口 | pid 档 | 日志 | 前置 | 行为 |
|---|---|---|---|---|---|
| `bin/start_api.sh` | 7900 | `run/api.pid` | `var/logs/api.log` | `etc/spark.env` | pid 活则退出 0；**7900 被别的进程占则 abort 不杀** |
| `bin/start_executor.sh` | — | `run/executor.pid` | `var/logs/executor.log` | `etc/spark.env` | lanes 取 `MB_LANES`（默认七道全开） |
| `bin/start_acestep.sh` | 8190 | `run/acestep.pid` | `var/logs/acestep.log` | `services/acestep/venv` + `server.py` | 同上幂等/abort |
| `bin/start_comfyui.sh` | 8188 | `run/comfyui.pid` | `var/logs/comfyui.log` | `~/ComfyUI/venv` | `--listen 0.0.0.0`；只发任务+只读观测，**代码层无 `/free`**（ADR-MV-4） |
| `bin/start_workers.sh [asr\|facegate\|lipsync\|asr1\|all]` | 8391/8395/8390/8191 | `run/*.pid` | `var/logs/<name>.log` | `var/venv-*` | 缺 venv 打印 `missing venv` 并返回 1；端口占用 abort 不杀 |
| `bin/status.sh` | — | 只读 | — | — | §1.5 |

共同点：都 `BASE="$HOME/MusicBox"`、都 `source etc/spark.env`（`set -a` 全量导出）、都用 `$BASE/node/bin/node`（v22.23.5）、都是 `setsid nohup` 后台 + pid 档。
所以：**改了 `etc/spark.env` 必须重启对应服务才生效**；起不来先 `tail -50 var/logs/<name>.log`。

推荐顺序（音乐线，本机已实测的组件）：

```bash
cd ~/MusicBox
bash bin/start_acestep.sh      # :8190（惰性加载，首发生乐才进模型）
bash bin/start_api.sh          # :7900
bash bin/start_executor.sh     # 拉单 daemon
bash bin/status.sh
```

---

## 5. MV 全载链路（ComfyUI + 83xx workers + MV 灰度）

### 5.1 顺序（照 `deploy/spark/fullload-test-plan.md` §2 的 A2→A5）

```bash
cd ~/MusicBox

# ① 生图/生视频共宿主队列（:8188）。共宿主纪律：只发任务 + 只读观测，永不 /free /kill。
bash bin/start_comfyui.sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8188/system_stats   # 期望 200

# ② MV 自有 worker（83xx，仅回环，executor 独占调用）
bash bin/start_workers.sh facegate   # :8395 — 权重齐，可起
bash bin/start_workers.sh asr        # :8391 — 起得来，但见下方 BLOCKED-3
bash bin/status.sh                   # 期望 8395/8391 变 200

# ③ API + 七道 lanes 的执行器（MV 线要 imgspark/vidspark/lipsync/align 四道）
bash bin/start_api.sh
bash bin/start_executor.sh           # lanes 来自 MB_LANES=music,intent,ffmpeg,imgspark,vidspark,lipsync,align

# ④ MV 灰度（已在 etc/spark.env:34 MB_MV_ENABLED=1；显式确认，不要靠记忆）
grep -n '^MB_MV_ENABLED=' etc/spark.env
curl -s http://127.0.0.1:7900/healthz | head -c 120     # 有 mv_metrics 段 = 开关真的生效了
```

判定线：`:8188/system_stats` 200 · `:8395/health` 200 · `:8391/health` 200 · `:7900/healthz` `{"ok":true` ·
执行器日志出现「已接入调度 … 通道=music,intent,ffmpeg,imgspark,vidspark,lipsync,align」。

### 5.2 BLOCKED（当前明确跑不通的，别硬试）

| # | 缺项 | 证据 | 影响 | 出路（**均需改 `etc/spark.env` 或拉权重，不由本文动**） |
|---|---|---|---|---|
| **B-1** | **lipsync 权重未拉（E2 遗留）** | `var/models/` 下只有 `facegate/`，无 EchoMimicV3-Flash 任何文件 | `:8390/health` 即便起来也只是 `configured:false`；`POST /lipsync` → **503 `ENGINE_NOT_READY`** → V15 / C4 口型链全红 | 拉权重到 `MB_LIPSYNC_MODELS` 指向的目录；**注意 `MB_LIPSYNC_MODELS` 这个键在 `src/` 里零引用**（死键，见 §9），真正决定行为的是下面两条 |
| **B-2** | **`MB_LIPSYNC_COMMAND` / `MB_LIPSYNC_SYNC_COMMAND` 未配** | `grep -c MB_LIPSYNC_COMMAND etc/spark.env` → **0**；`mv_lipsync/app.py` 无它即 503 | 同上：lipsync 起来也是空壳 | 显式写推理命令与打分命令（JSON 数组，含 `{video} {audio} {output} {text} {score_file}` 占位符） |
| **B-3** | **83xx 白名单没落到本仓 `var/`**：`MB_LIPSYNC_ROOTS`、`MB_MV_ASR_ROOTS` 未设 | 两者的代码默认值是 `"/opt/musicbox/var,E:/Work/MusicBox/var"`（`mv_lipsync/app.py:12-14`、`mv_asr/app.py:13-15`）；`grep` 两个键在 `etc/spark.env` 里 **0 命中** | `:8391`/`:8390` 进程能起、`/health` 能 200，但任何落在 `/home/jianzengliang/MusicBox/var/...` 的输入文件一律 **403「路径不在允许目录」**——即 `align`/`lipsync` 两道 lane 实跑必挂 | 照 `MB_FACEGATE_ROOTS`（已正确落 `.../MusicBox/var`）的样子补这两个键；`mv_facegate` 是唯一配对的，别拿它的表现推断另外两个 |
| **B-4** | **`:8391` 进程死** | `run/mv_asr.pid` DEAD，`ss` 无 `:8391` | `align` lane 领单即失败 | `bash bin/start_workers.sh asr`（venv 在位，能起；起完仍有 B-3） |
| **B-5** | **`h3-image-edit.json` 仍是 placeholder** | `src/executor/templates/manifest.json` 里该条 `placeholder:true`、`weights:[]`、`comfy_commit:null`（另三条 `false` 且带权重表+commit） | `mv_storyboard` 角色镜「只换背景壳」这条分支未真机标定（SP-MV-4），发单会被 `COMFY_TMPL_DRIFT` 拒 | 真跑一发回填 manifest（`comfy_commit`/`weights`/`vram_profile`/`evidence`，`placeholder:false`）；未回填前该分支按非致命降级走 `mv-facegate /swap ×2` |
| **B-6** | **内存留裕不足** | `free -g` 可用 ≈4G（vLLM `:8090` 常驻 117G 已用）；执行器领单前的 `ram_free < 20G` 就挂起等待 | 全载（音乐族+生图族+生视频族同驻，预算 ~80G）**现在必然起不来**，会一直挂在队列 | 先决定 vLLM 与全载谁让路（GB10 统一内存，二者互斥）；**阈值不许为了"通过"而下调**（历史上 8.5G/12.3G 判通过的软化不重演） |

`h3-image-cast` / `h3-image-broll` / `h3-fl2va` 三条**不在 blocked 里**：模板已登记、权重在位。
其中 `h3-image-broll` 的 manifest note 明写「纯文生图分支尚未在 Spark 真机单独验收」——照做时把它的 evidence 补上。

---

## 6. 真机（Android adb / Tailscale）

### 6.1 头号坑：`MB_PUBLIC_BASE_URL` 必须是手机可达地址

`audio_url` / `audio_master_url` / `waveform_url` / 视频产物 URL **全部由 `MB_PUBLIC_BASE_URL` 拼接**。
留默认 `http://127.0.0.1:7900` 的话，App 拿到的是手机自己身上的 127.0.0.1 —— **列表能出、卡片能渲染，但播放/下载全挂**，
而且服务端日志一片干净（一期 K90 实测踩过，11-26 全载清单里又列为 C0 前置）。

```bash
cd ~/MusicBox
grep -n '^MB_PUBLIC_BASE_URL=' etc/spark.env      # 实值：http://100.81.83.59:7900（DGX 的 Tailscale 地址）✓
# 手机与本机不在同一 LAN 时只能走 Tailscale；同 /24 且防火墙放行时可换 http://192.168.1.10:7900
# ⚠️ 手机侧 Tailscale 没连上时，App 顶部会显示「服务器未连接，当前可使用本地功能」——这是正确的降级
#    （明示、不崩、不装死）。先在手机上 curl 基址定性，再决定是修网络还是动代码（见下条决定性判据）。
```

改完**在手机上验**（不是在本机 curl）：

```bash
adb -s 8b1e8747 shell getprop ro.product.model                     # M2012K11AC
adb -s 8b1e8747 shell curl -s http://192.168.1.10:7900/healthz      # 决定性判据：设备上直连基址（/system/bin/curl 在位）
adb -s 8b1e8747 shell "toybox nc -w2 192.168.1.10 7900 </dev/null && echo TCP_OK"   # 只判 TCP 可达
```

本次实测（API 未起时）后一条回 `nc: connect: Connection refused` —— **refused = 手机到主机路由通、只是服务没起**，
比"超时"信息量大得多；服务起来后这两条应分别返回 `{"ok":true...}` 与 `TCP_OK`。

本机侧对拍（同一条命令换两个地址各跑一次，两边都该 200）：

```bash
curl -s http://192.168.1.10:7900/healthz | head -c 60     # LAN（手机走这条）
curl -s http://127.0.0.1:7900/healthz     | head -c 60    # 回环
```

**只要 LAN 那条非 200，就先别查 App，先查防火墙/监听地址/是不是忘了重启。**

### 6.2 当前设备与命令

| 设备 | 通道 | 用法 |
|---|---|---|
| 红米 `M2012K11AC`（Android 13）serial `8b1e8747` | USB 直连 `device` | 主力，`adb -s 8b1e8747 ...` |
| `M332BF`（Android 17） | Tailscale `100.75.247.55:5555` | **当前 offline**；要用的话 `adb connect 100.75.247.55:5555` 先打通 |
| `192.168.1.151:5555` | WiFi 局域网 | **当前 absent** |

```bash
adb devices -l                                    # 看清 serial / 型号
adb -s 8b1e8747 install -r <apk 路径>              # 见下方 blocked
adb -s 8b1e8747 logcat -s musicbox:*              # App 侧日志
adb -s 8b1e8747 exec-out screencap -p > /tmp/c1.png   # 证据留档（→ tmp/evidence/<ts>/C*_*.png）
adb -s 8b1e8747 shell dumpsys media_session        # 播控/锁屏验收
```

### 6.3 BLOCKED（真机侧）

- **本机无 `flutter`** → `flutter run` / `flutter build apk` 在本机做不了；`builds/` 目录也不存在（无现成 APK）。
  出路：本机装 Flutter SDK（Dart `^3.6.0`），或在别的机器出包后 `adb install`。
  打包期基址用 `--dart-define=MUSICBOX_BASE_URL=http://192.168.1.10:7900`（`src/app/lib/core/config.dart`），
  或走 App 内「服务器设置」页填同值——**两条都填成 127.0.0.1 就是 §6.1 的坑**。
- 签名件 `src/app/android/key.properties` 在位但**不入仓**；APK/keystore 一律不进 git。

---

## 7. 上线前必做（安全）— 三条凭据必须显式设置

> 状态：这三条的默认值正在被 lead 改为 **fail-closed**（不给就起不来）。在此之前，
> **不要把「没配也能起」当成「配好了」**。本节只写操作要求，代码改动不在本文范围。

| 键 | 当前默认（`src/server`） | 风险 | 必做 |
|---|---|---|---|
| `MB_DEV_OTP` | `1` → 验证码恒 `888888`（`config.js:104`） | 任意手机号 = 正式用户 token | 开发档**显式** `MB_DEV_OTP=1`；**生产必须显式 `MB_DEV_OTP=0`**（不要依赖"默认是 0"，默认是 1） |
| `MB_ADMIN_USERNAME` / `MB_ADMIN_PASSWORD` | `admin` / `admin1234`，且**明文写进启动日志**（`api/admin.js:13-21`） | 后台 `/admin/users`、`/admin/config/features` 可读写 | 上线前显式设两个键为强随机值；核对 `var/logs/api.log` 里**不再出现明文凭据**。闸门里 `TODO_P03=1` 可把这条告警转成硬失败，改完请把它打开 |
| `MB_EXECUTOR_TOKEN` | `dev-executor-token`（`config.js:32`） | 任何人可伪装执行器领单/回单（校验逻辑本身是对的，是默认值公开） | 显式设一个强随机值（`etc/spark.env` 里已是非默认值）；**别把它打印到命令行或日志**（§3.1 第 2 条） |

其它上线前项：`etc/*.env` `chmod 600` 且不入库；83xx 只回环（`app.py` 里 `host="127.0.0.1"`，别改成 0.0.0.0）；
执行器只出网拉单、GPU 机零入站（VPS 侧 `/executor/` 段用源 IP 白名单，见 `deploy/vps/SETUP.md` §2）；
`var/`（DB/令牌/产物/词库/权重）不入仓；用户面任何文案不得出现引擎型号名（契约 §0 纪律）。

---

## 8. 常见坑

| 现象 | 根因 | 处置 |
|---|---|---|
| 验收里 done 方向用例假超时 / 或明明有 ffmpeg 却判 `FFMPEG_MISSING` | 验收是**能力探测**：真编一段正弦 wav → `mp3(libmp3lame)` 编得动才算"存在"（`helpers.js:167-196`）。只做视频的精简构建会被判缺失（**这是正确行为**，不是 bug） | 本机 `/usr/bin/ffmpeg` 6.1.1 能力齐全，正常路径不会命中。要指定别的二进制用 `MB_TEST_FFMPEG=<绝对路径>`；要演练缺失方向用 `MB_TEST_FORCE_NO_FFMPEG=1`（此时 done 方向显式 skip，fail 方向恒执行） |
| `var-test/` 越堆越大（实测 **3.1G / 595 个目录**，跑一轮全量 +23 个目录 / +0.1G，`after()` 不回收） | 每套件独立 `MB_VAR_ROOT=var-test/<套件-pid-rand>`，用完不清 | 随便删：`rm -rf ~/MusicBox/var-test/*`（正式运行时数据在 `var/`，两者不同名，删错就麻烦了——**别删 `var/`**）。想留证据就先 `du -sh var-test` 记个数 |
| `database is locked` | 白盒只读库连接 `new DatabaseSync(dbPath)`（`helpers.js:544,839`）**没设 `busy_timeout`**（server 侧 `store.js:346` 设了 5s）→ V1-⑥ / V17-⑦ 间发。本次实测唯一那条红就是 V1-⑥ | 是已知 flaky（`--repeat 20` 就是为它设的门票）。**不要靠重跑变绿来交差**；服务端 `var/logs/api.log` 里也出现过同款（`store.js:366`），一并记给 lead。修它在测试侧加 busy_timeout，不在本文范围 |
| `SRC_MISSING 转码源文件不存在` | server 用 `MB_VAR_ROOT`、executor 用 `MB_VAR_DIR`，两者不同源 | 两个键设成同一路径（§3.1）；`etc/spark.env` 已同值，手敲命令时别只设一半 |
| 起服脚本报 `port N occupied by unknown process; abort` | `bin/*.sh` 刻意**不杀**别的进程（共宿主纪律） | `ss -ltnp \| grep :N` 看是谁。是上一轮自己起的孤儿 → 按 pid 档 kill；是宿主的服务（`:8188`/`:8090`）→ **不许 kill**，改端口策略或找宿主 |
| `:8391`/`:8390` `/health` 200 但一发就 403「路径不在允许目录」 | `MB_MV_ASR_ROOTS` / `MB_LIPSYNC_ROOTS` 没设，默认白名单是 `/opt/musicbox/var` + **`E:/Work/MusicBox/var`（Windows 残留）** | §5.2 B-3。**`/health` 200 ≠ 能用**，判可用要看实跑一发 |
| `POST /lipsync` → 503 `ENGINE_NOT_READY` | `MB_LIPSYNC_COMMAND` 未配（§5.2 B-2） | 同上 |
| `GET /v1/models` 200 但 intent 效果像没接 LLM | 模型名不对（§1.3），静默走词典启发式 | 对 `/v1/models` 的 `data[0].id` 校 `etc/spark.env`；判定「LLM 档有没有生效」看 intent 的 confidence 与审计来源字段，不是看有没有报错 |
| 状态脚本里 LLM 那行是 `000`/`404` 但服务明明在线 | vLLM 只有 `/v1/models`，裸 `/models` 是 **404** | `bin/status.sh` 已改为探测 `/v1/models`（本次修）；自己写探测时用 `/v1/models` |
| 全载跑不动 / 队列一直挂着 | `ram_free < 20G` 执行器主动挂起等待（GB10 统一内存，vLLM 常驻） | §5.2 B-6。**不降阈值**，先做取舍 |
| `nvidia-smi` 看不出显存 | GB10 统一内存，`memory.used/total` 返回 `N/A` | 判资源用 `free -g` + `:8188/system_stats` 的 `ram_free` |
| 手敲 `node` 和起服脚本用的 node 版本不同 | PATH 是 v25.2.0，`bin/*.sh` 用 `$BASE/node/bin/node` = v22.23.5 | 都 ≥22 可混用；要复现"脚本行为"就用 `$BASE/node/bin/node` 那条 |
| `node --test test/acceptance/` 直接失败 | Node 25 把目录参数当模块路径解析 | 用 glob：`node --test --test-concurrency=1 "test/acceptance/*.test.js"` |
| 验收多套件互抢同一空口 | 并发跑时端口探测撞车 | 恒带 `--test-concurrency=1`；基座端口用 `MB_TEST_BASE_PORT` 改 |

---

## 9. 环境变量族（`MB_*`）—— 只读说明，**本文不新增任何键**

- 全族都是 `MB_` 前缀（少数测试专用例外：`MB_TEST_FFMPEG`、`MB_TEST_FORCE_NO_FFMPEG`、`MB_TEST_BASE_PORT`；
  以及执行器 mock 开关 `EXECUTOR_MOCK`、兼容别名 `PORT`/`DEV_OTP`）。
- 计数口径（本次实测）：`grep -rhoE 'MB_[A-Z0-9_]+' src/server | sort -u` = **41** 个；
  `src/server` + `src/executor` 合并去重 = **58** 个。lead 口径的「57 个 server 侧」对应后者附近，
  差别在"是否把 executor 侧的键算进 server 族"，**不是有键被漏掉**。
- 单一真源是 **`etc/spark.env`（chmod 600，不入仓）**；`deploy/spark/spark.env.example` 只是模板。
  `bin/start_*.sh` 用 `set -a; . etc/spark.env` 全量导出，`deploy/spark/*.service` 与它同源。
- 最常碰的：`MB_VAR_ROOT` / `MB_VAR_DIR`（同源！§3.1）、`MB_PUBLIC_BASE_URL`（§6.1）、
  `MB_LLM_VLM_URL` / `MB_LLM_VLM_MODEL`（§1.3）、`MB_MV_ENABLED`（§5.1）、`MB_LANES`（§4）、
  `MB_FFMPEG` / `MB_FFPROBE`、`MB_COMFY_URL`、`MB_MUSIC_URL`、`MB_{LIPSYNC,FACEGATE,MV_ASR}_URL`、
  `MB_DEV_OTP` / `MB_ADMIN_*` / `MB_EXECUTOR_TOKEN`（§7）。
- **两个已核对的落位缺陷**（改法都是改 `etc/spark.env`，**不由本文动，也不靠新增键绕**）：
  1. `MB_LIPSYNC_MODELS`（`spark.env:19`）在 `src/` 里**零引用**，是死键——它挡不住 lipsync 找不到权重，别被它骗。
  2. `MB_LIPSYNC_ROOTS` / `MB_LIPSYNC_COMMAND` / `MB_LIPSYNC_SYNC_COMMAND` / `MB_MV_ASR_ROOTS` 是代码**已经在读**、
     但 `spark.env` 没落的键（§5.2 B-2/B-3）。补它们属于「把既有键配上」，不是新增环境变量。

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-26 | 首版。实态快照 / 最小链路（实测 21/21 + 172 例基线）/ MV 全载 blocked 清单 / 真机 / 安全三条 / 常见坑表。同步修 `bin/status.sh` 的 LLM 探测端点（`/models` → `/v1/models`）并把探测项按 MV 全家桶（7900/8090/8188/8390/8391/8395）补全。Windows 口径移到 [runbook-windows-legacy.md](runbook-windows-legacy.md) |

**本文只覆盖「本机现在怎么跑」。** 契约改动一律先改 [CONTRACTS.md](../CONTRACTS.md) 再改代码再回归
`test/acceptance/`；本页与 `CONTRACTS.md` 冲突时，以 `CONTRACTS.md` 为准并回来修本页。

### 6.5 服务端语音识别（sensevoice :8191）实测落位（2026-11-27）

本机（DGX）此前 **完全没有 ASR 环境**：系统 Python 无 `funasr`，且 Debian 系 PEP 668 禁止 `pip install --user`。
正解是建 venv（别用 `--break-system-packages` 污染系统 Python）：

```bash
python3 -m venv var/venvs/sensevoice
var/venvs/sensevoice/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu   # CPU 版即可
var/venvs/sensevoice/bin/pip install funasr fastapi uvicorn kaldi-native-fbank
ln -sfn venvs/sensevoice var/venv-asr        # bin/start_workers.sh 找的是 $MB_VENV_BASE/venv-asr
bash bin/start_workers.sh asr1               # 127.0.0.1:8191，懒加载
```

- **`kaldi-native-fbank`（或 `torchaudio`）是必需的**：缺它时 `/healthz` 照样 200、模型也“加载成功”，
  但第一次 `/asr` 才炸 `ImportError: torchaudio is not installed and neither is the kaldi-native-fbank fallback backend`。
  这是典型的“健康检查骗人”——起服后必须真打一次 `/asr` 才算就位。
- 实测（CPU，torch 2.15.0+cpu / funasr 1.4.29）：1 秒 220Hz 正弦 → `{"text":"Yeah.","duration":1.0}`
  （正弦无人声，模型给出幻觉文本属正常，`duration` 与音频一致才是关键判据）；`/healthz` → `model_loaded:true`。
- 越权读文件已被拒：`POST /asr {"path":"/etc/passwd"}` → `403 {"detail":"路径不在允许目录"}`（`MB_ASR_ROOTS` 白名单，抢救 P0-4 加的）。
- 端到端（server :7997 → worker :8191）实测：`/v1/health/speech` 报 `asr.ok=true`；
  `/v1/assistant/bootstrap` 的 `capabilities.voice` 随之变 `true`（此前硬编码 false）；
  `POST /v1/intent/voice` 上传 wav → `{"intent_id":"in_…"}`。
- 真机语音（手机录音 → 端侧 sherpa 或上传服务端）仍需在 GeekPro 连手机后验；本节的判据可直接复用。

### 6.6 音乐线真机全链（DGX 执行器 + GeekPro 5060 Ti 引擎）实测（2026-11-27）

拓扑（用户口径）：**server 与执行器留在 DGX**，生乐引擎在 GeekPro 的 5060 Ti 上，助手 LLM 用 DGX 已托管的 `qwen38-fp4`。

| 件 | 位置 | 实测证据 |
|---|---|---|
| ACE-Step 1.5 引擎 | GeekPro `E:\Work\X-Theater\runtime\acestep\server.py`（**不在** MusicBox 仓库的 `services/acestep`，那里没有 venv） | `GET /health` → `{"service":"w-m-acestep","vram":{"cuda":true,"gpu":"NVIDIA GeForce RTX 5060 Ti","vram_total_mb":16310.6}}` |
| 引擎入口 | `POST /music`、`GET /music/{id}/file`、`POST /unload`；**硬编码 `host=127.0.0.1` port 8190** | 读远端 server.py 尾部实测 |
| 助手 LLM | DGX `http://127.0.0.1:8090/v1` | `/v1/models` → `id=qwen38-fp4` |
| 语音识别 | DGX `127.0.0.1:8191`（见 §6.5） | `model_loaded:true` |

因为引擎只绑 `127.0.0.1`（`server.py:348` 是 `uvicorn.run(app, host="127.0.0.1", port=8190)`），
**不要为了连它去改别人仓库的源码**。两条路，**默认走 ①**：

**① 绑 Tailscale 网卡直连（推荐，不用隧道）** —— 用 uvicorn CLI 绕开它的 `__main__`，只监听 Tailscale 那张网卡：

```bash
# 从 DGX 经 SSH 拉起（HF_HUB_OFFLINE=1：模型已在本地，别去联网找）
GP_PASS=… python3 tmp/gp.py -t 10800 'set HF_HUB_OFFLINE=1&& cd /d E:\Work\X-Theater\runtime\acestep&& E:\Work\X-Theater\runtime\acestep\venv\Scripts\python.exe -m uvicorn server:app --host 100.100.140.75 --port 8190 --log-level warning'
curl -s -m 8 http://100.100.140.75:8190/health | head -c 200    # 本机验：RTX 5060 Ti / handler_ready 惰性加载
# etc/spark.env 的 MB_MUSIC_URL 就是它：MB_MUSIC_URL=http://100.100.140.75:8190
MB_SEC=30 MB_COUNT=1 bash tmp/real_music_run.sh                  # server+执行器+验收一次跑完
```

> 只绑 `100.100.140.75` 而**不是** `0.0.0.0`：那台是家用游戏机，别把生乐端口顺手开放给整个局域网。

**谁能碰引擎（架构红线）**：只有**执行器**直连 ACE-Step（`src/executor/lanes/music.js`：`POST /music` 提交 +
`GET /music/{id}/file` 按协议取件回捞）。App **永远只跟 server 说话**：提交 → 领任务 → 拿 `audio_url` → 经 server 的
`/f/*` 取件口下载。所以"引擎该绑哪张网卡"的判据是**执行器所在机器能不能打到它**（现在执行器在 DGX →
绑 Tailscale 网卡就够），而不是"手机能不能打到它"。把生乐引擎开放给手机直连既没必要也不安全：它没有鉴权、
没有扣费与配额，等于把 5060 Ti 白送出去当免费 GPU。
> 实测跨机链 30/30 判据全绿；产物经 `GET /music/{id}/file` 回捞（执行器在 DGX，异机 `E:\…\out\*.wav` 直接读不到）。

**② 备用：SSH 隧道反打**（Tailscale 面出问题时才用；此时 `MB_MUSIC_URL` 改回 `http://127.0.0.1:8190`）

```bash
python3 tmp/gp.py       -t 10800 '<同上的 python.exe server.py 起法>'
python3 tmp/gp_tunnel.py 8190 127.0.0.1 8190                     # 本机 8190 → GeekPro 127.0.0.1:8190
```

四个**必然踩到**的坑（本轮全部实测复现过，别再靠猜排障）：

1. **引擎返回的 `file` 是生成机自己的绝对路径**（`E:\...\out\x.wav`）。执行器在 Linux 上既不能当 URL 也不能本地复制 → 旧代码报「音乐生成产物缺失」，而引擎其实已出歌。已按协议取件口回捞（`GET /music/{id}/file`），修复见 `src/executor/lanes/music.js`。这类故障 FakeExecutor 永远验不到。
2. **子 shell 起 node 必须 `exec`**：`( cd src && node executor/index.js ) &` 里 `$!` 是子 shell 的 pid，`kill` 后 node 变孤儿继续抢单。本轮留下 3 个僵尸执行器，导致 `complete` 被 403 —— 不是服务端双领（领单是 CAS：`UPDATE … WHERE id=? AND status='queued'` + `changes===1`），也不是租约（租约 10min、心跳 60s、零失败）。
3. **端口必须确认空闲 + pidfile + trap**：孤儿 server 占住 7998 会让新 server `EADDRINUSE` 静默死，而脚本 `rm -rf` 过 var 目录 → 旧 server 握着已删 DB 的 inode → 验证脚本读新库读到空表，报「executors 表为空」这种彻底误导人的结论。
4. **`pkill -f <模式>` 会杀掉自己**（模式串出现在被执行的命令行里）。用 pidfile；非要 pkill 就用字符类 `'executor/inde[x].js'`。

引擎侧性能实测：单候选（30s 目标时长）在 5060 Ti 上约 **10–11 分钟**（含首次加载；服务「响应后释放显存」，所以每次都可能重载）。**这直接决定 `config.engine.leaseMs=10min` 偏紧**：count=3 的串行生成远超租约，是音乐线在真机上长期「跑不完 + 反复回队 + 退款」的结构性原因（见 `docs/musicbox-rescue-refactor-plan.md` M2 吞吐项）。

`/healthz` 的 `online` 是 **App 的 WSS 连接数，不是执行器数量** —— 判执行器死活要看 `executors.last_seen`（`scripts/verify_real_music.mjs` 的 A4b 就是这么做的）。

#### 6.6.1 真机验收结论（2026-11-27，GeekPro 5060 Ti + DGX qwen38-fp4）

`scripts/verify_real_music.mjs` 共 30 条判据，实测 **29 通过 / 1 真实失败**。通过的硬证据（不是 status=done 就算过）：
候选 mp3 真下载 1,201,965B、ffprobe `dur=30.02s codec=mp3 sr=48000 ch=2`、`mean_volume −16.9dB/−20.8dB`（非静音）、
2/2 唯一 sha256（同 seed 也真出不同版本）、扣费 30⚡、`Σdelta==余额`、助手 `mode=llm+rule caps.llm=true`、
读工具对话零扣费。唯一失败：**「帮我看看还有多少积分」被当闲聊回了自我介绍**（详见下）。

两个**必须显式配置否则功能不出现**的开关（都属于"看着像坏了"的那类）：

| 开关 | 默认 | 不开的后果 |
|---|---|---|
| `MB_PUBLIC_BASE_URL` | `http://127.0.0.1:7900` | 候选/作品的 `audio_url` 指向默认 :7900，换端口或反代后手机**取不到声音**（验证判据 A10b 专防这个） |
| `MB_MUSIC_ASSISTANT` + `MB_MUSIC_ASSISTANT_CHAT` | `0` / `0` | 助手恒为 `rule` 模式、`capabilities.llm=false`，用户体感"AI 助手没接大模型" |

助手的 LLM 节点由 `model_nodes` 种子 `mn_llm → MB_LLM_VLM_URL / MB_LLM_VLM_MODEL` 提供；`llm+rule` 还要
`AC.featureOn('assistant_chat_music')` 与 `M.probeNode('llm')` 探活为 healthy，任一不满足即静默退化为 rule（不报错）。

已实测的助手工具面（14 个，`src/server/l2assistant/core.js`）：`music.adjust_params / set_title / set_card /
regenerate / extend / cover / query_status`、`library.search`、`assistant.task_query / ticket_query / context /
task / message / event`。**契约三张工具表（CONTRACTS.md :608 / :764-765 / :830-831）均未声明积分/余额读工具**，
所以「查积分」只能落到 LLM 自由发挥并回出自介绍 —— 判据 A21b 把它单独量化，待产品裁决（加只读工具需先入契约）。
