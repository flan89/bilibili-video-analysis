/**
 * tests/unit/visual-model.test.ts: M5 视觉 model.ts 单元测试.
 *
 * 覆盖:
 * - FrameExtractionMode 3 个取值
 * - GetFramesInput schema: mode 跟其它参数二选一 (refine 校验)
 * - Coverage / FrameSet / GetFramesOutput schema
 * - FramesReasonCode 11 个枚举值稳定
 */
import { describe, expect, it } from "vitest";

import {
  CoverageSchema,
  FrameExtractionModeSchema,
  FrameSetSchema,
  FramesReasonCode,
  GetFramesInputSchema,
  GetFramesOutputSchema,
} from "../../scripts/visual/model.js";

describe("FrameExtractionMode", () => {
  it("只接受 timestamp / interval / scene", () => {
    expect(FrameExtractionModeSchema.parse("timestamp")).toBe("timestamp");
    expect(FrameExtractionModeSchema.parse("interval")).toBe("interval");
    expect(FrameExtractionModeSchema.parse("scene")).toBe("scene");
    expect(() => FrameExtractionModeSchema.parse("foo")).toThrow();
  });
});

describe("GetFramesInputSchema refine 校验", () => {
  it("mode=timestamp 必须提供 timestamps", () => {
    expect(() =>
      GetFramesInputSchema.parse({ video: "BV1xx", mode: "timestamp" }),
    ).toThrow(/timestamps/);
    expect(() =>
      GetFramesInputSchema.parse({
        video: "BV1xx",
        mode: "timestamp",
        timestamps: [],
      }),
    ).toThrow(/timestamps/);
    const ok = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "timestamp",
      timestamps: [1, 30, 60],
    });
    expect(ok.timestamps).toEqual([1, 30, 60]);
  });

  it("mode=interval 必须提供 intervalSeconds", () => {
    expect(() =>
      GetFramesInputSchema.parse({ video: "BV1xx", mode: "interval" }),
    ).toThrow(/intervalSeconds/);
    const ok = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "interval",
      intervalSeconds: 30,
      maxFrames: 20,
    });
    expect(ok.intervalSeconds).toBe(30);
  });

  it("mode=scene 允许默认参数 ()", () => {
    // sceneThreshold 跟 maxFrames 都有 schema default,
    // 单独 { mode: 'scene' } 不再 throw
    const ok = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "scene",
    });
    expect(ok.sceneThreshold).toBe(0.4); // schema default
    expect(ok.maxFrames).toBe(50); // schema default
  });

  it("mode=scene 显式提供 sceneThreshold 优先", () => {
    const ok = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "scene",
      sceneThreshold: 0.6,
      maxFrames: 20,
    });
    expect(ok.sceneThreshold).toBe(0.6);
    expect(ok.maxFrames).toBe(20);
  });

  it("resolution 默认 720p, 也接受 1080p", () => {
    const v1 = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "interval",
      intervalSeconds: 60,
    });
    expect(v1.resolution).toBe("720p");
    const v2 = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "interval",
      intervalSeconds: 60,
      resolution: "1080p",
    });
    expect(v2.resolution).toBe("1080p");
  });

  it("page 必须是正整数, cid 是字符串", () => {
    const ok = GetFramesInputSchema.parse({
      video: "BV1xx",
      mode: "interval",
      intervalSeconds: 60,
      page: 2,
      cid: "12345",
    });
    expect(ok.page).toBe(2);
    expect(ok.cid).toBe("12345");
  });

  it("maxFrames / timestamps 硬上限 100", () => {
    // maxFrames > 100 抛错
    expect(() =>
      GetFramesInputSchema.parse({
        video: "BV1xx",
        mode: "interval",
        intervalSeconds: 60,
        maxFrames: 5000,
      }),
    ).toThrow();
    // timestamps 超过 100 抛错
    expect(() =>
      GetFramesInputSchema.parse({
        video: "BV1xx",
        mode: "timestamp",
        timestamps: Array.from({ length: 101 }, (_, i) => i),
      }),
    ).toThrow();
    // 边界 100 OK
    expect(() =>
      GetFramesInputSchema.parse({
        video: "BV1xx",
        mode: "interval",
        intervalSeconds: 60,
        maxFrames: 100,
      }),
    ).not.toThrow();
  });
});

describe("CoverageSchema", () => {
  it("接受基本字段, complete 必须 boolean", () => {
    const ok = CoverageSchema.parse({
      startSeconds: 0,
      endSeconds: 60,
      targetDurationSeconds: 2055,
      frameCount: 3,
      complete: true,
    });
    expect(ok.complete).toBe(true);
    expect(ok.frameCount).toBe(3);
  });

  it("扩展字段 plannedFrameCount / requestedFrameCount / extractedFrameCount / truncated", () => {
    const ok = CoverageSchema.parse({
      startSeconds: 0,
      endSeconds: 300,
      targetDurationSeconds: 2055,
      frameCount: 6,
      plannedFrameCount: 35,
      requestedFrameCount: 6,
      extractedFrameCount: 6,
      truncated: true,
      complete: false,
    });
    expect(ok.plannedFrameCount).toBe(35);
    expect(ok.requestedFrameCount).toBe(6);
    expect(ok.extractedFrameCount).toBe(6);
    expect(ok.truncated).toBe(true);
    expect(ok.complete).toBe(false);
  });
});

describe("FrameSetSchema visualChanges 字段 ()", () => {
  it("scene mode 可选 visualChanges, 只含 timestampSeconds (无 score 假证据)", () => {
    const ok = FrameSetSchema.parse({
      video: { bvid: "BV1xx", cid: "12345" },
      mode: "scene",
      frames: [],
      coverage: {
        startSeconds: 0,
        endSeconds: 0,
        targetDurationSeconds: 2055,
        frameCount: 0,
        complete: true,
      },
      visualChanges: [
        { timestampSeconds: 10.5 },
        { timestampSeconds: 30.2 },
      ],
      acquisition: {
        dataKind: "frames",
        status: "success",
        warnings: [],
      },
    });
    expect(ok.visualChanges).toHaveLength(2);
    // 旧版 score 字段已删
    expect(ok.visualChanges?.[0]).not.toHaveProperty("score");
  });
});

describe("FrameSetSchema", () => {
  it("包含 video / mode / frames / coverage / acquisition, 默认 warnings=[]", () => {
    const ok = FrameSetSchema.parse({
      video: { bvid: "BV1xx", cid: "12345" },
      mode: "timestamp",
      frames: [],
      coverage: {
        startSeconds: 0,
        endSeconds: 0,
        targetDurationSeconds: 2055,
        frameCount: 0,
        complete: true,
      },
      acquisition: {
        dataKind: "frames",
        status: "success",
        source: "bilibili_player_api",
        requestedAt: "2026-08-19T00:00:00.000Z",
        completedAt: "2026-08-19T00:00:01.000Z",
        warnings: [],
      },
    });
    expect(ok.warnings).toEqual([]);
  });
});

describe("GetFramesOutputSchema", () => {
  it("成功结果必含 frameset, 失败结果必含 reasonCode", () => {
    const success = GetFramesOutputSchema.parse({
      success: true,
      outcome: "success",
      video: { bvid: "BV1xx", cid: "12345" },
      frameset: {
        video: { bvid: "BV1xx", cid: "12345" },
        mode: "timestamp",
        frames: [],
        coverage: {
          startSeconds: 0,
          endSeconds: 0,
          targetDurationSeconds: 2055,
          frameCount: 0,
          complete: true,
        },
        acquisition: {
          dataKind: "frames",
          status: "success",
          warnings: [],
        },
      },
    });
    expect(success.outcome).toBe("success");

    const failed = GetFramesOutputSchema.parse({
      success: false,
      outcome: "failed",
      reasonCode: "ffmpeg_unavailable",
      message: "ffmpeg 不可用",
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.reasonCode).toBe("ffmpeg_unavailable");
  });
});

describe("FramesReasonCode 11 个枚举值", () => {
  it("保持稳定 (后续 Agent 路由会依赖这些 code)", () => {
    const codes = Object.values(FramesReasonCode);
    expect(codes).toContain("metadata_prerequisite_failed");
    expect(codes).toContain("conflicting_page_selection");
    expect(codes).toContain("unknown_page");
    expect(codes).toContain("unknown_cid");
    expect(codes).toContain("cid_unavailable");
    expect(codes).toContain("aid_unavailable");
    expect(codes).toContain("playurl_prerequisite_failed");
    expect(codes).toContain("ffmpeg_unavailable");
    expect(codes).toContain("scene_detection_failed");
    expect(codes).toContain("frame_extraction_failed");
    expect(codes).toContain("unexpected_error");
    expect(codes.length).toBe(11);
  });
});
