# DGX Spark · qwen38-fp4 已托管接入（2026-11-23）

> **定稿口径（CONTRACTS.md §0）**：多模态 LLM/VLM = DGX Spark **已托管**的 qwen38-fp4，
> **单一 OpenAI 兼容端点**兼顾文本与图像，**不再自建 vLLM 双实例**。
> 基址 `cfg.llmVlmUrl`，默认 `http://127.0.0.1:8193/v1`，环境变量 `MB_LLM_VLM_URL` 覆盖。
> 用户面纪律：任何场合（含报错文案）不得出现引擎型号名，本目录文档仅供运维。

## 1. 指向方式（三处，保持一处真源）

| 位置 | 键 | 示例 |
|---|---|---|
| 执行机环境变量 | `MB_LLM_VLM_URL` | **`http://192.168.1.10:8090/v1`**（实测 2026-11-23：vLLM `/models` 返回 `qwen38-fp4`，ctx 262144；同机兼挂 SearXNG:8080，勿混淆） |

> **思考模型适配（2026-11-23 实测）**：该托管端点输出带 `reasoning`（思维链），`content` 可能为 null——server `prompts/intent.js` 与执行器 `lanes/intent.js` 已按 `content || reasoning` 兜底；server 侧 `max_tokens` 已上调至 3000 给推理留量，单轮超时 `MB_LLM_TIMEOUT_MS` 默认 60s。模型名 `MB_LLM_VLM_MODEL`（默认 `qwen38-fp4`）以 `/models` 返回为准。
| 执行机令牌文件 | `/etc/musicbox/executor.env` | 见 `deploy/vps/SETUP.md` §1 |
| 服务端配置 | `cfg.llmVlmUrl`（server 方 `config.js`） | 同值，供服务端侧兜底编译用 |

- 端点写**基址**即可（带 `/v1`，不带尾部斜杠）；执行器自行拼接 `/chat/completions`。
- 模型名由执行器 `MB_LLM_VLM_MODEL` 控制（默认 `qwen38-fp4`；以托管方 `/models` 返回值为准）。

## 2. 连通性自检（在**执行机**上跑）

```bash
LLM=${MB_LLM_VLM_URL:-http://127.0.0.1:8193/v1}

# ① 服务在线 + 模型名
curl -fsS "$LLM/models" | head -c 400; echo

# ② 文本一发（意图编译同型请求）
curl -fsS "$LLM/chat/completions" -H 'content-type: application/json' -d '{
  "model": "qwen38-fp4",
  "messages": [
    {"role": "system", "content": "只输出 JSON。"},
    {"role": "user", "content": "把\"想给妈妈写首温馨的生日歌\"编译成 {\"mood\":[],\"genre\":[]}，只输出 JSON"}
  ],
  "temperature": 0.3
}' | head -c 600; echo

# ③ 图片一发（多模态：本地 png → base64 data URL；用 printf 拼 JSON 避免引号地狱）
IMG=${1:-/tmp/mb_sample.png}   # 任意 ≤8MB 的 png/jpg；没有就现场造一张合法 1x1 PNG（不往仓里塞二进制）
[ -f "$IMG" ] || node -e 'const H=require("./test/acceptance/helpers.js");require("fs").writeFileSync(process.argv[1],H.makePng())' "$IMG"
DATA=$(base64 -w0 "$IMG")
printf '{"model":"qwen38-fp4","messages":[{"role":"user","content":[{"type":"text","text":"一句话描述这张图。"},{"type":"image_url","image_url":{"url":"data:image/png;base64,%s"}}]}]}' "$DATA" >/tmp/mb_img.json
curl -fsS "$LLM/chat/completions" -H 'content-type: application/json' -d @/tmp/mb_img.json | head -c 600; echo
```

判定：①返回 `data` 数组；②③返回 `choices[0].message.content` 非空。

> **2026-11-27 本机实测 3/3 绿**（`MB_LLM_VLM_URL=http://127.0.0.1:8090/v1`）：
> ① `data[].id = qwen38-fp4`，`max_model_len=262144`；② 返回 `{"mood":["温馨","感恩","幸福"],"genre":["生日歌","流行","民谣"]}`；
> ③ 喂 1x1 白图，模型如实答"这是一张纯白色的空白图片…"（说明多模态面真的在看图，不是复读文本）。
> 两条踩坑记录：**(a)** 旧版示例写 `deploy/spark/sample.png`，该文件**并不存在**，照抄必在 `base64` 处红，
> 会被误判成"LLM 不通"——现改为缺图就现场生成；**(b)** ② 的响应体里除 `content` 外还有 `reasoning` 字段
> （vLLM 思考模式回传），**判定只看 `choices[0].message.content`**，别拿整个响应去断言。
三发全绿 = 执行器 intent lane 的 LLM 面可用；任一失败 = intent lane 将自动走本地词典启发式（链路不断，confidence 降低），**不会报错中断**。

## 3. 可选自部署兜底（默认关）

仅当托管端点长时间不可用且需要维持意图线质量时，才在 Spark 上启用应急自部署：

```bash
bash deploy/spark/deploy_vllm_fallback.sh            # 默认不启动，只打印将执行的命令（干跑）
RUN=1 bash deploy/spark/deploy_vllm_fallback.sh      # 确认后真启（vLLM 小杯 Qwen，:8193）
```

- 脚本用**小杯开源 Qwen**（白名单内 Apache-2.0）起 vLLM，暴露与原托管**相同的 OpenAI 路径**，执行器零改动。
- 应急期结束务必 `docker stop` 并回指托管端点——兜底实例与托管模型效果有差。
- 5060 Ti 的 `:8190`（生乐）与本端点显存互不相干：lane 天然隔离，无互斥问题。
