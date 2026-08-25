/**
 * scripts/discovery/search-videos.ts: `bilibili.search_videos` Tool 入口.
 *
 * M7 批次 A: 关键词视频搜索原子 Tool.
 * - 一次只处理一个搜索词和一页结果; 多搜索词、翻页和停止时机由 Agent 决定 (D34);
 * - 不调用详情接口为候选补齐字段, 不计算隐藏质量分;
 * - 空结果 (missing) / 部分结果 (partial) / 失败 (failed) 用结构化状态表达 (D10);
 * - HTTP 412 与业务 code -412 统一表现为 search_risk_control, retryable=true
 *   只表示稍后重试可能有意义, Tool 自身绝不自动重试.
 */
import { z } from "zod";

import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import { WbiSigner } from "../bilibili/wbi.js";
import {
  type NormalizedSearchVideoResults,
  normalizeSearchVideoResults,
  searchVideoPage,
} from "./bilibili-search-adapter.js";
import {
  ExecutedVideoSearchQuerySchema,
  SearchDurationFilterSchema,
  SearchOrderSchema,
  VideoCandidateSchema,
  type ExecutedVideoSearchQuery,
  type SearchDurationFilter,
  type SearchOrder,
} from "../models/discovery.js";
import { IsoDateTimeSchema } from "../models/common.js";
import { AcquisitionRecordSchema, type AcquisitionRecord } from "../models/acquisition.js";

/** B 站 web 搜索报告总数的常见软上限; 达到后 numResults 不再可信 (翻页也最多约 50 页). */
export const SEARCH_REPORTED_TOTAL_SOFT_CAP = 1000;

/**
 * Tool 输入: 只保留有明确消费者的字段, 不暴露 search_type 等平台原始参数.
 *
 * 不提供发布时间筛选: 平台搜索接口的时间参数实测被忽略 (2026-08 取证),
 * 本地过滤只覆盖当前页、会制造错误的"无候选"语义. 需要按时间研究时,
 * Agent 用 `order: "latest"` 取候选, 再根据候选自带的 publishedAt 自行判断.
 */
export const SearchVideosInputSchema = z.object({
  /** 单个自然语言搜索词; 多个搜索词应由 Agent 分多次调用. */
  query: z.string().min(1),
  /** 页码, 正整数, 默认 1. */
  page: z.number().int().positive().default(1),
  /** 每页数量, 默认 20, 第一版上限 20. */
  pageSize: z.number().int().min(1).max(20).default(20),
  /** 排序方式, 默认综合排序; 枚举与 models/discovery.ts 保持同源. */
  order: SearchOrderSchema.default("relevance"),
  /** 时长筛选; 平台原生支持, 枚举与 models/discovery.ts 保持同源. */
  duration: SearchDurationFilterSchema.optional(),
});
export type SearchVideosInput = z.input<typeof SearchVideosInputSchema>;

/** Tool 失败时返回的稳定错误结构; 按需保留 HTTP 状态和 B 站业务码. */
export const SearchVideosToolErrorSchema = z.object({
  /** 稳定程序错误码, 例如 search_risk_control / search_http_error / search_invalid_response. */
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
export type SearchVideosToolError = z.infer<typeof SearchVideosToolErrorSchema>;

/** `bilibili.search_videos` 的无状态独立结果. */
export const SearchVideosOutputSchema = z.object({
  /** 是否得到可处理的搜索响应; 空结果也算 success=true. */
  success: z.boolean(),
  /** 实际执行的稳定查询描述 (回显), 成功失败都返回, 便于定位和 Coverage 说明. */
  query: ExecutedVideoSearchQuerySchema,
  /** 当前页候选列表; 空结果为 []. */
  candidates: z.array(VideoCandidateSchema).default([]),
  /** 分页信息. */
  pageInfo: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    returnedCount: z.number().int().nonnegative(),
    hasNextPage: z.boolean(),
  }),
  /** 平台报告的结果总数; 只能解释为当前接口报告值, 允许缺失. */
  reportedTotal: z.number().int().nonnegative().optional(),
  /** 本次结果的观察时间; 搜索是当前快照, 结论只覆盖该时间窗口. */
  observedAt: IsoDateTimeSchema,
  /** 无论成功失败都必须返回本次采集记录. */
  acquisition: AcquisitionRecordSchema,
  /** 失败时的结构化错误; 成功时为空. */
  error: SearchVideosToolErrorSchema.optional(),
}).superRefine((output, context) => {
  if (!output.success && !output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "搜索失败结果必须包含 error",
    });
  }
  if (output.success && output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "搜索成功结果不应包含 error",
    });
  }
});
export type SearchVideosOutput = z.infer<typeof SearchVideosOutputSchema>;

/** 依赖注入主要用于单元测试, 也方便替换代理 Client / 复用进程内 WBI 缓存. */
export interface SearchVideosDependencies {
  /** WBI 签名器; 搜索接口必须签名. */
  signer?: WbiSigner;
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  /** 可选 Cookie; 匿名搜索可能遇到风控, 有 Cookie 时可提高成功率. */
  cookie?: string;
  /** API 根地址; 测试可替换. */
  baseUrl?: string;
}

/** 从输入构造回显用的稳定查询描述. */
function toExecutedQuery(input: {
  query: string;
  page: number;
  pageSize: number;
  order: SearchOrder;
  duration?: SearchDurationFilter;
}): ExecutedVideoSearchQuery {
  return ExecutedVideoSearchQuerySchema.parse({
    keyword: input.query,
    order: input.order,
    page: input.page,
    pageSize: input.pageSize,
    duration: input.duration,
  });
}

/** 构造分页信息; hasNextPage 基于原始返回条数和平台报告总数做保守估计. */
function toPageInfo(
  input: { page: number; pageSize: number },
  rawReturnedCount: number,
  reportedTotal: number | undefined,
): SearchVideosOutput["pageInfo"] {
  const fullPage = rawReturnedCount >= input.pageSize;
  const beyondReportedTotal = reportedTotal !== undefined
    && input.page * input.pageSize >= reportedTotal;
  return {
    page: input.page,
    pageSize: input.pageSize,
    returnedCount: rawReturnedCount,
    hasNextPage: fullPage && !beyondReportedTotal,
  };
}

/**
 * `bilibili.search_videos` Tool 入口.
 *
 * Agent 框架只需要把输入映射到本函数, 再把返回 JSON 交给模型即可;
 * 这里刻意不绑定 OpenAI SDK、Pi、MCP 等具体协议 (与其它 Tool 一致).
 */
export async function searchBilibiliVideos(
  rawInput: SearchVideosInput,
  dependencies: SearchVideosDependencies = {},
): Promise<SearchVideosOutput> {
  const input = SearchVideosInputSchema.parse(rawInput);
  // 默认签名器必须复用 Tool 注入的 fetchImpl: 否则 WBI 密钥请求绕过注入,
  // 单测无法完全离线, 网络错误语义也与搜索请求不一致 (评审 P2).
  const signer = dependencies.signer ?? new WbiSigner({
    cookie: dependencies.cookie,
    ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  const requestedAt = new Date().toISOString();
  const executedQuery = toExecutedQuery(input);

  const failedPageInfo = {
    page: input.page,
    pageSize: input.pageSize,
    returnedCount: 0,
    hasNextPage: false,
  };

  try {
    const raw = await searchVideoPage(
      {
        signer,
        ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {}),
        cookie: dependencies.cookie,
        baseUrl: dependencies.baseUrl,
      },
      {
        keyword: input.query,
        page: input.page,
        pageSize: input.pageSize,
        order: input.order,
        duration: input.duration,
      },
    );

    const normalized: NormalizedSearchVideoResults = normalizeSearchVideoResults(raw, {
      page: input.page,
      pageSize: input.pageSize,
    });

    const warnings = [...normalized.warnings];
    if (
      normalized.reportedTotal !== undefined
      && normalized.reportedTotal >= SEARCH_REPORTED_TOTAL_SOFT_CAP
    ) {
      warnings.push(
        `平台报告结果数 (${normalized.reportedTotal}) 已达到搜索接口常见上限 (约 ${SEARCH_REPORTED_TOTAL_SOFT_CAP})，`
        + "该数值可能不代表真实总数，不应作为全站相关视频总量使用",
      );
    }

    // 状态判定 (AGENTS_M7 §6.5):
    // - 有候选且无缺口 → success; 有候选但有缺口 → partial; 无候选 → missing.
    const hasCandidates = normalized.candidates.length > 0;
    const status: AcquisitionRecord["status"] = !hasCandidates
      ? "missing"
      : warnings.length > 0
        ? "partial"
        : "success";

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "video_candidates",
      status,
      source: "bilibili_web_api",
      requestedAt,
      completedAt: new Date().toISOString(),
      itemCount: normalized.candidates.length,
      message: !hasCandidates
        ? "搜索成功但没有匹配候选"
        : warnings.length > 0
          ? "搜索成功，但存在字段缺口或平台数值不可信"
          : "搜索成功",
      warnings,
      metadata: {
        keyword: input.query,
        page: input.page,
        pageSize: input.pageSize,
        order: input.order,
        rawReturnedCount: normalized.rawReturnedCount,
        reportedTotal: normalized.reportedTotal,
        platformPageSize: normalized.platformPageSize,
      },
    });

    return SearchVideosOutputSchema.parse({
      success: true,
      query: executedQuery,
      candidates: normalized.candidates,
      pageInfo: toPageInfo(input, normalized.rawReturnedCount, normalized.reportedTotal),
      ...(normalized.reportedTotal !== undefined
        ? { reportedTotal: normalized.reportedTotal }
        : {}),
      observedAt: new Date().toISOString(),
      acquisition,
    });
  } catch (error) {
    // 输入解析错误直接抛给调用方 (CLI 会转成 stderr JSON), 不是采集失败.
    const normalized = toBilibiliError(error);
    const completedAt = new Date().toISOString();

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "video_candidates",
      status: "failed",
      source: "bilibili_web_api",
      requestedAt,
      completedAt,
      reasonCode: normalized.code,
      message: `搜索失败: ${normalized.message}`,
      warnings: [],
      metadata: {
        keyword: input.query,
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });

    return SearchVideosOutputSchema.parse({
      success: false,
      query: executedQuery,
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

/** 重新导出 BilibiliError, 方便上层 import (与 comments Tool 保持一致). */
export { BilibiliError };
