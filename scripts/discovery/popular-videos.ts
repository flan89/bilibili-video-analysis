/**
 * scripts/discovery/popular-videos.ts: `bilibili.popular_videos` Tool 入口.
 *
 * M8 批次 A: 当前热门视频原子 Tool.
 * - 一次只取一页热门列表; 翻页和停止时机由 Agent 决定 (AGENTS_M8 §14.3);
 * - 结果是平台热门机制的当前快照, 不是全站客观排名, Agent 回答时必须表述边界;
 * - 不接受 Cookie: 不承诺登录用户的个性化推荐流 (AGENTS_M8 §8.2);
 * - 空列表 (missing) / 部分条目跳过 (partial) / 失败 (failed) 用结构化状态表达;
 * - HTTP 412 与业务 -352 统一表现为 popular_risk_control, retryable=true
 *   只表示稍后重试可能有意义, Tool 自身绝不自动重试.
 */
import { z } from "zod";

import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import {
  type NormalizedPopularResults,
  fetchPopularPage,
  normalizePopularResults,
} from "./bilibili-popular-adapter.js";
import { VideoCandidateSchema } from "../models/discovery.js";
import { IsoDateTimeSchema } from "../models/common.js";
import { AcquisitionRecordSchema, type AcquisitionRecord } from "../models/acquisition.js";

/**
 * Tool 输入: 只有页码与页大小.
 * 不提供关键词、分区、排序和时间范围: 这些不是当前热门接口的真实能力 (AGENTS_M8 §8.2).
 */
export const PopularVideosInputSchema = z.object({
  /** 页码, 正整数, 默认 1. */
  page: z.number().int().positive().default(1),
  /** 每页数量, 默认 20, 第一版上限 20. */
  pageSize: z.number().int().min(1).max(20).default(20),
});
export type PopularVideosInput = z.input<typeof PopularVideosInputSchema>;

/** Tool 失败时返回的稳定错误结构; 按需保留 HTTP 状态和 B 站业务码. */
export const PopularVideosToolErrorSchema = z.object({
  /** 稳定程序错误码, 例如 popular_risk_control / popular_http_error / popular_invalid_response. */
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
export type PopularVideosToolError = z.infer<typeof PopularVideosToolErrorSchema>;

/** `bilibili.popular_videos` 的无状态独立结果. */
export const PopularVideosOutputSchema = z.object({
  /** 是否得到可处理的热门响应; 空列表也算 success=true (状态在 acquisition 里区分 missing). */
  success: z.boolean(),
  /** 当前页候选列表, 保留平台返回顺序; 空列表为 []. */
  candidates: z.array(VideoCandidateSchema).default([]),
  /** 分页信息. */
  pageInfo: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    hasNextPage: z.boolean(),
  }),
  /** 本次结果的观察时间; 热门是当前快照, 结论只覆盖该时间窗口. */
  observedAt: IsoDateTimeSchema,
  /** 无论成功失败都必须返回本次采集记录. */
  acquisition: AcquisitionRecordSchema,
  /** 失败时的结构化错误; 成功时为空. */
  error: PopularVideosToolErrorSchema.optional(),
}).superRefine((output, context) => {
  if (!output.success && !output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "热门获取失败结果必须包含 error",
    });
  }
  if (output.success && output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "热门获取成功结果不应包含 error",
    });
  }
});
export type PopularVideosOutput = z.infer<typeof PopularVideosOutputSchema>;

/** 依赖注入主要用于单元测试. */
export interface PopularVideosDependencies {
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  /** API 根地址; 测试可替换. */
  baseUrl?: string;
}

/** hasNextPage 优先根据平台 no_more 确定 (AGENTS_M8 §8.3); 缺失时按满页保守估计. */
function toHasNextPage(
  input: { page: number; pageSize: number },
  normalized: NormalizedPopularResults,
): boolean {
  if (normalized.noMore === true) return false;
  if (normalized.noMore === false) return true;
  return normalized.rawReturnedCount >= input.pageSize;
}

/**
 * `bilibili.popular_videos` Tool 入口.
 *
 * Agent 框架只需要把输入映射到本函数, 再把返回 JSON 交给模型即可;
 * 这里刻意不绑定 OpenAI SDK、Pi、MCP 等具体协议 (与其它 Tool 一致).
 */
export async function getBilibiliPopularVideos(
  rawInput: PopularVideosInput,
  dependencies: PopularVideosDependencies = {},
): Promise<PopularVideosOutput> {
  const input = PopularVideosInputSchema.parse(rawInput);
  const requestedAt = new Date().toISOString();

  const failedPageInfo = {
    page: input.page,
    pageSize: input.pageSize,
    returnedCount: 0,
    hasNextPage: false,
  };

  try {
    const raw = await fetchPopularPage(
      {
        ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {}),
        baseUrl: dependencies.baseUrl,
      },
      { page: input.page, pageSize: input.pageSize },
    );

    const normalized = normalizePopularResults(raw);

    const warnings = [...normalized.warnings];
    if (normalized.noMore === undefined) {
      warnings.push("平台未返回 no_more 标记，hasNextPage 只是基于满页的保守估计");
    }

    // 状态判定 (AGENTS_M8 §8.4):
    // - 有候选且无缺口 → success; 有候选但有缺口 → partial; 无候选 → missing.
    const hasCandidates = normalized.candidates.length > 0;
    const status: AcquisitionRecord["status"] = !hasCandidates
      ? "missing"
      : warnings.length > 0
        ? "partial"
        : "success";

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "popular_video_candidates",
      status,
      source: "bilibili_web_api",
      requestedAt,
      completedAt: new Date().toISOString(),
      itemCount: normalized.candidates.length,
      message: !hasCandidates
        ? "热门接口成功但没有返回候选"
        : warnings.length > 0
          ? "热门列表获取成功，但存在字段缺口"
          : "热门列表获取成功",
      warnings,
      metadata: {
        page: input.page,
        pageSize: input.pageSize,
        rawReturnedCount: normalized.rawReturnedCount,
        noMore: normalized.noMore,
        // 快照性质提示: 供 Agent 在回答中表述来源机制边界.
        snapshotNature: "platform_popular_mechanism",
      },
    });

    return PopularVideosOutputSchema.parse({
      success: true,
      candidates: normalized.candidates,
      pageInfo: {
        page: input.page,
        pageSize: input.pageSize,
        returnedCount: normalized.rawReturnedCount,
        hasNextPage: toHasNextPage(input, normalized),
      },
      observedAt: new Date().toISOString(),
      acquisition,
    });
  } catch (error) {
    // 输入解析错误直接抛给调用方 (CLI 会转成 stderr JSON), 不是采集失败.
    const normalized = toBilibiliError(error);
    const completedAt = new Date().toISOString();

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "popular_video_candidates",
      status: "failed",
      source: "bilibili_web_api",
      requestedAt,
      completedAt,
      reasonCode: normalized.code,
      message: `热门列表获取失败: ${normalized.message}`,
      warnings: [],
      metadata: {
        page: input.page,
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });

    return PopularVideosOutputSchema.parse({
      success: false,
      candidates: [],
      pageInfo: failedPageInfo,
      observedAt: completedAt,
      acquisition,
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
        ...(normalized.httpStatus !== undefined ? { httpStatus: normalized.httpStatus } : {}),
        ...(normalized.apiCode !== undefined ? { apiCode: normalized.apiCode } : {}),
      },
    });
  }
}

/** 重新导出 BilibiliError, 方便上层 import (与 search-videos 保持一致). */
export { BilibiliError };
