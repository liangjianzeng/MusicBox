import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

PORT = int(os.environ.get("MB_LIPSYNC_PORT", "8390"))
ROOTS = [Path(p).resolve() for p in os.environ.get(
    "MB_LIPSYNC_ROOTS", "/opt/musicbox/var,E:/Work/MusicBox/var"
).split(",") if p.strip()]
TIMEOUT_SEC = int(os.environ.get("MB_LIPSYNC_TIMEOUT_SEC", "1800"))
MAX_INPUT_BYTES = int(os.environ.get("MB_LIPSYNC_MAX_INPUT_BYTES", str(300 * 1024 * 1024)))

app = FastAPI(title="musicbox-mv-lipsync", version="1.0.0")
_lock = threading.Lock()


def _command_env(name):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("%s 必须是 JSON 数组" % name) from exc
    if not isinstance(value, list) or not value or not all(isinstance(x, str) for x in value):
        raise RuntimeError("%s 必须是非空字符串数组" % name)
    return value


def runtime_configured():
    try:
        return _command_env("MB_LIPSYNC_COMMAND") is not None
    except RuntimeError:
        return False


def local_file(value: str, max_bytes=MAX_INPUT_BYTES) -> Path:
    path = Path(value).resolve()
    if not any(path == root or root in path.parents for root in ROOTS):
        raise HTTPException(status_code=403, detail="文件路径不在允许目录")
    if not path.is_file():
        raise HTTPException(status_code=400, detail="输入文件不存在")
    if path.stat().st_size > max_bytes:
        raise HTTPException(status_code=400, detail="输入文件过大")
    return path


def output_file(value: str) -> Path:
    path = Path(value).resolve()
    if not any(path == root or root in path.parents for root in ROOTS):
        raise HTTPException(status_code=403, detail="输出路径不在允许目录")
    if path.suffix.lower() not in {".mp4", ".mov", ".webm"}:
        raise HTTPException(status_code=400, detail="输出必须是视频文件")
    return path


def render_command(template, video, audio, output, text, score_file):
    values = {"video": str(video), "audio": str(audio), "output": str(output),
              "text": text, "score_file": str(score_file)}
    return [part.format(**values) for part in template]


def parse_score(path: Path):
    try:
        value = float(path.read_text(encoding="utf-8").strip().splitlines()[0])
    except (OSError, ValueError, IndexError):
        return None
    return value if 0.0 <= value <= 1.0 else None


class LipsyncReq(BaseModel):
    video: str
    audio: str
    text: str = ""


@app.get("/health")
def health():
    return {"ok": True, "engine": "echomimic_v3_flash", "configured": runtime_configured(),
            "loaded": False, "scaffold": False}


@app.post("/lipsync")
def lipsync(req: LipsyncReq):
    template = _command_env("MB_LIPSYNC_COMMAND")
    if template is None:
        raise HTTPException(status_code=503, detail="ENGINE_NOT_READY: 未配置口型推理命令")
    video = local_file(req.video)
    audio = local_file(req.audio, 20 * 1024 * 1024)
    root = ROOTS[0]
    with tempfile.TemporaryDirectory(prefix="mv-lipsync-", dir=root) as temp:
        output = output_file(str(Path(temp) / "synced.mp4"))
        score_file = Path(temp) / "sync_score.txt"
        score_template = _command_env("MB_LIPSYNC_SYNC_COMMAND")
        try:
            args = render_command(template, video, audio, output, req.text[:2000], score_file)
            with _lock:
                result = subprocess.run(args, capture_output=True, text=True, timeout=TIMEOUT_SEC,
                                        check=False, shell=False)
            if result.returncode != 0:
                raise HTTPException(status_code=500, detail="口型推理失败: %s" % (result.stderr or result.stdout)[-500:])
            if not output.is_file() or output.stat().st_size < 1024:
                raise HTTPException(status_code=500, detail="口型推理未产出有效视频")
            with output.open("rb") as produced:
                header = produced.read(12)
            if not (header[4:8] == b"ftyp" or header[:4] == b"\x1aE\xdf\xa3"):
                raise HTTPException(status_code=500, detail="口型推理产物不是有效视频容器")
            fd, name = tempfile.mkstemp(prefix="lipsync-", suffix=".mp4", dir=root)
            os.close(fd)
            target = Path(name)
            try:
                output.replace(target)
                if score_template:
                    sync_args = render_command(score_template, target, audio, target, req.text[:2000], score_file)
                    with _lock:
                        checked = subprocess.run(sync_args, capture_output=True, text=True, timeout=300,
                                                 check=False, shell=False)
                    if checked.returncode != 0:
                        target.unlink(missing_ok=True)
                        raise HTTPException(status_code=500, detail="口型质量评分失败")
                return {"file": str(target), "sync_score": parse_score(score_file), "worker": "external-runtime"}
            except Exception:
                target.unlink(missing_ok=True)
                raise
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail="口型推理超时") from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail="口型服务异常: %s" % type(exc).__name__) from exc


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT)
