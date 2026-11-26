# 真机全链验证 C1→C7 — 保脸失败 + C4–C7 阻塞（2026-11-26 v2）

> 承接 `realdevice-test-plan-c1c2c3-1126.md`（用户确认：严格按 MD 执行 C1–C7，每步下产物肉眼复核保脸，进度回填本档）。
> 本轮用**真女主输入图** `var/input/protagonist_female.jpg`（sha `c32e3b79…`，深色长卷发/黑上衣/夜间）驱动全链。

## ⚠ 核心结论：保脸 FAILED（blocker）

**定妆没有保留输入女主的脸。** 证据见 `deploy/spark/evidence/flow-1126-1614/保脸对比_INPUT_vs_cast.png`。

| 图 | 内容 | 与输入女主关系 |
|---|---|---|
| INPUT（输入女主）| 圆脸、大而圆的眼睛、蓬松微卷**无刘海**长发、黑上衣、夜间 | **参照基准** |
| 候选1（已确认/绿上衣）| 窄脸、杏仁眼、直刘海、绿背心、侧脸逆光 | ❌ 另一位女性 |
| 候选2 | 发髻、白背心 | ❌ 又一位 |
| 候选3 | 直长发、白上衣、侧脸 | ❌ 又一位 |
| C3 视频帧 1/2 | = 候选1（绿上衣、直刘海） | ❌ 与 input 非同一人 |

**三张候选彼此都不一样，且都与输入女主不同**——保脸正常时应是"同一位女主的多个变体"，此处却生成三位陌生女性。定妆参考帧（输入女主）未被 h3-image-cast 锁定身份。

**量化（facegate 对照 input 女主）**：`face_scores=[0.0036, -0.0302, 0.0802]`（候选1/2/3）。全在 0 附近、候选2 负值 → 三候选脸与输入女主基本不匹配；保脸成功应为高分（约 0.7+）。与肉眼复核一致。

**机制根因**：`realCastImage` 把输入女主图上传为 REF_IMAGE，h3-image-cast 模板用 3×LoadImage(4/5/6)+MiniMaxH3ImageConditioning(images=["4","5","6"])，但 KSampler **denoise=1（纯噪声全重绘）、cfg=1、steps=6**——身份约束极弱，desc 提示词（"young woman, studio portrait"）主导生成 → generic 女主，非输入女主。

## 0 环境与驱动方式

- 可用机：**M332BF（43328e37 / Android17）**，Tailscale `100.75.247.55`，App 前台（com.dshphone/微信/钉钉等轮换）。
- 关键网络事实：
  - API 绑 `*:7900`，主机 LAN `192.168.1.10` 与 Tailscale `100.81.83.59` 均可达。
  - **设备经 Tailscale 到 API 的编排请求被鉴权中间件拒（device_key 新 token 从设备必 401）**；已知 token `at_5da9640b…` 从设备有效但 17:42(上海)过期。
  - 设备**连不上 LAN 文件 URL**（192.168.1.10）。
- 解法：**主机驱动 C1–C7 全编排**（host 拿稳定 token、可直取 LAN 产物做肉眼复核）。设备仅用于：①portrait 真机上传（真输入）②最终 mv_video 推设备真机播放。
> ⛔ **该步为不合规跑法（P1-6 已废止）**：灌余额使 402 余额不足、失败退款配对、预算双熔断三条真机必检路径全部失效，
>   其积分相关 ✅ 一律作废。复测见 realdevice-test-plan 的红线说明与运营面加额做法。
- 积分：灌 `host-flow-1612` guest 余额 1000000（`seed_guest.js`，先锁 `credit_reset_day` 防 daily_expire 清零）。

## 1 C1–C3 实测（主机驱动，产物已下 `deploy/spark/evidence/flow-1126-1614/`）

| 步 | 结果 |
|---|---|
| C1 音乐(60s女生歌唱) | work=`w_501908d2…`，60s / MP3 48kHz 立体声，vocal |
| C2-a 上传女主 | image_id=`ul_98195eaac98b121c09e0`（真机输入 portrait） |
| C2-b 建项目 | project=`mvp_e4b5cdfe75dd0e898bdb`，kind=vocal，budget=1000000 |
| C2-c cast_image | 3 候选图各 1.5–1.7MB PNG（保脸关键——**失败，见 §2**） |
| C2-e cast/confirm | 已确认候选1（绿上衣） |
| C3 定妆视频 | `c3_cast_video.mp4` 4.9MB，736×1312 / H264+AAC / 5.167s（**仍是错误女主**） |

## 2 C4–C7 阻塞（project=failed）

- storyboard 派单部分失败：`COMFY_REFERENCE｜分镜…角色参考帧不可达；真路径不降级为无身份图`。
- 因无首帧 → shoot 全部 `SRC_MISSING｜镜头首帧不存在`（15 镜均退 675⚡）。
- 项目终态 `status=failed`，15 镜仍 draft。

根因链：定妆参考帧（输入女主/候选图）ComfyUI 取不到 → storyboard 不降级 → shoot 无源 → 项目失败。与 §2 保脸失败同源（参考帧身份未正确注入）。

## 3 逐步复核结论（人工肉眼）

- C1 音乐规格 ✅（60s/女声歌唱/有词）。
- C2 上传 ✅。
- **C2 保脸 ❌（blocker）**：三候选 + C3 视频均非输入女主。
- C4–C7 ⛔（被 storyboard/参考帧阻塞，未产出成片）。

## 4 需修复项（按优先级）

1. **保脸（最高）**：h3-image-cast 未锁定 input 女主身份。需查 `realCastImage` 的 `portrait_path`→REF_IMAGE 注入与 h3 条件是否生效。
2. **storyboard COMFY_REFERENCE**：角色参考帧 ComfyUI 不可达，需确认可达性与降级策略。
3. 设备侧鉴权/网络：device_key token 从设备 401、设备取 LAN 文件 URL 不通——真机直连方案需先打通。

## 5 证据文件

`deploy/spark/evidence/flow-1126-1614/`：
- `保脸对比_INPUT_vs_cast.png`（INPUT vs 3 候选 + C3 两帧）
- `c2_cast_1/2/3.png`、`c3_cast_video.mp4`、`c3_frames/f1|f2.jpg`
- 复现：`test/client_drive/host_flow.sh`（bash 版）/ `host_flow_py.py`（python 版，直查 DB 取 clip）

> **红线（抢救计划 P1-6，2026-11-27 起为闸门判据）：真机验收禁止灌余额。**
> 用 `store.appendLedger` 把 guest 余额灌到百万级、或把 `mv_projects.budget_credits` 设成 1000000，
> 会一次性废掉四条最该在真机上被检验的路径：**余额不足 402、扣费与派单的原子性、失败退款配对、
> 预算双熔断（BUDGET_EXCEEDED/paused）**。本轮加固时实证这些路径上确实存在"扣钱无 job""同一笔退两次"
> 等资损缺陷 —— 灌余额的跑法会把它们全部掩盖成 ✅。
> 正确做法：按真实定价跑（访客每日 50⚡ + 真实扣费），需要更多额度就走**运营面** `/v1/admin/credits/adjust`
> 并留 `reason`，让账本与审计一起成立；预算不足就如实让熔断发生，再按契约用人工提高预算恢复。
> 历史跑法（灌至 1000050 / budget 1000000）保留在下表仅作留痕，其"积分校验 ✅"一律作废，不计通过。
