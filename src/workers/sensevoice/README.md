# SenseVoice 转写 worker（执行器同机 · CPU）

> 契约：`CONTRACTS.md` §0/§4。监听 `:8191`，仅供**执行器本机**调用，**只在内网/本机暴露**，绝不出公网。
> 职责：接收执行器传入的本机音频绝对路径，转写为 `{text, emotion, events[], duration}`。

## 部署（与执行器同一台机器）

```bash
cd src/workers/sensevoice
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

首次运行 FunASR 会从 ModelScope 拉取 `iic/SenseVoiceSmall` 权重（约 500MB，缓存到 `~/.cache/modelscope`）。
CPU 推理即可（≤60s 语音数秒内完成），无需 GPU。

## 启动

```bash
python app.py            # 默认 0.0.0.0:8191
# 或
uvicorn app:app --host 0.0.0.0 --port 8191
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MB_ASR_MODEL` | `iic/SenseVoiceSmall` | FunASR 模型 id（白名单内，可商用） |
| `MB_ASR_DEVICE` | `cpu` | `cpu` 或 `cuda` |
| `MB_ASR_PORT` | `8191` | 监听端口 |

## 接口

### `GET /healthz`
→ `{ok: true, model_loaded: bool, device: "cpu"}`。执行器/探活脚本用。

### `POST /asr`
请求：`{"path": "/abs/path/to/audio.(wav|m4a)"}`（执行器已把上传件落盘，仅传路径，不传二进制）。

响应 200：
```json
{
  "text": "转写正文（已剥离标签）",
  "emotion": "happy | sad | angry | neutral | ...",
  "events": ["bgm", "laughter", "..."],
  "duration": 12.34
}
```

错误：`400` 文件不存在/过大（>20MB）；`500` 推理异常 —— 执行器收到错误后按契约走本地词典启发式兜底，不中断链路。

## 说明

- `text/emotion/events` 来自 SenseVoice 富文本标签（`<|zh|><|HAPPY|><|BGM|>…`）解析；语言标签不计入 events。
- 时长优先 `librosa`（兼容 m4a），退回标准库 `wave`（仅 wav）。
- 本目录为交付件，开发机（无 GPU/未装依赖）不要求本机运行；无此服务时执行器自动降级，全链路仍可跑通。
