/**
 * scripts/models/danmaku.ts: 标准化弹幕数据模型.
 *
 * 跟 M1 Transcript 模型平行但语义不同:
 * - Transcript 段是**区间** (start/end)
 * - DanmakuSegment 是**瞬时** (start === end, D11 时间戳不可丢)
 *
 * B 站原始字段 (mode / color / weight / fontSize / midHash 等) 标准化后保留在
 * metadata 字段, 业务层需要时再读; 不混入业务字段名, 避免 D12 边界破坏.
 */
import { z } from "zod";

import { EntityIdSchema, ExtraMetadataSchema, MediaTimeSecondsSchema } from "./common.js";

/** 弹幕模式 (B 站原始 mode 字段). */
export const DanmakuModeSchema = z.enum([
  "normal", // 1/2/3 普通滚动
  "bottom", // 4 底端
  "top", // 5 顶端
  "reverse", // 6 逆向
  "advanced", // 7 高级
  "code", // 8 代码
  "bas", // 9 BAS
]);
export type DanmakuMode = z.infer<typeof DanmakuModeSchema>;

/**
 * 把 B 站整数 mode 转成 schema 枚举; 未知 mode 走"normal" 兜底 (前端按普通弹幕渲染).
 * 不抛错, 避免 B 站新 mode 直接破坏 Tool.
 */
export function normalizeDanmakuMode(raw: number | undefined): DanmakuMode {
  switch (raw) {
    case 1:
    case 2:
    case 3:
      return "normal";
    case 4:
      return "bottom";
    case 5:
      return "top";
    case 6:
      return "reverse";
    case 7:
      return "advanced";
    case 8:
      return "code";
    case 9:
      return "bas";
    default:
      return "normal";
  }
}

/** 弹幕池. */
export const DanmakuPoolSchema = z.enum(["normal", "subtitle", "special"]);
export type DanmakuPool = z.infer<typeof DanmakuPoolSchema>;

export function normalizeDanmakuPool(raw: number | undefined): DanmakuPool {
  switch (raw) {
    case 0:
      return "normal";
    case 1:
      return "subtitle";
    case 2:
      return "special";
    default:
      return "normal";
  }
}

/**
 * 单条标准化弹幕.
 *
 * startSeconds === endSeconds (D11: 瞬时事件也要保留时间戳), 单位秒.
 * sendTime 是 ISO 8601 字符串, 来自 B 站 ctime 字段 (Unix 秒).
 */
export const DanmakuSegmentSchema = z.object({
  /** 稳定 ID: d-{sendSeconds}-{id}, 跨段不重复. */
  id: EntityIdSchema,
  /** 视频内弹幕出现时间 (秒, 跟 M1 Transcript 同一坐标系). */
  startSeconds: MediaTimeSecondsSchema,
  /** 弹幕是瞬时, 等于 startSeconds. 保留字段便于跟 Transcript 对齐. */
  endSeconds: MediaTimeSecondsSchema,
  /** 弹幕文本 utf-8. */
  text: z.string(),

  /** B 站弹幕模式, 标准化为 enum (未知 mode 走 "normal" 兜底). */
  mode: DanmakuModeSchema,
  /** 弹幕颜色, 标准化为 hex "#RRGGBB". */
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  /** 发送者 mid 的 HASH, 用于脱敏后的反向关联 (D17 边界). */
  midHash: z.string().optional(),
  /** 弹幕发送时间 (ISO 8601), 来自 ctime. */
  sendTime: z.string().optional(),
  /** 平台智能屏蔽权重。该字段可能超过 10，只保留原值，不解释其业务含义。 */
  weight: z.number().int().nonnegative().optional(),

  /** 弹幕池. */
  pool: DanmakuPoolSchema,
  /** 段级原始/扩展字段, 例如 mode/fontSize 等 B 站特有. */
  metadata: ExtraMetadataSchema.optional(),
}).refine((segment) => segment.endSeconds >= segment.startSeconds, {
  message: "弹幕 endSeconds 必须大于等于 startSeconds",
});
export type DanmakuSegment = z.infer<typeof DanmakuSegmentSchema>;

/** 一段视频或目标分P的弹幕池. */
export const DanmakuSchema = z.object({
  /** 固定 "bilibili_danmaku". */
  source: z.literal("bilibili_danmaku"),
  /** BCP-47/常见语言标识, 默认 zh-CN (B 站弹幕默认中文). */
  language: z.string().min(1).default("zh-CN"),
  /** 多P视频中, 该 danmaku 对应的 cid. */
  cid: z.string().optional(),
  /** B 站提供方, 固定 "bilibili_player_api". */
  provider: z.string().optional(),

  /** 按时间排序的弹幕瞬时事件集合. */
  segments: z.array(DanmakuSegmentSchema),

  /** 总弹幕数 (含被过滤的 mode). */
  total: z.number().int().nonnegative(),
  /** 拉取的段数 (6min/段, 默认全段). */
  segmentCount: z.number().int().nonnegative(),
  /** 是否覆盖完整视频 (没截断). */
  complete: z.boolean().default(true),

  metadata: ExtraMetadataSchema.optional(),
});
export type Danmaku = z.infer<typeof DanmakuSchema>;
