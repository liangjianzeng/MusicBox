# MusicBox SenseVoice 转写 worker —— FastAPI :8191（2026-11-23）
# 职责：接收执行器本机音频路径，用 FunASR(SenseVoiceSmall) 输出 {text, emotion, events[], duration}。
# 部署：与执行器同机（CPU 即可），仅内网监听；开发机不要求本机运行，本目录为交付件。
# 启动：python app.py            或   uvicorn app:app --host 0.0.0.0 --port 8191
import os
import re
import threading
import wave
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("MB_ASR_MODEL", "iic/SenseVoiceSmall")
DEVICE = os.environ.get("MB_ASR_DEVICE", "cpu")
PORT = int(os.environ.get("MB_ASR_PORT", "8191"))
# 与其余三个 worker 一致：默认只监听回环（旧值 0.0.0.0 = 局域网内任意主机可白打 CPU 推理）
BIND = os.environ.get("MB_ASR_BIND", "127.0.0.1")
ROOTS = [Path(x).resolve() for x in os.environ.get(
    "MB_ASR_ROOTS", str(Path.home() / "MusicBox" / "var") + "," + str(Path("var").resolve())
).split(",") if x.strip()]

# SenseVoice 富文本标签：<|zh|><|HAPPY|><|BGM|><|withitn|> …
EMOTION_SET = {
    "HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARED", "DISGUSTED",
    "SURPRISED", "EMO_UNKNOWN",
}
EVENT_SET = {
    "BGM", "APPLAUSE", "LAUGHTER", "CRY", "COUGH", "BREATH",
    "Speech", "Event_Unknow",
}
TAG_RE = re.compile(r"<\|([^|>]+)\|>")

app = FastAPI(title="musicbox-sensevoice", version="1.0.0")

# —— 内部令牌（2026-11-26 抢救 P0-4）：worker 默认只监听回环；跨机部署必须设 MB_WORKER_TOKEN ——
WORKER_TOKEN = os.environ.get("MB_WORKER_TOKEN", "").strip()


def _require_token(x_worker_token: str = Header(default="")):
    """纵深防御：即便被端口转发/反向代理暴露到局域网，未带令牌也无法调用推理口。"""
    if WORKER_TOKEN and (x_worker_token or "").strip() != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="WORKER_UNAUTHORIZED")
    return True


def _default_roots():
    """可信素材根：去掉 /opt/musicbox 与 E:/Work 历史路径，改为当前部署可解析的位置。"""
    home_var = str(Path.home() / "MusicBox" / "var")
    return ",".join([home_var, str(Path("var").resolve())])

_model = None
_load_lock = threading.Lock()


def _load_model():
    # 双检锁：此前无锁，并发首个请求会重复加载模型（CPU 上数秒 × N 次，内存/算力雪崩）
    global _model
    if _model is not None:
        return _model
    with _load_lock:
      if _model is None:
        from funasr import AutoModel  # 延迟导入：/healthz 不依赖模型加载
        # trust_remote_code=False（2026-11-23 实测）：官方 ModelScope 仓不带 model.py，
        # SenseVoiceSmall 类由 funasr 内置注册；True 会去找不存在的远端代码导致 ImportError
        _model = AutoModel(model=MODEL_ID, trust_remote_code=False, device=DEVICE)
    return _model


def local_file(value: str) -> str:
    """只允许读可信目录内的音频（其余三个 worker 早有 ROOTS 白名单，本 worker 此前完全没有）。"""
    if not value:
        raise HTTPException(status_code=400, detail="缺少路径")
    candidate = Path(value).expanduser().resolve()
    if not any(candidate == root or root in candidate.parents for root in ROOTS):
        raise HTTPException(status_code=403, detail="路径不在允许目录")
    if not candidate.is_file():
        raise HTTPException(status_code=400, detail="音频文件不存在")
    return str(candidate)


def _duration(path: str) -> float:
    """时长探测：librosa 优先（支持 m4a 等），退回标准库 wave（仅 wav）。"""
    try:
        import librosa
        return float(librosa.get_duration(path=path))
    except Exception:
        pass
    try:
        with wave.open(path, "rb") as w:
            fr = w.getframerate() or 8000
            return round(w.getnframes() / float(fr), 2)
    except Exception:
        return 0.0


class AsrReq(BaseModel):
    path: str


@app.get("/healthz")
def healthz():
    return {"ok": True, "model_loaded": _model is not None, "device": DEVICE}


@app.post("/asr")
def asr(req: AsrReq, _auth: bool = Depends(_require_token)):
    path = local_file(req.path)
    if os.path.getsize(path) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="音频文件过大")
    model = _load_model()
    try:
        res = model.generate(input=path, cache={}, language="auto", use_itn=True)
    except Exception as exc:  # 模型异常不吞栈，返回 500 由执行器降级兜底
        raise HTTPException(status_code=500, detail="转写失败: %s" % type(exc).__name__)
    item = res[0] if isinstance(res, (list, tuple)) and res else (res or {})
    rich = item.get("text", "") if isinstance(item, dict) else str(item)
    tags = TAG_RE.findall(rich)
    text = TAG_RE.sub("", rich).strip()
    emotion = "neutral"
    for t in tags:
        if t.upper() in EMOTION_SET and t.upper() != "NEUTRAL":
            emotion = t.lower()
            break
    events = sorted({t.lower() for t in tags if t.upper() in EVENT_SET})
    return {
        "text": text,
        "emotion": emotion,
        "events": events,
        "duration": round(_duration(path), 2),
    }


if __name__ == "__main__":
    import uvicorn
    if not WORKER_TOKEN and BIND not in ("127.0.0.1", "localhost", "::1"):
        print("[sensevoice] 警告：监听 %s 且未设置 MB_WORKER_TOKEN，局域网内任意主机可调用本服务" % BIND)
    uvicorn.run(app, host=BIND, port=PORT)
