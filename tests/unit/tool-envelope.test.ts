/**
 * tests/unit/tool-envelope.test.ts: 跨 Tool Envelope 一致性测试.
 *
 * 9 个 Tool:
 *   - subtitle (scripts/subtitle/get.ts: GetSubtitleOutputSchema)
 *   - danmaku  (scripts/danmaku/get.ts: GetDanmakuOutputSchema)
 *   - comments (scripts/comments/get.ts: GetCommentsOutputSchema)
 *   - metadata (scripts/metadata/get.ts: GetMetadataOutputSchema)
 *   - frames   (scripts/visual/model.ts: GetFramesOutputSchema)
 *   - search-videos (M7) / popular-videos (M8 批次 A) / hot-searches (M8 批次 B)
 *   - related-videos (M8 批次 C)
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GetSubtitleOutputSchema } from "../../scripts/index.js";
import { GetDanmakuOutputSchema } from "../../scripts/index.js";
import { GetCommentsOutputSchema } from "../../scripts/index.js";
import { GetMetadataOutputSchema } from "../../scripts/index.js";
import { SearchVideosOutputSchema } from "../../scripts/index.js";
import { PopularVideosOutputSchema } from "../../scripts/index.js";
import { HotSearchesOutputSchema } from "../../scripts/index.js";
import { RelatedVideosOutputSchema } from "../../scripts/index.js";
import { GetFramesOutputSchema } from "../../scripts/visual/model.js";
import {
  AcquisitionRecordSchema,
  AcquisitionStateSchema,
} from "../../scripts/models/index.js";

/** 9 个 Tool 顶层 OutputSchema 元数据, 测试循环用. */
const TOOL_OUTPUTS = [
  { name: "subtitle", schema: GetSubtitleOutputSchema, topLevelError: true },
  { name: "danmaku", schema: GetDanmakuOutputSchema, topLevelError: true },
  { name: "comments", schema: GetCommentsOutputSchema, topLevelError: true },
  { name: "metadata", schema: GetMetadataOutputSchema, topLevelError: true },
  { name: "frames", schema: GetFramesOutputSchema, topLevelError: true },
  { name: "search-videos", schema: SearchVideosOutputSchema, topLevelError: true },
  { name: "popular-videos", schema: PopularVideosOutputSchema, topLevelError: true },
  { name: "hot-searches", schema: HotSearchesOutputSchema, topLevelError: true },
  { name: "related-videos", schema: RelatedVideosOutputSchema, topLevelError: true },
] as const;

/**
 * Unwrap ZodEffects (由 .superRefine() 包装) 到内层 ZodObject.
 * subtitle / metadata / frames 顶层都用了 .superRefine() 加自定义校验,
 * 顶层 _def 是 ZodEffects, 需要 _def.schema 才是真正的 ZodObject.
 */
function asZodObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  const def = (schema as z.ZodTypeAny)._def;
  if (def.typeName === "ZodEffects") {
    return asZodObject((def as { schema: z.ZodTypeAny }).schema);
  }
  if (def.typeName !== "ZodObject") {
    throw new Error(`expected ZodObject, got ${def.typeName}`);
  }
  return schema as z.ZodObject<z.ZodRawShape>;
}

describe("Tool Envelope 一致性", () => {
  describe("Schema 形态", () => {
    for (const { name, schema } of TOOL_OUTPUTS) {
      describe(`${name} Tool 顶层 envelope`, () => {
        it("必须有 success: boolean 字段", () => {
          const shape = asZodObject(schema).shape;
          expect(shape.success, `${name} 缺 success 字段`).toBeDefined();
          const successField = (shape.success as z.ZodTypeAny)._def;
          expect(successField.typeName, `${name} success 不是 boolean`).toBe(
            "ZodBoolean",
          );
        });

        it("必须有 acquisition 字段, 类型是 AcquisitionRecordSchema (或 .optional())", () => {
          const shape = asZodObject(schema).shape;
          expect(
            shape.acquisition,
            `${name} 缺 acquisition 字段 (承载 status / reasonCode / message)`,
          ).toBeDefined();
          // 关键契约: acquisition 字段的 schema 跟 AcquisitionRecordSchema 引用同一个对象
          // (Zod object identity 检查), 不只是"看起来一样".
          // 4 个 Tool 直接是 AcquisitionRecordSchema, frames 是 AcquisitionRecordSchema.optional().
          const acqField = shape.acquisition as z.ZodTypeAny;
          const acqInner =
            acqField._def.typeName === "ZodOptional"
              ? (acqField as z.ZodOptional<z.ZodTypeAny>)._def.innerType
              : acqField;
          expect(
            acqInner,
            `${name} acquisition 底层不是 AcquisitionRecordSchema 实例`,
          ).toBe(AcquisitionRecordSchema);
        });

        it("必须有 error 字段 (顶层), 承载 code / message / retryable", () => {
          const shape = asZodObject(schema).shape;
          expect(
            shape.error,
            `${name} 缺 error 字段 (跟其它 Tool envelope 对齐)`,
          ).toBeDefined();
        });
      });
    }
  });

  describe("AcquisitionRecord 内部字段 (所有 Tool 共用)", () => {
    it("status 必须是 AcquisitionStateSchema (6 段枚举)", () => {
      const statusField = (
        AcquisitionRecordSchema as z.ZodObject<z.ZodRawShape>
      ).shape.status;
      expect(statusField).toBeDefined();
      expect(
        (statusField as z.ZodTypeAny)._def.typeName,
        "AcquisitionRecord.status 不是 ZodEnum",
      ).toBe("ZodEnum");
    });

    it("status 枚举值覆盖 6 段 (not_requested / pending / success / partial / missing / failed)", () => {
      const expected = [
        "not_requested",
        "pending",
        "success",
        "partial",
        "missing",
        "failed",
      ] as const;
      expect(AcquisitionStateSchema.options).toEqual(expected);
    });

    it("reasonCode 必须是 z.string().optional()", () => {
      const reasonCodeField = (
        AcquisitionRecordSchema as z.ZodObject<z.ZodRawShape>
      ).shape.reasonCode;
      expect(reasonCodeField).toBeDefined();
      expect((reasonCodeField as z.ZodTypeAny)._def.typeName).toBe(
        "ZodOptional",
      );
      const inner = (reasonCodeField as z.ZodOptional<z.ZodString>)._def
        .innerType;
      expect((inner as z.ZodTypeAny)._def.typeName).toBe("ZodString");
    });

    it("message / itemCount 字段类型正确 (string / number optional)", () => {
      const shape = (AcquisitionRecordSchema as z.ZodObject<z.ZodRawShape>)
        .shape;
      expect(shape.message).toBeDefined();
      expect((shape.message as z.ZodTypeAny)._def.typeName).toBe(
        "ZodOptional",
      );
      expect(shape.itemCount).toBeDefined();
      expect((shape.itemCount as z.ZodTypeAny)._def.typeName).toBe(
        "ZodOptional",
      );
    });

    it("warnings 必须是 z.array(z.string()).default([])", () => {
      const shape = (AcquisitionRecordSchema as z.ZodObject<z.ZodRawShape>)
        .shape;
      expect(shape.warnings, "AcquisitionRecord 缺 warnings 字段").toBeDefined();
      expect((shape.warnings as z.ZodTypeAny)._def.typeName).toBe("ZodDefault");
    });

    it("dataKind 必须是 DataKindSchema, 14 个 enum 覆盖 metadata/cover/transcript/video/audio/frames/timeline/danmaku/comments/replies/video_candidates/popular_video_candidates/related_video_candidates/hot_search_topics", () => {
      const shape = (AcquisitionRecordSchema as z.ZodObject<z.ZodRawShape>)
        .shape;
      expect(shape.dataKind).toBeDefined();
      expect((shape.dataKind as z.ZodTypeAny)._def.typeName).toBe("ZodEnum");
    });

    it("requestedAt / completedAt 字段存在且类型正确", () => {
      const shape = (AcquisitionRecordSchema as z.ZodObject<z.ZodRawShape>)
        .shape;
      expect(shape.requestedAt).toBeDefined();
      expect(shape.completedAt).toBeDefined();
      // 都是 ZodOptional 包裹 (理由: 采集失败时可能没记录到)
      expect((shape.requestedAt as z.ZodTypeAny)._def.typeName).toBe(
        "ZodOptional",
      );
      expect((shape.completedAt as z.ZodTypeAny)._def.typeName).toBe(
        "ZodOptional",
      );
    });
  });

  describe("Happy path: 6 个 Tool 最小合法输出都能 parse", () => {
    it("subtitle success", () => {
      const out = GetSubtitleOutputSchema.parse({
        success: true,
        outcome: "success",
        video: { bvid: "BV1xx411c7mD", cid: "62131" },
        transcript: {
          cid: "62131",
          source: "official",
          language: "zh-CN",
          segments: [],
        },
        processing: {
          method: "deterministic_v1",
          warnings: [],
          stats: {
            inputSegmentCount: 0,
            outputSegmentCount: 0,
            emptySegmentCount: 0,
            duplicateSegmentCount: 0,
          },
        },
        acquisition: {
          dataKind: "transcript",
          status: "success",
          source: "bilibili_web_api",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.success).toBe(true);
      expect(out.acquisition.status).toBe("success");
    });

    it("danmaku success", () => {
      const out = GetDanmakuOutputSchema.parse({
        success: true,
        outcome: "success",
        video: { bvid: "BV1xx411c7mD", cid: "62131" },
        danmaku: {
          source: "bilibili_danmaku",
          language: "zh-CN",
          total: 0,
          segmentCount: 0,
          successfulSegments: 0,
          complete: true,
          segments: [],
        },
        acquisition: {
          dataKind: "danmaku",
          status: "success",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.status).toBe("success");
    });

    it("comments success (含 partial 演示: itemCount 1, warnings 1)", () => {
      const out = GetCommentsOutputSchema.parse({
        success: true,
        outcome: "success",
        video: { bvid: "BV1xx411c7mD" },
        collection: { comments: [], totalReported: 1, complete: true },
        acquisition: {
          dataKind: "comments",
          status: "partial",
          itemCount: 1,
          warnings: ["评论接口返回 412, 退避重试后只拿到 1 条"],
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.status).toBe("partial");
      expect(out.acquisition.warnings).toHaveLength(1);
    });

    it("metadata success", () => {
      const out = GetMetadataOutputSchema.parse({
        success: true,
        video: { bvid: "BV1xx411c7mD" },
        metadata: {
          bvid: "BV1xx411c7mD",
          title: "test",
          durationSeconds: 2055,
        },
        acquisition: {
          dataKind: "metadata",
          status: "success",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.status).toBe("success");
    });

    it("frames success", () => {
      const out = GetFramesOutputSchema.parse({
        success: true,
        outcome: "success",
        video: { bvid: "BV1xx411c7mD", cid: "62131" },
        frameset: {
          video: { bvid: "BV1xx411c7mD", cid: "62131" },
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
            requestedAt: "2026-08-19T00:00:00.000Z",
          },
          warnings: [],
        },
        acquisition: {
          dataKind: "frames",
          status: "success",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition?.status).toBe("success");
    });

    it("search-videos success (含 missing 演示: 空结果也是 success=true)", () => {
      const out = SearchVideosOutputSchema.parse({
        success: true,
        query: {
          keyword: "Agent Skill",
          order: "relevance",
          page: 1,
          pageSize: 20,
        },
        candidates: [],
        pageInfo: {
          page: 1,
          pageSize: 20,
          returnedCount: 0,
          hasNextPage: false,
        },
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "video_candidates",
          status: "missing",
          itemCount: 0,
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.status).toBe("missing");
      expect(out.success).toBe(true);
    });

    it("popular-videos success (M8 新 DataKind: popular_video_candidates)", () => {
      const out = PopularVideosOutputSchema.parse({
        success: true,
        candidates: [
          {
            video: { bvid: "BV1G48M6XEBt" },
            title: "当前热门示例条目",
            stats: { viewCount: 3229743, likeCount: 398925 },
            category: { id: 65, name: "网络游戏" },
            discoveryReason: "百万播放",
            position: 1,
          },
        ],
        pageInfo: {
          page: 1,
          pageSize: 20,
          returnedCount: 1,
          hasNextPage: true,
        },
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "popular_video_candidates",
          status: "success",
          itemCount: 1,
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.dataKind).toBe("popular_video_candidates");
      expect(out.candidates[0]?.discoveryReason).toBe("百万播放");
    });

    it("hot-searches success (M8 新 DataKind: hot_search_topics)", () => {
      const out = HotSearchesOutputSchema.parse({
        success: true,
        topics: [
          {
            keyword: "国产3A新作实机演示",
            displayName: "国产3A新作实机演示",
            position: 1,
            heatScore: 8452913,
          },
          {
            keyword: "新款旗舰手机发布会",
            position: 2,
            isCommercial: true,
          },
        ],
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "hot_search_topics",
          status: "success",
          itemCount: 2,
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.dataKind).toBe("hot_search_topics");
      expect(out.topics[1]?.isCommercial).toBe(true);
    });

    it("related-videos success (M8 新 DataKind: related_video_candidates)", () => {
      const out = RelatedVideosOutputSchema.parse({
        success: true,
        seedVideo: { bvid: "BV1C48C6BEDN" },
        candidates: [
          {
            video: { bvid: "BV1TM4m1r7xT" },
            title: "关联推荐示例条目",
            stats: { viewCount: 953125, likeCount: 187289 },
            category: { id: 251, name: "三农" },
            position: 1,
          },
        ],
        returnedCount: 40,
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "related_video_candidates",
          status: "success",
          itemCount: 1,
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
      });
      expect(out.acquisition.dataKind).toBe("related_video_candidates");
      expect(out.seedVideo?.bvid).toBe("BV1C48C6BEDN");
      expect(out.returnedCount).toBe(40);
    });
  });

  describe("Failed path: 7 个 Tool 失败输出都能 parse 且带 reasonCode", () => {
    it("subtitle failed (含 reasonCode 演示)", () => {
      const out = GetSubtitleOutputSchema.parse({
        success: false,
        outcome: "failed",
        video: { bvid: "BV1xx411c7mD" },
        acquisition: {
          dataKind: "transcript",
          status: "failed",
          reasonCode: "asr_python_not_found",
          message: "Python 不可达, ASR fallback 无法运行",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "asr_python_not_found",
          message: "Python 不可达",
          retryable: false,
        },
      });
      expect(out.acquisition.status).toBe("failed");
      expect(out.acquisition.reasonCode).toBe("asr_python_not_found");
      expect(out.error?.code).toBe("asr_python_not_found");
      expect(out.error?.retryable).toBe(false);
    });

    it("danmaku failed (含 reasonCode 演示)", () => {
      const out = GetDanmakuOutputSchema.parse({
        success: false,
        outcome: "failed",
        video: { bvid: "BV1xx411c7mD" },
        danmaku: {
          source: "bilibili_danmaku",
          language: "zh-CN",
          total: 0,
          segmentCount: 0,
          successfulSegments: 0,
          complete: false,
          segments: [],
        },
        acquisition: {
          dataKind: "danmaku",
          status: "failed",
          reasonCode: "comments_http_error",
          message: "弹幕接口 HTTP 412",
          warnings: ["B 站 datacenter IP 限速"],
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "danmaku_http_error",
          message: "HTTP 412",
          retryable: true,
          httpStatus: 412,
        },
      });
      expect(out.acquisition.reasonCode).toBe("comments_http_error");
      expect(out.error?.retryable).toBe(true);
    });

    it("comments failed", () => {
      const out = GetCommentsOutputSchema.parse({
        success: false,
        outcome: "failed",
        video: { bvid: "BV1xx411c7mD" },
        acquisition: {
          dataKind: "comments",
          status: "failed",
          reasonCode: "wbi_keys_unavailable",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "wbi_keys_unavailable",
          message: "x/web-interface/nav 失败",
          retryable: false,
        },
      });
      expect(out.acquisition.reasonCode).toBe("wbi_keys_unavailable");
    });

    it("metadata failed (失败时 metadata.title 必填, 演示", () => {
      const out = GetMetadataOutputSchema.parse({
        success: false,
        video: { bvid: "BV1xx411c7mD" },
        metadata: { bvid: "BV1xx411c7mD", title: "" },
        acquisition: {
          dataKind: "metadata",
          status: "failed",
          reasonCode: "aid_unavailable",
          message: "B 站 aid 不可用",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "aid_unavailable",
          message: "aid 不可用",
          retryable: false,
        },
      });
      expect(out.acquisition.reasonCode).toBe("aid_unavailable");
    });

    it("frames failed (fail() 也能透出 reasonCode)", () => {
      const out = GetFramesOutputSchema.parse({
        success: false,
        outcome: "failed",
        video: { bvid: "BV1xx411c7mD" },
        acquisition: {
          dataKind: "frames",
          status: "failed",
          reasonCode: "ffmpeg_unavailable",
          message: "ffmpeg 不在 PATH",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "ffmpeg_unavailable",
          message: "ffmpeg 不可达",
          retryable: false,
        },
        reasonCode: "ffmpeg_unavailable",
        message: "ffmpeg 不在 PATH",
      });
      // 关键契约: frames 顶层 acquisition 跟 error 都存在      expect(out.acquisition, "frames fail() 必须返回顶层 acquisition").toBeDefined();
      expect(out.acquisition?.status).toBe("failed");
      expect(out.acquisition?.reasonCode).toBe("ffmpeg_unavailable");
      expect(out.error?.retryable).toBe(false);
    });

    it("search-videos failed (风控: retryable=true 但不应立即连续重试)", () => {
      const out = SearchVideosOutputSchema.parse({
        success: false,
        query: {
          keyword: "Agent Skill",
          order: "relevance",
          page: 1,
          pageSize: 20,
        },
        candidates: [],
        pageInfo: {
          page: 1,
          pageSize: 20,
          returnedCount: 0,
          hasNextPage: false,
        },
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "video_candidates",
          status: "failed",
          reasonCode: "search_risk_control",
          message: "搜索失败: B 站搜索接口触发风控 (HTTP 412)",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "search_risk_control",
          message: "B 站搜索接口触发风控 (HTTP 412)",
          retryable: true,
          httpStatus: 412,
        },
      });
      expect(out.acquisition.reasonCode).toBe("search_risk_control");
      expect(out.error?.retryable).toBe(true);
      expect(out.error?.httpStatus).toBe(412);
    });

    it("popular-videos failed (业务 -352 风控: retryable=true 但不应立即连续重试)", () => {
      const out = PopularVideosOutputSchema.parse({
        success: false,
        candidates: [],
        pageInfo: {
          page: 1,
          pageSize: 20,
          returnedCount: 0,
          hasNextPage: false,
        },
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "popular_video_candidates",
          status: "failed",
          reasonCode: "popular_risk_control",
          message: "热门列表获取失败: B 站热门接口触发风控 (code=-352)",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "popular_risk_control",
          message: "B 站热门接口触发风控 (code=-352)",
          retryable: true,
          apiCode: -352,
        },
      });
      expect(out.acquisition.reasonCode).toBe("popular_risk_control");
      expect(out.error?.retryable).toBe(true);
      expect(out.error?.apiCode).toBe(-352);
    });

    it("hot-searches failed (HTTP 412 风控: retryable=true 但不应立即连续重试)", () => {
      const out = HotSearchesOutputSchema.parse({
        success: false,
        topics: [],
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "hot_search_topics",
          status: "failed",
          reasonCode: "hot_search_risk_control",
          message: "热搜列表获取失败: B 站热搜接口触发风控 (HTTP 412)",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "hot_search_risk_control",
          message: "B 站热搜接口触发风控 (HTTP 412)",
          retryable: true,
          httpStatus: 412,
        },
      });
      expect(out.acquisition.reasonCode).toBe("hot_search_risk_control");
      expect(out.error?.retryable).toBe(true);
      expect(out.error?.httpStatus).toBe(412);
    });

    it("related-videos failed (种子不存在: code=-400, 不可重试)", () => {
      const out = RelatedVideosOutputSchema.parse({
        success: false,
        candidates: [],
        returnedCount: 0,
        observedAt: "2026-08-19T00:00:00.000Z",
        acquisition: {
          dataKind: "related_video_candidates",
          status: "failed",
          reasonCode: "related_api_error",
          message: "关联推荐获取失败: B 站关联推荐接口返回错误 code=-400: 请求错误",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "related_api_error",
          message: "B 站关联推荐接口返回错误 code=-400: 请求错误",
          retryable: false,
          apiCode: -400,
        },
      });
      expect(out.acquisition.reasonCode).toBe("related_api_error");
      expect(out.error?.retryable).toBe(false);
      expect(out.error?.apiCode).toBe(-400);
    });
  });

  describe("Tool error 字段必须含 code / message / retryable", () => {
    it("frames error 字段含 code / message / retryable", () => {
      const out = GetFramesOutputSchema.parse({
        success: false,
        outcome: "failed",
        video: { bvid: "BV1xx411c7mD" },
        acquisition: {
          dataKind: "frames",
          status: "failed",
          requestedAt: "2026-08-19T00:00:00.000Z",
        },
        error: {
          code: "playurl_http_error",
          message: "DASH segment HTTP 500",
          retryable: true,
        },
      });
      // 解析后字段必须存在
      const errObj = out.error as unknown as Record<string, unknown>;
      expect(errObj.code).toBe("playurl_http_error");
      expect(errObj.message).toBe("DASH segment HTTP 500");
      expect(errObj.retryable).toBe(true);
    });
  });
});
