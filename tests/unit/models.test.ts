import { describe, expect, it } from "vitest";
import { CommentSchema, TaskPlanSchema } from "../../scripts/models/index.js";
import { PreparedTranscriptSchema } from "../../scripts/subtitle/model.js";
import { VideoRefSchema } from "../../scripts/metadata/model.js";

describe("models", () => {
  it("可以校验最小 content_learn TaskPlan", () => {
    const plan = TaskPlanSchema.parse({
      objective: "提取视频中的核心知识",
      primary_intent: "content_learn",
      secondary_intents: [],
      focus: ["core_ideas"],
      depth: "standard",
      clarification: { needed: false, question: null, reason: null },
      data_plan: {
        required: ["metadata", "transcript"],
        optional: [],
        avoid_by_default: ["comments", "video"],
        fallbacks: [{ if: "无官方字幕", then: "音频提取 + ASR" }],
      },
      routing_notes: [],
    });
    expect(plan.primary_intent).toBe("content_learn");
  });

  it("Comment 可以递归表达评论回复树", () => {
    const comment = CommentSchema.parse({
      id: "c1",
      content: "有没有自动化方案？",
      repliesComplete: true,
      replies: [{
        id: "r1",
        rootId: "c1",
        parentId: "c1",
        content: "我目前只能手工整理",
        repliesComplete: true,
        replies: [],
      }],
    });
    expect(comment.replies[0]?.rootId).toBe("c1");
  });

  it("Comment 缺省的回复完整性和子回复由 Schema 补齐", () => {
    const comment = CommentSchema.parse({
      id: "c-defaults",
      content: "测试默认值",
    });

    expect(comment.repliesComplete).toBe(false);
    expect(comment.replies).toEqual([]);
  });

  it("VideoRef 只关联视频和可选分P", () => {
    const video = VideoRefSchema.parse({ bvid: "BV1TEST", cid: "cid-1" });
    const withBusinessData = VideoRefSchema.safeParse({
      bvid: "BV1TEST",
      title: "不应进入 VideoRef",
    });

    expect(video).toEqual({ bvid: "BV1TEST", cid: "cid-1" });
    expect(withBusinessData.success).toBe(false);
  });

  it("PreparedTranscript 拒绝与 chunks 不一致的完整性和统计", () => {
    const result = PreparedTranscriptSchema.safeParse({
      source: "official",
      language: "zh-CN",
      cid: "cid-1",
      sourceComplete: true,
      coverageComplete: true,
      complete: true,
      chunks: [],
      warnings: [],
      stats: {
        inputSegmentCount: 0,
        emptySegmentCount: 0,
        duplicateSegmentCount: 0,
        cleanedUnitCount: 0,
        chunkCount: 1,
        mappedSegmentCount: 0,
      },
    });

    expect(result.success).toBe(false);
  });
});
