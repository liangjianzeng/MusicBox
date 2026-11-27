# -*- coding: utf-8 -*-
"""
声纹投递口（2026-11-27）· 与 server.py 解耦，好单独自测

为什么要有这个东西：引擎只接受 `ref_audio` = **它自己文件系统上的绝对路径**
（`os.path.isfile()` 校验，见 server.py），而人格 WAV 存在服务端那台 Linux 机上。
跨机部署下声纹送不过去，人格克隆**从来没有成功过一次**（真机日志：
`HTTP 400 {"detail":"ref_audio not found: /tmp/mb-dev/voices/..."}`）。

规矩（都是被真机教训出来的）：
  · **不开放**：`ACE_REF_KEY` 没配就直接 503 —— 宁可可失败，不许无声无息多一个匿名写文件的门；
  · **不信客户端文件名**：落盘名一律引擎自己生成（uuid + 白名单扩展名），
    客户端给的文件名只用来挑扩展名，`../../` 之类的穿不透；
  · **有上限**：超过 25MiB 直接 413，别拿 GPU 机的磁盘换一次误操作；
  · **有到期**：ref 是中间产物，默认 48h 后由下一次投递顺手清掉，不留永久垃圾。

本模块**不 import torch / acestep**，所以能在任何机器上直接跑：
  python3 scripts/check_ace_ref_intake.py
"""

import hmac
import os
import secrets
import time
from pathlib import Path

MAX_BYTES = 25 * 1024 * 1024                      # 25 MiB：30s 单声道 44.1k WAV 约 5MB，留足余量
ALLOWED_EXT = (".wav", ".mp3", ".flac", ".m4a", ".ogg")
CONTENT_TYPE_EXT = {
    "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav",
    "audio/mpeg": ".mp3", "audio/flac": ".flac",
    "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/ogg": ".ogg",
}
DEFAULT_TTL_HOURS = 48.0


class RefError(Exception):
    """带 HTTP 状态码的拒绝。路由层原样转成 HTTPException，别退化成 200+{ok:false}。"""

    def __init__(self, status, detail):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def pick_ext(header_ext=None, content_type=None):
    """只从白名单里挑扩展名；客户端给什么名字都不直接进路径。"""
    for raw, allowed in ((header_ext, True), (content_type, False)):
        v = (raw or "").strip().lower()
        if not v:
            continue
        if allowed:
            v = v if v.startswith(".") else "." + v
            if v in ALLOWED_EXT:
                return v
        else:
            ext = CONTENT_TYPE_EXT.get(v.split(";")[0].strip())
            if ext:
                return ext
    raise RefError(415, f"unsupported audio type（给的是 {header_ext!r}/{content_type!r}；"
                        f"只认 {','.join(ALLOWED_EXT)}）")


def prune_refs(ref_dir, ttl_hours=DEFAULT_TTL_HOURS, now=None):
    """删掉过期声纹。清理失败不致命（返回计数即可），但绝不许顺手删到 refs 目录之外。"""
    ref_dir = Path(ref_dir)
    if not ref_dir.is_dir():
        return 0
    cutoff = (now if now is not None else time.time()) - float(ttl_hours) * 3600.0
    removed = 0
    for p in ref_dir.iterdir():
        try:
            if not p.is_file():
                continue
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError:
            continue                      # 单个文件清不掉不该让整次投递失败
    return removed


def store_ref(body, *, key, ref_dir, header_ext=None, content_type=None,
              max_bytes=MAX_BYTES, ttl_hours=DEFAULT_TTL_HOURS, now=None):
    """
    收一次声纹。成功返回 {id, path, bytes, ext, pruned}，其中 path 是**引擎本机绝对路径**，
    正是 /music 要的 `ref_audio` 值。任何一条规矩不满足都抛 RefError（带状态码）。
    """
    configured = os.environ.get("ACE_REF_KEY", "")
    if not configured:
        raise RefError(503, "ref intake disabled（引擎未设 ACE_REF_KEY，宁可不给写也不开匿名门）")
    if not isinstance(key, str) or not key:
        raise RefError(401, "missing x-mb-ref-key")
    if not hmac.compare_digest(key, configured):      # 定时比较，不给计时侧信道留口子
        raise RefError(401, "bad x-mb-ref-key")
    if body is None or len(body) == 0:
        raise RefError(400, "empty body")
    if len(body) > max_bytes:
        raise RefError(413, f"too large：{len(body)} > {max_bytes} 字节")

    ext = pick_ext(header_ext, content_type)
    ref_dir = Path(ref_dir)
    ref_dir.mkdir(parents=True, exist_ok=True)
    ref_id = secrets.token_hex(10)
    final = ref_dir / f"{ref_id}{ext}"
    tmp = ref_dir / f".{ref_id}{ext}.part"
    try:
        tmp.write_bytes(body)
        os.replace(tmp, final)                        # 原子落盘：不会出现半截 wav 被 isfile 放行
    except OSError as e:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise RefError(500, f"write failed: {type(e).__name__}: {e}")

    return {
        "id": ref_id,
        "path": str(final.resolve()),
        "bytes": len(body),
        "ext": ext,
        "pruned": prune_refs(ref_dir, ttl_hours, now=now),
    }
