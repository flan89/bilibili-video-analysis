import { describe, expect, it } from "vitest";
import { TranscriptSchema, type Transcript } from "../../scripts/subtitle/model.js";
import { preprocessTranscript } from "../../scripts/subtitle/preprocessing.js";

function transcript(
  segments: Transcript["segments"],
  complete = true,
): Transcript {
  return TranscriptSchema.parse({
    source: "official",
    language: "zh-CN",
    cid: "cid-chunk",
    complete,
    segments,
  });
}

describe("字幕技术性分段", () => {
  it("达到最小长度后可以在强标点处结束文本块", () => {
    const input = transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "大家好，" },
      { id: "s2", startSeconds: 1, endSeconds: 2, text: "今天介绍这个方法。" },
      { id: "s3", startSeconds: 2, endSeconds: 3, text: "首先准备数据。" },
    ]);
    const result = preprocessTranscript(input, {
      chunking: { minCharacters: 10, maxCharacters: 100, maxDurationSeconds: 60 },
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]).toMatchObject({
      text: "大家好，今天介绍这个方法。",
      segmentIds: ["s1", "s2"],
      startSeconds: 0,
      endSeconds: 2,
    });
    expect(result.chunks[1]?.segmentIds).toEqual(["s3"]);
  });

  it("没有标点时仍会按字符上限分段，并覆盖全部来源 ID", () => {
    const input = transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "甲乙丙丁" },
      { id: "s2", startSeconds: 1, endSeconds: 2, text: "戊己庚辛" },
      { id: "s3", startSeconds: 2, endSeconds: 3, text: "壬癸子丑" },
    ]);
    const result = preprocessTranscript(input, {
      chunking: {
        minCharacters: 5,
        maxCharacters: 10,
        maxDurationSeconds: 60,
        breakOnStrongPunctuation: false,
      },
    });

    expect(result.chunks.map((chunk) => chunk.segmentIds)).toEqual([
      ["s1", "s2"],
      ["s3"],
    ]);
    expect(result.coverageComplete).toBe(true);
    expect(result.stats.mappedSegmentCount).toBe(3);
  });

  it("明显时间空档和说话人变化都会产生边界", () => {
    const input = transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "第一段", speaker: "A" },
      { id: "s2", startSeconds: 1.1, endSeconds: 2, text: "继续", speaker: "B" },
      { id: "s3", startSeconds: 10, endSeconds: 11, text: "新的部分", speaker: "B" },
    ]);
    const result = preprocessTranscript(input, {
      chunking: {
        minCharacters: 50,
        maxCharacters: 100,
        maxDurationSeconds: 60,
        maxGapSeconds: 2,
      },
    });

    expect(result.chunks.map((chunk) => chunk.segmentIds)).toEqual([
      ["s1"],
      ["s2"],
      ["s3"],
    ]);
    expect(result.chunks.map((chunk) => chunk.metadata?.boundaryReason)).toEqual([
      "speaker_change",
      "gap",
      "end_of_transcript",
    ]);
  });

  it("相邻重复字幕只保留一份文本，但映射全部原始 ID", () => {
    const input = transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "同一句" },
      { id: "s2", startSeconds: 1, endSeconds: 2, text: "同一句" },
      { id: "s3", startSeconds: 2, endSeconds: 3, text: "下一句" },
    ]);
    const result = preprocessTranscript(input, {
      chunking: { minCharacters: 50, maxCharacters: 100, maxDurationSeconds: 60 },
    });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.text).toBe("同一句下一句");
    expect(result.chunks[0]?.segmentIds).toEqual(["s1", "s2", "s3"]);
    expect(result.stats.duplicateSegmentCount).toBe(1);
    expect(result.coverageComplete).toBe(true);
  });

  it("单条超长字幕不截断原文，并显式记录 warning", () => {
    const longText = "这是一条不能随意截断的原始字幕".repeat(5);
    const input = transcript([
      { id: "long", startSeconds: 0, endSeconds: 80, text: longText },
    ]);
    const result = preprocessTranscript(input, {
      chunking: { minCharacters: 10, maxCharacters: 20, maxDurationSeconds: 30 },
    });

    expect(result.chunks[0]?.text).toBe(longText);
    expect(result.warnings.some((warning) => warning.code === "single_unit_exceeds_chunk_limit"))
      .toBe(true);
    expect(result.coverageComplete).toBe(true);
  });

  it("空 Transcript 和 partial Transcript 都保留明确完整性状态", () => {
    const empty = preprocessTranscript(transcript([]));
    expect(empty.chunks).toEqual([]);
    expect(empty.coverageComplete).toBe(true);
    expect(empty.complete).toBe(false);
    expect(empty.warnings.map((warning) => warning.code)).toContain("transcript_empty");

    const partial = preprocessTranscript(transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "只有部分字幕" },
    ], false));
    expect(partial.sourceComplete).toBe(false);
    expect(partial.coverageComplete).toBe(true);
    expect(partial.complete).toBe(false);
    expect(partial.warnings.map((warning) => warning.code)).toContain("source_transcript_incomplete");
  });

  it("重复的原始字幕 ID 会破坏唯一回查关系并标记覆盖不完整", () => {
    const result = preprocessTranscript(transcript([
      { id: "same-id", startSeconds: 0, endSeconds: 1, text: "第一句" },
      { id: "same-id", startSeconds: 1, endSeconds: 2, text: "第二句" },
    ]));

    expect(result.coverageComplete).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain("duplicate_segment_ids");
    expect(result.warnings.map((warning) => warning.code)).not.toContain("chunk_coverage_incomplete");
  });

  it("英文字幕片段之间补空格，中文片段不强行插入空格", () => {
    const english = preprocessTranscript(TranscriptSchema.parse({
      source: "official",
      language: "en-US",
      cid: "cid-en",
      segments: [
        { id: "e1", startSeconds: 0, endSeconds: 1, text: "Hello," },
        { id: "e2", startSeconds: 1, endSeconds: 2, text: "world." },
      ],
    }), { chunking: { minCharacters: 50, maxCharacters: 100, maxDurationSeconds: 60 } });
    expect(english.chunks[0]?.text).toBe("Hello, world.");

    const chinese = preprocessTranscript(transcript([
      { id: "c1", startSeconds: 0, endSeconds: 1, text: "你好，" },
      { id: "c2", startSeconds: 1, endSeconds: 2, text: "世界。" },
    ]), { chunking: { minCharacters: 50, maxCharacters: 100, maxDurationSeconds: 60 } });
    expect(chinese.chunks[0]?.text).toBe("你好，世界。");
  });
});
