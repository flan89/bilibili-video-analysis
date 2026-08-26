import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


AUDIO_DOWNLOAD_PATH = (
    Path(__file__).parents[2] / "runtime" / "python" / "audio-download.py"
)
SPEC = importlib.util.spec_from_file_location(
    "bilibili_skill_audio_download",
    AUDIO_DOWNLOAD_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载 audio-download.py: {AUDIO_DOWNLOAD_PATH}")
AUDIO_DOWNLOAD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIO_DOWNLOAD)


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback):
        return False

    def read(self):
        return b"fake-m4s"


class AudioDownloadTest(unittest.TestCase):
    def test_download_creates_missing_parent_directory(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_path = (
                Path(temporary_directory)
                / "data"
                / "raw"
                / "BV1test_123.c_audio.m4s"
            )
            with patch.object(
                AUDIO_DOWNLOAD.urllib.request,
                "urlopen",
                return_value=FakeResponse(),
            ):
                AUDIO_DOWNLOAD.download_m4s("https://example.com/audio.m4s", output_path)

            self.assertEqual(output_path.read_bytes(), b"fake-m4s")


if __name__ == "__main__":
    unittest.main()
