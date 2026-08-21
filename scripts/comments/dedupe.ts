/**
 * scripts/comments/dedupe.ts: 评论薄 deterministic preprocessing ().
 *
 * 设计原则:
 * - 纯函数, 不调模型, 不依赖外部状态 (跟 D24 一致, 不算 Tool, 是 helper)
 * - 输入是已经 normalize 过的 Comment[], 输出处理后的纯数据
 * - Agent / 上游 sampling 层可以组合调用
 *
 * 解决的问题 (M4 market_research 协议 D16 抽样规则配套):
 * - hot + time 双样本按 rpid 去重, 避免重复统计
 * - 按 role (Pain / Job / Workaround / Competitor 等) 计数
 * - Coverage validation: 实际 sample vs 平台 totalReported
 *
 * **不实现**:
 * - 不调 LLM 判定 role (语义判断是 Agent 的事)
 * - 不写 Tool (是 Tool, D24 冲突; 本文件是纯函数, 跟 D24 不冲突)
 * - 不做 sum / avg / 其他聚合 (按需加, 不预先造)
 *
 * 参考: market-research.md §"聚合深度控制" + §"跨源对齐"
 */

import type { Comment } from "../models/comment.js";

/**
 * 按 rpid (id 字段) 去重, 保留第一次出现.
 *
 * 适用场景: hot + time 双 sample 合并时, 避免同一条根评论被重复统计.
 * 复杂度: O(n) (用 Map).
 *
 * @param comments - 多源 sample 合并的 Comment[] (顺序: 第一次出现优先)
 * @returns 去重后的 Comment[] (顺序保持)
 */
export function dedupeByRpid(comments: Comment[]): Comment[] {
  const seen = new Set<string>();
  const result: Comment[] = [];
  for (const c of comments) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      result.push(c);
    }
  }
  return result;
}

/**
 * 按 role 计数.
 *
 * @param comments - 已 dedupe 过的 Comment[]
 * @param roleMap - 跟 Comment 数组平行的 role 标签数组 (按 index 对应)
 * @returns Record<role, count> - 每个 role 出现的次数
 *
 * 典型用法 (Agent 层):
 *   const roles = await llmClassifyRoles(comments);  // LLM 判定, 长度应 == comments.length
 *   const counts = countByRole(comments, roles);
 *   // { Pain: 17, Job: 4, Workaround: 6, ... }
 */
export function countByRole(
  comments: Comment[],
  roleMap: readonly string[],
): Record<string, number> {
  if (comments.length !== roleMap.length) {
    throw new Error(
      `countByRole: comments.length (${comments.length}) != roleMap.length (${roleMap.length})`,
    );
  }
  const counts: Record<string, number> = {};
  for (const role of roleMap) {
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return counts;
}

/**
 * 按 replyCount 降序排序.
 *
 * 适用场景: Workaround / Competitor 抽取 (market_research §4 协议),
 * 高 replyCount 通常是焦点评论.
 *
 * @param comments - 已 dedupe 过的 Comment[]
 * @returns 按 replyCount 降序排序的 Comment[] (稳定排序, replyCount 相等时保持原顺序)
 */
export function sortByReplyCount(comments: Comment[]): Comment[] {
  return [...comments].sort((a, b) => (b.replyCount ?? 0) - (a.replyCount ?? 0));
}

/**
 * Coverage 校验: 实际 sample vs 平台 totalReported.
 *
 * 关键: totalReported 含 reply (子回复), 不能直接当根评论分母.
 * tier 字段在调用方证明"已完整 fetch 整条根评论集合" 时才有意义.
 * 只 sample 头部时, 应当作 unknown, 避免 Agent 按 sample size 误判 population 规模.
 *
 * @param comments - 已 dedupe 过的根评论 Comment[]
 * @param totalReported - 平台报告的总评论数 (含 reply)
 * @param options.fetchComplete - 调用方是否已证明完整 fetch (默认 false, 保守)
 * @returns CoverageReport - 完整性 + 实际根评论数 + 平台报告数 + tier (基于 fetchComplete)
 */
export interface CoverageReport {
  /** 实际取得的根评论数 (去重后). */
  rootCommentCount: number;
  /** 平台报告的总评论数 (含 reply). */
  totalReported: number;
  /**
   * 评论区规模分级. 调用方传 fetchComplete=true 时按根评论数推 (small/medium/large),
   * 否则一律 unknown. Agent 看到 unknown 不能再按"小评论区"做 sampling 决策.
   * - "small" (< 200): 完整 fetch 优先
   * - "medium" (200-5000): progressive + saturation stop
   * - "large" (>= 5000): sampling + hot+time 双排序
   * - "unknown": 调用方未证明完整 fetch, Agent 不可推 population 规模
   */
  tier: "small" | "medium" | "large" | "unknown";
  /** 警告: 数据完整性 + tier 不可用说明. */
  warnings: string[];
}

export function validateCoverage(
  comments: Comment[],
  totalReported: number,
  options: { fetchComplete?: boolean } = {},
): CoverageReport {
  const rootCommentCount = comments.length;
  const warnings: string[] = [];

  if (totalReported > 0 && rootCommentCount > totalReported) {
    warnings.push(
      `actual root comments (${rootCommentCount}) > totalReported (${totalReported}), 数据异常`,
    );
  }

  // tier 只能在调用方证明完整 fetch 时按根评论数推, 否则 unknown
  let tier: CoverageReport["tier"];
  if (options.fetchComplete !== true) {
    tier = "unknown";
    warnings.push(
      `tier 不可用: 调用方未证明完整 fetch, sample size ${rootCommentCount} 不应直接推 population 规模`,
    );
  } else if (rootCommentCount < 200) {
    tier = "small";
  } else if (rootCommentCount < 5000) {
    tier = "medium";
  } else {
    tier = "large";
  }

  return {
    rootCommentCount,
    totalReported,
    tier,
    warnings,
  };
}

/**
 * 组合 helper: 一次完成 dedupe + sort + count + coverage.
 *
 * 典型用法 (M4 market_research 协议 hot+time 双 sample):
 *   const hot = await getComments({ sort: 3, pageSize: 20 });
 *   const time = await getComments({ sort: 2, pageSize: 20, cursor: hot.nextCursor });
 *   const merged = mergeCommentSamples([hot.collection, time.collection]);
 *   // → { comments, coverage, byRole }
 *
 * @param collections - 多个 CommentCollection 数组 (按 sample 源顺序, 第一次优先)
 * @param roleMap - 跟最终 comments 平行的 role 标签 (Agent 调 LLM 判定)
 * @returns { comments, coverage, byRole }
 */
export interface MergedSample {
  comments: Comment[];
  coverage: CoverageReport;
  byRole: Record<string, number>;
}

export function mergeCommentSamples(
  collections: Array<{ comments: Comment[]; totalReported?: number }>,
  roleMap?: readonly string[],
  options: { fetchComplete?: boolean } = {},
): MergedSample {
  // 1) 合并所有 comments
  const allComments = collections.flatMap((c) => c.comments);

  // 2) 按 rpid 去重
  const comments = dedupeByRpid(allComments);

  // 3) totalReported: 取最大 (覆盖最广的)
  const totalReported = Math.max(
    0,
    ...collections.map((c) => c.totalReported ?? 0),
  );

  // 4) coverage (tier 严格基于 fetchComplete, 默认 false → unknown)
  const coverage = validateCoverage(comments, totalReported, {
    fetchComplete: options.fetchComplete,
  });

  // 5) byRole (optional)
  const byRole: Record<string, number> = {};
  if (roleMap) {
    Object.assign(byRole, countByRole(comments, roleMap));
  }

  return { comments, coverage, byRole };
}
