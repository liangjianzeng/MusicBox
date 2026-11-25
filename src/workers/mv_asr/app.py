# MusicBox MV 对齐转写 worker —— FastAPI :8391 脚手架（2026-11-24，SP-MV-2/N2-2 接线）
# 职责：一期 src/workers/sensevoice/app.py 的 MV 扩展——SenseVoice 转写 + **逐段时间戳输出**，
#       供执行器 mv_align 与歌词逐句规则对齐（timings 三分用：唱段分配/切窗/字幕，架构 §4.1）。
# 诚实声明：本文件为**骨架交付件**——不装 funasr/torch、不加载模型；真机接线属 SP-MV-2
#       （DGX Spark 侧 uv venv + ModelScope SenseVoiceSmall，CPU 常驻 ~2G，见 docs/…construction-plan §2.1 S4）。
# 依赖（Spark 侧安装，勿在本阶段执行）：
#   uv venv var/venv-asr && uv pip install fastapi uvicorn funasr torchaudio（对齐一期 venv-asr 纪律）
# 启动（真机）：uvicorn app:app --host 127.0.0.1 --port 8391
# 协议（与执行器 lanes/mv.js realAlign 对齐）：
#   GET  /healthz                         → {ok, model_loaded, device, scaffold}
#   POST /asr {path, timestamp?:bool}     → {text, emotion, events, duration, segments:[{text,start,end}]}
#     （timestamp=false 时与一期 :8191 同型；segments 缺省 []，SP-MV-2 补 VAD 分句时间戳）
import os
import re
import wave

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

MODEL_ID = os.environ.get("MB_MV_ASR_MODEL", "iic/SenseVoiceSmall")
DEVICE = os.environ.get("MB_MV_ASR_DEVICE", "cpu")
PORT = int(os.environ.get("MB_MV_ASR_PORT", "8391"))

# SenseVoice 富文本标签：<|zh|><|HAPPY|><|BGM|> …（与一期同典）
TAG_RE = re.compile(r"<\|([^|>]+)\|>")

app = FastAPI(title="musicbox-mv-asr", version="0.1.0-scaffold")
_model = None  # 真机：from funasr import AutoModel 延迟加载（/healthz 不依赖模型）


def _load_model():
    global _model
    if _model is None:
        raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: funasr 未接线（SP-MV-2 交付项）")
    return _model


def _duration(path: str) -> float:
    try:
        with wave.open(path, "rb") as w:
            fr = w.getframerate() or 8000
            return round(w.getnframes() / float(fr), 2)
    except Exception:
        return 0.0


class AsrReq(BaseModel):
    path: str
    timestamp: bool = False


@app.get("/healthz")
def healthz():
    return {"ok": True, "model_loaded": _model is not None, "device": DEVICE, "scaffold": True}


@app.post("/asr")
def asr(req: AsrReq):
    path = req.path
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=400, detail="音频文件不存在")
    if os.path.getsize(path) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="音频文件过大")
    _load_model()  # 骨架阶段恒 503（诚实失败；执行器按 ASR_UNREACHABLE 上抛）
    # TODO(SP-MV-2)：model.generate(..., timestamp=true) + VAD 分句 →
    #   segments=[{text, start, end}]（秒，±150ms 通过线），text/emotion/events 同一期形状
    raise HTTPException(status_code=501, detail="NOT_IMPLEMENTED")
