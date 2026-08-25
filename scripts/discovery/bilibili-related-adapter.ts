/**
 * scripts/discovery/bilibili-related-adapter.ts: B 站关联推荐适配层.
 *
 * 职责:
 * 1. fetch 拉取 x/web-interface/archive/related 单次响应 (无分页契约);
 * 2. 原始视频详情卡片 → VideoCandidate 标准化: URL 规范化 / 统计转换 /
 *    分区最小信息; 种子视频自身确定性过滤, 相同 BV 号只保留首次出现;
 * 3. 结构化失败: HTTP 412 与业务 -352/-412 统一为 related_risk_control.
 *
 * D12 边界: B 站原始字段只存在于 bilibili- 前缀的 adapter / raw-schema 文件;
 * Tool / 分析侧只依赖 models/discovery.ts.
 * M8 §10: 关联推荐表达平台推荐邻接关系, 不保证主题等价或观点相关;
 * 适配层不做任何相关性判断、质量打分或排序调整, 原样保留平台返回顺序.
 */
import { BilibiliError } from "../bilibili/errors.js";
import {
  BVID_PATTERN,
  normalizeProtocolRelativeUrl,
  toCount,
} from "./bilibili-discovery-helpers.js";
import {
  type RawRelatedResponse,
  type RawRelatedVideoItem,
  RawRelatedVideoItemSchema,
  decodeRelatedResponse,
} from "./bilibili-related-raw-schema.js";
import {
  type VideoCandidate,
  VideoCandidateSchema,
} from "../models/discovery.js";

/* -------- 单条 raw → VideoCandidate -------- */

/**
 * 把单条关联条目标准化为 VideoCandidate.
 * 返回 undefined 表示该条目无法定位视频身份 (无有效 bvid, 例如 OGV 番剧条目)
 * 或缺标题, 由调用方过滤并计数.
 */
function candidateFromRaw(item: RawRelatedVideoItem, position: number): VideoCandidate | undefined {
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

  // 推荐理由: 2026-08 实测该接口恒返回空字符串; 空字符串不写 discoveryReason.
  const reason = item.rcmd_reason?.trim();
  const discoveryReason = reason !== undefined && reason.length > 0 ? reason : undefined;

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
    durationSeconds: toCount(item.duration),
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

/* -------- 整体响应 → 标准化候选列表 -------- */

/** normalizeRelatedResults 的结果. */
export interface NormalizedRelatedResults {
  /** 标准化候选列表, 保留平台返回顺序; 已过滤种子自身与重复 BV 号. */
  candidates: VideoCandidate[];
  /** 平台原始返回条数 (确定性整理前), 含被跳过条目. */
  rawReturnedCount: number;
  /** 平台意外返回种子视频自身并被过滤的次数. */
  seedFilteredCount: number;
  /** 因重复 BV 号被去掉的条目数 (保留首次出现). */
  duplicateRemovedCount: number;
  /** 确定性整理过程中的非致命问题说明 (会进入 acquisition.warnings). */
  warnings: string[];
}

/** Tool 已解析出的种子身份；av 输入时只有 aid，不额外请求详情接口换取 bvid。 */
export interface RelatedSeedIdentity {
  bvid?: string;
  aid?: string;
}

/**
 * 把一次关联推荐响应标准化为候选列表 (AGENTS_M8 §10.4).
 *
 * - 种子视频自身被平台返回时确定性过滤并计数;
 * - 相同 BV 号只保留第一次出现, position 保留原始列表位置;
 * - 不调用详情接口补齐字段, 不计算任何隐藏质量分;
 * - 被跳过的条目都会在 warnings 中计数说明, 不静默丢弃.
 *
 * @param seedIdentity 种子视频可用身份；按 bvid 优先、aid 次之过滤种子自身。
 */
export function normalizeRelatedResults(
  raw: RawRelatedResponse,
  seedIdentity: RelatedSeedIdentity,
): NormalizedRelatedResults {
  const items = raw.data;
  const rawReturnedCount = items.length;

  const candidates: VideoCandidate[] = [];
  const seenBvids = new Set<string>();
  let unparseableCount = 0;
  let skippedCount = 0;
  let seedFilteredCount = 0;
  let duplicateRemovedCount = 0;
  let unsafeAidComparisonCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    // position 保留原始列表位置 (含被跳过的条目), 便于回查该次关联推荐.
    const position = index + 1;
    const itemResult = RawRelatedVideoItemSchema.safeParse(items[index]);
    if (!itemResult.success) {
      unparseableCount += 1;
      continue;
    }
    const item = itemResult.data;

    // 种子自身过滤: 平台意外返回时不混入候选, 只计数说明.
    const matchesSeedBvid = seedIdentity.bvid !== undefined && item.bvid === seedIdentity.bvid;
    let matchesSeedAid = false;
    if (seedIdentity.aid !== undefined && item.aid !== undefined) {
      if (typeof item.aid === "string") {
        matchesSeedAid = item.aid === seedIdentity.aid;
      } else if (Number.isSafeInteger(item.aid)) {
        matchesSeedAid = String(item.aid) === seedIdentity.aid;
      } else {
        // JSON 数值一旦超过安全整数范围就不能再作为可靠身份比较依据。
        unsafeAidComparisonCount += 1;
      }
    }
    if (matchesSeedBvid || matchesSeedAid) {
      seedFilteredCount += 1;
      continue;
    }

    const candidate = candidateFromRaw(item, position);
    if (candidate === undefined) {
      skippedCount += 1;
      continue;
    }

    // 相同 BV 号只保留第一次出现.
    if (seenBvids.has(candidate.video.bvid)) {
      duplicateRemovedCount += 1;
      continue;
    }
    seenBvids.add(candidate.video.bvid);
    candidates.push(candidate);
  }

  // 所有条目都无法按视频条目解析时, 视为原始结构变化, 让 Tool 走 failed,
  // 而不是把结构异常伪装成"关联推荐为空".
  if (rawReturnedCount > 0 && unparseableCount === rawReturnedCount) {
    throw new BilibiliError({
      code: "related_invalid_response",
      message: `B 站关联推荐接口返回 ${rawReturnedCount} 条结果, 但全部无法按视频条目解析`,
    });
  }

  const warnings: string[] = [];
  if (seedFilteredCount > 0) {
    warnings.push("平台返回了种子视频自身，已确定性过滤");
  }
  if (duplicateRemovedCount > 0) {
    warnings.push(`${duplicateRemovedCount} 条关联条目 BV 号重复，已保留首次出现`);
  }
  if (unsafeAidComparisonCount > 0) {
    warnings.push(
      `${unsafeAidComparisonCount} 条关联条目的 aid 超出安全整数范围，无法可靠核对 av 种子身份`,
    );
  }
  if (unparseableCount > 0) {
    warnings.push(`${unparseableCount} 条关联条目结构与预期不一致，已跳过`);
  }
  if (skippedCount > 0) {
    warnings.push(`${skippedCount} 条关联条目缺少 BV 号或标题（可能包含 OGV 番剧条目），已跳过`);
  }

  return {
    candidates,
    rawReturnedCount,
    seedFilteredCount,
    duplicateRemovedCount,
    warnings,
  };
}

/* -------- fetch 拉取一次关联推荐 -------- */

/** related 专用依赖上下文, 与 popular/search 适配层同构 (不跨目录共享类型). */
export interface RelatedFetchContext {
  /** 注入 fetch, 便于完全离线的单元测试. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
  baseUrl?: string;
}

/** 关联推荐请求的种子标识: bvid 优先, 只有 av 号输入时用 aid. */
export type RelatedSeedParam =
  | { kind: "bvid"; bvid: string }
  | { kind: "aid"; aid: string };

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136 Safari/537.36";
const DEFAULT_BASE = "https://api.bilibili.com/";
/** 视频播放页 Referer: 实测该接口无头也能返回, 携带请求头只为与其它发现来源保持一致. */
const RELATED_REFERER = "https://www.bilibili.com/";
/** 请求超时; 与 BilibiliClient / 其它发现来源适配层保持一致. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * 拉取 x/web-interface/archive/related 单次响应 (已 decode + 校验).
 *
 * HTTP 412 与业务 code -352/-412 统一转成 related_risk_control (retryable=true);
 * retryable=true 只表示稍后重试可能有意义, Tool 绝不自动重试 (AGENTS_M8 §14.2).
 */
export async function fetchRelatedList(
  ctx: RelatedFetchContext,
  seed: RelatedSeedParam,
): Promise<RawRelatedResponse> {
  const baseUrl = ctx.baseUrl ?? DEFAULT_BASE;
  const seedQuery = seed.kind === "bvid" ? `bvid=${encodeURIComponent(seed.bvid)}` : `aid=${encodeURIComponent(seed.aid)}`;
  const url = `${baseUrl}x/web-interface/archive/related?${seedQuery}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (ctx.fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": ctx.userAgent ?? DEFAULT_UA,
        Referer: RELATED_REFERER,
      },
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    throw new BilibiliError({
      code: "related_network_error",
      message: timedOut
        ? `B 站关联推荐接口请求超时（${REQUEST_TIMEOUT_MS}ms）`
        : `B 站关联推荐接口网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 412) {
    throw new BilibiliError({
      code: "related_risk_control",
      message: "B 站关联推荐接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
      httpStatus: 412,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new BilibiliError({
      code: "related_http_error",
      message: `B 站关联推荐接口请求失败，HTTP ${response.status}`,
      httpStatus: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new BilibiliError({
      code: "related_invalid_json",
      message: "B 站关联推荐接口没有返回有效的 JSON",
      httpStatus: response.status,
      cause: error,
    });
  }

  let decoded: RawRelatedResponse;
  try {
    decoded = decodeRelatedResponse(json);
  } catch (error) {
    throw new BilibiliError({
      code: "related_invalid_response",
      message: "B 站关联推荐响应结构与当前适配器预期不一致",
      cause: error,
    });
  }

  // -352 常见于缺少普通浏览器请求头; -412 是通用风控码. 都按来源风控处理.
  if (decoded.code === -352 || decoded.code === -412) {
    throw new BilibiliError({
      code: "related_risk_control",
      message: `B 站关联推荐接口触发风控 (code=${decoded.code})，稍后重试可能恢复，但不应立即连续重试`,
      apiCode: decoded.code,
      retryable: true,
    });
  }
  if (decoded.code !== 0) {
    throw new BilibiliError({
      code: "related_api_error",
      // -400 实测为 bvid/aid 缺失或无效: 重试同一输入没有意义.
      message: `B 站关联推荐接口返回错误 code=${decoded.code}: ${decoded.message ?? "未知错误"}`,
      apiCode: decoded.code,
      retryable: decoded.code === -509,
    });
  }
  return decoded;
}
