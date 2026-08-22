import importlib.util
import unittest
from pathlib import Path


PIPELINE_PATH = Path(__file__).parents[2] / "runtime" / "python" / "pipeline.py"
SPEC = importlib.util.spec_from_file_location("bilibili_skill_asr_pipeline", PIPELINE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载 pipeline.py: {PIPELINE_PATH}")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class PipelineContractTest(unittest.TestCase):
    def test_empty_segments_are_missing(self):
        status, complete = PIPELINE.classify_normalized_segments([], [])
        self.assertEqual(status, "missing")
        self.assertFalse(complete)

    def test_single_normal_segment_is_complete(self):
        status, complete = PIPELINE.classify_normalized_segments(
            [{"startSeconds": 1.25, "endSeconds": 4.5, "text": "正文"}],
            [],
        )
        self.assertEqual(status, "success")
        self.assertTrue(complete)

    def test_zero_time_fallback_is_partial(self):
        status, complete = PIPELINE.classify_normalized_segments(
            [{"startSeconds": 0, "endSeconds": 0, "text": "整段正文"}],
            ["asr_vad_no_segments_detected: fallback"],
        )
        self.assertEqual(status, "partial")
        self.assertFalse(complete)

    def test_filtered_short_segments_are_partial(self):
        status, complete = PIPELINE.classify_normalized_segments(
            [{"startSeconds": 2, "endSeconds": 5, "text": "正文"}],
            ["asr_vad_filtered_short_segments: 过滤 1 段"],
        )
        self.assertEqual(status, "partial")
        self.assertFalse(complete)


if __name__ == "__main__":
    unittest.main()
