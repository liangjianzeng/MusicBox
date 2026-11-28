import json
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import threading

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


PORT = int(os.environ.get("MB_LIPSYNC_PORT", "8390"))
ROOTS = [Path(p).resolve() for p in os.environ.get(
    "MB_LIPSYNC_ROOTS", _default_roots()
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


def command_ready():
    """配了命令模板 **且首项真的能执行** 才算就绪。

    只看"配没配"会漏掉最坑的一类：模板写了、二进制没装/路径错了，于是派单一路跑到
    /lipsync 才 500。健康口提前把它说清，闸门就不会拿着"已配置"的假信号放行。
    """
    try:
        template = _command_env("MB_LIPSYNC_COMMAND")
    except RuntimeError:
        return False
    if not template:
        return False
    exe = template[0]
    return bool(shutil.which(exe)) or Path(exe).is_file()


def score_configured():
    try:
        return _command_env("MB_LIPSYNC_SYNC_COMMAND") is not None
    except RuntimeError:
        return False


def weights_root() -> Path:
    """权重落盘位：与 deploy/spark/mv-lipsync.service 的 MODELSCOPE_CACHE 同源。"""
    return Path(os.environ.get("MODELSCOPE_CACHE") or (Path.home() / "MusicBox" / "var" / "models")).resolve()


WEIGHT_SUFFIXES = {".safetensors", ".bin", ".pth", ".pt", ".onnx"}


def weights_present() -> bool:
    """权重目录里有没有**非空**权重文件（递归找，ModelScope 缓存带模型 id 目录层）。

    语义边界要写死在话里：这只证明"下载完整"，不做前向校验 —— 所以真机判词（V14/V15）
    仍然必须真跑一次 /lipsync 才算过，不许拿这个字段当"引擎可用"的通行证。
    引擎无关：本 worker 是外部运行时适配（EchoMimicV3-Flash / MuseTalk / LatentSync 都能
    通过 MB_LIPSYNC_COMMAND 接进来），所以不硬编码某一家的权重文件名。
    """
    root = weights_root()
    if not root.is_dir():
        return False
    try:
        return any(p.is_file() and p.suffix.lower() in WEIGHT_SUFFIXES and p.stat().st_size > 0
                   for p in root.rglob("*"))
    except OSError:
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


@app.get("/healthz")
@app.get("/health")
def health():
    """能力如实上报。

    2026-11-28 现场：这里原本只有 `/health`，且把 `loaded` **硬编码成 False**。
    而真机判词 V14/V15 探的是 `/healthz` + `weights_loaded`（与 mv_asr/sensevoice 的
    路由约定一致）——路由名和字段名两头对不上，探针恒缺，于是 15 条真机用例无论装没装
    权重都以 skip 呈现：闸门看起来全绿，MV 真机侧一次都没跑过。
    现在两套路由都挂同一个处理器，字段如实反映"权重在位/命令可执行/评分已配"。
    """
    return {"ok": True, "engine": "echomimic_v3_flash",
            "weights_loaded": weights_present(), "weights_dir": str(weights_root()),
            "configured": runtime_configured(), "command_ready": command_ready(),
            "score_configured": score_configured(), "loaded": command_ready() and weights_present(),
            "scaffold": False}


@app.post("/lipsync")
def lipsync(req: LipsyncReq, _auth: bool = Depends(_require_token)):
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
