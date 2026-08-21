import { describe, expect, it } from "vitest";
import { TranscriptSchema, type Transcript } from "../../scripts/subtitle/model.js";
import {
  cleanTranscriptSegments,
  normalizeTranscriptText,
} from "../../scripts/subtitle/preprocessing.js";

function transcript(segments: Transcript["segments"]): Transcript {
  return TranscriptSchema.parse({
    source: "official_ai",
    language: "zh-CN",
    cid: "cid-clean",
    complete: true,
    segments,
  });
}

describe("字幕保守清洗", () => {
  it("只规范空白和换行，不改写字幕词语", () => {
    expect(normalizeTranscriptText("  第一步\r\n  准备\t数据  ")).toBe("第一步 准备 数据");
    expect(normalizeTranscriptText("API、数字 123 和专有名词")).toBe("API、数字 123 和专有名词");
  });

  it("在副本中按时间排序、丢弃空字幕并保留原始 Transcript", () => {
    const input = transcript([
      { id: "s2", startSeconds: 2, endSeconds: 3, text: "第二句" },
      { id: "empty", startSeconds: 1, endSeconds: 1.5, text: " \n\t " },
      { id: "s1", startSeconds: 0, endSeconds: 1, text: " 第一句 " },
    ]);
    const before = structuredClone(input);
    const result = cleanTranscriptSegments(input);

    expect(result.units.map((unit) => unit.text)).toEqual(["第一句", "第二句"]);
    expect(result.emptySegmentCount).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "segments_reordered",
      "empty_segments_dropped",
    ]);
    expect(input).toEqual(before);
  });

  it("只合并时间相邻、文本完全相同且说话人相同的字幕", () => {
    const input = transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "重复内容", speaker: "A" },
      { id: "s2", startSeconds: 1.2, endSeconds: 2, text: "重复内容", speaker: "A" },
      { id: "s3", startSeconds: 5, endSeconds: 6, text: "重复内容", speaker: "A" },
      { id: "s4", startSeconds: 6.1, endSeconds: 7, text: "重复内容", speaker: "B" },
    ]);
    const result = cleanTranscriptSegments(input, { duplicateMaxGapSeconds: 0.5 });

    expect(result.units).toHaveLength(3);
    expect(result.units[0]).toMatchObject({
      startSeconds: 0,
      endSeconds: 2,
      segmentIds: ["s1", "s2"],
    });
    expect(result.units[1]?.segmentIds).toEqual(["s3"]);
    expect(result.units[2]?.segmentIds).toEqual(["s4"]);
    expect(result.duplicateSegmentCount).toBe(1);
  });

  it("相似但不完全相同的字幕不会通过模糊匹配删除", () => {
    const input = transcript([
      { id: "s1", startSeconds: 0, endSeconds: 1, text: "先验证最小方案" },
      { id: "s2", startSeconds: 1, endSeconds: 2, text: "先验证最小的方案" },
    ]);
    const result = cleanTranscriptSegments(input);

    expect(result.units).toHaveLength(2);
    expect(result.duplicateSegmentCount).toBe(0);
  });
});
