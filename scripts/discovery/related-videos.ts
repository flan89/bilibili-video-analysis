/**
 * scripts/discovery/related-videos.ts: `bilibili.related_videos` Tool 入口.
 *
 * M8 批次 C: 给定视频的关联推荐原子 Tool.
 * - 单次请求取得平台围绕种子视频的一组关联推荐, 没有可靠分页契约, 不提供翻页 (AGENTS_M8 §10.2);
 * - 结果是平台推荐邻接关系快照: 不保证主题等价或观点相关, Agent 回答时必须表述边界;
 * - 不接受 Cookie: 不承诺登录用户的个性化推荐流;
 * - limit 只做本地确定性截取, 不改变平台单次返回行为;
 * - 种子视频自身被平台返回时确定性过滤, 相同 BV 号只保留首次出现 (AGENTS_M8 §10.4);
 * - 空列表 (missing) / 部分条目跳过 (partial) / 失败 (failed) 用结构化状态表达;
 * - HTTP 412 与业务 -352/-412 统一表现为 related_risk_control, retryable=true
 *   只表示稍后重试可能有意义, Tool 自身绝不自动重试.
 * - Tool 到返回候选即停止: 不递归获取"关联视频的关联视频", 不判断候选与研究问题的相关性.
 */
import { z } from "zod";

import { BilibiliClient, type BilibiliApiClient } from "../bilibili/client.js";
import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import { resolveBilibiliVideoInput } from "../bilibili/url.js";
import {
  type NormalizedRelatedResults,
  fetchRelatedList,
  normalizeRelatedResults,
} from "./bilibili-related-adapter.js";
import { VideoCandidateSchema } from "../models/discovery.js";
import { VideoRefSchema } from "../models/video.js";
import { IsoDateTimeSchema } from "../models/common.js";
import { AcquisitionRecordSchema, type AcquisitionRecord } from "../models/acquisition.js";

/**
 * Tool 输入: 种子视频 + 本地截取上限.
 * 不提供翻页: 当前接口单次返回整组推荐, 没有分页契约 (AGENTS_M8 §10.2).
 */
export const RelatedVideosInputSchema = z.object({
  /** 种子视频: B站视频 URL、BV号或 av号; 短链会被展开一次. */
  video: z.string().min(1),
  /** 本地截取上限; 默认 20, 第一版上限 40 (平台单次实测返回约 40 条). */
  limit: z.number().int().min(1).max(40).default(20),
});
export type RelatedVideosInput = z.input<typeof RelatedVideosInputSchema>;

/** Tool 失败时返回的稳定错误结构; 按需保留 HTTP 状态和 B 站业务码. */
export const RelatedVideosToolErrorSchema = z.object({
  /** 稳定程序错误码, 例如 related_risk_control / related_http_error / related_invalid_response. */
  code: z.string().min(1),
  /** 给人和 Agent 阅读的错误说明. */
  message: z.string().min(1),
  /** 是否建议稍后重试; 风控场景为 true 但不应立即连续重试. */
  retryable: z.boolean(),
  /** 可选 HTTP 状态. */
  httpStatus: z.number().int().optional(),
  /** 可选 B 站业务 code. */
  apiCode: z.number().int().optional(),
});
export type RelatedVideosToolError = z.infer<typeof RelatedVideosToolErrorSchema>;

/** `bilibili.related_videos` 的无状态独立结果. */
export const RelatedVideosOutputSchema = z.object({
  /** 是否得到可处理的关联推荐响应; 空列表也算 success=true (状态在 acquisition 里区分 missing). */
  success: z.boolean(),
  /**
   * 种子视频引用.
   * 输入是 BV 号 / 视频 URL 时必带; 输入只有 av 号时平台关联接口可用 aid 请求,
   * 但本 Tool 不再额外调用详情接口换取 bvid, 此时缺省并在 acquisition.metadata 记录 seedAid.
   */
  seedVideo: VideoRefSchema.optional(),
  /** 关联候选列表, 保留平台返回顺序; 已过滤种子自身与重复 BV 号; 空列表为 []. */
  candidates: z.array(VideoCandidateSchema).default([]),
  /** 平台原始返回条数 (确定性整理与本地截取前). */
  returnedCount: z.number().int().nonnegative(),
  /** 本次结果的观察时间; 关联推荐是当前快照, 结论只覆盖该时间窗口. */
  observedAt: IsoDateTimeSchema,
  /** 无论成功失败都必须返回本次采集记录. */
  acquisition: AcquisitionRecordSchema,
  /** 失败时的结构化错误; 成功时为空. */
  error: RelatedVideosToolErrorSchema.optional(),
}).superRefine((output, context) => {
  if (!output.success && !output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "关联推荐获取失败结果必须包含 error",
    });
  }
  if (output.success && output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "关联推荐获取成功结果不应包含 error",
    });
  }
});
export type RelatedVideosOutput = z.infer<typeof RelatedVideosOutputSchema>;

/** 依赖注入主要用于单元测试. */
export interface RelatedVideosDependencies {
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  /** API 根地址; 测试可替换. */
  baseUrl?: string;
  /** 视频输入解析 (短链展开) 所需客户端; 测试可替换. */
  client?: BilibiliApiClient;
}

/** 构造失败输出: 视频输入解析失败或接口失败共用. */
function makeFailedOutput(params: {
  input: z.infer<typeof RelatedVideosInputSchema>;
  requestedAt: string;
  normalized: ReturnType<typeof toBilibiliError>;
  metadata: Record<string, unknown>;
  /** 本地输入拒绝使用 local_validation，避免伪装成平台请求失败。 */
  source?: "local_validation" | "bilibili_web_api";
}): RelatedVideosOutput {
  const completedAt = new Date().toISOString();

  const acquisition = AcquisitionRecordSchema.parse({
    dataKind: "related_video_candidates",
    status: "failed",
    source: params.source ?? "bilibili_web_api",
    requestedAt: params.requestedAt,
    completedAt,
    reasonCode: params.normalized.code,
    message: params.source === "local_validation"
      ? `关联推荐输入校验未通过: ${params.normalized.message}`
      : `关联推荐获取失败: ${params.normalized.message}`,
    warnings: [],
    metadata: {
      limit: params.input.limit,
      retryable: params.normalized.retryable,
      ...(params.normalized.httpStatus !== undefined ? { httpStatus: params.normalized.httpStatus } : {}),
      ...(params.normalized.apiCode !== undefined ? { apiCode: params.normalized.apiCode } : {}),
      ...params.metadata,
    },
  });

  return RelatedVideosOutputSchema.parse({
    success: false,
    candidates: [],
    returnedCount: 0,
    observedAt: completedAt,
    acquisition,
    error: {
      code: params.normalized.code,
      message: params.normalized.message,
      retryable: params.normalized.retryable,
      ...(params.normalized.httpStatus !== undefined ? { httpStatus: params.normalized.httpStatus } : {}),
      ...(params.normalized.apiCode !== undefined ? { apiCode: params.normalized.apiCode } : {}),
    },
  });
}

/**
 * `bilibili.related_videos` Tool 入口.
 *
 * Agent 框架只需要把输入映射到本函数, 再把返回 JSON 交给模型即可;
 * 这里刻意不绑定 OpenAI SDK、Pi、MCP 等具体协议 (与其它 Tool 一致).
 */
export async function getBilibiliRelatedVideos(
  rawInput: RelatedVideosInput,
  dependencies: RelatedVideosDependencies = {},
): Promise<RelatedVideosOutput> {
  const input = RelatedVideosInputSchema.parse(rawInput);
  const requestedAt = new Date().toISOString();
  const client = dependencies.client ?? new BilibiliClient();

  // 1) 解析种子视频输入: BV 号优先, av 号退化为 aid, 短链展开一次.
  let resolvedInput;
  try {
    resolvedInput = await resolveBilibiliVideoInput(input.video, client);
  } catch (error) {
    const normalized = toBilibiliError(error);
    return makeFailedOutput({
      input,
      requestedAt,
      normalized,
      metadata: { seedInput: input.video },
      source: normalized.code === "invalid_video_input"
        ? "local_validation"
        : "bilibili_web_api",
    });
  }

  const seedBvid = resolvedInput.kind === "bvid" ? resolvedInput.bvid : undefined;
  const seedAid = resolvedInput.kind === "aid" ? resolvedInput.aid : undefined;
  const seedMetadata = seedBvid !== undefined ? { seedBvid } : { seedAid };

  try {
    const raw = await fetchRelatedList(
      {
        ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {}),
        baseUrl: dependencies.baseUrl,
      },
      seedBvid !== undefined
        ? { kind: "bvid", bvid: seedBvid }
        : { kind: "aid", aid: seedAid as string },
    );

    const normalized: NormalizedRelatedResults = normalizeRelatedResults(raw, {
      ...(seedBvid !== undefined ? { bvid: seedBvid } : {}),
      ...(seedAid !== undefined ? { aid: seedAid } : {}),
    });

    // limit 只做本地确定性截取: 平台单次返回整组推荐, 截取不触发额外请求.
    const candidates = normalized.candidates.slice(0, input.limit);

    // 状态判定 (与热门/热搜一致):
    // - 有候选且无缺口 → success; 有候选但有缺口 → partial; 无候选 → missing.
    const hasCandidates = candidates.length > 0;
    const status: AcquisitionRecord["status"] = !hasCandidates
      ? "missing"
      : normalized.warnings.length > 0
        ? "partial"
        : "success";

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "related_video_candidates",
      status,
      source: "bilibili_web_api",
      requestedAt,
      completedAt: new Date().toISOString(),
      itemCount: candidates.length,
      message: !hasCandidates
        ? "关联推荐接口成功但没有返回候选"
        : normalized.warnings.length > 0
          ? "关联推荐获取成功，但存在条目缺口"
          : "关联推荐获取成功",
      warnings: normalized.warnings,
      metadata: {
        limit: input.limit,
        rawReturnedCount: normalized.rawReturnedCount,
        // 快照性质提示: 关联推荐是平台推荐邻接关系, 不是主题等价或代表性抽样.
        snapshotNature: "platform_related_recommendation",
        ...seedMetadata,
      },
    });

    return RelatedVideosOutputSchema.parse({
      success: true,
      ...(seedBvid !== undefined ? { seedVideo: { bvid: seedBvid } } : {}),
      candidates,
      returnedCount: normalized.rawReturnedCount,
      observedAt: new Date().toISOString(),
      acquisition,
    });
  } catch (error) {
    // 输入解析错误直接抛给调用方 (CLI 会转成 stderr JSON), 不是采集失败.
    return makeFailedOutput({
      input,
      requestedAt,
      normalized: toBilibiliError(error),
      metadata: seedMetadata,
    });
  }
}

/** 重新导出 BilibiliError, 方便上层 import (与其它发现来源保持一致). */
export { BilibiliError };
