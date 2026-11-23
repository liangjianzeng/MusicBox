# 预研 Spike 清单（SP1–SP5 · 2026-11-23）

> 目的：上线前逐环节压测/质量摸底，全部**可独立运行、缺环境即 SKIP 不报错**。
> 契约真源 `CONTRACTS.md`；端口口径：生乐 `:8190`、转写 `:8191`、理解端点 `:8193/v1`（托管，见 `deploy/spark/README.md`）、API `:7900`。

| # | 项目 | 运行方式 | 机器 | 状态 |
|---|---|---|---|---|
| SP1 | 语音→意图卡链路 | `bash spikes/SP1_intent_chain.sh`（详见 `SP1_intent_chain.md`） | 执行机（:8191 同机） | 脚本就绪 |
| SP2 | 托管理解端点连通 | `deploy/spark/README.md` §2 三条 curl | 任意内网机 | 文档就绪 |
| SP3 | 生乐两档批量计时 | `bash spikes/SP3_acestep_batch.sh` | 5060 Ti 生乐机 | 脚本就绪 |
| SP4 | App 生成流手工清单 | 人工（App 侧施工方执行） | App + API | 清单见下 |
| SP5 | App 意图卡流手工清单 | 人工（App 侧施工方执行） | App + API | 清单见下 |

## SP3 记录口径

`30s 档墙钟均值 / 4min 档墙钟均值 / 失败数`。30s 档超 300s → music lane 超时线需上调；任一档连续 3/3 成功记为通过。

## SP4 · App 生成流（手工清单）

1. 游客登录 → `/v1/me` 积分 50。
2. 简单模式一句话点歌 → 202 `job_id` → 进度条随 `job.progress` 推进（33/66/99）→ WSS `job.done`。
3. 候选 3 卡带可播（mp3）、波形图有数据（peaks）；重复点生成返回同一 job（幂等，不重复扣分）。
4. 采纳 1 条 → 作品库可见 → seed-pack 可导出（prompt/tags/bpm/seed 齐全）。
5. 断网重试：生成中断网再恢复，轮询最终收敛到 done/failed；failed 有 refund。

## SP5 · App 意图卡流（手工清单）

1. 录 15s 语音 → 意图卡 ≤30s 出现（WSS `intent.card`），字段齐全无引擎名。
2. confidence<0.75 时 1-2 题、每题 2-4 选项、默认选中推荐项；答题后卡更新。
3. 图片入口同上；两轮澄清上限生效。
4. ready 卡 `generate` → 进 SP4 生成流；卡变 consumed 不可复用。
5. 转写/理解端点停机时：卡仍产出（confidence 降低、有澄清题），流程不中断。

## SKIP 约定

脚本探测依赖（curl 探活/样本文件），缺失打印 `SKIP: 原因` 并退出码 0，便于 CI 里"预研不阻塞"。
