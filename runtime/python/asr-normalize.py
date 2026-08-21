#!/usr/bin/env python3
"""
asr-normalize: 标准化 ASR 输出到 Transcript schema (与 Level 1 同结构)

现有 scripts/subtitle/model.ts Transcript schema:
  {
    source: "official" | "official_ai" | "asr",
    language: "zh-CN" | "en" | ...,
    cid: string?,
    segments: [
      { id, startSeconds, endSeconds, text, ... }
    ],
    complete: boolean,
    metadata?: ...
  }

VAD + SenseVoice 拆分版输出格式:
  [{
    key: "video_id",
    segments: [
      { from_ms: 0, to_ms: 2000, text: "<|en|><|BGM|>..." },
      { from_ms: 2000, to_ms: 5000, text: "<|zh|><|NEUTRAL|><|Speech|>..." },
      ...
    ]
  }]

用法:
  python3 scripts/prototype/04_normalize.py <video_id> <input.asr.json>

输出: data/raw/<video_id>.transcript.json
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


# SenseVoice 特殊 token
TAG_PATTERN = re.compile(r"<\|[a-z_]+\|>", re.IGNORECASE)
BGM_PATTERN = re.compile(r"<\|BGM\|>", re.IGNORECASE)
SPEECH_PATTERN = re.compile(r"<\|Speech\|>", re.IGNORECASE)
EVENT_PATTERN = re.compile(r"<\|([A-Z_]+)\|>", re.IGNORECASE)

# 语种 tag -> ISO 语种代码
LANG_TAG_MAP = {
    "zh": "zh-CN",
    "en": "en",
    "yue": "zh-HK",
    "ja": "ja",
    "ko": "ko",
}


def extract_clean_and_meta(text: str) -> tuple[str, str | None, str]:
    """从 SenseVoice 文本中提取 (clean_text, emotion, lang_code)
    - clean_text: 移除所有 <|xxx|> 标签后的纯文本
    - emotion: 情感标签 (如 HAPPY/SAD/EMO_UNKNOWN 等)
    - lang_code: 语种代码 (如 en/zh)
    """
    lang = "zh"
    m = re.search(r"<\|([a-z]{2,3})\|>", text)
    if m:
        lang = m.group(1)

    emotion = None
    for em in re.findall(r"<\|([A-Z_]+)\|>", text):
        if em not in ("BGM", "Speech"):
            emotion = em
            break

    clean = TAG_PATTERN.sub("", text).strip()
    return clean, emotion, lang


def is_bgm(text: str) -> bool:
    """判断一段是否为纯 BGM (无语音).

    关键认知: SenseVoice 的 <|BGM|> 标签是"环境有背景音乐", **不代表人声缺席**.
    真正的语音段会有 <|Speech|> 标签. 所以:
      - 有 <|Speech|>  →  speech 段 (即使环境有 BGM)
      - 无 <|Speech|> 但有 <|BGM|> 且无实际文本  →  纯 BGM 段
      - 无任何 tag 但有文本  →  保守判定为 speech
    """
    has_speech = bool(SPEECH_PATTERN.search(text))
    if has_speech:
        return False  # 明确有人声, 不是纯 BGM
    # 无 Speech 标签: 检查是否有实际文本
    clean = TAG_PATTERN.sub("", text).strip()
    return len(clean) < 3  # 阈值: 3 字符以下视为 BGM 段


def normalize(video_key: str, asr_path: Path) -> dict:
    """funasr VAD+ASR 拆分版输出 -> 现有 Transcript segments + language.

    注意: 这里只输出 segments + language 两个字段, 不输出完整 Transcript.
    完整 Transcript 的组装 (注入 cid / source / complete) 由 pipeline.py 负责,
    避免在 Python 端重复维护 cid 等 Skill 上下文信息.
    """
    if not asr_path.exists():
        print(f"[04] 输入不存在: {asr_path}", file=sys.stderr)
        sys.exit(1)

    with open(asr_path, "r", encoding="utf-8") as f:
        asr_data = json.load(f)

    if not asr_data:
        return _empty_normalized()

    record = asr_data[0]
    raw_segments = record.get("segments", [])

    if not raw_segments:
        return _empty_normalized()

    # 收集语种 (用第一段)
    first_text = raw_segments[0].get("text", "")
    _, _, lang = extract_clean_and_meta(first_text)
    language = LANG_TAG_MAP.get(lang, "zh-CN")

    segments = []
    for idx, raw in enumerate(raw_segments):
        text = raw.get("text", "")
        from_ms = raw.get("from_ms", 0)
        to_ms = raw.get("to_ms", 0)
        clean, emotion, _ = extract_clean_and_meta(text)

        # M1 TranscriptSegmentSchema 必填: id, startSeconds, endSeconds, text
        # 可选: confidence, speaker, metadata
        seg_obj: dict = {
            "id": f"asr-{idx}",
            "startSeconds": round(from_ms / 1000.0, 3),
            "endSeconds": round(to_ms / 1000.0, 3),
            "text": clean if clean and not is_bgm(text) else "",
        }
        # ASR 段 metadata: kind (speech/bgm) + emotion
        if not clean or is_bgm(text):
            seg_obj["metadata"] = {"kind": "bgm", "emotion": emotion}
        elif emotion:
            seg_obj["metadata"] = {"kind": "speech", "emotion": emotion}
        else:
            seg_obj["metadata"] = {"kind": "speech"}
        segments.append(seg_obj)

    if not segments:
        return _empty_normalized()

    return {"language": language, "segments": segments}


def _empty_normalized() -> dict:
    """空 ASR 输出的最小形态, 让 pipeline.py 知道"没结果"."""
    return {"language": "zh-CN", "segments": []}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python3 scripts/subtitle/asr/asr-normalize.py <video_key> <input.asr.json>", file=sys.stderr)
        sys.exit(1)
    # video_key 实际是 "<bvid>_<cid>" 而不只是 bvid, 命名含 cid
    video_key = sys.argv[1]
    asr_path = Path(sys.argv[2])
    normalized = normalize(video_key, asr_path)

    # asr-normalize 只输出 segments + language, 写中间文件给 pipeline.py 组装完整 Transcript
    # 注意: 这里是中间产物, 不是最终 transcript.json
    intermediate_path = Path(f"data/raw/{video_key}.normalized.json")
    with open(intermediate_path, "w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, indent=2)
    print(f"[04] 完成: {intermediate_path}", file=sys.stderr)
    speech_n = sum(1 for s in normalized["segments"] if s.get("metadata", {}).get("kind") == "speech")
    bgm_n = sum(1 for s in normalized["segments"] if s.get("metadata", {}).get("kind") == "bgm")
    print(f"[04]   - segments: {len(normalized['segments'])} (speech={speech_n}, bgm={bgm_n})", file=sys.stderr)
    print(f"[04]   - language: {normalized['language']}", file=sys.stderr)
