/**
 * scripts/danmaku/get.ts: `bilibili.get_danmaku` Tool 入口.
 *
 * M3 Stage 1 实现: 给定 B 站视频, 拉取完整弹幕池 (按时间戳分段的 protobuf),
 * 返回标准化 Danmaku (瞬时事件集合).
 *
 * 设计原则 (D08/D12/D24/D25/D26):
 * - 无状态: 每次调用独立, 不共享 VideoAsset
 * - 原子 Tool: 内部完成 metadata → discover → normalize 全链, 一次性返回
 * - 外部 API 隔离: 弹幕 B 站原始字段不暴露到 Tool 输出
 * - Agent 紧凑视图: 隐藏 cid / duration / segmentCount 等内部细节
 * - 失败结构化: BilibiliError → reasonCode, 不抛业务异常
 *
 * 弹幕 Tool 不需要登录态 (D13 风格: API 优先). 评论 Tool 才需要 (Stage 2).
 */
import { VideoRefSchema, type VideoRef } from "../models/video.js";
import { z } from "zod";

import { BilibiliClient, type BilibiliSubtitleClient } from "../bilibili/client.js";
import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";
import {
  discoverDanmakuSegments,
  type DiscoverDanmakuSegmentsResult,
} from "./bilibili-adapter.js";
import {
  AcquisitionRecordSchema,
  type AcquisitionRecord,
} from "../models/acquisition.js";
import {
  VideoMetadataSchema,
  VideoPageSchema,
  type VideoMetadata,
} from "../metadata/model.js";
import { DanmakuSchema, type Danmaku } from "../models/danmaku.js";
import { getBilibiliMetadata } from "../metadata/get.js";

/** Tool 输入: Agent 自然拥有的视频标识和可选分P选择. */
export const GetDanmakuInputSchema = z.object({
  /** B 站视频 URL / BV 号 / av 号. */
  video: z.string().min(1),
  /** 可选底层分P cid; 普通调用优先用自然分P编号. */
  cid: z.string().min(1).optional(),
  /** 用户自然指定的分P编号, 从 1 开始. */
  page: z.number().int().positive().optional(),
  /** 可选最大段数 (6min/段), 默认 12 (覆盖 72min 视频). */
  maxSegments: z.number().int().positive().max(50).optional(),
});
export type GetDanmakuInput = z.infer<typeof GetDanmakuInputSchema>;

/** Tool 失败时返回的稳定错误结构. */
export const DanmakuToolErrorSchema = z.object({
  /** 稳定程序错误码. */
  code: z.string().min(1),
  /** 给用户和 Agent 阅读的错误说明. */
  message: z.string().min(1),
  /** 是否建议原参数稍后重试. */
  retryable: z.boolean(),
  /** 可选 B 站业务错误码. */
  apiCode: z.number().int().optional(),
});
export type DanmakuToolError = z.infer<typeof DanmakuToolErrorSchema>;

/** 多P未选定时, 返回的最小分P信息. */
export const DanmakuPageChoiceSchema = VideoPageSchema.pick({
  page: true,
  cid: true,
  title: true,
  durationSeconds: true,
});

/** `bilibili.get_danmaku` 的无状态独立结果. */
export const GetDanmakuOutputSchema = z.object({
  success: z.boolean(),
  /** 比 success 更细的分类. */
  outcome: z.enum(["success", "selection_required", "failed"]),
  /** 能确定视频身份时返回; 成功或 failed 时通常包含 cid. */
  video: VideoRefSchema.optional(),
  /** 获取成功时返回完整弹幕. */
  danmaku: DanmakuSchema.optional(),
  /** 本次弹幕采集记录. */
  acquisition: AcquisitionRecordSchema,
  /** 多P未选定时返回可选列表. */
  pageChoices: z.array(DanmakuPageChoiceSchema).optional(),
  /** 失败时的结构化错误. */
  error: DanmakuToolErrorSchema.optional(),
});
export type GetDanmakuOutput = z.infer<typeof GetDanmakuOutputSchema>;

/** 依赖注入 (单测用). */
export interface GetDanmakuDependencies {
  client?: BilibiliSubtitleClient;
}

/**
 * `bilibili.get_danmaku` Tool 入口.
 *
 * 不抛业务异常: 任何失败 (URL 解析 / metadata 缺失 / 弹幕拉取失败)
 * 都通过 `outcome: "failed"` + `error.code` 表达.
 */
export async function getBilibiliDanmaku(
  rawInput: GetDanmakuInput,
  dependencies: GetDanmakuDependencies = {},
): Promise<GetDanmakuOutput> {
  const input = GetDanmakuInputSchema.parse(rawInput);
  const client = dependencies.client ?? new BilibiliClient();
  const requestedAt = new Date().toISOString();

  // 1) 解析 video → canonical URL + 解析出的 page (来自 URL ?p=)
  let resolvedInput;
  try {
    resolvedInput = await resolveBilibiliVideoInput(input.video, client);
  } catch (error) {
    const normalized = toBilibiliError(error);
    return GetDanmakuOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition: makeAcquisition({
        status: "failed",
        requestedAt,
        source: "bilibili_web_api",
        reasonCode: normalized.code,
        message: `解析弹幕所需视频输入失败: ${normalized.message}`,
        metadata: { retryable: normalized.retryable },
      }),
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
    });
  }

  // 2) 合并分P选择 (input.page 优先于 URL ?p=)
  if (
    input.page !== undefined
    && resolvedInput.requestedPage !== undefined
    && input.page !== resolvedInput.requestedPage
  ) {
    return GetDanmakuOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition: makeAcquisition({
        status: "failed",
        requestedAt,
        reasonCode: "conflicting_page_selection",
        message: `命令指定第 ${input.page}P, 但视频 URL 指定第 ${resolvedInput.requestedPage}P`,
      }),
      error: {
        code: "conflicting_page_selection",
        message: `命令指定第 ${input.page}P, 但视频 URL 指定第 ${resolvedInput.requestedPage}P`,
        retryable: false,
      },
    });
  }

  const requestedPage = input.page ?? resolvedInput.requestedPage;

  // 3) 拿 metadata → 找 aid + cid + 选分P
  const metadataResult = await getBilibiliMetadata(
    { video: resolvedInput.canonicalUrl, includeTags: false },
    { client },
  );

  if (!metadataResult.success || !metadataResult.metadata || !metadataResult.video) {
    const metadataError = metadataResult.error;
    const message = metadataError
      ? `获取弹幕所需视频信息失败: ${metadataError.message}`
      : "获取弹幕所需视频信息失败";
    return GetDanmakuOutputSchema.parse({
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
    return GetDanmakuOutputSchema.parse({
      success: false,
      outcome: "failed",
      acquisition: makeAcquisition({
        status: "failed",
        requestedAt,
        reasonCode: "aid_unavailable",
        message: "视频元信息缺少弹幕接口所需的 aid",
      }),
      error: {
        code: "aid_unavailable",
        message: "视频元信息缺少弹幕接口所需的 aid",
        retryable: false,
      },
    });
  }

  // 4) 选分P
  const pageChoice = selectPage(metadata, input.cid, requestedPage);
  if (pageChoice.kind === "selection_required") {
    return GetDanmakuOutputSchema.parse({
      success: false,
      outcome: "selection_required",
      video: VideoRefSchema.parse({ bvid: metadata.bvid }),
      acquisition: makeAcquisition({
        status: "not_requested",
        requestedAt,
        reasonCode: "danmaku_cid_required",
        message: "多P视频尚未选择目标分P, 未发起弹幕请求",
      }),
      pageChoices: metadata.pages,
    });
  }
  if (pageChoice.kind === "failed") {
    return GetDanmakuOutputSchema.parse({
      success: false,
      outcome: "failed",
      video: VideoRefSchema.parse({ bvid: metadata.bvid }),
      acquisition: makeAcquisition({
        status: "failed",
        requestedAt,
        reasonCode: pageChoice.error.code,
        message: pageChoice.error.message,
      }),
      error: {
        code: pageChoice.error.code,
        message: pageChoice.error.message,
        retryable: pageChoice.error.retryable,
      },
    });
  }

  const cid = pageChoice.cid;
  const video = VideoRefSchema.parse({ bvid: metadata.bvid, cid });
  const durationSeconds = metadata.pages.find((p) => p.cid === cid)?.durationSeconds;

  // 5) 拉取 + 标准化弹幕
  try {
    const result: DiscoverDanmakuSegmentsResult = await discoverDanmakuSegments(
      client,
      {
        aid: Number(aid), // metadata.aid 是 string (跨语言安全), 接口要 number
        cid: Number(cid),
        durationSeconds,
        maxSegments: input.maxSegments,
      },
    );

    const danmaku = DanmakuSchema.parse(result.danmaku);
    const acquisition = makeAcquisition({
      status: danmaku.complete && result.warnings.length === 0 ? "success" : "partial",
      source: "bilibili_player_api",
      requestedAt,
      message: !danmaku.complete || result.warnings.length > 0
        ? "弹幕获取成功, 但部分段拉取失败或被截断"
        : "弹幕获取成功",
      itemCount: danmaku.segments.length,
      warnings: result.warnings,
      metadata: {
        aid: Number(aid),
        cid,
        segmentCount: danmaku.segmentCount,
        complete: danmaku.complete,
      },
    });

    return GetDanmakuOutputSchema.parse({
      success: true,
      outcome: "success",
      video,
      danmaku,
      acquisition,
    });
  } catch (error) {
    const normalized = toBilibiliError(error);
    return GetDanmakuOutputSchema.parse({
      success: false,
      outcome: "failed",
      video,
      acquisition: makeAcquisition({
        status: "failed",
        source: "bilibili_player_api",
        requestedAt,
        reasonCode: normalized.code,
        message: `弹幕拉取失败: ${normalized.message}`,
        metadata: {
          aid: Number(aid),
          cid,
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

interface PageSelectionSuccess { kind: "selected"; cid: string }
interface PageSelectionRequired { kind: "selection_required" }
interface PageSelectionFailed { kind: "failed"; error: BilibiliError }
type PageSelection = PageSelectionSuccess | PageSelectionRequired | PageSelectionFailed;

function selectPage(
  metadata: VideoMetadata,
  explicitCid: string | undefined,
  requestedPage: number | undefined,
): PageSelection {
  const pages = metadata.pages;

  if (explicitCid !== undefined) {
    const matched = pages.find((p) => p.cid === explicitCid);
    if (!matched) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "unknown_cid",
          message: `cid=${explicitCid} 不属于当前视频的分P列表`,
        }),
      };
    }
    if (requestedPage !== undefined && matched.page !== requestedPage) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "conflicting_page_selection",
          message: `cid=${explicitCid} 对应第 ${matched.page}P, 与指定的第 ${requestedPage}P 不一致`,
        }),
      };
    }
    return { kind: "selected", cid: matched.cid };
  }

  if (requestedPage !== undefined) {
    const matched = pages.find((p) => p.page === requestedPage);
    if (!matched) {
      return {
        kind: "failed",
        error: new BilibiliError({
          code: "unknown_page",
          message: `第 ${requestedPage}P 不属于当前视频, 可选范围为 1-${pages.length}`,
        }),
      };
    }
    return { kind: "selected", cid: matched.cid };
  }

  if (pages.length === 1 && pages[0]) {
    return { kind: "selected", cid: pages[0].cid };
  }
  if (pages.length > 1) {
    return { kind: "selection_required" };
  }
  return {
    kind: "failed",
    error: new BilibiliError({
      code: "cid_unavailable",
      message: "视频元信息没有可用于拉取弹幕的 cid",
    }),
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
    dataKind: "danmaku", // M1 已预留的 kind
    status: options.status,
    source: options.source ?? "bilibili_player_api",
    requestedAt: options.requestedAt,
    completedAt: new Date().toISOString(),
    reasonCode: options.reasonCode,
    message: options.message,
    itemCount: options.itemCount,
    warnings: options.warnings ?? [],
    metadata: options.metadata,
  });
}
