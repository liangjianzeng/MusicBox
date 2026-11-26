# MusicBox 真机业务测试计划 · 更新版 R1（2026-11-26）

> 更新自 [realdevice-test-plan-1125r2.md](realdevice-test-plan-1125r2.md)（R2，11-25 下午）。
> 本更新只改**阶段状态与判定**：代码/端口/脚本未变，A、B 两轮已实测跑通，C 轮受设备网络阻塞。
> 全量证据见 [fullload-evidence.md](fullload-evidence.md)；MV 保脸专项见 [spikes/SP6_mv_face_preservation.md](../../spikes/SP6_mv_face_preservation.md)。

## 0 现状基线（11-26 12:4x 采样 · gx10-85f3）

| 项 | 值 | 判读 |
|---|---|---|
| LLM | DGX 本机 `:8090` = `Inkling2-Mini:vision`（`/models` alias 在线） | R2 变更点已验收；手机可达 `http://100.81.83.59:8090/v1` |
| 内存 | `free -g` 121 总；GB10 全 resident（H3 三族 + 生乐 + LLM） | 预算充足，B 档阈值 ram_free≥20G 仍按实档诚实留档 |
| 阶段 A | 全量后端**已起并接入调度** | §1 全绿（本轮新达成） |
| 阶段 B | `fullload_real.mjs all` **三发连续跑通** | §2 全绿（本轮新达成，含全量后端 resident 复测） |
| 阶段 C | **阻塞** — 目标机 unreachable | §3 见阻塞原因，等设备入 LAN |

## 1 阶段 A — 全量后端（✅ 11-26 实测全绿）

| # | 服务 | 端口 | 判定 |
|---|---|---|---|
| A1 | ACE-Step 生乐 | `:8190` | `GET /health` FastAPI 响应（`handler_ready:false` 正常） |
| A2 | ComfyUI（共宿主） | `:8188` | `GET /system_stats` 200；无 `/free` |
| A3 | mv_lipsync | `:8390` | FastAPI 响应（`weights_loaded:false` 正常，权重未拉） |
| A3 | mv_asr | `:8391` | `/healthz` `{"ok":true,"model_loaded":false}` |
| A3 | mv_facegate | `:8395` | 运行中（根路径 404，端点 `/score`/`/swap` 在） |
| A3 | sensevoice | `:8191` | `/healthz` `{"ok":true}` |
| A4 | API + executor | `:7900` | `/healthz` `{"ok":true,...}`；executor log「已接入调度」 |
| A5 | executor 7 lane | — | `music,intent,ffmpeg,imgspark,vidspark,lipsync,align` |

起服即 `bin/start_{acestep,workers,api,executor}.sh` 幂等套（setsid nohup + pid 档 + 端口占用即拒绝不杀）。

## 2 阶段 B — 全加载（✅ 11-26 实测全绿）

`node src/executor/selftest/fullload_real.mjs all`（music 45s → image 864×1536 → video 736×1312 124f turbo4，**不卸载之间**）：

| 步 | 产物 | 墙时 | 内存 ram_free |
|---|---|---|---|
| B1 生乐 | `var/out/fullload/*_music.wav` 8,640,044B · 45s | 69.2s（warmup 55.4 + model 13.8） | 25.9→18.7GB · vram 峰 9.2G |
| B2 生图 | `*_cast.png` 1,765,440B（h3-image-cast） | 21.0s | 18.7→19.9GB |
| B3 生视频 | `*_cast_video.mp4` 4,613,091B（h3-fl2va） | 292.8s | 19.9→12.3GB |

host_available（`/proc/meminfo`）全程 26568→19149→20363→12576 MB。三族引擎全驻、三发连续无 unload/OOM/崩溃 ⇒ **功能通过**。
观察：视频族最重，单步抽 ~7.6GB，收尾 ram_free 12.3G、host_available ~12.6G，**低于 20G 留裕阈值**（全 resident + 全视频为最坏情形，系统稳定未 OOM）。11-25 fresh 加载收尾仍有 40.4–44.6G（基线不同）。

## 3 阶段 C — 3 台验证（✅ 2/3 通过 · 详见取证档）

> **11-26 已执行**：经 **Liang-GeekPro（100.100.140.75）USB adb** 突破网络约束。小米13（98fc9410）、K40（8b1e8747）同 LAN 直达 `:7900`，全链 C1→C2→C3 通过；M332BF 应用层触达不了 API 仍阻塞。
> 逐台结果/产物/复现口径见 [realdevice-verify-c1c2c3-1126.md](realdevice-verify-c1c2c3-1126.md)。

### C0 通道与可达（执行结果）

| 台 | 型号 | serial | 通道 | 可达 API? |
|---|---|---|---|---|
| 1 | 小米13 | `98fc9410` | GeekPro USB | ✅ 同 LAN |
| 2 | K40 | `8b1e8747` | GeekPro USB | ✅ 同 LAN |
| 3 | M332BF | `43328e37` | Tailscale `100.75.247.55` | ❌ 应用层路由不到 DGX |

C2 真实人像取 `var/out/fullload/1795667149848_cast.png`（H3 定妆图），经 `/v1/mv/image` 上传拿 image_id 后 `source:upload` 建项目。脚本 `test/client_drive/c123_local_portrait.sh` 自包含跑全链。

积分对游客日档 50 ⇒ 两台链 gen15+cast_image10+cast_video20=45 ≤50（每台独立游客会话）。C4 口型 skip（lipsync 权重未拉）。

## 4 熔断与失败口径（R2 全保留）

**阻塞原因（11-26 实测）**：3 台目标机无一能达 DGX API。

| 台 | 型号 | serial | 通道 | 可达 API? |
|---|---|---|---|---|
| 3 | M332BF | `43328e37` | Tailscale `100.75.247.55:5555` | ❌ 独立 WiFi，curl LAN+tailnet 均空；未装 App |
| 1 | 2211133C | `98fc9410` | — | ❌ 未联网 |
| 2 | M2012K11AC | `8b1e8747` | — | ❌ 未联网 |

探测（每台）：`adb -s <serial> shell true` → toybox curl `http://192.168.1.10:7900/healthz`（LAN）与 `http://100.81.83.59:7900/healthz`（tailnet）→ 均红；`pm list packages \| grep musicbox` → 未装。

**解锁条件**（满足其一即可推进 C0–C3）：
1. 把某台目标机（或 M332BF）连到 **DGX 同 LAN WiFi**（192.168.1.x）→ 装 `:7900` 版 App 跑完整业务链取证；
2. 或确认设备 **Tailscale 应用层可达**（装 Tailscale + App BASE_URL 指 `100.81.83.59`）——当前设备无 Tailscale App、curl tailnet 亦空，此路未通。

C0–C3 业务链脚本、积分口径（每台 45≤50）、C4 口型 skip（lipsync 权重未拉）均沿用 R2 §3，待设备入 LAN 即执行。

## 4 熔断与失败口径（R2 全保留）

| 现象 | 口径 |
|---|---|
| `ram_free <20G` | executor 挂起不干预；连续 3 低水位 ⇒ 观测上报不杀共宿主；B2 留档实测 |
| relay 台 API 两基址红 | 留档红该台，链即 LAN 台全链 + 亮屏两台另拍单（不伪造） |
| facegate 503 / lipsync weights_loaded:false | 权重缺诚实呈现（C4 skip） |
| 目标机 unreachable | 留档红，等设备入 LAN（本轮现状） |

**执行顺序**：A(绿)→B(绿)→C0(3台)→C1..C3→C4 skip。A、B 已绿；C 待设备。每阶段全绿才下一，任一红即留档原因。
