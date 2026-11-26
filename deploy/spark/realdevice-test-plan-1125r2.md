# MusicBox 真机业务测试计划 · 第2 周轮 R2（2026-11-25 下午）

> 基线：R1 计划/留档见 [fullload-test-plan.md](fullload-test-plan.md) / [fullload-evidence.md](fullload-evidence.md)（上午轮，`:8090` Off、单小米13 客户端）。
> R2 变更（发起人指示）：
> 1. **LLM 已配置在线**：DGX 本机 `:8090` = llama.cpp `Inkling2-Mini:vision`（GGUF UD-Q4_K_XL + dspark Q8_0 spec-draft，ctx 262144，fa on，cache q4；起 16:06 via `start_inkling_llamacpp_8090.sh`）。手机可达地址 `http://100.81.83.59:8090/v1`；执行机本机即 `http://127.0.0.1:8090/v1`。
>    - **env 必改**：`MB_LLM_VLM_MODEL=qwen38-fp4` → `Inkling2-Mini:vision`（以 `/models` 返回 `alias` 为准，否则 chat 404 → intent 走词典兜底即质量红）。
>    - 契约 §0 纪律：用户面文案零引擎型号名。
> 2. **全加载口径**：音乐模型 + MiniMax H3 全家桶（生图族+生视频族）一次性同时驻（发起人：内存资源非常充足）。
> 3. **客户端验证 = 3 台测试机**（R1 即单小米13）：
>
> | 台 | 型号 | serial | 安卓 | 通道（按列顺序，反引号即可直接执行） | 状态 |
> |---|---|---|---|---|---|
> | 1 | 2211133C | `98fc9410` | 16 | USB `adb -s 98fc9410 shell true` → Tailscale `adb connect 100.109.138.2:5555` | 亮屏 · 常亮 · 前台 WeChat |
> | 2 | M2012K11AC | `8b1e8747` | 13 | USB `adb -s 8b1e8747 shell true` → WiFi LAN `adb connect 192.168.1.151:5555` | 息屏 · 非常亮 · 无前台 |
> | 3 | M332BF | `43328e37` | 17 | Tailscale `adb connect 100.75.247.55:5555` | 亮屏 · 常亮 · 前台 dsh_phone |
>
> 采样口径：R2 探测即本 DGX 机（`gx10-85f3`）；USB 两台**未 attach 到 DGX**（fleet 报告 host=Liang-GeekPro）⇒ 按通道顺序 USB 探测失败后自动走次 relay。adb 本机即 1.0.41/34.0.4。

## 0 R2 实测前提（16:2x–16:3x 采样）

| 项 | 值 | 判读 |
|---|---|---|
| 监听 | `:8090`(llama LLM) `:8080`(SearXNG) `:3080`(web) | `:7900/:8188/:8190/:8191/:83xx` 全部未起 ⇒ 阶段 A 必起（R1 落位 bin/etc 存在，services/var/run 缺） |
| 内存 | `free -g` 121 总 / 56 已用 / **65 可用**；GB10 0% util（NVML 即沙箱拒，full-access 档 OK） | LLM 驻即 RSS~6.4G+GPU 侧；R1 三族+生乐 驻即 ~59G ⇒ **预算对 65G 即零头**，B4 阈值 ram_free≥20G 对 R1 档即**必留档诚实**（发起人口径：内存充足，仍不伪造） |
| 落位缺 | `~/MusicBox/services/acestep` 缺 · `var/{venv-*,models,out,logs}` 缺 · `run/` 缺 | A0 落位单（§1） |
| venv 供 | `/opt/musicbox/var/venv-{asr,facegate,lipsync}` 存在（弃路径只读对照，**软链落位**） | A0 |
| 生乐 | `~/musicgen-server/.venv`（torch 2.10.0+cu130，`import acestep` OK）+ `/mnt/models-ssd/.../ACE-Step-1.5/checkpoints` 28G | A0 软链落位 |
| 生图/视频 | `~/ComfyUI` venv OK · H3 权重热集（diffusion 77G dir/text_encoders 22G/vae 13G/loras 17G）· 模板 `h3-image-cast`/`h3-fl2va` 已 R1 真机登记（placeholder:false） | B0 无需重登记；`h3-image-broll` 纯文生图分支未单独验收 |
| 权重缺 | lipsync（EchoMimicV3）与 facegate buffalo_l onnx **未拉**（`/opt/musicbox/var/models` 空） | C4 口型即 skip 登记（E2 遗留）；facegate precheck 即 503 诚实 |
| APK | `builds/` 不落 DGX（R1 apk 即 dev 机产物） | C 即 设备已装档探测 `pm list packages`；UI 级另拍即亮屏两台 |

## 1 阶段 A — 落位 + 起服务（顺序 + 判定）

| # | 动作 | 判定 |
|---|---|---|
| A0 | 落位单：`etc/spark.env` 改 `MB_LLM_VLM_MODEL=Inkling2-Mini:vision` + 显式 `MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD`（dev 值，chmod 600；afee684 即运维文档去默认明文凭据，代码默认 admin/admin1234 即 dev 档）；`services/acestep/{server.py←deploy/spark/services/acestep_server.py, venv→~/musicgen-server/.venv, models→/mnt/models-ssd/.../checkpoints, acestep-repo→(venv 即 acestep 已 importable，软链 vendor 档)}`；`var/venv-{asr,facegate,lipsync}→/opt/musicbox/var/venv-*`；`mkdir var/{out,logs,models,uploads,exec} run/` | `node --check` 两入口无错；软链对活档 |
| A1 | `bin/start_acestep.sh`（:8190 惰性） | `GET :8190/health` 200（`handler_ready:false` 正常） |
| A2 | `bin/start_comfyui.sh`（:8188 共宿主） | `GET :8188/system_stats` 200；代码层无 /free |
| A3 | `bin/start_workers.sh all`（8391/8395/8390/8191 回环） | 各 `/health` 200（lipsync `weights_loaded:false` 正常；facegate scaffold 503 即权重缺诚实留档） |
| A4 | `bin/start_api.sh`（:7900，`MB_PUBLIC_BASE_URL` 即**三台可达基址对 C0 探测后确认**）+ `bin/start_executor.sh`（7 领） | `GET :7900/healthz` 200；executor log「已接入调度」 |
| A5 | 后台档案扫 `POST /admin/model-nodes/probe-all`（admin 鉴即 A0 显式 creds） | music/comfy/asr/83xx 对档 200；**llm 对 R2 即 200**（R1 红→R2 绿，即变更验收点） |

## 2 阶段 B — 全加载（音乐+H3 全家桶 一次性驻）+ LLM 两探针

| # | 发 | 判定线 |
|---|---|---|
| B0 | LLM 两探针（R2 新面）：文本一发（intent 同型 JSON）+ 图片一发（png→base64 data URL） | `choices[0].message.content`（或 `reasoning` 兜底）非空；model 名对 alias 即 200 |
| B1 | `node src/executor/selftest/fullload_real.mjs all`（music 45s → image 864×1536 → video 736×1312 124f turbo4，**不卸载之间**） | music 200 wav 45±2s 立体声；png 魔数+尺寸；mp4 5.17s±0.2/24fps |
| B2 | 内存采样每发前后（`free -g` · `:8188/system_stats.ram_free` · `:8190/health.vram`） | 无 OOM/无 swap 抖动；**ram_free 全程 ≥20G 对 LLM 驻档即留档实测**（缺则诚实红，不放宽） |
| B3 | 降级演练（可选）：`:8188` 不可达 → `COMFY_UNREACHABLE` 回队诚实 | 不吊死，错误码诚实 |

留档 → `deploy/spark/fullload-evidence-1125r2.md`（耗时表+内存曲线+产物路径+判定）。

## 3 阶段 C — 3 台验证（本次改动对客户端面）

**C0 通道与可达（每台，通道列顺序）**
1. 按台通道：USB 档 probe（`adb -s <serial> shell true`，DGX 即未 attach ⇒ 预期 fail）→ relay 档（`adb connect <host>:5555` ⇒ 连接名即 `host:5555`，后续 `-s` 对连接名）。
2. 设备侧可达探测（toybox curl）：`http://192.168.1.10:7900/healthz`（LAN 台）与 `http://100.81.83.59:7900/healthz`（tailnet 档）⇒ 对每台**实测取绿基址**，写 `MB_PUBLIC_BASE_URL` 对该台 App 设置页/`--dart-define` 档；两红即留档红（不伪造）。
3. 装档探测：`pm list packages | grep musicbox`（APK 不落 DGX ⇒ 已装档即验证，未装即另拍单）。

**C1–C3 业务链（对 [test/client_drive](../../test/client_drive) 脚本，API 基址对 C0 绿值）**

| 台 | 链 | 证据 |
|---|---|---|
| 2（小米13，息屏） | C1 音乐全链（guest→generate→轮询→mp3/waveform 取→adopt）+ C2 定妆照 + C3 定妆视频+拍板 | 协议链 log + job 耗时表 + 产物字节对；UI 截图即 skip（息屏，R1 坑） |
| 1（Android16 亮屏常亮） | C1 音乐全链 + `screencap` 首页/揭晓页 | `tmp/evidence/<ts>/D1_*.png` + logcat `musicbox:*` |
| 3（Android17 亮屏常亮） | C1 音乐全链 + `screencap` 首页/播放页 | `tmp/evidence/<ts>/D3_*.png` + logcat |

积分对游客日档 50 ⇒ 每台链 gen15+cast_image10+cast_video20=45 ≤50（台 2 全链；台 1/3 即音乐链 15 对日档对 3 台即 45×3 对**每台独立游客会话**对 device_key `d1/d2/d3-fullload-1125r2`）。

**C4 口型+成片**：skip 登记（lipsync 权重未拉，E2 遗留）。

## 4 熔断与失败口径（R1 对全保留 + R2 增）

| 现象 | 口径 |
|---|---|
| LLM chat 404 model 名 | `MB_LLM_VLM_MODEL` 对 `/models` alias 勘（A0 即钉） |
| `ram_free <20G` | executor 挂起等待（观测不干预）；连续 3 低水位 ⇒ 观测上报，不杀共宿主；B2 留档实测 |
| NVML/torch cuda 即沙箱拒 | 对 full-access 档重探测即判定（R2 已证 GB10 活） |
| relay 台 API 两基址红 | 留档红该台，链即 LAN 台全链 + 亮屏两台即另拍单（不伪造） |
| facegate 503 / lipsync weights_loaded:false | 权重缺诚实呈现（C4 skip） |

**执行顺序**：A0→A1..A5 → B0→B1→B2→B3 →（留档）→ C0(3 台)→C1..C3 → C4 skip。每阶段全绿才下一；任一红即留档原因。
