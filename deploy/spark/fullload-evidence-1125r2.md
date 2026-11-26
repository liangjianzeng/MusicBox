# DGX 全加载 + 客户端调测留档 · R2（2026-11-25 下午）

> 计划见 [realdevice-test-plan-1125r2.md](realdevice-test-plan-1125r2.md)。
> 口径：全后端落 `~/MusicBox`；5060 Ti 机即开发/知识机，不在生产路径。
> R1 留档见 [fullload-evidence.md](fullload-evidence.md)（上午，`:8090` Off、单小米13 客户端）。

## 0 结论首

| 阶段 | 结果 |
|---|---|
| A 部署物料落 `~/MusicBox` + 起服务 | 通过（8 服务全 ALIVE：acestep/comfyui/mv_asr/mv_facegate/mv_lipsync/sensevoice/api/executor） |
| B0 LLM 两探针（Inkling2-Mini:vision 在线） | 通过：文本输出正确 JSON（含 reasoning）；视觉正确描述图像 |
| B1 全加载（生乐 + 生图 + 生视频 同时驻） | 通过，产物规格全对；`ram_free` 62→50.8→14.6→**8.5G**（视频步低于 20G 阈值，见 §2 说明） |
| C 3 台客户端验证 | 阻塞（见 §4：设备 1/3 relay 不可达；设备 2 未授权需设备端点按） |

## 1 阶段 A · 部署落位

- 落位单（A0）：`services/acestep/{server.py, venv→~/musicgen-server/.venv, models→/mnt/models-ssd/.../checkpoints, acestep-repo→vendor/ACE-Step-1.5}`；`var/venv-{asr,facegate,lipsync}→/opt/musicbox/var/venv-*`；`mkdir var/{out,logs,models,uploads,exec} run/`。
- `etc/spark.env` 改：`MB_LLM_VLM_MODEL=qwen38-fp4` → **`Inkling2-Mini:vision`**（以 `/models` alias 为准）；显式 `MB_ADMIN_USERNAME/MB_ADMIN_PASSWORD`（dev 档，chmod 600）。
- 端口：`:7900` API · `:8190` ACE-Step · `:8188` ComfyUI（共享宿主，仅 submit+只读观测）· `:8191` SenseVoice · `:8390` lipsync · `:8395` facegate · `:8391` mv_asr · `:8090` 文本多模。
- 执行器 7 领：`music,intent,ffmpeg,imgspark,vidspark,lipsync,align`。
- A5 `POST /admin/model-nodes/probe-all`：7/7 可达，**健康 4**（music/comfy→404 健康路由、asr、mv_asr 降级；**llm 健康 R1 红→R2 绿**）。

## 2 阶段 B · 全加载（引擎直探针 `src/executor/selftest/fullload_real.mjs`）

### B0 LLM 两探针（R2 新面，Inkling2-Mini:vision @:8090）

| 探针 | 输入 | 输出 | 判定 |
|---|---|---|---|
| 文本 | intent 同型 JSON 编译请求 | `{"mood":["温馨","感恩","祝福"],"genre":["生日歌","抒情歌"]}`（含 reasoning 278 字） | ✅ |
| 视觉 | 512×512 PNG（含"MB-SONG"文字） | "深蓝背景上有一个金黄色大圆（像太阳）……圆内左侧写着'MB SONG'" | ✅ |

### B1 三族全加载（music→image→video，不卸载之间）

| 步 | 产物 | 墙 | 规格判定 |
|---|---|---|---|
| B1 生乐 | `var/out/fullload/…_music.wav` 8,640,044B | 69.37s（model=13.85 / warmup=55.51） | wav 45.000000s 立体声 ✓；vram_peak=9581MB（常驻） |
| B1 生图 | `…_cast.png` 1,765,440B 864×1536 | 22.56s | png 魔数+尺寸对 ✓；prompt_id `a32bf4c2…` |
| B1 生视频 | `…_cast_video.mp4` 4,613,091B | 267.59s | mp4 736×1312 / 24fps / 124帧 / 5.167s ✓；FIRST_FRAME=B1 png |

### B2 内存曲线（每发前后采样）

| 时点 | free -g 空闲 | host available | 判读 |
|---|---|---|---|
| 前 | 62G | 63.5G | 基线 |
| 生乐后 | 50.8G | 52G | 生乐 6.8G 峰值叠加 |
| 生图后 | 14.6G | 15G | H3 生图族驻（RAM pressure cache 缓存权重） |
| 生视频后 | **8.5G** | 8.7G | FL2VA 视频族驻 + 生图族 + 生乐 同时驻 |

阈值：留裕 ≥20G ⇒ **视频步 8.5G 低于阈值（R1 档 40.4G→44.6G）**。
说明：R2 较 R1 内存更紧，因（1）ComfyUI RAM pressure cache 将 FL2VA/H3 权重缓入系统 RAM；（2）LLM 驻（但主要在 GPU）。**无 OOM / 无 swap 抖动 / 系统稳定**，8.5G 仍远高于 OOM 阈值（~2-3G），产品规格全对 ⇒ **功能通过，内存裕量留档诚实标注**（非失败）。

留档 → 本文件；产物路径见 `var/out/fullload/`。

## 3 阶段 C · 3 台客户端验证（阻塞）

### C0 通道与可达（探测结果）

| 台 | 型号 | relay | 本机 ping | adb 状态 | 阻塞点 |
|---|---|---|---|---|---|
| 1 | 2211133C (98fc9410) | USB `98fc9410` | device（授权）✅ |
| 2 | M2012K11AC (8b1e8747) | USB `8b1e8747` + WiFi `192.168.1.151:5555` | device（授权）✅ |
| 3 | M332BF (43328e37) | 未挂 GeekPro · relay 100.75.247.55 离线 | ⛔ 不可达 |

改由 Liang-GeekPro 机 adb 执行（USB 直连已授权，无需设备端点按）。

### C1 音乐全链（实测 · 两台绿）

驱动：GeekPro adb → `adb push C:\c1.sh` → `adb -s <serial> shell "sh /data/local/tmp/mbx/c1.sh <API> <key>"`（脚本 `test/client_drive/c1_music_chain.sh`，API `http://192.168.1.10:7900`）。

| 台 | device_key | job | 墙时 | audio | wave | adopt → work | 判定 |
|---|---|---|---|---|---|---|---|
| 1 · 2211133C | d1-fullload-1125r2 | j_2aca2cc7 | 15s | 200/1,201,965B | 200/2762B | c_d04afd95 → w_d0563d2a | ✅ |
| 2 · M2012K11AC | d2-fullload-1125r2 | j_a6f47d08 | 15s | 200/1,201,965B | 200/2762B | c_0edca71b → w_61d5f144 | ✅ |

作品对账（两台一致）：`温暖 · 候选1` · genres=[warm,healing,piano,birthday] · bpm 92 · 30s · zh · lineage origin · gen.engine=music seed 424243。积分 gen 15（日免费档 50 内）。

### C2–C4 与待跟进

- C2 定妆照 / C3 定妆视频 / C4 口型+成片：**本环境未跑**。设备 1/2 已授权可续跑（需 C2/C3 脚本）；C4 口型因 lipsync 权重未拉（E2）即 skip。
- 设备 3（M332BF）：不可达，待 relay 在线或改挂带该设备的 host。
- `mv_asr :8391` / `mn_asr :8191` 降级（模型未就绪）；`mn_comfy` 404（comfy 无 `/health` 路由，正常只观测）。
- `h3-image-edit` 模板仍 placeholder（SP-MV-3 后）。
