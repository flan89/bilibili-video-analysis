/**
 * scripts/discovery/bilibili-hot-search-adapter.ts: B 站热搜适配层.
 *
 * 职责:
 * 1. fetch 拉取 s.search.bilibili.com/main/hotword 一次响应 (无需 WBI 签名);
 * 2. 原始热搜词条 → HotSearchTopic 标准化: 展示名清理 / 图标规范化 /
 *    热度值转换 / 商业标记原样保留;
 * 3. 结构化失败: HTTP 412 与业务 -352/-412 统一为 hot_search_risk_control.
 *
 * D12 边界: B 站原始字段只存在于 bilibili- 前缀的 adapter / raw-schema 文件;
 * Tool / 分析侧只依赖 models/discovery.ts 的 HotSearchTopic.
 * M8 §9.4: Tool 到返回热搜词即停止, 适配层不自动展开搜索、不选择"最值得研究"的词、
 * 不根据词面生成事件解释, 也不把 heatScore 换算成跨日期趋势.
 */
import { BilibiliError } from "../bilibili/errors.js";
import {
  normalizeProtocolRelativeUrl,
  toCount,
} from "./bilibili-discovery-helpers.js";
import {
  type RawHotSearchItem,
  type RawHotSearchResponse,
  RawHotSearchItemSchema,
  decodeHotSearchResponse,
} from "./bilibili-hot-search-raw-schema.js";
import {
  type HotSearchTopic,
  HotSearchTopicSchema,
} from "../models/discovery.js";

/* -------- 单条 raw → HotSearchTopic -------- */

/**
 * 把单条热搜词条标准化为 HotSearchTopic.
 * 返回 undefined 表示该条目缺少可用搜索词 (keyword 为空), 由调用方过滤并计数.
 */
function topicFromRaw(item: RawHotSearchItem, position: number): HotSearchTopic | undefined {
  const keyword = item.keyword?.trim();
  if (!keyword) {
    return undefined;
  }

  const displayName = item.show_name?.trim();
  const iconUrl = item.icon !== undefined && item.icon.trim().length > 0
    ? normalizeProtocolRelativeUrl(item.icon.trim())
    : undefined;
  const platformPosition = toCount(item.pos);
  const heatLevel = item.heat_layer?.trim();
  const commercialRaw = item.stat_datas?.is_commercial;
  const isCommercial = commercialRaw === undefined
    ? undefined
    : commercialRaw === true || commercialRaw === 1 || commercialRaw === "1";

  const parsed = HotSearchTopicSchema.safeParse({
    keyword,
    ...(displayName !== undefined && displayName.length > 0 ? { displayName } : {}),
    position: platformPosition !== undefined && platformPosition > 0 ? platformPosition : position,
    heatScore: toCount(item.heat_score),
    ...(heatLevel !== undefined && heatLevel.length > 0 ? { heatLevel } : {}),
    ...(isCommercial !== undefined ? { isCommercial } : {}),
    ...(iconUrl !== undefined ? { iconUrl } : {}),
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

/* -------- 整份响应 → 标准化词条列表 -------- */

/** normalizeHotSearchTopics 的结果. */
export interface NormalizedHotSearchTopics {
  /** 标准化词条列表, 保留平台返回顺序. */
  topics: HotSearchTopic[];
  /** 本次原始返回条数 (确定性整理前), 含被跳过条目. */
  rawReturnedCount: number;
  /** 平台响应标识; 供回查本次快照. */
  traceId: string | undefined;
  /** 平台报告的快照时间。 */
  platformObservedAt: string | undefined;
  /** 平台报告的词条总数。 */
  reportedTotal: number | undefined;
  /** 确定性整理过程中的非致命问题说明 (会进入 acquisition.warnings). */
  warnings: string[];
}

/**
 * 把一次热搜响应标准化为词条列表.
 *
 * 不展开任何词条为视频搜索, 不计算词条之间的相对重要性;
 * 被跳过的条目都会在 warnings 中计数说明, 不静默丢弃.
 */
export function normalizeHotSearchTopics(raw: RawHotSearchResponse): NormalizedHotSearchTopics {
  // 置顶词条不能被静默忽略；放在普通列表之前，条目自身有 pos 时仍优先保留平台位置。
  const items = [...raw.top_list, ...raw.list];
  const rawReturnedCount = items.length;

  const topics: HotSearchTopic[] = [];
  let unparseableCount = 0;
  let skippedCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    // position 保留列表内原始位置 (含被跳过的条目), 便于回查当前热搜页面.
    const position = index + 1;
    const itemResult = RawHotSearchItemSchema.safeParse(items[index]);
    if (!itemResult.success) {
      unparseableCount += 1;
      continue;
    }
    const topic = topicFromRaw(itemResult.data, position);
    if (topic === undefined) {
      skippedCount += 1;
      continue;
    }
    topics.push(topic);
  }

  // 所有条目都无法按热搜词条解析时, 视为原始结构变化, 让 Tool 走 failed,
  // 而不是把结构异常伪装成"热搜为空".
  if (
    rawReturnedCount > 0
    && topics.length === 0
    && unparseableCount + skippedCount === rawReturnedCount
  ) {
    throw new BilibiliError({
      code: "hot_search_invalid_response",
      message: `B 站热搜接口返回 ${rawReturnedCount} 条结果, 但全部无法按热搜词条解析`,
    });
  }

  const warnings: string[] = [];
  if (unparseableCount > 0) {
    warnings.push(`${unparseableCount} 条热搜词条结构与预期不一致，已跳过`);
  }
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} 条热搜词条缺少可用搜索词，已跳过`);
  }

  const timestamp = toCount(raw.timestamp);
  const reportedTotal = toCount(raw.total_count);
  return {
    topics,
    rawReturnedCount,
    traceId: raw.seid !== undefined ? String(raw.seid) : undefined,
    platformObservedAt: timestamp !== undefined
      ? new Date(timestamp * 1000).toISOString()
      : undefined,
    reportedTotal,
    warnings,
  };
}

/* -------- fetch 拉取一次热搜 -------- */

/** hot-search 专用依赖上下文, 与 popular-adapter 的 PopularFetchContext 同构. */
export interface HotSearchFetchContext {
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  baseUrl?: string;
}

/** 一次热搜请求的参数. */
export interface HotSearchParams {
  /** Tool 最终保留的词条数量；当前来源不接收该参数，由 Tool 在本地截取。 */
  limit: number;
}

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const DEFAULT_BASE = "https://s.search.bilibili.com/";
/** 热搜来自首页搜索框; 实测无 Referer 也可返回, 仍统一携带保持一致. */
const HOT_SEARCH_REFERER = "https://www.bilibili.com/";
/** 请求超时; 与其它发现来源适配层保持一致. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 拉取 main/hotword 一次响应 (已 decode + 校验).
 *
 * HTTP 412 与业务 code -352/-412 统一转成 hot_search_risk_control (retryable=true);
 * retryable=true 只表示稍后重试可能有意义, Tool 绝不自动重试 (AGENTS_M8 §14.2).
 */
export async function fetchHotSearchList(
  ctx: HotSearchFetchContext,
  params: HotSearchParams,
): Promise<RawHotSearchResponse> {
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE;
  // limit 是稳定 Tool 契约的一部分，但平台端点不接收该参数；调用方会在标准化后本地截取。
  void params.limit;
  const url = new URL("main/hotword", baseUrl).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (ctx.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": ctx.userAgent ?? DEFAULT_UA,
        Referer: HOT_SEARCH_REFERER,
      },
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new BilibiliError({
      code: "hot_search_network_error",
      message: timedOut
        ? `B 站热搜接口请求超时（${REQUEST_TIMEOUT_MS}ms）`
        : `B 站热搜接口网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 412) {
    throw new BilibiliError({
      code: "hot_search_risk_control",
      message: "B 站热搜接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
      httpStatus: 412,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new BilibiliError({
      code: "hot_search_http_error",
      message: `B 站热搜接口请求失败，HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new BilibiliError({
      code: "hot_search_invalid_json",
      message: "B 站热搜接口没有返回有效 JSON",
      httpStatus: response.status,
      cause: error,
    });
  }

  let decoded: RawHotSearchResponse;
  try {
    decoded = decodeHotSearchResponse(json);
  } catch (error) {
    throw new BilibiliError({
      code: "hot_search_invalid_response",
      message: "B 站热搜响应结构与当前适配器预期不一致",
      cause: error,
    });
  }

  // -352 常见于缺少普通浏览器请求头; -412 是通用风控码. 都按来源风控处理.
  if (decoded.code === -352 || decoded.code === -412) {
    throw new BilibiliError({
      code: "hot_search_risk_control",
      message: `B 站热搜接口触发风控 (code=${decoded.code})，稍后重试可能恢复，但不应立即连续重试`,
      apiCode: decoded.code,
      retryable: true,
    });
  }
  if (decoded.code !== 0) {
    throw new BilibiliError({
      code: "hot_search_api_error",
      message: `B 站热搜接口返回错误 code=${decoded.code}: ${decoded.message ?? "未知错误"}`,
      apiCode: decoded.code,
      retryable: decoded.code === -509,
    });
  }
  return decoded;
}
