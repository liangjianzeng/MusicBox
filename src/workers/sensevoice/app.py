# MusicBox SenseVoice 转写 worker —— FastAPI :8191（2026-11-23）
# 职责：接收执行器本机音频路径，用 FunASR(SenseVoiceSmall) 输出 {text, emotion, events[], duration}。
# 部署：与执行器同机（CPU 即可），仅内网监听；开发机不要求本机运行，本目录为交付件。
# 启动：python app.py            或   uvicorn app:app --host 0.0.0.0 --port 8191
import os
import re
import wave

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("MB_ASR_MODEL", "iic/SenseVoiceSmall")
DEVICE = os.environ.get("MB_ASR_DEVICE", "cpu")
PORT = int(os.environ.get("MB_ASR_PORT", "8191"))

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
_model = None


def _load_model():
    global _model
    if _model is None:
        from funasr import AutoModel  # 延迟导入：/healthz 不依赖模型加载
        # trust_remote_code=False（2026-11-23 实测）：官方 ModelScope 仓不带 model.py，
        # SenseVoiceSmall 类由 funasr 内置注册；True 会去找不存在的远端代码导致 ImportError
        _model = AutoModel(model=MODEL_ID, trust_remote_code=False, device=DEVICE)
    return _model


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
def asr(req: AsrReq):
    path = req.path
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=400, detail="音频文件不存在")
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
    uvicorn.run(app, host="0.0.0.0", port=PORT)
