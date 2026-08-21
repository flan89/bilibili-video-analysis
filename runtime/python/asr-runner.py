#!/usr/bin/env python3
"""
原型 03: VAD 切段 + SenseVoice 转写 (解耦版, 强制带时间戳)

funasr 1.4.2 中 SenseVoiceSmall + VAD 合并输出不稳定 (sentence_info 时有时无),
因此拆成两步: VAD 单独拿时间戳, 按段切 wav, 每段单独跑 SenseVoice.

模型:
  - vad_model: fsmn-vad (纯 VAD, 稳定返回 value: [[start_ms, end_ms], ...])
  - asr_model: iic/SenseVoiceSmall (每段单独跑, 给出该段 text + tags)

输出: <input_stem>.asr.json
  [{
    key: "video_id",
    segments: [
      { from_ms, to_ms, text: "<|en|><|EMO_UNKNOWN|><|Speech|>..." },
      ...
    ]
  }]

用法:
  python3 scripts/subtitle/asr/asr-runner.py <input.wav> [language]
  language: auto | zh | en | yue | ja | ko (默认 auto)
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def required_model_path(env_name: str) -> str:
    """模型只能由 setup 准备，Tool 运行时不允许隐式联网下载。"""
    value = os.environ.get(env_name)
    if not value or not Path(value).exists():
        raise RuntimeError(f"缺少已准备模型路径: {env_name}")
    return value


def run_vad(wav_path: Path) -> tuple[list[list[int]], int]:
    """跑 fsmn-vad 拿语音段 [start_ms, end_ms].
    返回 (kept_segments, filtered_count) 元组, 让 transcribe 能记录
    被 < 1s 过滤掉的段数, 透传给 Agent. 旧版静默丢数据是 GPT 提的 B3 必修项."""
    from funasr import AutoModel

    print(f"[03/VAD] 加载 fsmn-vad 模型...", file=sys.stderr)
    vad_model = AutoModel(
        model=required_model_path("BILIBILI_SKILL_VAD_MODEL_DIR"),
        disable_update=True,
    )
    print(f"[03/VAD] 跑 VAD: {wav_path.name}", file=sys.stderr)
    res = vad_model.generate(
        input=str(wav_path),
        cache={},
        max_single_segment_time=30000,
    )
    if not res or "value" not in res[0]:
        return [], 0
    raw_segments = res[0]["value"]
    # 过滤: 至少 1s. 记录被过滤数, 不再静默丢数据.
    kept = [seg for seg in raw_segments if seg[1] - seg[0] >= 1000]
    filtered_count = len(raw_segments) - len(kept)
    return kept, filtered_count


def cut_wav_segment(wav_path: Path, start_ms: int, end_ms: int, output_path: Path) -> None:
    """用 ffmpeg 切 wav 段"""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(wav_path),
        "-ss", str(start_ms / 1000.0),
        "-to", str(end_ms / 1000.0),
        "-ar", "16000", "-ac", "1", "-f", "wav",
        str(output_path),
    ]
    subprocess.run(cmd, check=True)


def run_sensevoice(seg_path: Path, language: str = "auto") -> str:
    """跑 SenseVoice 转写一段 wav, 返回 text (含 tags)"""
    from funasr import AutoModel

    # 延迟加载 (VAD 模型已经占了内存, 复用同一个进程避免重复加载)
    if not hasattr(run_sensevoice, "_model"):
        print(f"[03/ASR] 加载 SenseVoice-Small 模型...", file=sys.stderr)
        run_sensevoice._model = AutoModel(
            model=required_model_path("BILIBILI_SKILL_SENSEVOICE_MODEL_DIR"),
            disable_update=True,
        )
    model = run_sensevoice._model
    res = model.generate(
        input=str(seg_path),
        language=language,
        use_itn=True,
    )
    if isinstance(res, list) and res:
        return res[0].get("text", "")
    return ""


def transcribe(input_path: Path, language: str = "auto") -> Path:
    if not input_path.exists():
        print(f"[03] 输入不存在: {input_path}", file=sys.stderr)
        sys.exit(1)

    output_path = input_path.with_suffix(".asr.json")
    # warning 收集到独立 JSON 文件, pipeline.py 读它收集到 acquisition.warnings
    # 透传给 TS Agent 看到 (Python 内部状态对 Agent 不可见的旧问题)
    warnings_path = input_path.with_suffix(".asr.warnings.json")
    collected_warnings: list[str] = []

    if output_path.exists():
        print(f"[03] 已存在: {output_path} (跳过转写)", file=sys.stderr)
        return output_path

    t0 = time.time()

    # Step 1: VAD 切段
    vad_segments, filtered_count = run_vad(input_path)
    print(f"[03/VAD] 切出 {len(vad_segments)} 段", file=sys.stderr)
    if filtered_count > 0:
        # 短于 1s 的 VAD 段不再静默丢弃, 记录到 warning
        collected_warnings.append(
            f"asr_vad_filtered_short_segments: VAD 检测到 {len(vad_segments) + filtered_count} 段,"
            f" {filtered_count} 段因 < 1s 被过滤 (可能包含短但关键的词如'对'/'不'/'99'/'GPT' 等)"
        )
    if not vad_segments:
        # 无 VAD 段, fallback: 整段跑 ASR 无时间戳
        # 显式 warning, 让 TS Agent 知道时间锚点全在 00:00
        text = run_sensevoice(input_path, language)
        result = [{"key": input_path.stem, "segments": [{
            "from_ms": 0, "to_ms": 0, "text": text,
        }]}]
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        collected_warnings.append(
            "asr_vad_no_segments_detected: VAD 未找到任何 ≥1s 语音段, fallback 到整段 ASR,"
            " 产出 from=0,to=0 假段, 时间锚点全在 00:00 不可信",
        )
        _write_warnings(warnings_path, collected_warnings)
        print(f"[03] 完成 (无 VAD): {output_path}", file=sys.stderr)
        return output_path

    # Step 2: 每段单独 ASR
    tmp_dir = input_path.parent / ".tmp_vad_segments"
    tmp_dir.mkdir(exist_ok=True)
    segments_out = []
    filtered_out_count = 0  # 记录 VAD 过滤掉的段数
    for i, (start_ms, end_ms) in enumerate(vad_segments):
        seg_path = tmp_dir / f"{input_path.stem}_seg{i:03d}.wav"
        cut_wav_segment(input_path, start_ms, end_ms, seg_path)
        text = run_sensevoice(seg_path, language)
        segments_out.append({
            "from_ms": start_ms,
            "to_ms": end_ms,
            "text": text,
        })
        print(f"[03/ASR] 段 {i+1}/{len(vad_segments)}: [{start_ms/1000:.1f}s-{end_ms/1000:.1f}s] {text[:60]}{'...' if len(text)>60 else ''}", file=sys.stderr)

    # Step 3: 清理临时文件
    for f in tmp_dir.iterdir():
        f.unlink()
    tmp_dir.rmdir()

    result = [{"key": input_path.stem, "segments": segments_out}]
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 把 collected_warnings 写到独立 JSON 文件, pipeline.py 透传给 TS.
    _write_warnings(warnings_path, collected_warnings)

    elapsed = time.time() - t0
    print(f"[03] 完成: {output_path}", file=sys.stderr)
    print(f"[03]   - segments: {len(segments_out)}", file=sys.stderr)
    print(f"[03]   - 总耗时: {elapsed:.1f}s", file=sys.stderr)
    return output_path


def _write_warnings(path: Path, warnings: list[str]) -> None:
    """把内部 warning 收集到独立 JSON, pipeline.py 透传给 TS."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"warnings": warnings}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python3 scripts/prototype/03_asr.py <input.wav> [language]", file=sys.stderr)
        sys.exit(1)
    lang = sys.argv[2] if len(sys.argv) > 2 else "auto"
    transcribe(Path(sys.argv[1]), lang)
