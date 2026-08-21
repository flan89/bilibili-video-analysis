import { z } from "zod";

/**
 * 模型层通用基础定义。
 *
 * 设计原则：
 * 1. 尽量保存“原始事实”，不要在采集层提前混入 LLM 判断。
 * 2. 媒体时间统一使用秒，便于字幕、弹幕、关键帧在同一时间轴上对齐。
 * 3. 未来可能变化但当前不值得单独建模的原始字段，先放入 metadata。
 */

/** 不同来源的 ID 规则不同，因此只约束为非空字符串。 */
export const EntityIdSchema = z.string().min(1);
export type EntityId = z.infer<typeof EntityIdSchema>;

/** 视频内部的时间位置，统一使用“秒”；允许小数，便于精确定位字幕、弹幕与帧。 */
export const MediaTimeSecondsSchema = z.number().nonnegative();
export type MediaTimeSeconds = z.infer<typeof MediaTimeSecondsSchema>;

/** 平台事件时间使用 Unix 时间戳，单位统一为秒。 */
export const UnixTimeSecondsSchema = z.number().int().nonnegative();
export type UnixTimeSeconds = z.infer<typeof UnixTimeSecondsSchema>;

/** 系统内部的请求/处理时间统一使用带时区的 ISO 8601 字符串。 */
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/**
 * 松散元数据容器。
 *
 * B站接口字段可能变化，因此允许暂存非核心原始字段；
 * 但某字段一旦成为稳定业务依赖，应提升为正式字段，避免长期依赖“魔法 key”。
 */
export const ExtraMetadataSchema = z.record(z.unknown());
export type ExtraMetadata = z.infer<typeof ExtraMetadataSchema>;

/**
 * 公开用户引用。
 *
 * 只保存分析任务真正需要的最小公开信息，避免为了“以后可能有用”而收集无关用户画像数据。
 */
export const PublicUserRefSchema = z.object({
  /** 平台公开用户 ID，例如 B站 mid；接口未返回时允许缺省。 */
  userId: z.string().min(1).optional(),
  /** 用户公开显示名称。 */
  name: z.string().min(1).optional(),
  /** 用户公开头像地址；仅作为展示/溯源信息，不作为身份判断依据。 */
  avatarUrl: z.string().url().optional(),
  /** 公开徽章/身份文本；只有确有分析价值且接口返回时才填写。 */
  badge: z.string().optional(),
});
export type PublicUserRef = z.infer<typeof PublicUserRefSchema>;

/**
 * 媒体时间范围，用于视频片段、字幕范围、视觉段落等。
 * start/end 都使用秒，并强制保证 end >= start。
 */
export const MediaRangeSchema = z.object({
  /** 区间起点，单位：秒。 */
  startSeconds: MediaTimeSecondsSchema,
  /** 区间终点，单位：秒。 */
  endSeconds: MediaTimeSecondsSchema,
}).refine((value) => value.endSeconds >= value.startSeconds, {
  message: "endSeconds 必须大于等于 startSeconds",
});
export type MediaRange = z.infer<typeof MediaRangeSchema>;
