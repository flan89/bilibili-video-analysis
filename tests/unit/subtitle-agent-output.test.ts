import { describe, expect, it } from "vitest";
import {
  toAgentSubtitleOutput,
} from "../../scripts/cli/subtitle/agent-output.js";
import { GetSubtitleOutputSchema } from "../../scripts/subtitle/get.js";

describe("字幕 Agent 紧凑输出", () => {
  it("保留全部正文、时间和完整性，同时移除逐段内部元数据", () => {
    const result = GetSubtitleOutputSchema.parse({
      success: true,
      outcome: "success",
      video: { bvid: "BV1TEST", cid: "cid-1" },
      transcript: {
        source: "official_ai",
        language: "zh",
        cid: "cid-1",
        provider: "bilibili",
        complete: true,
        segments: [
          {
            id: "subtitle:very-long-track-id:1",
            startSeconds: 1.25,
            endSeconds: 2.5,
            text: "第一句",
            metadata: {
              sourceIndex: 0,
              sourceSegmentIds: ["subtitle:very-long-track-id:1"],
            },
          },
          {
            id: "subtitle:very-long-track-id:2",
            startSeconds: 2.5,
            endSeconds: 4,
            text: "第二句",
            metadata: {
              sourceIndex: 1,
              sourceSegmentIds: ["subtitle:very-long-track-id:2"],
            },
          },
        ],
      },
      acquisition: {
        dataKind: "transcript",
        status: "success",
        itemCount: 2,
        message: "字幕获取成功",
        warnings: [],
      },
      availableTracks: [],
      processing: {
        method: "deterministic_v1",
        warnings: [{
          code: "adjacent_duplicates_merged",
          message: "相邻重复字幕已合并",
          segmentIds: ["subtitle:very-long-track-id:2"],
        }],
        stats: {
          inputSegmentCount: 2,
          outputSegmentCount: 2,
          emptySegmentCount: 0,
          duplicateSegmentCount: 0,
        },
      },
    });

    const output = toAgentSubtitleOutput(result);
    const serialized = JSON.stringify(output);

    expect(output.transcript?.segments).toEqual([
      { segmentNumber: 1, startSeconds: 1.25, endSeconds: 2.5, text: "第一句" },
      { segmentNumber: 2, startSeconds: 2.5, endSeconds: 4, text: "第二句" },
    ]);
    expect(output.transcript?.complete).toBe(true);
    expect(output.processing?.warnings[0]).toEqual({
      code: "adjacent_duplicates_merged",
      message: "相邻重复字幕已合并",
    });
    expect(serialized).not.toContain("very-long-track-id");
    expect(serialized).not.toContain("sourceSegmentIds");
  });

  it("多P待选择结果仍保留 pageChoices 和状态", () => {
    const result = GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "selection_required",
      video: { bvid: "BV1MULTI" },
      acquisition: {
        dataKind: "transcript",
        status: "not_requested",
        reasonCode: "subtitle_cid_required",
        message: "需要选择分P",
        warnings: [],
      },
      availableTracks: [],
      pageChoices: [
        { page: 1, cid: "cid-1", title: "第一部分", durationSeconds: 60 },
        { page: 2, cid: "cid-2", title: "第二部分", durationSeconds: 80 },
      ],
    });

    const output = toAgentSubtitleOutput(result);

    expect(output.outcome).toBe("selection_required");
    expect(output.pageChoices?.map((page) => page.cid)).toEqual(["cid-1", "cid-2"]);
    expect(output.transcript).toBeUndefined();
  });

  it("语音识别环境缺失时保留 setupHint", () => {
    const result = GetSubtitleOutputSchema.parse({
      success: false,
      outcome: "missing",
      video: { bvid: "BV1TEST", cid: "cid-1" },
      acquisition: {
        dataKind: "transcript",
        status: "missing",
        reasonCode: "no_official_subtitle",
        message: "没有官方字幕",
        warnings: [],
      },
      availableTracks: [],
      setupHint: {
        capability: "asr",
        reason: "语音识别环境尚未准备完成",
        doctorCommand: { executable: "node", args: ["cli.mjs", "doctor"] },
        planCommand: { executable: "node", args: ["cli.mjs", "setup", "asr", "--plan"] },
        applyCommand: { executable: "node", args: ["cli.mjs", "setup", "asr", "--apply"] },
      },
    });

    const output = toAgentSubtitleOutput(result);

    expect(output.setupHint?.capability).toBe("asr");
    expect(output.setupHint?.applyCommand.args).toContain("--apply");
  });
});
