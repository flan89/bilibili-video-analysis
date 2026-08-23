/**
 * scripts/discovery/bilibili-search-adapter.ts: B 站视频搜索适配层.
 *
 * 职责:
 * 1. 把稳定业务参数 (order / duration / page / pageSize) 映射为 B 站原始参数;
 * 2. WBI 签名 + fetch 拉取 x/web-interface/wbi/search/type 一页响应;
 * 3. 原始字段 → VideoCandidate 标准化: 去高亮标记 / arcurl 规范化 /
 *    时长字符串解析 / "--" 统计转换 / 逗号标签拆分;
 * 4. 不提供发布时间本地过滤，避免只过滤当前页却产生错误的“无结果”语义.
 *
 * D12 边界: B 站原始字段只存在于 bilibili- 前缀的 adapter / raw-schema 文件;
 * Tool / 分析侧只依赖 models/discovery.ts.
 * D24: 一次调用只处理一个搜索词的一页结果, 翻页和多搜索词由 Agent 决定.
 */
import { BilibiliError } from "../bilibili/errors.js";
import type { WbiSigner } from "../bilibili/wbi.js";
import {
  BVID_PATTERN,
  normalizeProtocolRelativeUrl,
  toCount,
} from "./bilibili-discovery-helpers.js";
import {
  type RawSearchResponse,
  type RawSearchVideoItem,
  RawSearchVideoItemSchema,
  decodeSearchResponse,
} from "./bilibili-search-raw-schema.js";
import {
  type SearchDurationFilter,
  type SearchOrder,
  type VideoCandidate,
  VideoCandidateSchema,
} from "../models/discovery.js";

/* -------- 稳定参数 → B 站原始参数映射 -------- */

/** 排序映射: 稳定语义 → B 站 web 搜索 order 值. */
export const SEARCH_ORDER_TO_RAW: Record<SearchOrder, string> = {
  relevance: "totalrank",
  latest: "pubdate",
  views: "click",
  danmaku: "dm",
  favorites: "stow",
};

/** 时长筛选映射: 稳定语义 → B 站搜索 duration 区间值. */
export const SEARCH_DURATION_TO_RAW: Record<SearchDurationFilter, number> = {
  under_10m: 1,
  "10_to_30m": 2,
  "30_to_60m": 3,
  over_60m: 4,
};

/* -------- 确定性清理工具 -------- */

/** 平台高亮标记, 例如 <em class="keyword">xxx</em>. */
const HIGHLIGHT_TAG_PATTERN = /<\/?em[^>]*>/gi;

/** 去掉标题/简介中的平台高亮标记, 保留内文. */
export function stripHighlightTags(text: string): string {
  return text.replace(HIGHLIGHT_TAG_PATTERN, "").trim();
}

// BV 号校验 / 协议相对地址规范化 / 数值转换已提取到 bilibili-discovery-helpers.ts,
// 供热门与关联推荐来源复用 (M8); 这里保持原有导出, 现有调用方与测试不受影响.
export { normalizeProtocolRelativeUrl, toCount };

/** 从 arcurl 提取 BV 号; 接受协议相对地址和完整 URL. */
export function extractBvidFromArcurl(arcurl: string): string | undefined {
  const match = arcurl.match(/BV[0-9A-Za-z]{10}/);
  return match?.[0];
}

/**
 * 把 B 站时长字符串解析成秒; 非法格式返回 undefined.
 *
 * 平台约定 (2026-08 真实响应取证, 如 "303:15" = 5小时3分15秒):
 * 两段格式是「总分钟:秒」, 分钟段可能超过 60 且不进位为小时;
 * 三段格式才是「时:分:秒」. 逐段 *60 累加的写法对两种格式均成立.
 */
export function parseDurationToSeconds(text: string): number | undefined {
  const parts = text.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }
  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + part;
  }
  return seconds;
}

/* -------- 单条 raw → VideoCandidate -------- */

/**
 * 把单条搜索结果标准化为 VideoCandidate.
 * 返回 undefined 表示该条目无法定位视频身份 (无有效 bvid), 由调用方过滤并计数.
 */
function candidateFromRaw(item: RawSearchVideoItem, position: number): VideoCandidate | undefined {
  const bvid = item.bvid !== undefined && BVID_PATTERN.test(item.bvid)
    ? item.bvid
    : (item.arcurl !== undefined ? extractBvidFromArcurl(item.arcurl) : undefined);
  if (bvid === undefined) {
    return undefined;
  }

  // 当前真实响应使用 pic；picture 只作为历史或其它响应形态的兼容兜底。
  const rawCoverUrl = item.pic ?? item.picture;
  const coverUrl = rawCoverUrl !== undefined ? normalizeProtocolRelativeUrl(rawCoverUrl) : undefined;
  const avatarUrl = item.upic !== undefined ? normalizeProtocolRelativeUrl(item.upic) : undefined;

  const stats = {
    viewCount: toCount(item.play),
    danmakuCount: toCount(item.video_review),
    favoriteCount: toCount(item.favorites),
  };
  const hasStats = stats.viewCount !== undefined
    || stats.danmakuCount !== undefined
    || stats.favoriteCount !== undefined;

  const parsed = VideoCandidateSchema.safeParse({
    video: { bvid },
    title: stripHighlightTags(item.title),
    description: item.description !== undefined ? stripHighlightTags(item.description) : undefined,
    author: item.author !== undefined || item.mid !== undefined
      ? {
        userId: item.mid !== undefined ? String(item.mid) : undefined,
        name: item.author,
        ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      }
      : undefined,
    // pubdate 真实响应可能是字符串形式的 Unix 秒, toCount 统一转为 number.
    publishedAt: toCount(item.pubdate),
    durationSeconds: item.duration !== undefined ? parseDurationToSeconds(item.duration) : undefined,
    ...(coverUrl !== undefined ? { coverUrl } : {}),
    tags: item.tag !== undefined
      ? item.tag.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
      : [],
    ...(hasStats ? { stats } : {}),
    position,
    sourceUrl: `https://www.bilibili.com/video/${bvid}/`,
  });
  if (!parsed.success) {
    // 理论上只有 title 清理后为空等极端情况会走到这里.
    return undefined;
  }
  return parsed.data;
}

/* -------- 整页响应 → 标准化候选列表 -------- */

/** normalizeSearchVideoResults 的选项. */
export interface NormalizeSearchVideoOptions {
  /** 当前页码, 只用于记录, 不参与标准化. */
  page: number;
  /** 请求的每页数量, 只用于记录, 不参与标准化. */
  pageSize: number;
}

/** normalizeSearchVideoResults 的结果. */
export interface NormalizedSearchVideoResults {
  /** 标准化候选列表 (已完成高亮清理与 URL 规范化). */
  candidates: VideoCandidate[];
  /** 本页原始返回条数 (确定性整理前), 用于估计是否还有下一页. */
  rawReturnedCount: number;
  /** 平台报告的结果总数; 只能解释为当前接口报告值, 不等于全站精确总数. */
  reportedTotal: number | undefined;
  /** 平台实际使用的每页数量; 与请求值不一致时说明平台忽略了请求参数. */
  platformPageSize: number | undefined;
  /** 确定性整理过程中的非致命问题说明 (会进入 acquisition.warnings). */
  warnings: string[];
}

/**
 * 把一页搜索响应标准化为候选列表.
 *
 * 不调用详情接口补齐字段, 不计算任何隐藏质量分;
 * 被跳过/过滤的条目都会在 warnings 中计数说明, 不静默丢弃.
 */
export function normalizeSearchVideoResults(
  raw: RawSearchResponse,
  options: NormalizeSearchVideoOptions,
): NormalizedSearchVideoResults {
  const items = raw.data?.result ?? [];
  const rawReturnedCount = items.length;

  const candidates: VideoCandidate[] = [];
  let unparseableCount = 0;
  let nonVideoCount = 0;
  let noBvidCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    // position 保留原始页内位置 (含被跳过的条目), 便于回查当前搜索结果页.
    const position = index + 1;
    const itemResult = RawSearchVideoItemSchema.safeParse(items[index]);
    if (!itemResult.success) {
      unparseableCount += 1;
      continue;
    }
    const item = itemResult.data;
    if (item.type !== undefined && item.type !== "video") {
      nonVideoCount += 1;
      continue;
    }

    const candidate = candidateFromRaw(item, position);
    if (candidate === undefined) {
      noBvidCount += 1;
      continue;
    }

    candidates.push(candidate);
  }

  // 所有条目都无法按视频条目解析时, 视为原始结构变化, 让 Tool 走 failed,
  // 而不是把结构异常伪装成"搜索成功但无结果".
  if (rawReturnedCount > 0 && unparseableCount === rawReturnedCount) {
    throw new BilibiliError({
      code: "search_invalid_response",
      message: `B 站搜索返回 ${rawReturnedCount} 条结果, 但全部无法按视频条目解析`,
    });
  }

  const warnings: string[] = [];
  if (unparseableCount > 0) {
    warnings.push(`${unparseableCount} 条搜索结果条目结构与预期不一致，已跳过`);
  }
  if (nonVideoCount > 0) {
    warnings.push(`${nonVideoCount} 条搜索结果不是视频条目，已跳过`);
  }
  if (noBvidCount > 0) {
    warnings.push(`${noBvidCount} 条搜索结果无法提取 BV 号，已跳过`);
  }

  return {
    candidates,
    rawReturnedCount,
    reportedTotal: raw.data?.numResults,
    platformPageSize: raw.data?.pagesize,
    warnings,
  };
}

/* -------- WBI 签名 + fetch 拉取一页 -------- */

/** search 专用依赖上下文, 与 comments-adapter 的 FetchContext 同构 (不跨目录共享类型). */
export interface SearchFetchContext {
  /** WBI 签名器; 搜索接口必须签名, 否则被 -403 拒绝. */
  signer: WbiSigner;
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  cookie?: string;
  baseUrl?: string;
}

/** 一页搜索的请求参数 (已映射为稳定语义). */
export interface SearchVideoPageParams {
  /** 单个搜索词. */
  keyword: string;
  /** 页码, 从 1 开始. */
  page: number;
  /** 每页数量. */
  pageSize: number;
  /** 排序. */
  order: SearchOrder;
  /** 时长筛选. */
  duration?: SearchDurationFilter;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const DEFAULT_BASE = "https://api.bilibili.com/";
/** 请求超时; 与 BilibiliClient 默认值保持一致, 两段 fetch (WBI 密钥 + 搜索) 统一控制. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 把签名阶段的错误统一成搜索域错误.
 *
 * WbiSigner 内部会请求 x/web-interface/nav 拿 WBI 密钥, 网络失败时抛原生
 * TypeError; 这里统一归类为 search_network_error, 不让签名阶段错误退化成
 * unexpected_error (评审 P2). WbiSigner 抛出的结构化 BilibiliError 原样透传.
 */
function toSignError(error: unknown): BilibiliError {
  if (error instanceof BilibiliError) {
    return error;
  }
  return new BilibiliError({
    code: "search_network_error",
    message: `B 站搜索 WBI 签名失败: ${error instanceof Error ? error.message : String(error)}`,
    retryable: true,
    cause: error,
  });
}

/**
 * 拉取 x/web-interface/wbi/search/type 一页响应 (已 decode + 校验).
 *
 * HTTP 412 与业务 code -412 统一转成 search_risk_control (retryable=true);
 * retryable=true 只表示稍后重试可能有意义, 是否重试由 Agent 决定,
 * 本函数绝不自动重试 (见 AGENTS_M7 §6.5).
 */
export async function searchVideoPage(
  ctx: SearchFetchContext,
  params: SearchVideoPageParams,
): Promise<RawSearchResponse> {
  let signed: string;
  try {
    signed = await ctx.signer.signRequest(undefined, {
      search_type: "video",
      keyword: params.keyword,
      page: params.page,
      page_size: params.pageSize,
      order: SEARCH_ORDER_TO_RAW[params.order],
      ...(params.duration !== undefined
        ? { duration: SEARCH_DURATION_TO_RAW[params.duration] }
        : {}),
    });
  } catch (error) {
    throw toSignError(error);
  }
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE;
  const url = `${baseUrl}x/web-interface/wbi/search/type?${signed}`;
  return await fetchAndParse(ctx, url);
}

/** fetch + decode + envelope 错误转换; 不在这里做业务标准化. */
async function fetchAndParse(ctx: SearchFetchContext, url: string): Promise<RawSearchResponse> {
  // 与 BilibiliClient 一致的超时控制: 避免搜索请求无限挂起.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (ctx.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": ctx.userAgent ?? DEFAULT_UA,
        ...(ctx.cookie ? { cookie: ctx.cookie } : {}),
        Referer: "https://www.bilibili.com/",
      },
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new BilibiliError({
      code: "search_network_error",
      message: timedOut
        ? `B 站搜索接口请求超时（${REQUEST_TIMEOUT_MS}ms）`
        : `B 站搜索接口网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 412) {
    throw new BilibiliError({
      code: "search_risk_control",
      message: "B 站搜索接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
      httpStatus: 412,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new BilibiliError({
      code: "search_http_error",
      message: `B 站搜索接口请求失败，HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new BilibiliError({
      code: "search_invalid_json",
      message: "B 站搜索接口没有返回有效 JSON",
      httpStatus: response.status,
      cause: error,
    });
  }

  let decoded: RawSearchResponse;
  try {
    decoded = decodeSearchResponse(json);
  } catch (error) {
    throw new BilibiliError({
      code: "search_invalid_response",
      message: "B 站搜索响应结构与当前适配器预期不一致",
      cause: error,
    });
  }

  if (decoded.code === -412) {
    throw new BilibiliError({
      code: "search_risk_control",
      message: `B 站搜索接口触发风控 (code=${decoded.code})`,
      apiCode: decoded.code,
      retryable: true,
    });
  }
  if (decoded.code !== 0) {
    throw new BilibiliError({
      code: "search_api_error",
      message: `B 站搜索接口返回错误 code=${decoded.code}: ${decoded.message ?? decoded.msg ?? "未知错误"}`,
      apiCode: decoded.code,
      retryable: decoded.code === -509,
    });
  }
  return decoded;
}
