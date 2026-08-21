#!/usr/bin/env python3
"""
原型 02: ffmpeg 抽 16kHz mono wav (FunASR 输入格式)

FunASR SenseVoice-Small 内部会做 16kHz 重采样, 这里抽 wav 是为了:
  1. 统一入口 (无论 yt-dlp 给 m4a / m4s / 别的容器)
  2. wav 无压缩,后续步骤无解码开销
  3. 16kHz mono 是 ASR 模型标准输入, 减少运行时重采样误差

用法:
  python3 scripts/subtitle/asr/audio-extract.py <input.m4a>

输出: <input_stem>.wav (同目录)
"""
import subprocess
import sys
from pathlib import Path


def extract(input_path: Path) -> Path:
    """抽 16kHz mono wav"""
    if not input_path.exists():
        print(f"[02] 输入不存在: {input_path}", file=sys.stderr)
        sys.exit(1)

    output_path = input_path.with_suffix(".wav")
    if output_path.exists():
        print(f"[02] 已存在: {output_path} (跳过抽取)", file=sys.stderr)
        return output_path

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(input_path),
        "-ar", "16000",  # 16kHz
        "-ac", "1",       # mono
        "-f", "wav",
        str(output_path),
    ]
    print(f"[02] ffmpeg 抽 16kHz mono wav: {input_path.name} -> {output_path.name}", file=sys.stderr)
    subprocess.run(cmd, check=True)

    # 验证输出
    probe = subprocess.run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration,bit_rate",
        "-of", "default=noprint_wrappers=1",
        str(output_path),
    ], capture_output=True, text=True, check=True)
    print(f"[02] 完成: {output_path} ({output_path.stat().st_size:,} bytes)", file=sys.stderr)
    print(f"[02] {probe.stdout.strip()}", file=sys.stderr)
    return output_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 scripts/prototype/02_extract.py <input.m4a>", file=sys.stderr)
        sys.exit(1)
    extract(Path(sys.argv[1]))
