# MusicBox MV 人脸身份门控 worker —— FastAPI :8395 脚手架（2026-11-24，N0-4 接线）
# 职责：ArcFace 余弦 + 姿态粗估为定妆/分镜/抽帧打身份分（传照档对上传照评，AI 脸档对定妆照互评）；
#       inswapper_128 低分兜底换脸（×2 门，剧场 facegate 协议范式移植，自有部署）。
# 诚实声明：本文件为**骨架交付件**——不装 insightface/onnx、不加载模型；真机接线属 N0-4
#       （DGX Spark 侧 uv venv + buffalo_l/inswapper onnx，CPU 常驻 ~2G，见 docs/…construction-plan §2.1 S4）。
# 依赖（Spark 侧安装，勿在本阶段执行）：
#   uv venv var/venv-facegate && uv pip install fastapi uvicorn insightface onnxruntime opencv-python-headless
# 启动（真机）：uvicorn app:app --host 127.0.0.1 --port 8395
# 协议（与执行器 lanes/mv.js facegateScore 对齐）：
#   GET  /health                      → {ok, ref_loaded, scaffold}
#   POST /score {img_b64, ref_file?}  → {score, yaw, pitch, pass}
#   POST /swap  {dst_b64, ref_file?}  → {png_b64, score}
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

PORT = int(os.environ.get("MB_FACEGATE_PORT", "8395"))
MODEL_DIR = os.environ.get("MB_FACEGATE_MODELS", "/opt/musicbox/var/models/facegate")
FACEGATE_GATE = float(os.environ.get("MB_FACEGATE_GATE", "0.6"))
REF_FILE = os.environ.get("MB_FACEGATE_REF", "")  # 缺省参考照（var/uploads 下的定妆/传照）

app = FastAPI(title="musicbox-mv-facegate", version="0.1.0-scaffold")
_app_ready = False  # FaceAnalysis 就绪标志（真机 prepare 后置 True；本阶段保持 False）


def _require_engine():
    if not _app_ready:
        raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: insightface 未接线（N0-4 交付项）")


class ScoreIn(BaseModel):
    img_b64: str
    ref_file: str = None


class SwapIn(BaseModel):
    dst_b64: str
    ref_file: str = None
    gate: float = FACEGATE_GATE


@app.get("/health")
def health():
    # 执行器观测端点：秒级返回，绝不触发模型加载
    return {"ok": True, "ref_loaded": _app_ready, "gate": FACEGATE_GATE, "scaffold": True}


@app.post("/score")
def score(req: ScoreIn):
    # TODO(N0-4): cv2.imdecode → FaceAnalysis(buffalo_l) 最大脸 → normed_embedding 与参考照余弦
    #   + 5 点 kps 姿态粗估（yaw/pitch 惩罚，剧场 facegate 语义移植）→ {score, yaw, pitch, pass}
    _require_engine()
    raise HTTPException(status_code=501, detail="NOT_IMPLEMENTED")


@app.post("/swap")
def swap(req: SwapIn):
    # TODO(N0-4): inswapper_128.onnx 换脸 ×2 兜底（低分镜），返回 png_b64 + 换后分
    _require_engine()
    raise HTTPException(status_code=501, detail="NOT_IMPLEMENTED")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
