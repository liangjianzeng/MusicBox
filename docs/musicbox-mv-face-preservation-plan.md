# MV 定妆保脸方案一（I2V 首帧）落地设计

> **状态**：已落地为**默认定脸方案**（2026-11-26）。承接 SP6 spike 实测结论。
> **前置**：`spikes/SP6_mv_face_preservation.md`（方案一实测定档）、`CONTRACTS.md`（v2.3 mv_* job 契约）、`docs/musicbox-phase2-mv-plan.md` §4.7.1。

---

## 0. 一句话结论

> **上传角色图后，默认走「方案一」：把女主原图直接当 I2V 首帧，一条生成内锁脸抽帧。**
> 跨生成定妆（h3-image-cast ×3）已证伪，降级为**显式启用的遗留分支**；日后更好的方案按 `cast_method` 分支点接入，**不动默认**。

---

## 1. 为什么（SP6 实测）

| 方案 | 引擎 | 保脸方式 | vs 女主打分 | 结论 |
|---|---|---|---|---|
| Plan A（h3-image-cast ×3 跨生成） | h3-image-cast | 跨生成锚点 | 4 变体 **all ≈ 0** | ❌ 换脸（SP6 §1） |
| **方案一（I2V 首帧）** | h3-fl2va | 一条生成内 | 0.14 ~ 0.64 | ✅ 同一人（SP6 §2） |

- **根因（Plan A 失败）**：跨生成之间没有身份锚点，H3 参考图机制在"生成→抽帧→再生成"链路留不住脸。
- **方案一成立**：把女主原图当 `MiniMaxH3ImageToVideo.first_frame`，同一条视频里让她自己转角度——一条生成内自洽，脸不漂。
- **打分起伏 = 角度，不是换脸**（侧脸/背对天然低，0.4–0.64 即"同一人"）；换脸会稳定 ≈0。

**当前实机故障（v2 验证）**：`realCastImage` 用 h3-image-cast 定妆 → 3 候选彼此不同且均非 input 女主，`face_scores=[0.0036,-0.0302,0.0802]`，C3 视频首帧来自错脸候选 → 整链脸漂。

---

## 2. 分支架构（`cast_method` 定脸方案点）

定脸方案是**唯一的分支点**，挂在角色（`mv_characters.cast_method`）上，项目级可覆盖（`mv_projects.cast_method`）。上传角色图后**默认 `i2v_first_frame`（方案一）**。

| cast_method | 引擎 | 保脸 | 状态 | 说明 |
|---|---|---|---|---|
| `i2v_first_frame`（**方案一**） | h3-fl2va I2V 首帧 | 一条生成内锁脸 | **默认** | 上传角色图后自动走 |
| `h3_image_cast` | h3-image-cast ×3 | 跨生成 | 遗留分支 | 已证伪，仅显式启用（迁移/特殊需求） |
| `ref2va` | h3-ref2va | 表演视频换脸 | 未来分支 | 需表演视频，偏"换脸"语义 |
| `likeness_lora` | LoRA 微调 | 多图训练 | 未来分支 | 需女主多角度图供训练 |

**分支纪律**：
- 默认永远 `i2v_first_frame`；新增方案只往 `CAST_METHODS` 集合追加，**不改默认、不改现有分支**。
- 非法 `cast_method` → 400（契约化白名单，见 §4.2）。
- 项目级 `cast_method` 缺省继承角色级；角色级缺省 `i2v_first_frame`。

---

## 3. 流程变化（业务）

### 之前（Plan A，3 步，已废弃为默认）
```
上传人像 → cast_image(h3-cast ×3 陌生候选) → 选候选照
        → cast_video(I2V，但首帧=错脸候选) → 选帧确认 → scripting
```

### 之后（方案一，2 步，默认）
```
上传人像 → cast(I2V 首帧直出定妆视频 + 抽帧 + facegate 逐帧评分)
        → 在帧格里勾选「满意角度」确认(viewRefs) → scripting
        → storyboard / shoot / ...
```

**用户面收益**：不再有"3 张陌生候选"的困惑；定妆 = 一段保脸视频 + 带 facegate 分的角度帧，用户直接选角度。

---

## 4. 系统设计

### 4.1 路由链（一处改动贯穿 5 层）
```
API dispatch(mvJobs)
  ── jobType='mv_cast' ──▶ server lanes 表(vidspark)
  ──▶ executor ROUTE(mv_cast→vidspark) + pickRunner
  ──▶ executor lanes/mv.js BRANCH['mv_cast']='vidspark' → runMvJob → realCastI2V
  ──▶ engine completeMv('mv_cast') → completeMvCast
```

### 4.2 store schema
`mv_characters` / `mv_projects` 各增一列：
```sql
ALTER TABLE mv_characters ADD COLUMN cast_method TEXT DEFAULT 'i2v_first_frame';
ALTER TABLE mv_projects ADD COLUMN cast_method TEXT DEFAULT 'i2v_first_frame';
```
- 迁移放在 `store.js` `ensureSchema()` 的 MV wave 段（幂等 `ALTER ... ADD`，已存行补默认值）。
- 白名单：`i2v_first_frame`(默认) / `h3_image_cast`(遗留) / `ref2va`(未来) / `likeness_lora`(未来)。

### 4.3 API — 项目创建（`createProject`）
- 入参接受 `character.cast_method`（或顶层 `b.cast_method`），**默认 `i2v_first_frame`**。
- 非 upload 通道（AI 脸）也落默认 `i2v_first_frame`（未来可加 AI 脸专用分支，本期先同默认）。
- 非法值 → 400。

### 4.4 API — characterShape 暴露
- 输出新增 `cast_method`（默认回填 `i2v_first_frame`），供前端决定 UI 文案（"定妆视频选角" vs "定妆照选角"）。

### 4.5 API — 统一派发（`mvJobs`）
新增统一入口 `type:'cast'`（**默认走方案一**）：
```
POST /v1/mv/projects/:id/jobs {type:"cast", params:{cast_method?}}
  → 解析 cast_method（params 覆盖 → 角色级 → 项目级 → 默认 i2v_first_frame）
  → i2v_first_frame   → jobType='mv_cast'   payload:{portrait_path, cast_method, desc, seed}
  → h3_image_cast     → jobType='mv_cast_image'  payload:{portrait_path, desc, seed}  # 遗留分支
```
- **保留** `cast_image` / `cast_video` 老类型向后兼容（`cast_video` 不再强依赖 `cast_image_url`，方案一用 `portrait_path` 直出）。
- 幂等键含 `cast_method`，不同方案各自幂等。

### 4.6 executor — `realCastI2V`（方案一真实现）
```
portrait_path ─▶ uploadAsset → FIRST_FRAME
                ─▶ h3-fl2va I2V（FIRST_FRAME + prompt=转头/多角度 + 换景）
                ─▶ 抽 ~13 帧（CAST_VID.frames）
                ─▶ facegate 逐帧 vs portrait（score/yaw/pitch/pass）
产物：cast_video + frames[{url,score,yaw,pitch,pass}]
```
- 即现有 `realCastVideo` 的"首帧=女主原图"版本：把 `realCastVideo` 里 `p.cast_image` 的取源抽象为 `firstSrc`（方案一取 `p.portrait_path`，遗留取 `p.cast_image`），**共享抽帧/facegate 核心**，不复制逻辑。
- 与 SP6 方法 A/B 一致：首帧锁脸 + prompt 换景 + 转头多角度，三者解耦。

### 4.7 engine — `completeMvCast`
- 落 `cast_video_url` + `frames_json`（含每帧 facegate 分），与 `completeMvCastVideo` 同构。
- viewRefs 仍由用户 `cast/confirm`（`frame_sel` 取帧）拍板固化——**拍板权在人**（不代拍板）。
- 全部角色确认后 `casting→scripting` 不变。

---

## 5. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/server/core/store.js` | `mv_characters`/`mv_projects` 增 `cast_method` 列 + 迁移；`CAST_METHODS` 白名单常量 |
| `src/server/api/mv.js` | `createProject` 接受/存 `cast_method`；`characterShape` 暴露；`mvJobs` 新增统一 `cast` 派发（按 `cast_method` 分流），`cast_video` 解耦 `cast_image_url` |
| `src/executor/lanes/mv.js` | `realCastI2V`（共享 `castI2VCore`）；`BRANCH`/`runMvJob`/mock 表加 `mv_cast` |
| `src/executor/index.js` | `ROUTE` + `pickRunner` 加 `mv_cast` |
| `src/server/lanes/index.js` | `LANES` 加 `mv_cast → vidspark` |
| `src/server/core/engine.js` | `completeMv` 加 `mv_cast → completeMvCast` |
| `docs/musicbox-mv-face-preservation-plan.md` | 本设计文档 |

---

## 6. 向后兼容与回滚

- **向后兼容**：老 `cast_image`/`cast_video` 类型保留；已有项目 `cast_method` 缺省补 `i2v_first_frame`。
- **回滚**：项目/角色级 `cast_method='h3_image_cast'` 即回退老定妆照流程（显式、可逐项目）。
- **默认不可被静默切**：新增方案只追加，默认恒 `i2v_first_frame`。

---

## 7. 验收

> **确定性回归（先跑，任何改动后必跑）**：
> ```bash
> node src/executor/selftest/mv_mock_e2e.mjs     # 期望：mv_mock_e2e: 28/28 通过（含方案一 mv_cast 4 断言）
> node --test test/acceptance/v13_mv_contract.test.js   # 期望：28/28
> node --test test/acceptance/v21_unified_full_scenario.test.js   # 期望：9/9
> ```
> 全量 `node --test test/acceptance/*.test.js` 在**高并发**（16 文件并行各起 server 子进程）下会间歇性 flaky
>（V17/V18/V4/V1 等**与定妆无关**的套件轮流 fail，属负载竞争、非回归）；**判定回归请以串行/单文件绿为准**。

**验收清单（映射到上面三个确定性用例）**：

1. **默认路径（方案一）**：上传 input 女主 → 派 `cast`（不传 `cast_method`）→ executor `mv_cast`→`realCastI2V`，首帧=`portrait_path` 锁脸 → 抽 13 帧 + 逐帧 facegate。
   - 单测：`mv_mock_e2e` `mv_cast` 块（mp4+13 帧、`result.frames×13`、`portrait_path` 透传、`mock+stub` 诚实标注）。
   - 真机复核（§1 结论）：抽帧肉眼 = input 女主；facegate 分 pattern 高（0.4~0.64，随角度起伏）**非稳定 0**（稳定 0 才是换脸）。
2. **分支路径（遗留）**：`cast_method='h3_image_cast'` → `mv_cast_image`→`realCastImage`，仍出 3 候选照。
   - 单测：`mv_mock_e2e` `mv_cast_image` 块（png×3 + `face_scores×3`）。
3. **契约**：`characterShape.cast_method` 输出正确（缺省回填 `i2v_first_frame`）；非法 `cast_method` → 400（`resolveCastMethod` 白名单）。
   - 单测：`v13_mv_contract` 对 `characterShape.cast_method` 的断言。
4. **拍板**：`cast/confirm` 用 `frame_sel` 选帧 → viewRefs 固化 → `casting→scripting`（**拍板权在人**，助手不代拍）。
   - 单测：`v13_mv_contract` / `v21` 的 `cast→confirm→scripting` 链路。

**通过标准**：上述 3 条确定性命令全绿（28/28、28/28、9/9），即视为方案一落地验收通过。

---

## 7.1 真实生成复现（FL2VA I2V 实机，2026-11-26 实测通过）

> 这是**真调后端生成的证据**，不是 mock。复现它即可验证"方案一保脸"属实。

### 7.1.1 远程端点（本机 ComfyUI，dgx 托管的 H3 生成后端）

| 项 | 值 |
|---|---|
| ComfyUI HTTP | `http://127.0.0.1:8188`（`/prompt` 提交、`/history/:id` 查结果、`/object_info` 看节点） |
| 工作流蓝图 | `ComfyUI/blueprints/Image to Video (MiniMax H3).json` |
| FL2VA UNET | `models/unet/minimax_h3_fl2va_pruned_int8_convrot.safetensors`（→ `/mnt/models-ssd/...` 软链） |
| 视频 VAE | `models/vae/minimax_h3_video_vae_fp16.safetensors`（**5.2GB**，视频版，**别用 image vae**） |
| CLIP/VLM | `models/clip/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` |
| 输入女主图 | `ComfyUI/input/identity_ref_60b9cc5089a4.jpg`（1280×2783，黑色长发/黑上衣/夜间城市） |
| 产出 | `ComfyUI/output/realcast/cast_video_00001_.mp4` |

### 7.1.2 关键坑（不踩这两个就 400 / 崩）

1. **UNET 必须用 FL2VA（视频版），不能用 image 版**：
   - `model_detection.py` 按权重里**有无 `audio_patch_proj.weight`** 判定 `image_model`：
     - 有音频流 → `minimax_h3`（视频版 `MiniMaxH3`，要 5D AV latent）
     - 无音频流 → `minimax_h3_image`（图像版 `MiniMaxH3Image`）
   - 错用 image UNET + 图像 VAE → `MiniMaxH3Image.extra_conds` 取 `noise.shape[3]/[4]` 时 **`tuple index out of range`**（latent 形状对不上）。
2. **VAE 必须用视频版** `minimax_h3_video_vae_fp16`（图像 VAE 解不出视频）。
3. 节点 `MiniMaxH3ImageToVideo`（`comfy_extras/nodes_minimax_h3.py`）返回 `CONDITIONING + AV latent`；标准 `KSampler` 直接吃嵌套 AV latent 会越界，需走视频版模型链路。

### 7.1.3 工作流（FL2VA fl2va = first-frame-to-video，正是文档里的 h3-fl2va）

```
UNETLoader(minimax_h3_fl2va...) → 视频版 MiniMaxH3 模型
CLIPLoader(qwen3vl_minimax_h3)
VAELoader(minimax_h3_video_vae_fp16)
LoadImage(identity_ref_...) ──▶ first_frame
MiniMaxH3ImageToVideo(clip,vae,prompt=转头/多角度, width=768,height=1344,length=124, first_frame)
  → CONDITIONING(positive) + AV latent
ConditioningZeroOut → negative
KSampler(model, positive, negative, latent_image, seed=424242, steps=6, cfg=1.0, euler/simple, denoise=1.0)
VAEDecode(samples, video_vae)
CreateVideo(images, fps=24)   → VIDEO 类型
SaveVideo(video, prefix=realcast/cast_video, format=mp4)
```
提交：`POST http://127.0.0.1:8188/prompt  {"prompt": <workflow>, "client_id": <uuid>}`。

### 7.1.4 实测产出与保脸证据

- **视频**：`cast_video_00001_.mp4`，`768×1344 · 24fps · 5.17s · 124 帧`（真实 GPU 生成，约 6~7 分钟出片）。
- **保脸核验**（视频首帧+关键帧 vs 输入女主图，归一化余弦相似度）：

| 帧 | vs 女主原图 | 解读 |
|---|---|---|
| 帧1（首帧） | **0.9972** | 首帧=女主本人，锁脸成立 |
| 帧2 | 0.9265 | 缓转 |
| 帧3 | 0.7616 | 侧转 |
| 帧4 | 0.6591 | 3/4 侧脸，随角度缓降 |

- **结论**：全链同一人，随转头**逐级缓降**（角度效应）——正是 §1 定义的"同一人"pattern，**非换脸**（换脸会稳定 ≈0，如 SP6 Plan A）。
- **核验联系表**：`/tmp/realcast/montage_portrait_vs_frames.png`（图1输入女主图 vs 视频帧1~4，肉眼可见同一人）。

> 复现命令（改 `client_id` 即可）：
> ```bash
> curl -s http://127.0.0.1:8188/prompt \
>   -H 'Content-Type: application/json' \
>   -d '{"prompt":<上述workflow>,"client_id":"<uuid>"}'
> # 轮询：curl -s http://127.0.0.1:8188/history/<prompt_id>  直到 status.status_str=success
> ```

---

## 8. 与 SP6 的关系

- 本方案 = SP6 推荐 MV 工作流的**工程化默认**（SP6 §5）。
- 保留 SP6 否定的 Plan A 作为遗留分支（§2 表），满足"迁移/特殊需求可显式启用"。
- `ref2va`/`likeness_lora` 为 SP6 §8 列的后续可选，本期登记为未来分支，**不实现、不阻塞默认**。
