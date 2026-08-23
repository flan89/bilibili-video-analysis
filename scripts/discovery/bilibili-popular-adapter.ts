/**
 * scripts/discovery/bilibili-popular-adapter.ts: B 站当前热门适配层.
 *
 * 职责:
 * 1. fetch 拉取 x/web-interface/popular 一页响应 (无需 WBI 签名);
 * 2. 原始视频详情卡片 → VideoCandidate 标准化: URL 规范化 / 统计转换 /
 *    推荐理由文本提取 / 分区最小信息;
 * 3. 结构化失败: HTTP 412 与业务 -352 统一为 popular_risk_control.
 *
 * D12 边界: B 站原始字段只存在于 bilibili- 前缀的 adapter / raw-schema 文件;
 * Tool / 分析侧只依赖 models/discovery.ts.
 * M8 §8: 热门列表是平台热门机制的当前快照, 不是全站客观排名;
 * 适配层不做任何质量打分或排序调整, 原样保留平台返回顺序.
 */
import { BilibiliError } from "../bilibili/errors.js";
import {
  BVID_PATTERN,
  normalizeProtocolRelativeUrl,
  toCount,
} from "./bilibili-discovery-helpers.js";
import {
  type RawPopularReason,
  type RawPopularResponse,
  type RawPopularVideoItem,
  RawPopularVideoItemSchema,
  decodePopularResponse,
} from "./bilibili-popular-raw-schema.js";
import {
  type VideoCandidate,
  VideoCandidateSchema,
} from "../models/discovery.js";

/* -------- 确定性清理工具 -------- */

/** 提取推荐理由文本; 空字符串或无效形态返回 undefined (不写空标签). */
export function extractDiscoveryReason(reason: RawPopularReason | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const text = typeof reason === "string" ? reason : reason.content;
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 把热门接口的 duration (通常为秒数值, 兼容字符串形式数字) 转成非负秒数. */
export function popularDurationToSeconds(raw: number | string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

/* -------- 单条 raw → VideoCandidate -------- */

/**
 * 把单条热门条目标准化为 VideoCandidate.
 * 返回 undefined 表示该条目无法定位视频身份 (无有效 bvid) 或缺标题, 由调用方过滤并计数.
 */
function candidateFromRaw(item: RawPopularVideoItem, position: number): VideoCandidate | undefined {
  if (item.bvid === undefined || !BVID_PATTERN.test(item.bvid)) {
    return undefined;
  }
  const title = item.title?.trim();
  if (!title) {
    return undefined;
  }

  const coverUrl = item.pic !== undefined ? normalizeProtocolRelativeUrl(item.pic) : undefined;
  const avatarUrl = item.owner?.face !== undefined
    ? normalizeProtocolRelativeUrl(item.owner.face)
    : undefined;

  const stat = item.stat;
  const stats = {
    viewCount: toCount(stat?.view),
    danmakuCount: toCount(stat?.danmaku),
    favoriteCount: toCount(stat?.favorite),
    likeCount: toCount(stat?.like),
    replyCount: toCount(stat?.reply),
    coinCount: toCount(stat?.coin),
    shareCount: toCount(stat?.share),
  };
  const hasStats = Object.values(stats).some((value) => value !== undefined);

  const categoryId = toCount(item.tid);
  const categoryName = item.tname?.trim();
  const hasCategory = categoryId !== undefined || (categoryName !== undefined && categoryName.length > 0);

  const discoveryReason = extractDiscoveryReason(item.rcmd_reason);

  const parsed = VideoCandidateSchema.safeParse({
    video: { bvid: item.bvid },
    title,
    ...(item.desc !== undefined && item.desc.trim().length > 0 ? { description: item.desc.trim() } : {}),
    ...(item.owner !== undefined
      ? {
          author: {
            userId: item.owner.mid !== undefined ? String(item.owner.mid) : undefined,
            name: item.owner.name,
            ...(avatarUrl !== undefined ? { avatarUrl } : {}),
          },
        }
      : {}),
    publishedAt: toCount(item.pubdate),
    durationSeconds: popularDurationToSeconds(item.duration),
    ...(coverUrl !== undefined ? { coverUrl } : {}),
    tags: [],
    ...(hasStats ? { stats } : {}),
    position,
    sourceUrl: `https://www.bilibili.com/video/${item.bvid}/`,
    ...(hasCategory
      ? {
          category: {
            ...(categoryId !== undefined ? { id: categoryId } : {}),
            ...(categoryName !== undefined && categoryName.length > 0 ? { name: categoryName } : {}),
          },
        }
      : {}),
    ...(discoveryReason !== undefined ? { discoveryReason } : {}),
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

/* -------- 整页响应 → 标准化候选列表 -------- */

/** normalizePopularResults 的结果. */
export interface NormalizedPopularResults {
  /** 标准化候选列表, 保留平台返回顺序. */
  candidates: VideoCandidate[];
  /** 本页原始返回条数 (确定性整理前), 含被跳过条目. */
  rawReturnedCount: number;
  /** 平台是否声明已无更多热门条目; 缺失时按满页保守估计. */
  noMore: boolean | undefined;
  /** 确定性整理过程中的非致命问题说明 (会进入 acquisition.warnings). */
  warnings: string[];
}

/**
 * 把一页热门响应标准化为候选列表.
 *
 * 不调用详情接口补齐字段, 不计算任何隐藏质量分;
 * 被跳过的条目都会在 warnings 中计数说明, 不静默丢弃.
 */
export function normalizePopularResults(raw: RawPopularResponse): NormalizedPopularResults {
  const items = raw.data?.list ?? [];
  const rawReturnedCount = items.length;

  const candidates: VideoCandidate[] = [];
  let unparseableCount = 0;
  let skippedCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    // position 保留原始页内位置 (含被跳过的条目), 便于回查当前热门页面.
    const position = index + 1;
    const itemResult = RawPopularVideoItemSchema.safeParse(items[index]);
    if (!itemResult.success) {
      unparseableCount += 1;
      continue;
    }
    const candidate = candidateFromRaw(itemResult.data, position);
    if (candidate === undefined) {
      skippedCount += 1;
      continue;
    }
    candidates.push(candidate);
  }

  // 所有条目都无法按视频条目解析时, 视为原始结构变化, 让 Tool 走 failed,
  // 而不是把结构异常伪装成"热门列表为空".
  if (
    rawReturnedCount > 0
    && candidates.length === 0
    && unparseableCount + skippedCount === rawReturnedCount
  ) {
    throw new BilibiliError({
      code: "popular_invalid_response",
      message: `B 站热门接口返回 ${rawReturnedCount} 条结果, 但全部无法按视频条目解析`,
    });
  }

  const warnings: string[] = [];
  if (unparseableCount > 0) {
    warnings.push(`${unparseableCount} 条热门条目结构与预期不一致，已跳过`);
  }
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} 条热门条目缺少 BV 号或标题，已跳过`);
  }

  return {
    candidates,
    rawReturnedCount,
    noMore: raw.data?.no_more,
    warnings,
  };
}

/* -------- fetch 拉取一页 -------- */

/** popular 专用依赖上下文, 与 search-adapter 的 SearchFetchContext 同构 (不跨目录共享类型). */
export interface PopularFetchContext {
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  baseUrl?: string;
}

/** 一页热门的请求参数. */
export interface PopularVideoPageParams {
  /** 页码, 从 1 开始. */
  page: number;
  /** 每页数量. */
  pageSize: number;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const DEFAULT_BASE = "https://api.bilibili.com/";
/** 热门页面 Referer: 缺少 UA/Referer 时平台实测返回业务 -352 (AGENTS_M8 §8.4). */
const POPULAR_REFERER = "https://www.bilibili.com/v/popular/all";
/** 请求超时; 与 BilibiliClient / 搜索适配层保持一致. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 拉取 x/web-interface/popular 一页响应 (已 decode + 校验).
 *
 * HTTP 412 与业务 code -352/-412 统一转成 popular_risk_control (retryable=true);
 * retryable=true 只表示稍后重试可能有意义, Tool 绝不自动重试 (AGENTS_M8 §14.2).
 */
export async function fetchPopularPage(
  ctx: PopularFetchContext,
  params: PopularVideoPageParams,
): Promise<RawPopularResponse> {
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE;
  const url = `${baseUrl}x/web-interface/popular?ps=${params.pageSize}&pn=${params.page}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (ctx.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": ctx.userAgent ?? DEFAULT_UA,
        Referer: POPULAR_REFERER,
      },
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new BilibiliError({
      code: "popular_network_error",
      message: timedOut
        ? `B 站热门接口请求超时（${REQUEST_TIMEOUT_MS}ms）`
        : `B 站热门接口网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 412) {
    throw new BilibiliError({
      code: "popular_risk_control",
      message: "B 站热门接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
      httpStatus: 412,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new BilibiliError({
      code: "popular_http_error",
      message: `B 站热门接口请求失败，HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new BilibiliError({
      code: "popular_invalid_json",
      message: "B 站热门接口没有返回有效 JSON",
      httpStatus: response.status,
      cause: error,
    });
  }

  let decoded: RawPopularResponse;
  try {
    decoded = decodePopularResponse(json);
  } catch (error) {
    throw new BilibiliError({
      code: "popular_invalid_response",
      message: "B 站热门响应结构与当前适配器预期不一致",
      cause: error,
    });
  }

  // -352 常见于缺少普通浏览器请求头; -412 是通用风控码. 都按来源风控处理.
  if (decoded.code === -352 || decoded.code === -412) {
    throw new BilibiliError({
      code: "popular_risk_control",
      message: `B 站热门接口触发风控 (code=${decoded.code})，稍后重试可能恢复，但不应立即连续重试`,
      apiCode: decoded.code,
      retryable: true,
    });
  }
  if (decoded.code !== 0) {
    throw new BilibiliError({
      code: "popular_api_error",
      message: `B 站热门接口返回错误 code=${decoded.code}: ${decoded.message ?? "未知错误"}`,
      apiCode: decoded.code,
      retryable: decoded.code === -509,
    });
  }
  return decoded;
}
