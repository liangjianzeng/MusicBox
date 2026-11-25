import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[2]
WORKERS = ROOT / "src" / "workers"


def load_worker(name):
    spec = importlib.util.spec_from_file_location(name, WORKERS / name / "app.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


asr = load_worker("mv_asr")
lipsync = load_worker("mv_lipsync")

try:
    import cv2  # noqa: F401
except ImportError:
    cv2_stub = types.ModuleType("cv2")
    cv2_stub.IMREAD_COLOR = 1
    cv2_stub.imread = lambda path: None
    cv2_stub.imdecode = lambda buf, mode: None
    cv2_stub.imencode = lambda ext, image: (False, None)
    sys.modules["cv2"] = cv2_stub
facegate = load_worker("mv_facegate")


class AsrTests(unittest.TestCase):
    def test_segments_parse_milliseconds_and_strip_tags(self):
        parsed = asr.parse_segments({"sentence_info": [
            {"text": "<|HAPPY|>第二句", "start": 500000, "end": 620500},
            {"text": "<|BGM|>", "start": 0, "end": 1000},
            {"line": "第一句", "start_sec": 1.25, "end_sec": 2.5},
        ]})
        self.assertEqual(parsed, [
            {"text": "第一句", "start": 1.25, "end": 2.5},
            {"text": "第二句", "start": 500.0, "end": 620.5},
        ])

    def test_path_allowlist_and_size_limit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            audio = root / "voice.wav"
            with wave.open(str(audio), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(8000)
                w.writeframes(b"\0\0" * 8000)
            with patch.object(asr, "ROOTS", [root.resolve()]), patch.object(asr, "MAX_AUDIO_BYTES", 1024 * 1024):
                self.assertEqual(asr.local_file(str(audio)), audio.resolve())
                self.assertEqual(asr._duration(audio), 1.0)
                with self.assertRaises(HTTPException) as denied:
                    asr.local_file(str(ROOT / "outside.wav"))
                self.assertEqual(denied.exception.status_code, 403)
                with patch.object(asr, "MAX_AUDIO_BYTES", 10):
                    with self.assertRaises(HTTPException) as large:
                        asr.local_file(str(audio))
                    self.assertEqual(large.exception.status_code, 400)

    def test_transcribe_contract_with_fake_model(self):
        class Model:
            def generate(self, **kwargs):
                self.kwargs = kwargs
                return [{"text": "<|NEUTRAL|>你好<|HAPPY|>", "sentence_info": [
                    {"text": "你好", "start": 0, "end": 1200},
                ]}]

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            audio = root / "voice.wav"
            audio.write_bytes(b"RIFFtest")
            model = Model()
            with patch.object(asr, "ROOTS", [root.resolve()]), patch.object(asr, "_model", model):
                result = asr.asr(asr.AsrReq(path=str(audio), timestamp=True))
            self.assertEqual(result["text"], "你好")
            self.assertEqual(result["emotion"], "happy")
            self.assertEqual(result["segments"], [{"text": "你好", "start": 0.0, "end": 1.2}])
            self.assertTrue(model.kwargs["sentence_timestamp"])


class FacegateTests(unittest.TestCase):
    def test_reference_allowlist(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(facegate, "ROOTS", [root.resolve()]):
                with self.assertRaises(HTTPException) as denied:
                    facegate._reference(str(ROOT / "outside.png"))
                self.assertEqual(denied.exception.status_code, 403)

    def test_missing_face_is_an_honest_fail(self):
        class Engine:
            def get(self, image):
                return []

        result = facegate.score_faces(Engine(), object(), object())
        self.assertEqual(result, {"score": 0.0, "yaw": None, "pitch": None, "pass": False, "face_detected": False})

    def test_invalid_base64_rejected(self):
        with self.assertRaises(HTTPException) as invalid:
            facegate._decode("not base64!")
        self.assertEqual(invalid.exception.status_code, 400)

    def test_swap_uses_executor_img_field(self):
        self.assertIn("img_b64", facegate.SwapIn.model_fields)


class LipsyncTests(unittest.TestCase):
    def test_command_is_argv_without_shell(self):
        command = ["runner", "--video", "{video}", "--text", "{text}", "--output", "{output}"]
        rendered = lipsync.render_command(command, "a b.mp4", "a.wav", "out.mp4", "你好; rm -rf x", "score.txt")
        self.assertEqual(rendered[2], "a b.mp4")
        self.assertEqual(rendered[4], "你好; rm -rf x")
        self.assertNotIn("shell", rendered)

    def test_paths_and_score_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            video = root / "in.mp4"
            video.write_bytes(b"x")
            score = root / "score.txt"
            with patch.object(lipsync, "ROOTS", [root.resolve()]):
                self.assertEqual(lipsync.local_file(str(video)), video.resolve())
                self.assertEqual(lipsync.output_file(str(root / "out.mp4")), root / "out.mp4")
                with self.assertRaises(HTTPException):
                    lipsync.output_file(str(root / "out.txt"))
                with self.assertRaises(HTTPException):
                    lipsync.local_file(str(ROOT / "outside.mp4"))
            for value, expected in [("0.75\n", 0.75), ("1.2", None), ("bad", None), ("", None)]:
                score.write_text(value, encoding="utf-8")
                self.assertEqual(lipsync.parse_score(score), expected)

    def test_unconfigured_runtime_is_not_ready(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(HTTPException) as missing:
                lipsync.lipsync(lipsync.LipsyncReq(video="a", audio="b"))
            self.assertEqual(missing.exception.status_code, 503)

    def test_external_runtime_produces_verified_mp4(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            video = root / "in.mp4"
            audio = root / "in.wav"
            video.write_bytes(b"input")
            audio.write_bytes(b"input")
            writer = "from pathlib import Path; import sys; p=Path(sys.argv[1]); p.write_bytes(b'\\0\\0\\0\\x18ftypisom'+b'x'*1100)"
            env = {"MB_LIPSYNC_COMMAND": json.dumps([sys.executable, "-c", writer, "{output}"])}
            with patch.object(lipsync, "ROOTS", [root.resolve()]), patch.dict(os.environ, env, clear=True):
                result = lipsync.lipsync(lipsync.LipsyncReq(video=str(video), audio=str(audio), text="你好"))
            output = Path(result["file"])
            try:
                self.assertGreater(output.stat().st_size, 1024)
                self.assertEqual(output.read_bytes()[4:8], b"ftyp")
                self.assertEqual(result["worker"], "external-runtime")
            finally:
                output.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
