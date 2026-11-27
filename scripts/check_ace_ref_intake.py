# -*- coding: utf-8 -*-
"""
ref_intake 的自测（判词）。跑法：python3 scripts/check_ace_ref_intake.py
不 import torch/acestep，任何机器都能跑；闸门里的 node 判词会 spawn 本脚本，红即入仓失败。

为什么要有：声纹投递口是"引擎能读到声纹"的唯一出路，而它同时是个**能往 GPU 机写文件**的口子。
这种代码不许靠肉眼 Review —— 鉴权、上限、类型白名单、防穿越、到期清理，每条都得真跑一遍。
"""

import os
import sys
import time
import tempfile
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "services" / "acestep"))

from ref_intake import RefError, store_ref, pick_ext, prune_refs, MAX_BYTES  # noqa: E402

FAILED = []


def check(name, fn):
    try:
        fn()
        print("  ✓", name)
    except AssertionError as e:
        FAILED.append(name)
        print("  ✗", name, "→", e)
    except Exception as e:  # 意外异常也算红：判词不许被异常吞掉
        FAILED.append(name)
        print("  ✗", name, f"→ 意外 {type(e).__name__}: {e}")


def expect_status(status, fn, what):
    try:
        fn()
    except RefError as e:
        assert e.status == status, f"{what}：期望 {status}，实际 {e.status}（{e.detail}）"
        return e
    raise AssertionError(f"{what}：应当被拒（{status}），却通过了")


def main():
    tmp = Path(tempfile.mkdtemp(prefix="ace_ref_check_"))
    os.environ["ACE_REF_KEY"] = "s3cret-check-key"
    wav = b"RIFF" + b"\x00" * 40 + b"data" + b"\xf7" * 512

    print("ref_intake 自测：")

    def no_key_no_open_door():
        saved = os.environ.pop("ACE_REF_KEY")
        try:
            expect_status(503, lambda: store_ref(wav, key="s3cret-check-key", ref_dir=tmp),
                          "没配 ACE_REF_KEY")
            assert list(tmp.glob("*.wav")) == [], "匿名门没关严：居然落盘了文件"
        finally:
            os.environ["ACE_REF_KEY"] = saved
    check("没配 ACE_REF_KEY → 503 且一个字节都不落盘（宁可可失败，不开匿名门）", no_key_no_open_door)

    check("缺 key → 401", lambda: expect_status(
        401, lambda: store_ref(wav, key="", ref_dir=tmp), "缺 key"))
    check("错 key → 401", lambda: expect_status(
        401, lambda: store_ref(wav, key="wrong", ref_dir=tmp), "错 key"))
    check("空 body → 400", lambda: expect_status(
        400, lambda: store_ref(b"", key="s3cret-check-key", ref_dir=tmp), "空 body"))
    check("超限 → 413（且不留半截文件）", lambda: (
        expect_status(413, lambda: store_ref(b"\x00" * (MAX_BYTES + 1), key="s3cret-check-key",
                                             ref_dir=tmp, header_ext="wav"), "超限"),
        assert_unchanged(tmp)))
    check("类型不在白名单 → 415", lambda: expect_status(
        415, lambda: store_ref(wav, key="s3cret-check-key", ref_dir=tmp,
                               header_ext="exe", content_type="application/octet-stream"), "坏类型"))
    check("content-type 兜底认 wav", lambda: (
        lambda r: None)(store_ref(wav, key="s3cret-check-key", ref_dir=tmp,
                                  content_type="audio/x-wav; charset=binary")))

    def ok_shape():
        r = store_ref(wav, key="s3cret-check-key", ref_dir=tmp, header_ext="WAV")
        p = Path(r["path"])
        assert p.is_file(), f"返回的 path 必须真实存在（/music 只认 isfile）：{r}"
        assert p.read_bytes() == wav, "落盘字节必须与投递一致"
        assert r["bytes"] == len(wav) and r["ext"] == ".wav", r
        assert p.parent == tmp.resolve() or p.parent == tmp, f"必须落在 refs 目录内：{p}"
        stem = p.name[: -len(".wav")]
        assert len(stem) == 20 and all(c in "0123456789abcdef" for c in stem), \
            f"落盘名必须是引擎自己生成的 hex，实际 {p.name}"
        assert r["pruned"] >= 0
    check("正常投递 → 返回引擎本机绝对路径，名字由引擎生成", ok_shape)

    def traversal_proof():
        # 这个模块**压根没有"文件名"入参** —— 客户端能影响的只有扩展名。
        # 所以防穿越要测的是：把穿越样式从唯一的入口（header_ext）夹带进来时，
        # 必须**拒绝**而不是采信；而合法扩展名时落盘路径必须锁死在 refs 目录内。
        for evil in ("../../../Windows/system32/evil.wav", "wav/../../../x", ".wav; rm -rf /",
                     "%2e%2e%2f.wav", "wav\u0000.txt"):
            try:
                store_ref(wav, key="s3cret-check-key", ref_dir=tmp, header_ext=evil)
                raise AssertionError(f"夹带穿越样式竟然被采信：{evil!r}")
            except RefError as e:
                assert e.status == 415, f"{evil!r} 应以 415 拒绝，实际 {e.status}"
        r = store_ref(wav, key="s3cret-check-key", ref_dir=tmp, header_ext="wav")
        p = Path(r["path"])
        assert p.parent == tmp.resolve() or p.parent == tmp, f"逃出 refs 目录：{p}"
        assert ".." not in p.name and "/" not in p.name and "\\" not in p.name, p.name
        assert not Path("C:/Windows/system32/evil.wav").exists(), "系统目录被写入了"
        assert not [q for q in tmp.iterdir() if q.name.startswith(".")], "藏了隐藏文件"
    check("唯一入口只能给扩展名：夹带穿越样式一律 415，合法时锁死在 refs 内", traversal_proof)

    def ttl_prune():
        d = tmp / "prune"
        d.mkdir(parents=True, exist_ok=True)
        old = d / ("a" * 20 + ".wav")
        old.write_bytes(b"old")
        fresh = d / ("b" * 20 + ".wav")
        fresh.write_bytes(b"new")
        ancient = time.time() - 100 * 3600.0
        os.utime(old, (ancient, ancient))
        removed = prune_refs(d, ttl_hours=48.0)
        assert removed == 1, f"应清掉 1 个过期，实际 {removed}"
        assert not old.exists() and fresh.exists(), "清理删错了对象"
        # 目录外的东西不许被顺手删
        outside = tmp / "keepme.wav"
        outside.write_bytes(b"keep")
        os.utime(outside, (ancient, ancient))
        prune_refs(d, ttl_hours=48.0)
        assert outside.exists(), "越界删除：refs 目录之外的文件被删了"
    check("到期清理只清 refs 内的过期件，不越界", ttl_prune)

    def pick_ext_rules():
        assert pick_ext("mp3", None) == ".mp3"
        assert pick_ext(None, "audio/flac") == ".flac"
        assert pick_ext("wav", "application/octet-stream") == ".wav"
        for bad in ("", "exe", "php", None):
            try:
                pick_ext(bad, "text/html")
                raise AssertionError(f"坏类型 {bad!r} 竟然放行")
            except RefError as e:
                assert e.status == 415
    check("扩展名只从白名单里挑，白名单外一律 415", pick_ext_rules)

    def no_part_leftovers():
        before = set(p.name for p in tmp.iterdir() if p.is_file())
        try:
            store_ref(b"\x00" * (MAX_BYTES + 1), key="s3cret-check-key", ref_dir=tmp,
                      header_ext="wav")
        except RefError:
            pass
        after = set(p.name for p in tmp.iterdir() if p.is_file())
        assert before == after, f"失败投递留下了残file：{after - before}"
        assert not [p for p in tmp.glob("*.part")], "残留 .part 会让 isfile 放行半截文件"
    check("被拒的投递不留 .part / 残file（原子落盘）", no_part_leftovers)

    shutil.rmtree(tmp, ignore_errors=True)
    if FAILED:
        print(f"\n✗ ref_intake 自测失败 {len(FAILED)} 条：{'；'.join(FAILED)}")
        return 1
    print("\n✓ ref_intake 自测全过")
    return 0


def assert_unchanged(tmp):
    assert not [p for p in tmp.glob("*.part")], "超限投递留下了 .part"


if __name__ == "__main__":
    sys.exit(main())
