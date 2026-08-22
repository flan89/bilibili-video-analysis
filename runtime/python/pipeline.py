#!/usr/bin/env python3
"""
asr/pipeline.py: Level 3 ASR 全链路 Python 入口 (TS 集成专用)

串接 4 个独立 Python 脚本:
  audio-download → audio-extract → asr-runner → asr-normalize

不修改 4 个脚本的独立可运行性, 全部通过 subprocess 串接.
最终读取 <bv>_<cid>.transcript.json 输出结构化 JSON 到 stdout 给 TS 解析.

stdout 输出 schema:
  {
    "success": bool,
    "transcript": { ... M1 Transcript schema ... } | null,
    "acquisition": {
      "status": "success" | "partial" | "missing" | "failed",
      "source": "funasr",
      "reasonCode": "..." (if failed),
      "message": "..." (if failed),
      "warnings": ["..."]
    }
  }

stderr: 阶段进度信息 (给人看, 不影响 TS 解析)

用法:
  python3 scripts/subtitle/asr/pipeline.py <BV号> <cid>
"""
import json
import subprocess
import sys
from pathlib import Path

# 工作目录由 TypeScript 运行时设为 Cache Home/asr/work，所有可再生中间产物
# 都写入缓存，不污染只读 Skill 安装目录。
PROJECT_ROOT = Path.cwd()
ASR_DIR = Path(__file__).parent
PYTHON = sys.executable


def run_step(args: list[str], step_name: str) -> None:
    """subprocess 调一个 Python 脚本, stderr 透传, 失败抛异常."""
    print(f"[pipeline] {step_name}: {' '.join(args)}", file=sys.stderr)
    result = subprocess.run(
        [PYTHON, *args],
        cwd=PROJECT_ROOT,
        capture_output=False,  # 透传 stderr (给人看进度)
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{step_name} 失败 (exit {result.returncode})")


def emit(success: bool, transcript: dict | None, acquisition: dict) -> None:
    """输出结构化 JSON 到 stdout."""
    output = {
        "success": success,
        "transcript": transcript,
        "acquisition": acquisition,
    }
    print(json.dumps(output, ensure_ascii=False))


def classify_normalized_segments(
    segments: list[dict],
    runner_warnings: list[str],
) -> tuple[str, bool]:
    """根据标准化后的时间字段返回 ``(status, complete)``。"""
    if not segments:
        return "missing", False

    fallback_segment = (
        len(segments) == 1
        and segments[0].get("startSeconds") == 0
        and segments[0].get("endSeconds") == 0
    )
    filtered_short_segments = any(
        warning.startswith("asr_vad_filtered_short_segments:")
        for warning in runner_warnings
    )
    complete = not fallback_segment and not filtered_short_segments
    return ("success" if complete else "partial"), complete


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: python3 scripts/subtitle/asr/pipeline.py <BV号> <cid>", file=sys.stderr)
        return 2

    bvid = sys.argv[1]
    cid = sys.argv[2]
    if not cid:
        print("[pipeline] ERROR: cid 必填 (, 避免 Evidence Identity 污染)", file=sys.stderr)
        return 2

    # 统一 videoKey 含 cid, 中间产物全部按 <bvid>_<cid> 命名
    video_key = f"{bvid}_{cid}"
    print(f"[pipeline] 开始 ASR 全链路: {video_key}", file=sys.stderr)

    # 1) download audio.m4s
    # 透传 cid 给 audio-download, 避免 Python 端自己 get_cid
    run_step(
        [str(ASR_DIR / "audio-download.py"), bvid, cid],
        "1/4 audio-download",
    )

    # 2) extract wav
    m4s_path = PROJECT_ROOT / "data" / "raw" / f"{video_key}.c_audio.m4s"
    run_step(
        [str(ASR_DIR / "audio-extract.py"), str(m4s_path)],
        "2/4 audio-extract",
    )

    # 3) VAD + ASR
    wav_path = PROJECT_ROOT / "data" / "raw" / f"{video_key}.c_audio.wav"
    run_step(
        [str(ASR_DIR / "asr-runner.py"), str(wav_path), "auto"],
        "3/4 asr-runner",
    )

    # 4) normalize → data/raw/<bvid>_<cid>.normalized.json
    asr_json = PROJECT_ROOT / "data" / "raw" / f"{video_key}.c_audio.asr.json"
    run_step(
        [str(ASR_DIR / "asr-normalize.py"), video_key, str(asr_json)],
        "4/4 asr-normalize",
    )

    # 5) 组装最终 Transcript (注入 cid, source=asr)
    #     完整 Transcript schema 在 scripts/subtitle/model.ts:
    #     { source, language, cid?, provider?, segments, complete, metadata? }
    #     字段名跟 M1 一致, 跑通 TS 端 Zod 验证.
    normalized_path = PROJECT_ROOT / "data" / "raw" / f"{video_key}.normalized.json"
    if not normalized_path.exists():
        emit(False, None, {
            "status": "failed",
            "source": "funasr",
            "reasonCode": "asr_transcript_missing",
            "message": f"ASR 流水线完成但未生成 {normalized_path}",
            "warnings": [],
        })
        return 1

    try:
        normalized = json.loads(normalized_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        emit(False, None, {
            "status": "failed",
            "source": "funasr",
            "reasonCode": "asr_transcript_unreadable",
            "message": f"读取 ASR 标准化结果失败: {e}",
            "warnings": [],
        })
        return 1

    # 收集 asr-runner 写出的 warnings (Python 内部状态不再丢失)
    # 例如整段 fallback 时 asr-runner 已经标记 warning
    runner_warnings_path = PROJECT_ROOT / "data" / "raw" / f"{video_key}.c_audio.asr.warnings.json"
    runner_warnings: list[str] = []
    if runner_warnings_path.exists():
        try:
            runner_warnings = json.loads(runner_warnings_path.read_text(encoding="utf-8")).get("warnings", [])
        except (json.JSONDecodeError, OSError):
            pass  # warnings 文件读失败不阻塞, 透传空 list

    raw_segments = normalized.get("segments", [])
    if not isinstance(raw_segments, list):
        emit(False, None, {
            "status": "failed",
            "source": "funasr",
            "reasonCode": "asr_transcript_invalid_segments",
            "message": "ASR segments 不是数组",
            "warnings": runner_warnings,
        })
        return 1

    status, complete = classify_normalized_segments(raw_segments, runner_warnings)
    if status == "missing":
        emit(False, None, {
            "status": "missing",
            "source": "funasr",
            "reasonCode": "asr_empty_transcript",
            "message": "ASR 未生成任何可用片段",
            "warnings": runner_warnings,
        })
        return 0

    transcript = {
        "source": "asr",
        "language": normalized.get("language", "zh-CN"),
        "provider": "funasr",
        "segments": raw_segments,
        "complete": complete,
    }
    transcript["cid"] = cid

    transcript_path = PROJECT_ROOT / "data" / "raw" / f"{video_key}.transcript.json"
    transcript_path.write_text(
        json.dumps(transcript, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"[pipeline] 最终 transcript 写入: {transcript_path} "
        f"(segments={len(transcript['segments'])})",
        file=sys.stderr,
    )

    emit(True, transcript, {
        "status": status,
        "source": "funasr",
        "warnings": runner_warnings,
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        # 顶层 catch 兜底: 任何未捕获异常都输出结构化 failed JSON
        emit(False, None, {
            "status": "failed",
            "source": "funasr",
            "reasonCode": "asr_pipeline_exception",
            "message": f"ASR 流水线异常: {e}",
            "warnings": [],
        })
        sys.exit(1)
