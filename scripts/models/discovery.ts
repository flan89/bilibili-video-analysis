import { z } from "zod";
import { PublicUserRefSchema, UnixTimeSecondsSchema } from "./common.js";
import { VideoRefSchema } from "./video.js";

/**
 * scripts/models/discovery.ts: 主题发现 (视频搜索) 的稳定业务模型.
 *
 * M7 新增: search-videos Tool 只负责"关键词 → 候选视频轻量信息"这一件事:
 * - 不调用详情接口为候选补齐字段 (保持原子性和低成本, 见 AGENTS_M7 §6.3);
 * - 不给候选计算隐藏的综合质量分 (D34: Agent 负责语义选择);
 * - 搜索结果只是当前快照, 不能证明长期趋势, 也不能证明市场已验证 (D33).
 *
 * D12 边界: B 站原始字段 (arcurl / video_review / numResults ...) 只停留在
 * scripts/discovery/bilibili-search-* (adapter / raw-schema), 业务层只依赖本文件的标准化模型.
 */

/** 搜索结果排序方式. 稳定语义, 由适配层映射为 B 站具体 order 参数. */
export const SearchOrderSchema = z.enum([
  /** 综合排序 (平台默认). */
  "relevance",
  /** 最新发布. */
  "latest",
  /** 播放最多. */
  "views",
  /** 弹幕最多. */
  "danmaku",
  /** 收藏最多. */
  "favorites",
]);
export type SearchOrder = z.infer<typeof SearchOrderSchema>;

/** 视频时长筛选. 平台搜索接口原生支持, 由适配层映射为时长区间参数. */
export const SearchDurationFilterSchema = z.enum([
  /** 10 分钟以下. */
  "under_10m",
  /** 10 到 30 分钟. */
  "10_to_30m",
  /** 30 到 60 分钟. */
  "30_to_60m",
  /** 60 分钟以上. */
  "over_60m",
]);
export type SearchDurationFilter = z.infer<typeof SearchDurationFilterSchema>;

/** 搜索接口确实稳定返回的公开统计. 不伪造点赞、评论等搜索接口未稳定返回的字段. */
export const VideoCandidateStatsSchema = z.object({
  /** 播放量; 只是搜索快照值, 不代表实时数据. */
  viewCount: z.number().int().nonnegative().optional(),
  /** 弹幕数. */
  danmakuCount: z.number().int().nonnegative().optional(),
  /** 收藏数. */
  favoriteCount: z.number().int().nonnegative().optional(),
});
export type VideoCandidateStats = z.infer<typeof VideoCandidateStatsSchema>;

/**
 * 单条搜索候选视频.
 *
 * 刻意不是完整 VideoMetadata (AGENTS_M7 §6.3):
 * - 不调用详情接口补齐, 字段以搜索接口实际返回为准;
 * - stats 只反映搜索快照, 深入分析前不代表视频当前数据;
 * - position 只表示"当前页内的结果位置", 不构成跨页或全站排名;
 * - Agent 需要完整元信息时应复用 metadata Tool, 而不是信任候选快照.
 */
export const VideoCandidateSchema = z.object({
  /** 规范化视频引用; bvid 由适配层从 bvid/arcurl 提取并校验. */
  video: VideoRefSchema,
  /** 清理平台高亮标记后的标题. */
  title: z.string().min(1),
  /** 清理高亮标记后的简介摘要; 平台未返回时缺省. */
  description: z.string().optional(),
  /** 作者最小公开引用. */
  author: PublicUserRefSchema.optional(),
  /** 发布时间, Unix 秒. */
  publishedAt: UnixTimeSecondsSchema.optional(),
  /** 视频时长, 秒. */
  durationSeconds: z.number().nonnegative().optional(),
  /** 封面地址; 适配层会把协议相对地址规范化为 https. */
  coverUrl: z.string().url().optional(),
  /** 搜索结果中可用的标签名列表; 平台未返回时为空. */
  tags: z.array(z.string()).default([]),
  /** 搜索接口确实返回的公开统计. */
  stats: VideoCandidateStatsSchema.optional(),
  /** 当前页中的结果位置, 从 1 开始; 只用于回查当前页, 不表示排名. */
  position: z.number().int().positive(),
  /** 规范化视频地址 (https://www.bilibili.com/video/<bvid>/). */
  sourceUrl: z.string().url().optional(),
});
export type VideoCandidate = z.infer<typeof VideoCandidateSchema>;

/** 当前页的分页信息. */
export const SearchPageInfoSchema = z.object({
  /** 当前页码, 从 1 开始. */
  page: z.number().int().positive(),
  /** 请求的每页数量. */
  pageSize: z.number().int().positive(),
  /**
   * 本页平台原始返回的条目数量 (确定性整理前, 含被跳过的非视频/缺 BV 条目).
   * 只用于满页判断与 hasNextPage 估计; 有效候选数量请直接使用 candidates.length.
   */
  returnedCount: z.number().int().nonnegative(),
  /**
   * 是否可能还有下一页.
   * B 站搜索接口没有显式 is_end 字段, 这里是保守估计:
   * 本页原始返回满页且未越过平台报告总数时才为 true.
   * 供 Agent 决定是否继续翻页, 不构成"必须翻完"的承诺.
   */
  hasNextPage: z.boolean(),
});
export type SearchPageInfo = z.infer<typeof SearchPageInfoSchema>;

/**
 * 实际执行的稳定查询描述.
 *
 * 用途是回显和 Coverage 说明: Agent 最终回答时应能说明用了哪个搜索词、
 * 什么排序和筛选、查的是第几页; 失败时也能定位是哪个查询失败.
 */
export const ExecutedVideoSearchQuerySchema = z.object({
  /** 实际使用的单个搜索词. */
  keyword: z.string().min(1),
  /** 实际排序. */
  order: SearchOrderSchema,
  /** 页码. */
  page: z.number().int().positive(),
  /** 每页数量. */
  pageSize: z.number().int().positive(),
  /** 时长筛选. */
  duration: SearchDurationFilterSchema.optional(),
});
export type ExecutedVideoSearchQuery = z.infer<typeof ExecutedVideoSearchQuerySchema>;
