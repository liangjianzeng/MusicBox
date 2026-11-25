import os
import re
import threading
import wave
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("MB_MV_ASR_MODEL", "iic/SenseVoiceSmall")
DEVICE = os.environ.get("MB_MV_ASR_DEVICE", "cpu")
PORT = int(os.environ.get("MB_MV_ASR_PORT", "8391"))
ROOTS = [Path(p).resolve() for p in os.environ.get(
    "MB_MV_ASR_ROOTS", "/opt/musicbox/var,E:/Work/MusicBox/var"
).split(",") if p.strip()]
TAG_RE = re.compile(r"<\|([^|>]+)\|>")
EMOTIONS = {"HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARED", "DISGUSTED", "SURPRISED", "EMO_UNKNOWN"}
EVENTS = {"BGM", "APPLAUSE", "LAUGHTER", "CRY", "COUGH", "BREATH", "SPEECH", "EVENT_UNKNOW"}
MAX_AUDIO_BYTES = int(os.environ.get("MB_MV_ASR_MAX_BYTES", str(20 * 1024 * 1024)))

app = FastAPI(title="musicbox-mv-asr", version="1.0.0")
_model = None
_lock = threading.Lock()


def local_file(value: str) -> Path:
    candidate = Path(value).resolve()
    if not any(candidate == root or root in candidate.parents for root in ROOTS):
        raise HTTPException(status_code=403, detail="音频路径不在允许目录")
    if not candidate.is_file():
        raise HTTPException(status_code=400, detail="音频文件不存在")
    if candidate.stat().st_size > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail="音频文件过大")
    return candidate


def _load_model():
    global _model
    with _lock:
        if _model is None:
            try:
                from funasr import AutoModel
            except ImportError as exc:
                raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: 缺少 funasr") from exc
            try:
                _model = AutoModel(model=MODEL_ID, trust_remote_code=False, device=DEVICE)
            except Exception as exc:
                raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: 模型加载失败") from exc
    return _model


def _duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 8000), 2)
    except Exception:
        try:
            import soundfile as sf
            return round(float(sf.info(str(path)).duration), 2)
        except Exception:
            return 0.0


def _seconds(value, milliseconds=True):
    number = float(value or 0)
    return round(number / 1000.0 if milliseconds else number, 3)


def parse_segments(item):
    raw = item.get("sentence_info") or item.get("segments") or []
    segments = []
    for part in raw:
        if not isinstance(part, dict):
            continue
        text = TAG_RE.sub("", str(part.get("text") or part.get("line") or "")).strip()
        start = _seconds(part.get("start", part.get("start_sec")), "start" in part)
        end = _seconds(part.get("end", part.get("end_sec")), "end" in part)
        if text and end > start:
            segments.append({"text": text, "start": start, "end": end})
    return sorted(segments, key=lambda x: x["start"])


class AsrReq(BaseModel):
    path: str
    timestamp: bool = False


@app.get("/healthz")
@app.get("/health")
def healthz():
    return {"ok": True, "model_loaded": _model is not None, "device": DEVICE, "scaffold": False}


@app.post("/asr")
def asr(req: AsrReq):
    path = local_file(req.path)
    model = _load_model()
    try:
        result = model.generate(input=str(path), cache={}, language="auto", use_itn=True,
                                sentence_timestamp=bool(req.timestamp))
    except Exception as exc:
        raise HTTPException(status_code=500, detail="转写失败: %s" % type(exc).__name__) from exc
    item = result[0] if isinstance(result, (list, tuple)) and result else (result or {})
    if not isinstance(item, dict):
        item = {"text": str(item)}
    rich = str(item.get("text") or "")
    tags = TAG_RE.findall(rich)
    text = TAG_RE.sub("", rich).strip()
    emotion = next((t.lower() for t in tags if t.upper() in EMOTIONS and t.upper() != "NEUTRAL"), "neutral")
    events = sorted({t.lower() for t in tags if t.upper() in EVENTS})
    return {"text": text, "emotion": emotion, "events": events,
            "duration": _duration(path), "segments": parse_segments(item) if req.timestamp else []}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
