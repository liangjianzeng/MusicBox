# SP1 · 意图链路预研（语音 → 转写 → 意图卡）

**目的**：在无 App 的情况下验证 S2 序列的服务端两跳——`:8191` 转写质量 × 托管多模态端点的 IntentCard 编译质量，产出对照表供 prompt 迭代。

## 前置

| 依赖 | 检查 | 缺失时 |
|---|---|---|
| 3 段语音样本 | `spikes/samples/a.{wav,m4a}` `b` `c`（≤60s，真实人声） | 脚本 `SKIP` 并提示 |
| 转写服务 | `curl http://127.0.0.1:8191/healthz` | `SKIP`（先启动 `src/workers/sensevoice/app.py`） |
| 理解端点 | `curl $MB_LLM_VLM_URL/models` | **不 SKIP**：只出转写列，对照表 mood 显示「本地兜底」 |
| node / curl | 执行机自带 | `SKIP` |

## 运行

```bash
# 缺省样本目录模式
bash spikes/SP1_intent_chain.sh
# 或指定文件
bash spikes/SP1_intent_chain.sh 庆生.m4a 跑步.wav 助眠.wav
# 端点覆盖
MB_LLM_VLM_URL=http://10.0.0.12:8193/v1 bash spikes/SP1_intent_chain.sh
```

## 输出

```
== IntentCard 对照表 ==
#|转写              |mood   |曲风          |置信 |题数|情绪/事件
1|想给妈妈写首生日歌 |温暖   |pop/folk      |0.62 |1  |happy/-
...
```

## 判读口径（预研结论怎么记）

- **转写**：专名/数字是否正确（ITN）、有无吞字。
- **mood/曲风**：是否与语义相符；同一句跑 3 次看稳定性。
- **confidence**：语义完整句应 ≥0.75 且 **0 题直出**；含糊句应 1-2 题。
- **题量纪律**：任何情况下题数 ≤2、每题选项 2-4、必带推荐项（执行器 `sanitizeCard` 会兜底整形，但预研看模型原生质量）。
- 若 mood 列全为「本地兜底」→ 理解端点未起/不可达；线上链路不断，但需先修复再做 prompt 调优。

结果建议贴回 `spikes/`（如 `SP1-结果-20261123.md`），供 `src/server/prompts` 的编译指令迭代。
