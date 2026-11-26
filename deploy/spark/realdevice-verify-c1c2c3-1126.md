# 阶段 C · 3 台真机业务链取证（2026-11-26）

> 承接 [realdevice-test-plan-1126r1.md](realdevice-test-plan-1126r1.md)。
> 前置：阶段 A（全后端起）/ B（fullload 留档）已绿。本档记录 C1→C2→C3 全链在真机上的实测。

## 0 突破：GeekPro USB adb

阶段 C 长期卡点 = 设备触达不了本机 API（:7900）。本轮由 **Liang-GeekPro（100.100.140.75，Tailscale）** 突破：

- GeekPro 为 Windows，USB 直插 **小米13（98fc9410 / 2211133C）** 与 **K40（8b1e8747 / M2012K11AC）**，adb 已授权（无需设备端点按）。
- adb 路径：`C:\Users\jianz\AppData\Local\Android\Sdk\platform-tools\adb.exe`。
- 本机通过 **SSH（账号 <已脱敏> / 口令 <已脱敏>）+ pty 密码注入**（2026-11-26 抢救脱敏：该凭据曾以明文写进本文档，已轮换并删除；口令不再出现在任何仓库文件中） 驱动 GeekPro 的 adb；二进制文件用 **scp** 在 GeekPro↔本机间安全传输。
- 目标机与本机同 LAN（192.168.1.x）⇒ 可直达 `http://192.168.1.10:7900`。

## 1 C2 真实人像来源（关键）

C2 定妆报 `COMFY_REFERENCE_REQUIRED`（真路径需真实人像）。DGX 无外网、:8765 人像服务未起，改用地产已生成人像：

- 取 `var/out/fullload/1795667149848_cast.png`（H3-image-cast 生成的 864×1536 真人定妆图）。
- 本机侧验证：游客登录 → `POST /v1/mv/image`（`file=@cast.png`）⇒ `image_id=ul_f87e5a4dc8ec1e81c3d6`（过人脸预检）。
- 推送至设备 `/data/local/tmp/mbx/portrait.png`，C2 用 `source:upload + image_id` 建项目。

## 2 测试脚本

`test/client_drive/c123_local_portrait.sh <API> <本地portrait> <device_key>`（自包含，跑测试机 toybox curl）：
C1 音乐 generate→adopt 拿 work_id → 上传本地人像拿 image_id → C2 建项目(source=upload)+派 cast_image → C3 派 cast_video。

## 3 实测结果

### 3.1 小米13（98fc9410 / Android16）— 全链 ✅

| 步 | 结果 |
|---|---|
| C1 音乐 | user=音乐旅人7694 · wall=31s · **work_id=w_e6b1fe898124a062014d** |
| C2 人像 | **image_id=ul_a706fa86e97a1a341623** · **project=mvp_91bb05a772569234e443** · 妆照 done |
| C3 视频 | job done · 视频 736×1312 / H264 + AAC / 5.167s |

证据（`tmp/evidence/`）：`98fc9410_c1_v2.mp3`（1,201,965B MP3 48kHz 立体声）、`98fc9410_c2_w5.png`（1,756,084B PNG 864×1536）、`98fc9410_c3_w6.mp4`（3,306,691B H264 736×1312 5.167s）。

### 3.2 K40（8b1e8747 / Android13）— 全链 ✅

| 步 | 结果 |
|---|---|
| C1 音乐 | user=音乐旅人4390 · wall=26s · **work_id=w_b9b7fb85a5bde9e2abe0** |
| C2 人像 | **image_id=ul_8aea32696e1462030afa** · **project=mvp_234ac01b0e1e563430cc** · cast_job status=done |
| C3 视频 | **job.json status=done** · 视频 736×1312 / H264 + AAC / 5.167s |

证据（`tmp/evidence/`）：`8b1e8747_c3.mp4`（5,509,616B H264 736×1312 5.167s，含 AAC 音轨）。设备侧 `cast_job.json`/`job.json` 均 `status:done`。

### 3.3 M332BF（43328e37 / Android17）— ⛔ 阻塞

- 状态：Tailscale `100.75.247.55` 在线（`[device]`），App `com.musicbox.musicbox` 已装。
- 触达：`curl http://192.168.1.10:7900` 与 `http://100.81.83.59:7900` **均空**（设备应用层路由不到 DGX，非网络离线）。
- 结论：App 在但连不上服务端，无法跑业务链。需把该机移到 DGX 同 LAN 或解决其 Tailscale 应用层路由。

## 4 结论

| 台 | 通道 | C1音乐 | C2人妆 | C3视频 | 判定 |
|---|---|---|---|---|---|
| 小米13 | GeekPro USB `98fc9410` | ✅ | ✅ | ✅ | **通过** |
| K40 | GeekPro USB `8b1e8747` | ✅ | ✅ | ✅ | **通过** |
| M332BF | Tailscale `100.75.247.55` | ⛔ | ⛔ | ⛔ | 阻塞（触达不了 API） |

**2/3 台真机全链（C1→C2→C3）通过**，产物规格一致（视频 736×1312 / 5.167s / H264+AAC）。
M332BF 待入 DGX 同 LAN 后复测。

## 5 复现口径

```bash
# 本机→GeekPro 驱动 adb 的辅助（已验证）
source /tmp/mbx.sh          # gexec/grun/gpush（SSH+pty）；/tmp/scpg.sh（scp 二进制）
# 推脚本+人像到设备，跑全链
gpush test/client_drive/c123_local_portrait.sh 98fc9410
gpush var/out/fullload/1795667149848_cast.png 98fc9410
gexec "$ADB -s 98fc9410 shell sh /data/local/tmp/mbx/c123_local_portrait.sh http://192.168.1.10:7900 /data/local/tmp/mbx/portrait.png dev-98fc9410"
# 产物回传：adb pull -> GeekPro ; /tmp/scpg.sh <本地> 'C:/Users/jianz/<名>'
```
