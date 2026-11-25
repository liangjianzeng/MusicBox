# DGX 全加载 + 客户端调测留档（2026-11-25）

口径：全部后端服务落 DGX Spark（gx10-85f3，121Gi 统一内存）下 `~/MusicBox`；5060 Ti 机即知识/开发机，不在生产路径。
测试计划见 [fullload-test-plan.md](fullload-test-plan.md)；此文件即实测留档。

## 0 结论首

| 阶段 | 结果 |
|---|---|
| A 部署物料落 `~/MusicBox` | 通过（62 文件 src 落位，bin/etc/run/var 落位，ACE-Step 服务落位） |
| B 全加载（生乐 + 生图 + 生视频 同时驻） | 通过，`ram_free` 40.4G→44.6G，阈值 20G 留裕 |
| C 客户端全链（小米13 直 USB） | 通过：音乐 66s · 定妆照 15.2s · 定妆视频 269.7s · 拍板推进 scripting |
| C′ K40 验证（上传人像真路径，即 落位 首 版） | 通过：音乐 16s · 定妆照 26s · 定妆视频 275s · 拍板 scripting · facegate 四项真反馈 |
| 阻塞 | 无（三项待跟进，见 §6） |

## 1 阶段 A · 部署落位

- 布局：`~/MusicBox/{src,deploy,bin,etc,services,test,var,run}`；`src/{server,executor,workers}` 62 文件。
- 端口：`:7900` API · `:8190` ACE-Step · `:8188` ComfyUI（共享宿主，仅 submit + 只读观测）· `:8191` SenseVoice · `:8390` lipsync · `:8395` facegate · `:8391` mv_asr（死，§5）。
- 执行器 7 领：`music,intent,ffmpeg,imgspark,vidspark,lipsync,align`。
- 落位即 `bin/start_*.sh` 幂套（setsid nohup + pid 档 + 端口占用即拒绝，不杀他人进程）。

### A1 部署漂移（关键发现）

首次同步后，工作树继续演进 ⇒ 落位落后 18 文件 + 缺 1 模板：

```
DRIFT  server/{config.js, api/mv.js, core/{engine,mv_aireview,mv_validator,rules,store}.js,
       l2assistant/core.js, l2mv/{facade,governance}.js, prompts/{mv_assist,mv_script}.js, rules/mv_budget.js}
DRIFT  executor/{index.js, lanes/mv.js, lib/comfy.js, selftest/mv_filters_check.mjs, templates/manifest.json}
MISSING_ON_DGX  executor/templates/h3-image-broll.json
```

重同步（tar→scp→tar）⇒ **drift 0 / 62 文件 md5 一致**，API 与执行器重启。
落位旧版 `mv.js` 注释「project status 推进到 scripting 显式延期」；新版即全部角色确认后推进 `casting→scripting`，实测通过 ⇒ 拍板推进即**落位版本问题，非代码缺陷**。

## 2 阶段 B · 全加载（引擎直探针 `src/executor/selftest/fullload_real.mjs`）

| 步 | 产物 | 墙 | 备注 |
|---|---|---|---|
| B1 生乐 | `var/out/fullload/1795577653950_music.wav` 8,640,044B · 45.000000s | 138.09s（warmup 50.56 + model 64.89） | `task_type:text2music` seed 424242 `vram_peak_mb:6848` |
| B2 生图 | `1795577685182_cast.png` 1,765,440B 864×1536 | 24.06s（冷）→ 15.04s（seed 424249 复出，生图族驻） | 模板 `h3-image-cast`，prompt_id 8315d4e5… |
| B3 生视频 | `1795577965269_cast_video.mp4` 4,613,091B 736×1312 24fps 5.167s | 270.57s | 模板 `h3-fl2va`，`FIRST_FRAME`=B2 png，LENGTH 124 STEPS 4，prompt_id 812d3791… |
| B4 内存采样 | ComfyUI `system_stats` ram_total 130,593,894,400 / ram_free 43,544,825,856 | — | 三族 + 生乐 同时驻：`ram_free` 40.4G→44.6G；`free -g` 121/81/13/48/44；`:8190/health` `handler_ready:true lm_ready:true gen_count:1 vram_peak_mb:6848` |

阈值：留裕 ≥20G ⇒ **通过**（44.6G 留裕，生乐 6.8G 峰值叠加无 OOM）。

模板档（`executor/templates/manifest.json`）：`h3-image-cast` 生图族驻 ~37G；`h3-fl2va` 视频族 +~27G；`h3-image-edit` 仍 `placeholder:true`（未跑，SP-MV-3 后）。

## 3 阶段 C · 客户端全链（小米13 `8b1e8747` / M2012K11AC，USB 直）

驱动方式：设备侧 toybox `curl` 协议链（脚本落 [test/client_drive](../../test/client_drive)）；UI 触控注入即 `INJECT_EVENTS` 拒绝（生产包），故 UI 视觉证据即 K40 另拍。

包：`builds/MusicBox-v0.1.0+1-release-dgxlan.apk`（19.6MB，`--dart-define=MUSICBOX_BASE_URL=http://192.168.1.10:7900`）落小米13 + K40。

| 步 | 对象 | 墙 | 客户端可达产物 |
|---|---|---|---|
| C0 | `GET /healthz` 设备侧 | — | `healthz=200`；K40 包首屏无「服务器未连接」条，积分档 `⚡ 50 积分`（服务端读面） |
| C1 生乐链 | guest `u_f3dbc38edcc5b8a93901`（音乐旅人9737，device_key xm13-fullload-1125）→ job `j_ca13e465a66dc325ce2f` | 66s（生乐 常驻，无 warmup） | `audio_url` mp3 1,201,965B 200 · `waveform_url` 2,765B 200 |
| C1b 采纳 | `POST /v1/works/:id/adopt {candidate_id}` → `w_66c2d6aa9c692f4f92cf` | — | `GET /v1/works?mine=1` 即该作品可见（bpm 92，genres warm/healing/piano/gentle/birthday） |
| C2 定妆照 | project `mvp_0fc24dbb920e8881e832`（kind instrumental，budget 1200⚡）→ job `j_909812201121e90c8f0a` | 15.2s（04:18:29.630→04:18:44.806，生图族驻） | `cast_images` 3 候选 png（读面） |
| C3 定妆视频 | job `j_825bf129aa88204c202e` | 269.7s（04:23:28.707→04:27:58.406） | `cast_video_url` mp4 5,509,616B 200（设备取）· 抽帧 13 png（前 3 落留档 1,169,998 / 1,374,026 / 1,483,921B） |
| C3c 拍板 | `POST /v1/mv/projects/:id/cast/confirm {character_id,cast_image_url,frame_sel×8}` | — | `viewrefs` 8 固化 · `cast_image_url`/`cast_video_url` 落 · project `casting→scripting` |

积分：gen 15 + cast_image 10 + cast_video 20 = 45 ≤ 50（游客日免费档）✓

留档文件（设备取 ⇒ Windows）：`tmp/evidence/C3_cast_video.mp4`、`tmp/evidence/C3_frame{1,2,3}.png`、`tmp/evidence/C0_k40_connected.png`。

## 4 落位补丁（生产即 DGX 档）

`deploy/spark/services/acestep_server.py`（落位 `~/MusicBox/services/acestep/server.py`）：

- 5060 Ti 档 `offload_to_cpu=True` + 响应后手动 `.to("cpu")` 卸 ⇒ 在 GB10 + torch 2.10.0/cu130 组合抛
  `Attempted to set the storage of a tensor on device "cuda:0" to a storage on different "cpu"`，
  后续请求即 `einx.errors.CallOperationError … Expected all tensors on the same device (cuda:0 vs cpu)`（ResidualFSQ 码book 半卸）。
- DGX 档：`INIT.offload_to_cpu=False` · `LM_INIT.offload_to_cpu=False` · `ACESTEP_KEEP_RESIDENT=1` ⇒ `_release_gpu_vram()` 即只统计不卸。
- 实测：重启后 C1 客户端生乐 66s 通过（无 warmup 即常驻）；`vram_peak_mb` 6848 即生乐 档 int8 DiT + 5Hz-LM 常驻。

## 5 待跟进

1. `mv_asr :8391` 进程死（log 空）— 需 `bin/start_workers.sh` 该领 重出 + 日志档。
2. `:8090` vLLM（qwen38-fp4）未起 ⇒ 剧本 `suggest` / 跨模块音乐助手 未覆盖（C4 剧本·lipsync·compose 未跑）。
3. `POST /admin/model-nodes/probe-all` 即 `UNAUTHORIZED`（管理员档）；首启动会种子默认管理员 ⇒ 生产需 `MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD` 覆盖后重启。
4. 小米13 即 息屏（`cmd display` 仅亮度，无唤醒）⇒ UI 级截图即 K40（Android 16）/ M332BF（Android 17）另拍。
5. `h3-image-edit` 模板仍 placeholder（SP-MV-3 后）；B5 降级演练未跑。
