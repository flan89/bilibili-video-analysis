import { z } from "zod";

/**
 * B站元数据接口原始字段 schema.
 *
 * 这里只描述 B站原始响应字段,任何业务字段(分区映射/标签标准化/分P归一)
 * 都在 metadata/bilibili-adapter.ts 完成,不要在这里混入业务逻辑.
 */

/** UP 主原始字段. */
export const RawVideoOwnerSchema = z.object({
  /** B站 mid. */
  mid: z.union([z.number(), z.string()]),
  /** UP 主昵称. */
  name: z.string(),
  /** 头像 URL. */
  face: z.string().optional(),
}).passthrough();
export type RawVideoOwner = z.infer<typeof RawVideoOwnerSchema>;

/** 视频公开统计原始字段. */
export const RawVideoStatSchema = z.object({
  /** 播放量. */
  view: z.number().int().nonnegative().optional(),
  /** 弹幕数. */
  danmaku: z.number().int().nonnegative().optional(),
  /** 评论数. */
  reply: z.number().int().nonnegative().optional(),
  /** 收藏数. */
  favorite: z.number().int().nonnegative().optional(),
  /** 投币数. */
  coin: z.number().int().nonnegative().optional(),
  /** 分享数. */
  share: z.number().int().nonnegative().optional(),
  /** 点赞数. */
  like: z.number().int().nonnegative().optional(),
}).passthrough();
export type RawVideoStat = z.infer<typeof RawVideoStatSchema>;

/** 多P中的一页原始字段. */
export const RawVideoPageSchema = z.object({
  /** 分P cid. */
  cid: z.union([z.number(), z.string()]),
  /** 分P序号. */
  page: z.number().int().positive(),
  /** B站显示的分P标题. */
  part: z.string().optional(),
  /** 分P时长,秒. */
  duration: z.number().nonnegative(),
  /** 来源类型,例如 vupload;仅作为扩展元数据保留. */
  from: z.string().optional(),
  /** 老视频可能存在的 vid. */
  vid: z.string().optional(),
  /** 某些来源页可能带外链. */
  weblink: z.string().optional(),
  /** 视频尺寸信息;V1 暂不标准化,只保留原始对象. */
  dimension: z.unknown().optional(),
}).passthrough();
export type RawVideoPage = z.infer<typeof RawVideoPageSchema>;

/** `/x/web-interface/view` 中 Tool 实际依赖的数据子集. */
export const RawVideoViewDataSchema = z.object({
  /** BV 号. */
  bvid: z.string().min(1),
  /** AV 数字 ID. */
  aid: z.union([z.number(), z.string()]),
  /** 默认/首个 cid. */
  cid: z.union([z.number(), z.string()]).optional(),
  /** 视频主标题. */
  title: z.string(),
  /** 视频简介. */
  desc: z.string().optional(),
  /** 封面地址. */
  pic: z.string().optional(),
  /** 发布时间,Unix 秒. */
  pubdate: z.number().int().nonnegative().optional(),
  /** 稿件创建时间,Unix 秒. */
  ctime: z.number().int().nonnegative().optional(),
  /** 视频总时长,秒. */
  duration: z.number().nonnegative().optional(),
  /** 视频分区 ID. */
  tid: z.number().int().optional(),
  /** 视频分区名称. */
  tname: z.string().optional(),
  /** B站原始版权类型. */
  copyright: z.number().int().optional(),
  /** 平台报告的分P数量. */
  videos: z.number().int().positive().optional(),
  /** UP 主信息. */
  owner: RawVideoOwnerSchema.optional(),
  /** 公开统计信息. */
  stat: RawVideoStatSchema.optional(),
  /** 多P页面列表. */
  pages: z.array(RawVideoPageSchema).optional(),
}).passthrough();
export type RawVideoViewData = z.infer<typeof RawVideoViewDataSchema>;

/** 标签接口中的单个标签. */
export const RawTagSchema = z.object({
  /** 标签 ID. */
  tag_id: z.union([z.number(), z.string()]).optional(),
  /** 标签显示名称. */
  tag_name: z.string().min(1),
}).passthrough();
export type RawTag = z.infer<typeof RawTagSchema>;

/** 标签列表. */
export const RawTagListSchema = z.array(RawTagSchema);
export type RawTagList = z.infer<typeof RawTagListSchema>;
