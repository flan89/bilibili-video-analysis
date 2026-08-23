/**
 * scripts/discovery/hot-searches.ts: `bilibili.hot_searches` Tool 入口.
 *
 * M8 批次 B: 当前热搜词原子 Tool.
 * - 一次请求返回一组热搜词条; 词条不是视频, 输出独立 HotSearchTopic 模型;
 * - 原子边界 (AGENTS_M8 §9.4): 到返回热搜词即停止, 不自动把词提交给 search-videos,
 *   不选择"最值得研究"的词, 不根据词面生成事件解释, 不把 heatScore 换算成趋势;
 * - 不接受 Cookie: 热搜是公开快照, 不承诺个性化内容;
 * - 空列表 (missing) / 部分条目跳过 (partial) / 失败 (failed) 用结构化状态表达;
 * - HTTP 412 与业务 -352 统一表现为 hot_search_risk_control, retryable=true
 *   只表示稍后重试可能有意义, Tool 自身绝不自动重试.
 */
import { z } from "zod";

import { BilibiliError, toBilibiliError } from "../bilibili/errors.js";
import {
  fetchHotSearchList,
  normalizeHotSearchTopics,
} from "./bilibili-hot-search-adapter.js";
import { HotSearchTopicSchema } from "../models/discovery.js";
import { IsoDateTimeSchema } from "../models/common.js";
import { AcquisitionRecordSchema, type AcquisitionRecord } from "../models/acquisition.js";

/**
 * Tool 输入: 只有词条数量.
 * 第一版不提供分类、地区和历史时间参数 (AGENTS_M8 §9.2).
 */
export const HotSearchesInputSchema = z.object({
  /** 请求的词条数量, 默认 10, 第一版上限 10; 只影响一次请求的返回规模, 不触发额外请求. */
  limit: z.number().int().min(1).max(10).default(10),
});
export type HotSearchesInput = z.input<typeof HotSearchesInputSchema>;

/** Tool 失败时返回的稳定错误结构; 按需保留 HTTP 状态和 B 站业务码. */
export const HotSearchesToolErrorSchema = z.object({
  /** 稳定程序错误码, 例如 hot_search_risk_control / hot_search_http_error / hot_search_invalid_response. */
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
export type HotSearchesToolError = z.infer<typeof HotSearchesToolErrorSchema>;

/** `bilibili.hot_searches` 的无状态独立结果. */
export const HotSearchesOutputSchema = z.object({
  /** 是否得到可处理的热搜响应; 空列表也算 success=true (状态在 acquisition 里区分 missing). */
  success: z.boolean(),
  /** 当前热搜词条列表, 保留平台返回顺序; 空列表为 []. */
  topics: z.array(HotSearchTopicSchema).default([]),
  /** 本次结果的观察时间; 热搜是当前快照, 结论只覆盖该时间窗口. */
  observedAt: IsoDateTimeSchema,
  /** 平台自身报告的观察时间；来源未提供时缺省。 */
  platformObservedAt: IsoDateTimeSchema.optional(),
  /** 平台报告的词条总数；来源未提供时缺省。 */
  reportedTotal: z.number().int().nonnegative().optional(),
  /** 无论成功失败都必须返回本次采集记录. */
  acquisition: AcquisitionRecordSchema,
  /** 失败时的结构化错误; 成功时为空. */
  error: HotSearchesToolErrorSchema.optional(),
}).superRefine((output, context) => {
  if (!output.success && !output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "热搜获取失败结果必须包含 error",
    });
  }
  if (output.success && output.error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["error"],
      message: "热搜获取成功结果不应包含 error",
    });
  }
});
export type HotSearchesOutput = z.infer<typeof HotSearchesOutputSchema>;

/** 依赖注入主要用于单元测试. */
export interface HotSearchesDependencies {
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  /** API 根地址; 测试可替换. */
  baseUrl?: string;
}

/**
 * `bilibili.hot_searches` Tool 入口.
 *
 * Agent 框架只需要把输入映射到本函数, 再把返回 JSON 交给模型即可;
 * 这里刻意不绑定 OpenAI SDK、Pi、MCP 等具体协议 (与其它 Tool 一致).
 * Agent 要研究某个热搜词时, 应在读取结果后单独调用 search-videos 进入 M7 流程.
 */
export async function getBilibiliHotSearches(
  rawInput: HotSearchesInput,
  dependencies: HotSearchesDependencies = {},
): Promise<HotSearchesOutput> {
  const input = HotSearchesInputSchema.parse(rawInput);
  const requestedAt = new Date().toISOString();

  try {
    const raw = await fetchHotSearchList(
      {
        ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {}),
        baseUrl: dependencies.baseUrl,
      },
      { limit: input.limit },
    );

    const normalized = normalizeHotSearchTopics(raw);
    // limit 语义是确定性截取: 即使平台返回超出请求数量, 也只保留前 limit 条.
    const topics = normalized.topics.slice(0, input.limit);

    const warnings = [...normalized.warnings];

    // 状态判定 (与 popular 同构):
    // - 有词条且无缺口 → success; 有词条但有缺口 → partial; 无词条 → missing.
    const hasTopics = topics.length > 0;
    const status: AcquisitionRecord["status"] = !hasTopics
      ? "missing"
      : warnings.length > 0
        ? "partial"
        : "success";

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "hot_search_topics",
      status,
      source: "bilibili_web_api",
      requestedAt,
      completedAt: new Date().toISOString(),
      itemCount: topics.length,
      message: !hasTopics
        ? "热搜接口成功但没有返回词条"
        : warnings.length > 0
          ? "热搜列表获取成功，但存在字段缺口"
          : "热搜列表获取成功",
      warnings,
      metadata: {
        limit: input.limit,
        rawReturnedCount: normalized.rawReturnedCount,
        ...(normalized.traceId !== undefined ? { traceId: normalized.traceId } : {}),
        // 快照性质提示: 供 Agent 在回答中表述来源机制边界 (搜索关注度词条, 非事件背景).
        snapshotNature: "platform_hot_search_snapshot",
      },
    });

    return HotSearchesOutputSchema.parse({
      success: true,
      topics,
      observedAt: new Date().toISOString(),
      ...(normalized.platformObservedAt !== undefined
        ? { platformObservedAt: normalized.platformObservedAt }
        : {}),
      ...(normalized.reportedTotal !== undefined
        ? { reportedTotal: normalized.reportedTotal }
        : {}),
      acquisition,
    });
  } catch (error) {
    // 输入解析错误直接抛给调用方 (CLI 会转成 stderr JSON), 不是采集失败.
    const normalized = toBilibiliError(error);
    const completedAt = new Date().toISOString();

    const acquisition = AcquisitionRecordSchema.parse({
      dataKind: "hot_search_topics",
      status: "failed",
      source: "bilibili_web_api",
      requestedAt,
      completedAt,
      reasonCode: normalized.code,
      message: `热搜列表获取失败: ${normalized.message}`,
      warnings: [],
      metadata: {
        limit: input.limit,
        retryable: normalized.retryable,
        httpStatus: normalized.httpStatus,
        apiCode: normalized.apiCode,
      },
    });

    return HotSearchesOutputSchema.parse({
      success: false,
      topics: [],
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

/** 重新导出 BilibiliError, 方便上层 import (与其它发现来源 Tool 保持一致). */
export { BilibiliError };
