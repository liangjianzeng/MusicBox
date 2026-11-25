# MusicBox MV 口型重绘 worker —— FastAPI :8390 脚手架（2026-11-24，SP-MV-1 接线）
# 职责：接收执行器切窗后的「演唱镜视频 + 指定音频段」，用 EchoMimicV3-Flash 重绘口型，
#       内置 SyncNet 自检返回 sync_score（质量门阈值由服务端判定，低于阈值执行器/服务端补样）。
# 诚实声明：本文件为**骨架交付件**——不装 torch、不拉权重、不推理；真机接线属 SP-MV-1/N2-2
#       （DGX Spark 侧，uv venv + ModelScope/hf-mirror 权重 → var/models，懒加载/空闲 10min 释放）。
# 依赖（Spark 侧安装，勿在本阶段执行）：
#   uv venv var/venv-lipsync && uv pip install fastapi uvicorn torch(≥aarch64 cu12x) echomimic-weights...
#   （见 deploy/spark/mv-lipsync.service 与 docs/musicbox-phase2-construction-plan.md §2.1 S4/S5）
# 启动（真机）：uvicorn app:app --host 127.0.0.1 --port 8390
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

PORT = int(os.environ.get("MB_LIPSYNC_PORT", "8390"))
WEIGHTS_DIR = os.environ.get("MB_LIPSYNC_MODELS", "/opt/musicbox/var/models")
IDLE_RELEASE_SEC = 600  # 一期 ACE-Step 纪律：懒加载 + 空闲 10min 释放

app = FastAPI(title="musicbox-mv-lipsync", version="0.1.0-scaffold")
_engine = None  # EchoMimicV3-Flash 推理管线（懒加载；本阶段保持 None）


def _weights_ready() -> bool:
    return os.path.isdir(WEIGHTS_DIR) and any(os.scandir(WEIGHTS_DIR))


def _load_engine():
    """真引擎接线点（SP-MV-1）：torch/EchoMimic 延迟导入，绝不模块级加载。"""
    global _engine
    if _engine is None:
        raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: 权重/引擎未接线（SP-MV-1 交付项）")
    return _engine


class LipsyncReq(BaseModel):
    video: str          # 执行器本机绝对路径（与 worker 同机）
    audio: str          # 切窗音频段（wav，含 ±0.2s 上下文余量，执行器负责切）
    text: str = ""      # 可选唱词（引擎条件增强用）


@app.get("/health")
def health():
    # 执行器 LIPSYNC_UNREACHABLE 判定端点：必须秒级返回，不触发模型加载
    return {"ok": True, "engine": "echomimic_v3_flash", "weights_ready": _weights_ready(), "loaded": _engine is not None, "scaffold": True}


@app.post("/lipsync")
def lipsync(req: LipsyncReq):
    # 契约（架构 §4.1）：POST /lipsync {video, audio} → {file, sync_score}
    for k in ("video", "audio"):
        v = getattr(req, k)
        if not v or not os.path.isfile(v):
            raise HTTPException(status_code=400, detail="PARAM_MISSING: %s" % k)
    eng = _load_engine()  # 骨架阶段恒 503（诚实失败，绝不假成功）
    raise HTTPException(status_code=501, detail="NOT_IMPLEMENTED: SP-MV-1 接线后启用（eng=%r）" % (eng,))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
