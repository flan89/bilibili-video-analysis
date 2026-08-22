/**
 * scripts/comments/get-replies.ts: `bilibili.get_comment_replies` Tool 入口.
 *
 *  适用场景: Agent 看到一级评论的 replyCount > 0, 觉得是焦点时按需深入.
 */
import { z } from "zod";

import { BilibiliClient, type BilibiliSubtitleClient } from "../bilibili/client.js";
import { toBilibiliError } from "../bilibili/errors.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";
import {
  getReplyRepliesPage,
  normalizeReplyThread,
} from "./bilibili-adapter.js";
import { WbiSigner } from "../bilibili/wbi.js";
import {
  AcquisitionRecordSchema,
  type AcquisitionRecord,
} from "../models/index.js";
import { type VideoMetadata } from "../metadata/model.js";
import { CommentSchema, type Comment } from "../models/comment.js";
import { getBilibiliMetadata } from "../metadata/get.js";

/** Tool 输入. */
export const GetCommentRepliesInputSchema = z.object({
  video: z.string().min(1),
  /** 根评论 rpid. 必填 (这是"拉哪条根评论的回复"的核心参数). */
  root: z.string().min(1),
  /**
   * 回复页码 (B 站 pn). 改: 重命名 replyPage 避免跟其它 Tool 的 "page=分P" 冲突.
   * 默认 1.
   */
  replyPage: z.number().int().positive().optional(),
  /** 每页 1-49, 默认 20 (B 站 reply 接口限制). */
  pageSize: z.number().int().min(1).max(49).optional(),
});
export type GetCommentRepliesInput = z.infer<typeof GetCommentRepliesInputSchema>;

export const CommentRepliesToolErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  apiCode: z.number().int().optional(),
});
export type CommentRepliesToolError = z.infer<typeof CommentRepliesToolErrorSchema>;

/** `bilibili.get_comment_replies` 的无状态独立结果. */
export const GetCommentRepliesOutputSchema = z.object({
  success: z.boolean(),
  outcome: z.enum(["success", "failed"]),
  /** video 只含 bvid, 不绑 cid. */
  video: z.object({ bvid: z.string() }).optional(),
  /** 根评论 rpid. */
  root: z.string().optional(),
  /** 完整回复数组. 顶层 reply.repliesComplete 反映本页是否完整. */
  replies: z.array(CommentSchema).optional(),
  /** 翻页信息. */
  page: z.object({
    num: z.number().int(),
    size: z.number().int(),
    count: z.number().int(),
  }).optional(),
  /** B 站报告的回复总数 (= page.count). */
  totalReported: z.number().int().optional(),
  /** Whether Bilibili reports that the returned page is the last page. */
  lastPageReached: z.boolean().optional(),
  /**
   * 新增 hasMore, 跟 lastPageReached 互补. Agent 写代码时更直观.
   */
  hasMore: z.boolean().optional(),
  /** 下一页页码; lastPageReached=true 时 undefined. */
  nextReplyPage: z.number().int().optional(),
  /** True only when page 1 contains the whole reported thread. Deprecated. */
  complete: z.boolean().optional(),
  acquisition: AcquisitionRecordSchema,
  error: CommentRepliesToolErrorSchema.optional(),
});
export type GetCommentRepliesOutput = z.infer<typeof GetCommentRepliesOutputSchema>;

export interface GetCommentRepliesDependencies {
  client?: BilibiliSubtitleClient;
  signer?: WbiSigner;
  cookie?: string;
}

/** A stateless page is complete only when page 1 already contains the whole thread. */
export function isReplyThreadComplete(thread: {
  page: { num: number };
  replies: readonly Comment[];
  totalReported: number;
  lastPageReached: boolean;
}): boolean {
  return thread.page.num === 1
    && thread.lastPageReached
    && thread.replies.length >= thread.totalReported;
}

/**
 * `bilibili.get_comment_replies` Tool 入口.
 */
export async function getBilibiliCommentReplies(
  rawInput: GetCommentRepliesInput,
  dependencies: GetCommentRepliesDependencies = {},
): Promise<GetCommentRepliesOutput> {
  const input = GetCommentRepliesInputSchema.parse(rawInput);
  const client = dependencies.client ?? new BilibiliClient();
  const signer = dependencies.signer ?? new WbiSigner({ cookie: dependencies.cookie });
  const requestedAt = new Date().toISOString();

  // 1) URL 解析 + metadata 拉取
  let resolvedInput;
  try {
    resolvedInput = await resolveBilibiliVideoInput(input.video, client);
  } catch (error) {
    const normalized = toBilibiliError(error);
    return GetCommentRepliesOutputSchema.parse({
      success: false,
      outcome: "failed",
      root: input.root,
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_web_api",
        requestedAt,
        reasonCode: normalized.code,
        message: `解析回复所需视频输入失败: ${normalized.message}`,
        metadata: { retryable: normalized.retryable },
      }),
      error: errorToError(normalized),
    });
  }

  const metadataResult = await getBilibiliMetadata(
    { video: resolvedInput.canonicalUrl, includeTags: false },
    { client },
  );

  if (!metadataResult.success || !metadataResult.metadata) {
    const metadataError = metadataResult.error;
    return GetCommentRepliesOutputSchema.parse({
      success: false,
      outcome: "failed",
      root: input.root,
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_web_api",
        requestedAt,
        reasonCode: metadataError?.code ?? "metadata_prerequisite_failed",
        message: `获取回复所需视频信息失败: ${metadataError?.message ?? "未知"}`,
        metadata: { retryable: metadataError?.retryable ?? false },
      }),
      error: errorToError(metadataError ?? {
        code: "metadata_prerequisite_failed",
        message: "metadata 缺失",
        retryable: false,
      }),
    });
  }

  const metadata: VideoMetadata = metadataResult.metadata;
  const aid = metadata.aid;
  if (!aid) {
    return GetCommentRepliesOutputSchema.parse({
      success: false,
      outcome: "failed",
      root: input.root,
      acquisition: makeAcquisition({
        status: "failed",
        requestedAt,
        reasonCode: "aid_unavailable",
        message: "视频元信息缺少回复接口所需的 aid",
      }),
      error: {
        code: "aid_unavailable",
        message: "视频元信息缺少回复接口所需的 aid",
        retryable: false,
      },
    });
  }

  const video = { bvid: metadata.bvid };

  // 2) 拉回复树
  try {
    const raw = await getReplyRepliesPage(
      { signer, fetchImpl: undefined, cookie: dependencies.cookie },
      {
        aid: Number(aid),
        root: input.root,
        pn: input.replyPage ?? 1,
        ps: input.pageSize ?? 20,
      },
    );
    const normalized = normalizeReplyThread(raw, input.root, { aid });
    const complete = isReplyThreadComplete(normalized);

    const acquisition = makeAcquisition({
      status: "success",
      source: "bilibili_web_api",
      requestedAt,
      // 用 lastPageReached 替代 complete (B 站 cursor.is_end 严格判定)
      message: normalized.lastPageReached
        ? "回复树已到最后一页 (cursor.is_end=true)"
        : "回复树还有更多页 (cursor.is_end≠true), Agent 需累积多页判断 Traversal Coverage",
      itemCount: normalized.replies.length,
      metadata: {
        aid: Number(aid),
        root: input.root,
        replyPage: input.replyPage ?? 1,
        pageSize: input.pageSize ?? 20,
        totalReported: normalized.totalReported,
        lastPageReached: normalized.lastPageReached,
        hasMore: normalized.hasMore,
      },
    });

    return GetCommentRepliesOutputSchema.parse({
      success: true,
      outcome: "success",
      video,
      root: input.root,
      replies: normalized.replies,
      page: normalized.page,
      totalReported: normalized.totalReported,
      lastPageReached: normalized.lastPageReached,
      hasMore: normalized.hasMore,
      // 兼容老 fixture / 旧 Agent (deprecated, 后续 V1+ 移除)
      complete,
      ...(normalized.nextPage !== undefined ? { nextReplyPage: normalized.nextPage } : {}),
      acquisition,
    });
  } catch (error) {
    const normalized = toBilibiliError(error);
    return GetCommentRepliesOutputSchema.parse({
      success: false,
      outcome: "failed",
      video,
      root: input.root,
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_web_api",
        requestedAt,
        reasonCode: normalized.code,
        message: `回复树拉取失败: ${normalized.message}`,
        metadata: {
          aid: Number(aid),
          root: input.root,
          replyPage: input.replyPage ?? 1,
          retryable: normalized.retryable,
          httpStatus: normalized.httpStatus,
          apiCode: normalized.apiCode,
        },
      }),
      error: errorToError(normalized),
    });
  }
}

// ---------- 内部辅助 ----------

function errorToError(e: { code: string; message: string; retryable: boolean; apiCode?: number }): CommentRepliesToolError {
  return {
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    apiCode: e.apiCode,
  };
}

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
    // replies Tool 跟根评论 comments Tool 区别: 这里返回子回复, 用 replies 标识
    dataKind: "replies",
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

/** 重新导出 Comment 类型, 方便上层统一 import. */
export type { Comment };
