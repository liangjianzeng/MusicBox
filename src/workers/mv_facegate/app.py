import base64
import math
import os
import threading
from pathlib import Path

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

# —— 内部令牌（2026-11-26 抢救 P0-4）：worker 默认只监听回环；跨机部署必须设 MB_WORKER_TOKEN ——
WORKER_TOKEN = os.environ.get("MB_WORKER_TOKEN", "").strip()


def _require_token(x_worker_token: str = Header(default="")):
    """纵深防御：即便被端口转发/反向代理暴露到局域网，未带令牌也无法调用推理口。"""
    if WORKER_TOKEN and (x_worker_token or "").strip() != WORKER_TOKEN:
        raise HTTPException(status_code=401, detail="WORKER_UNAUTHORIZED")
    return True


def _default_roots():
    """可信素材根：去掉 /opt/musicbox 与 E:/Work 历史路径，改为当前部署可解析的位置。"""
    return ",".join([str(Path.home() / "MusicBox" / "var"), str(Path("var").resolve())])


PORT = int(os.environ.get("MB_FACEGATE_PORT", "8395"))
MODEL_ROOT = Path(os.path.expanduser(os.environ.get(
    "MB_FACEGATE_MODELS", str(Path.home() / "MusicBox" / "var" / "models" / "facegate")))).resolve()
MODEL_NAME = os.environ.get("MB_FACEGATE_MODEL_NAME", "buffalo_l")
FACEGATE_GATE = float(os.environ.get("MB_FACEGATE_GATE", "0.6"))
ROOTS = [Path(p).resolve() for p in os.environ.get(
    "MB_FACEGATE_ROOTS", _default_roots()
).split(",") if p.strip()]
MAX_IMAGE_B64 = int(os.environ.get("MB_FACEGATE_MAX_IMAGE_B64", str(12 * 1024 * 1024)))

app = FastAPI(title="musicbox-mv-facegate", version="1.0.0")

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

_app = None
_swapper = None
_lock = threading.Lock()


def _require_engine():
    global _app
    with _lock:
        if _app is None:
            try:
                from insightface.app import FaceAnalysis
                _app = FaceAnalysis(name=MODEL_NAME, root=str(MODEL_ROOT), providers=["CPUExecutionProvider"])
                _app.prepare(ctx_id=-1, det_size=(640, 640))
            except Exception as exc:
                raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: %s" % type(exc).__name__) from exc
    return _app


def _decode(value: str):
    if not value or len(value) > MAX_IMAGE_B64:
        raise HTTPException(status_code=400, detail="图片为空或过大")
    try:
        raw = base64.b64decode(value, validate=True)
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="图片编码无效") from exc
    if image is None or image.size > 4096 * 4096:
        raise HTTPException(status_code=400, detail="图片无法解码或分辨率过大")
    return image


def _reference(ref_file: str):
    if not ref_file:
        raise HTTPException(status_code=400, detail="缺少参考照")
    path = Path(ref_file).resolve()
    if not any(path == root or root in path.parents for root in ROOTS):
        raise HTTPException(status_code=403, detail="参考照路径不在允许目录")
    if not path.is_file():
        raise HTTPException(status_code=400, detail="参考照不存在")
    image = cv2.imread(str(path))
    if image is None:
        raise HTTPException(status_code=400, detail="参考照无法解码")
    return image


def _largest(engine, image):
    faces = engine.get(image)
    return max(faces, key=lambda f: float((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))) if faces else None


def _pose(face):
    kps = getattr(face, "kps", None)
    if kps is None or len(kps) < 5:
        return 0.0, 0.0
    left, right, nose, left_mouth, right_mouth = kps[:5]
    eye_mid = (left + right) / 2.0
    mouth_mid = (left_mouth + right_mouth) / 2.0
    face_height = max(1.0, float(face.bbox[3] - face.bbox[1]))
    yaw = math.degrees(math.atan2(float(nose[0] - eye_mid[0]), float(mouth_mid[1] - eye_mid[1]) + face_height * 0.2))
    pitch = math.degrees(math.atan2(float(nose[1] - eye_mid[1]), max(1.0, float(mouth_mid[0] - eye_mid[0]))))
    return round(yaw, 2), round(pitch, 2)


def score_faces(engine, image, reference):
    face, ref = _largest(engine, image), _largest(engine, reference)
    if face is None or ref is None:
        return {"score": 0.0, "yaw": None, "pitch": None, "pass": False, "face_detected": face is not None}
    score = float(np.dot(face.normed_embedding, ref.normed_embedding))
    yaw, pitch = _pose(face)
    penalty = min(0.2, (abs(yaw) + abs(pitch)) / 90.0 * 0.2)
    score = max(-1.0, min(1.0, score - penalty))
    return {"score": round(score, 4), "yaw": yaw, "pitch": pitch,
            "pass": score >= FACEGATE_GATE, "face_detected": True}


def solo_faces(engine, image):
    """无参考照即单图档（人像预检首）：即 不即 身份对照，score/pass 即 None，
    即 返回 正脸 几何 + 光照 + 遮挡 启发（预检即辅助，非门禁）。"""
    face = _largest(engine, image)
    if face is None:
        return {"score": None, "yaw": None, "pitch": None, "pass": None,
                "face_detected": False, "light": None, "occlusion": None}
    yaw, pitch = _pose(face)
    h, w = image.shape[:2]
    x1, y1 = max(0, int(face.bbox[0])), max(0, int(face.bbox[1]))
    x2, y2 = min(w, int(face.bbox[2])), min(h, int(face.bbox[3]))
    crop = image[y1:y2, x1:x2]
    light = round(float(np.mean(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY))) / 255.0, 3) if crop.size else None
    det = float(getattr(face, "det_score", 1.0) or 0.0)
    return {"score": None, "yaw": yaw, "pitch": pitch, "pass": None,
            "face_detected": True, "light": light, "occlusion": det < 0.4}


class ScoreIn(BaseModel):
    img_b64: str
    ref_file: str | None = None


class SwapIn(ScoreIn):
    gate: float = FACEGATE_GATE


@app.get("/health")
def health():
    return {"ok": True, "ready": _app is not None, "gate": FACEGATE_GATE, "scaffold": False}


@app.post("/score")
def score(req: ScoreIn, _auth: bool = Depends(_require_token)):
    engine = _require_engine()
    with _lock:
        if not req.ref_file:
            return solo_faces(engine, _decode(req.img_b64))
        return score_faces(engine, _decode(req.img_b64), _reference(req.ref_file))


@app.post("/swap")
def swap(req: SwapIn, _auth: bool = Depends(_require_token)):
    global _swapper
    engine = _require_engine()
    image, reference = _decode(req.img_b64), _reference(req.ref_file)
    ref = _largest(engine, reference)
    if ref is None:
        raise HTTPException(status_code=422, detail="参考照未检测到人脸")
    with _lock:
        if _swapper is None:
            try:
                from insightface.model_zoo import get_model
                _swapper = get_model(str(MODEL_ROOT / "inswapper_128.onnx"), providers=["CPUExecutionProvider"])
            except Exception as exc:
                raise HTTPException(status_code=503, detail="SWAP_NOT_READY: 换脸模型未就绪") from exc
        try:
            result = _swapper.get(image, ref, paste_back=True)
        except Exception as exc:
            raise HTTPException(status_code=500, detail="换脸失败: %s" % type(exc).__name__) from exc
    if result is None:
        raise HTTPException(status_code=422, detail="目标图未检测到可替换人脸")
    ok, encoded = cv2.imencode(".png", result)
    if not ok:
        raise HTTPException(status_code=500, detail="换脸结果编码失败")
    judged = score_faces(engine, result, reference)
    return {"png_b64": base64.b64encode(encoded.tobytes()).decode("ascii"), **judged}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
