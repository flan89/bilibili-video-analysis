/**
 * scripts/comments/get.ts: `bilibili.get_comments` Tool 入口.
 *
 * M3 Stage 2.4 修: 评论是 video 级 (aid) 数据, 不分 P.
 * - Input: video / sort / cursor / pageSize (cid / page / pageNum 全删)
 * - Output: VideoRef 只含 bvid (没 cid)
 * - outcome 简化: "success" | "failed" (没 selection_required)
 *
 * D08/D12/D24/D25/D26 跟原版一致.
 */
import { z } from "zod";

import { BilibiliClient, type BilibiliSubtitleClient } from "../bilibili/client.js";
import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";
import {
  type NormalizedMainReplies,
  getMainRepliesPage,
  normalizeMainReplies,
  wrapMainRepliesAsCollection,
} from "./bilibili-adapter.js";
import { WbiSigner } from "../bilibili/wbi.js";
import {
  AcquisitionRecordSchema,
  type AcquisitionRecord,
} from "../models/index.js";
import {
  VideoMetadataSchema,
  type VideoMetadata,
} from "../metadata/model.js";
import { CommentCollectionSchema, type CommentCollection } from "../models/comment.js";
import { getBilibiliMetadata } from "../metadata/get.js";

/** Tool 输入 */
export const GetCommentsInputSchema = z.object({
  video: z.string().min(1),
  /**
   * 排序: 3 = 热度 (默认), 2 = 时间.
   * 对应 B 站 x/v2/reply/wbi/main 的 mode 参数.
   */
  sort: z.union([z.literal(2), z.literal(3)]).optional(),
  /**
   * 游标: 首次 undefined, 后续用上一次返回的 nextCursor.
   * 对应 B 站 pagination_reply.next_offset 字符串.
   */
  cursor: z.string().min(1).optional(),
  /** 每页 1-30, 默认 20. */
  pageSize: z.number().int().min(1).max(30).optional(),
});
export type GetCommentsInput = z.infer<typeof GetCommentsInputSchema>;

/** Tool 失败时的稳定错误结构. */
export const CommentsToolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  apiCode: z.number().int().optional(),
});
export type CommentsToolError = z.infer<typeof CommentsToolErrorSchema>;

/** `bilibili.get_comments` 的无状态独立结果 */
export const GetCommentsOutputSchema = z.object({
  success: z.boolean(),
  outcome: z.enum(["success", "failed"]),
  video: z.object({ bvid: z.string() }).optional(),
  collection: CommentCollectionSchema.optional(),
  /** 下一页游标 (B 站 pagination_reply.next_offset). undefined = 没更多. */
  nextCursor: z.string().optional(),
  acquisition: AcquisitionRecordSchema,
  error: CommentsToolErrorSchema.optional(),
});
export type GetCommentsOutput = z.infer<typeof GetCommentsOutputSchema>;

/** 依赖注入 (单测用). */
export interface GetCommentsDependencies {
  client?: BilibiliSubtitleClient;
  signer?: WbiSigner;
  cookie?: string;
}

/**
 * `bilibili.get_comments` Tool 入口.
 */
export async function getBilibiliComments(
  rawInput: GetCommentsInput,
  dependencies: GetCommentsDependencies = {},
): Promise<GetCommentsOutput> {
  const input = GetCommentsInputSchema.parse(rawInput);
  const client = dependencies.client ?? new BilibiliClient();
  const signer = dependencies.signer ?? new WbiSigner({ cookie: dependencies.cookie });
  const requestedAt = new Date().toISOString();

  // 1) 解析 video → canonical URL
  let resolvedInput;
  try {
    resolvedInput = await resolveBilibiliVideoInput(input.video, client);
  } catch (error) {
    const normalized = toBilibiliError(error);
    return GetCommentsOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_web_api",
        requestedAt,
        reasonCode: normalized.code,
        message: `解析评论所需视频输入失败: ${normalized.message}`,
        metadata: { retryable: normalized.retryable },
      }),
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    });
  }

  // 2) 拿 metadata → 找 aid
  const metadataResult = await getBilibiliMetadata(
    { video: resolvedInput.canonicalUrl, includeTags: false },
    { client },
  );

  if (!metadataResult.success || !metadataResult.metadata || !metadataResult.video) {
    const metadataError = metadataResult.error;
    const message = metadataError
      ? `获取评论所需视频信息失败: ${metadataError.message}`
      : "获取评论所需视频信息失败";
    return GetCommentsOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_web_api",
        requestedAt,
        reasonCode: metadataError?.code ?? "metadata_prerequisite_failed",
        message,
        metadata: { retryable: metadataError?.retryable ?? false },
      }),
      error: {
        code: metadataError?.code ?? "metadata_prerequisite_failed",
        message,
        retryable: metadataError?.retryable ?? false,
      },
    });
  }

  const metadata: VideoMetadata = VideoMetadataSchema.parse(metadataResult.metadata);
  const aid = metadata.aid;
  if (!aid) {
    return GetCommentsOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition: makeAcquisition({
        status: "failed",
        requestedAt,
        reasonCode: "aid_unavailable",
        message: "视频元信息缺少评论接口所需的 aid",
      }),
      error: {
        code: "aid_unavailable",
        message: "视频元信息缺少评论接口所需的 aid",
        retryable: false,
      },
    });
  }

  const video = { bvid: metadata.bvid };

  // 3) 拉评论 (WBI 签名 + fetch)
  try {
    const raw = await getMainRepliesPage(
      { signer, fetchImpl: undefined, cookie: dependencies.cookie },
      {
        aid: Number(aid),
        mode: input.sort ?? 3,
        next: input.cursor,
        ps: input.pageSize ?? 20,
      },
    );
    const normalized: NormalizedMainReplies = normalizeMainReplies(raw, String(aid));
    const sortLabel = input.sort === 2 ? "time" : "hot";
    const collection: CommentCollection = wrapMainRepliesAsCollection(normalized, sortLabel);

    const warnings: string[] = [];
    if (collection.totalReported && collection.totalReported > collection.comments.length) {
      warnings.push(
        `totalReported=${collection.totalReported} 大于本次返回 ${collection.comments.length} 条, 用 nextCursor 继续翻页`,
      );
    }

    const acquisition = makeAcquisition({
      status: "success",
      source: "bilibili_web_api",
      requestedAt,
      message: warnings.length > 0
        ? "评论获取成功, 但还有更多页"
        : "评论获取成功",
      itemCount: collection.comments.length,
      warnings,
      metadata: {
        aid: Number(aid),
        sort: input.sort ?? 3,
        pageSize: input.pageSize ?? 20,
        complete: normalized.complete,
        allCount: normalized.allCount,
      },
    });

    return GetCommentsOutputSchema.parse({
      success: true,
      outcome: "success",
      video,
      collection,
      nextCursor: normalized.nextCursor,
      acquisition,
    });
  } catch (error) {
    const normalized = toBilibiliError(error);
    return GetCommentsOutputSchema.parse({
      success: false,
      outcome: "failed",
      video,
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_web_api",
        requestedAt,
        reasonCode: normalized.code,
        message: `评论拉取失败: ${normalized.message}`,
        metadata: {
          aid: Number(aid),
          retryable: normalized.retryable,
          httpStatus: normalized.httpStatus,
          apiCode: normalized.apiCode,
        },
      }),
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        apiCode: normalized.apiCode,
      },
    });
  }
}

// ---------- 内部辅助 ----------

interface MakeAcquisitionOptions {
  status: "not_requested" | "success" | "partial" | "missing" | "failed";
  source?: string;
  requestedAt: string;
  reasonCode?: string;
  message: string;
  itemCount?: number;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

function makeAcquisition(options: MakeAcquisitionOptions): AcquisitionRecord {
  return AcquisitionRecordSchema.parse({
    dataKind: "comments",
    status: options.status,
    source: options.source ?? "bilibili_web_api",
    requestedAt: options.requestedAt,
    completedAt: new Date().toISOString(),
    reasonCode: options.reasonCode,
    message: options.message,
    itemCount: options.itemCount,
    warnings: options.warnings ?? [],
    metadata: options.metadata,
  });
}

/** 重新导出 BilibiliError, 方便上层 import. */
export { BilibiliError };
