import json
from pathlib import Path
import tempfile
import unittest

from summarize import summarize


def summarize_frames(provider, variant, frames):
    with tempfile.TemporaryDirectory() as tmp:
        directory = Path(tmp)
        (directory / "result.json").write_text(json.dumps({"provider": provider, "variant": variant}))
        (directory / "frames.jsonl").write_text("".join(json.dumps(frame) + "\n" for frame in frames))
        return summarize(directory)


class ProtocolCountersTest(unittest.TestCase):
    def test_managed_handles_are_observations_between_protocol_frames(self):
        frames = [
            {"type": "managed_model_references", "data": ["o1"]},
            {"type": "frame", "data": {"method": "thread/tokenUsage/updated", "params": {
                "tokenUsage": {"total": {"inputTokens": 80, "cachedInputTokens": 30}, "last": {"inputTokens": 80}}
            }}},
        ]
        for variant in ("managed-handles", "code-mode-managed-handles"):
            with self.subTest(variant=variant):
                report = summarize_frames("codex", variant, frames)
                self.assertEqual((report["calls"], report["first"], report["uncached"]), (1, 80, 50))

    def test_acp_peak_and_totals_do_not_imply_request_counters(self):
        frames = [
            {"type": "frame", "data": {"method": "session/update", "params": {
                "update": {"sessionUpdate": "usage_update", "used": 75}
            }}},
            {"type": "frame", "data": {"result": {"usage": {"inputTokens": 70, "cachedReadTokens": 30}}}},
        ]
        report = summarize_frames("agy", "raw", frames)
        self.assertEqual((report["peak"], report["cached"], report["uncached"]), (75, 30, 70))
        self.assertIsNone(report["first"])
        self.assertIsNone(report["calls"])
