import { z } from "zod";
import {
  ExtraMetadataSchema,
  PublicUserRefSchema,
  UnixTimeSecondsSchema,
} from "../models/common.js";
// VideoRef 抽到 scripts/models/video.ts 作为跨能力域 shared model.
// 这里 re-export 保持向后兼容 (老代码可能从 metadata/model 导入).
export { VideoRefSchema, type VideoRef } from "../models/video.js";

/**
 * B站多P视频中的一个 Page。
 * cid 属于具体分P，因此不应只粗暴放在视频根对象上。
 */
export const VideoPageSchema = z.object({
  /** 分P序号，从 1 开始。 */
  page: z.number().int().positive(),
  /** B站内容 ID；字幕、弹幕、播放流等能力通常需要 cid。 */
  cid: z.string().min(1),
  /** Skill 标准化后的分P显示标题。 */
  title: z.string(),
  /** 该分P时长，单位：秒。 */
  durationSeconds: z.number().nonnegative(),
  /** B站接口中的原始 part 文本；保留它便于和平台显示/接口回查对应。 */
  part: z.string().optional(),
  /** 分P级暂未稳定建模的原始字段，例如尺寸、来源类型等。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type VideoPage = z.infer<typeof VideoPageSchema>;

/** 视频公开统计信息。所有字段都允许缺省，因为不同接口/权限可能返回不同集合。 */
export const VideoStatsSchema = z.object({
  /** 播放量。 */
  viewCount: z.number().int().nonnegative().optional(),
  /** 点赞数。 */
  likeCount: z.number().int().nonnegative().optional(),
  /** 投币数。 */
  coinCount: z.number().int().nonnegative().optional(),
  /** 收藏数。 */
  favoriteCount: z.number().int().nonnegative().optional(),
  /** 分享数。 */
  shareCount: z.number().int().nonnegative().optional(),
  /** 评论数。 */
  commentCount: z.number().int().nonnegative().optional(),
  /** 弹幕数。 */
  danmakuCount: z.number().int().nonnegative().optional(),
});
export type VideoStats = z.infer<typeof VideoStatsSchema>;

/** B站视频标准化元信息。业务层应依赖这个结构，而不是依赖 B站原始 JSON 字段。 */
export const VideoMetadataSchema = z.object({
  /** B站 BV 号，是 Skill 首选的视频稳定标识。 */
  bvid: z.string().min(1),
  /** B站 AV 数字 ID；转换为字符串保存，避免 JS 大整数边界和跨语言差异。 */
  aid: z.string().optional(),
  /** 标准化后的视频来源 URL，通常去掉无关跟踪参数。 */
  sourceUrl: z.string().url().optional(),
  /** 视频主标题。 */
  title: z.string(),
  /** 视频简介/描述原文。 */
  description: z.string().optional(),
  /** UP 主的最小公开引用。 */
  author: PublicUserRefSchema.optional(),
  /** 发布时间，Unix 秒。 */
  publishedAt: UnixTimeSecondsSchema.optional(),
  /** 整个视频总时长，单位：秒。 */
  durationSeconds: z.number().nonnegative().optional(),
  /** 视频封面地址。 */
  coverUrl: z.string().url().optional(),
  /** 视频标签名列表；标签接口不可用时允许为空。 */
  tags: z.array(z.string()).default([]),
  /** 播放、点赞、评论等公开统计。 */
  stats: VideoStatsSchema.optional(),

  /**
   * B站可能是多P视频，字幕、弹幕、帧都应落到具体 cid。
   * 单P视频 pages 通常只有一项。
   */
  pages: z.array(VideoPageSchema).default([]),
  /** 暂未提升为正式字段的来源元信息，例如分区、创建时间、版权类型等。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;
