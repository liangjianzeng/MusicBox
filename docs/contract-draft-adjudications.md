# 契约草案待判缺陷 · 逐条判定（2026-11-27）

> 来源：`docs/CONTRACTS.next.md` 起草阶段列出的 6 条"实现与契约不一致/可疑"缺陷。
> 纪律：每条都到代码现场核对后才下结论；**不成立也要写明为什么不成立**，否则下一个人会重新怀疑一遍。

| # | 指控 | 现场 | 判定 | 依据 |
|---|---|---|---|---|
| 1 | `/v1/app/config` 无鉴权下发整张积分表 | `api/appconfig.js:1-2,38` | **成立但按设计保留** | App 必须在派单前显示"本次消耗 15⚡"。实测下发内容为 `daily_free/per_candidate/adjust/extend/cover/dsp/mv` —— 全是用户面售价，**不含 worker 内部成本**，不构成内部经济泄密。约束：今后新增键不得放内部成本 |
| 2 | persona 声纹样本进公共 `/f/*` | `api/personas.js:50` → `U.saveToOut(config.paths.out,…)`；`index.js:99` `/f/*` 映射 out 目录 | **成立（真缺陷，PIPL 敏感个人信息）** | 声纹属敏感个人信息，任何持 URL 者可下载他人声纹。待修：私有目录 + 属主鉴权取件 + 合规用例。`personaShape` 本身不外泄 `voice_ref`（已核对） |
| 3 | `/executor/register` 泄露模型节点端点 | `api/executor.js:24,38` | **不成立** | `register` 首行即 `assertToken(ctx)`，`nodesForExecutor()` 只发给持执行器令牌的调用方（执行器本就是受信内网组件）。前置条件由 P0-3 兜住：prod 下 `MB_EXECUTOR_TOKEN` 未显式配置直接拒绝启动（V28-① 实测） |
| 4 | `mood` 长度上限两处不一致 | `l2assistant/core.js:28` 60 ↔ `l2music/governance.js:26` 20；canonical `api/works.js:23` `slice(0,20)` | **成立（真缺陷）** | 同一字段两处校验漂移：助手放行 60 字，写入截成 20 字 → 用户静默丢字。应统一到共享常量（canonical=20）。注：草案里给的路径缺了 `src/server/` 前缀，按此路径 grep 会误判成"文件不存在" |
| 5 | `mv.shot_reshoot.shot_id` kind 漂移 | 契约 `CONTRACTS.md:441` 写 `shot_id:string`；实现 `l2mv/governance.js:54` 是 `kind:'shotId'` | **契约写少了，改契约** | 实现更严（`shotId` 会做归属校验）。收敛方向是提高契约精度，**不是**把实现降级成 string |
| 6 | `works.js` dsp 退款 `ref_type` 不配对 | `api/works.js:410,417` | **不成立（口径需在契约里写明）** | 幂等命中退款与扣费用**同一元组** `('dsp','work',w.id)`，配对正确；终态失败退款由引擎按 `('job',job.id)` 记账，可经 `jobs.credits_cost` 关联 —— 两种口径用途不同，契约应分别写明，避免今后被误判成 bug |

## 复核中新追加的两条（判定 2 的连带发现，已修 + 已验）

| # | 缺陷 | 现场 | 修法 | 验收 |
|---|---|---|---|---|
| 7 | **任何人可用他人人格克隆声音**：派单取 persona 只按 id 查，不校验归属；公开人格同样可被取用 | `api/works.js` `buildMusicPayload` 内 `SELECT * FROM personas WHERE id=?`（无 user_id 条件） | 非属主一律 403 + `persona.use_denied` 审计（含 `is_public=1`）；契约 v5.2.5 | V31-① |
| 8 | **跨机声线克隆静默失效**：`payload.persona.ref_abs_path` 是服务端绝对路径；执行器只判断"字段是否存在"就把不存在的路径发给引擎，且 `meta.clone.applied` 提前写死 true | `api/works.js:37` 组 payload；`executor/lanes/music.js` 旧 `const persona = p.persona && p.persona.ref_abs_path ? …` | payload 带 `persona.id`；执行器经鉴权取件口回捞（带 TTL 缓存，避免逐候选重复下载）；取不到则诚实降级；顺带修 guide 走 `payload.music_endpoint` 而 cover 走 `cfg.musicUrl` 的**异机分裂** | V31-②③④ |

## 附：本轮一并核对的实测口径（写进契约防再犯）

- `/healthz.online` 的 `online` 是 **App WSS 连接数**，不是执行器个数（真机排障时把它当执行器数，误判过"执行器没起来"）。
- 执行器死活看 `executors.last_seen`（300s 窗口），不看 `online`。
- ACE-Step 引擎返回的 `file` 是**异机绝对路径**，必须走 `GET /music/{id}/file` 取件口回捞（已在 `lanes/music.js` 实现并留审计）。
