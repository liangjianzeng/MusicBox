# DGX Spark 基线快照（SP-MV-4 对照用 · 2026-11-24）

> 采样方式：开发机 SSH `DgxSpark`（`100.81.83.59`，nvsync.key，Ubuntu 24.04.5 aarch64）直接探测。
> 口径：本快照为**§2.1 S1/S2/S3/S7** 四项的留档记录，S4/S5/S6/S8/S9 见后续 §2.1 缺项单。

## S1 Node ≥22 arm64
- 主机：gx10-85f3（`Linux gx10-85f3 7.0.0-1025-nvidia #26~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Tue Nov 3 19:27:25 UTC 2 aarch64`）
- `node -v` = **v22.23.5** ✓（≥22 通过线）

## S2 ffmpeg aarch64（能力探测：能编 libmp3lame 才算数）
- `ffmpeg -version` = **6.1.1-3ubuntu5+esm15**（Ubuntu 24.04 aarch64）
- 编码器：`libmp3lame` ✓（MP3 编码）
- 滤镜（均存在）：`amix`(N->A)、`drawtext`(V->V)、`xfade`(VV->V)、`zoompan`(V->V)、`fps`、`scale`、`pad`、`setsar` ✓
- 通过线：含 libmp3lame/drawtext/xfade/zoompan ✓

## S3 NVMe 容量
- `df -h /` = `/dev/nvme0n1p2` **916G 总 / 510G 已用 / 360G 可用**（59%）
- 通过线：剩余 ≥150G ✓（360G ≥ 150G）
- `/opt/musicbox` 当前不存在（首次部署前置，见 S6/S4 缺项单）

## S7 端口复核
- `ss -ltn` 对架构 §1.1 避让清单 + 8390/8391/8395 复核：
  - 7900（musicbox-api）/ 7901（acceptance）/ 8188 / 8090 / 8390（lipsync）/ 8391（asr）/ 8395（facegate）/ 8288（逃生口）——**均无监听** ✓ 无冲突
- 注意：`:8188`（ComfyUI）/`:8090`（vLLM）**未在 Spark 上运行**（共宿主服务未起；S8 基线留档无实时目标，见下）

## S8 共宿主基线快照（S8 缺项，未能闭环）
- `:8188/system_stats` —— **空响应**（服务未起）
- `:8090/models` —— **空响应**（服务未起）
- **结论：S8 不可闭环**。共宿主服务（ComfyUI :8188、vLLM :8090）当前不可达，无法留档基线。已列为宿主协调单（E#），不伪造数据。

## 资源侧（补充）
- GPU：NVIDIA GB10（Persistence-M 开，32C，3W，P8，0% util，驱动 580.178.04，CUDA 13.0）
- CPU：20 核
- RAM：121Gi 总 / 21Gi 已用 / **100Gi 可用**
- systemd：255（255.4-1ubuntu8.18）
- uv：**未安装**（S4 待装，见缺项单）
- lipsync 权重：**未拉**（`/opt/musicbox/var/models` 不存在，S5 待做）
- systemd 五单元：**未装**（`/etc/systemd/system/` 无 musicbox-*，S6 待装）

## 留档结论
- S1/S2/S3/S7 **通过**（留档于此）
- S4（uv venv ×3）、S5（lipsync 权重 E2）、S6（systemd 五单元）、S8（共宿主基线）、S9（tailnet 可达性）**未闭环**，列为缺项单（见下）
- **未触碰**：`:8188`/`:8090`/ACE-Step/SearXNG（本次仅探测，无写操作）
