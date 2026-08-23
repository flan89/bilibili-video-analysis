/**
 * scripts/discovery/bilibili-hot-search-raw-schema.ts: B 站热搜接口原始字段 schema.
 *
 * 当前使用 `https://s.search.bilibili.com/main/hotword`。该来源会返回商业标记、
 * 平台快照时间、热度层级和报告总数，能够支撑 Skill 对热搜来源边界的披露要求。
 * B 站原始字段只保留在本文件与对应 adapter 中。
 */
import { z } from "zod";

/** 单条热搜词附带的来源状态。 */
export const RawHotSearchStatDataSchema = z.object({
  /** 商业标记；真实响应使用 "0" / "1"，同时兼容数值和布尔形态。 */
  is_commercial: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** 词条进入当前热搜周期的 Unix 秒时间。 */
  stime: z.union([z.string(), z.number()]).optional(),
  /** 词条离开当前热搜周期的 Unix 秒时间。 */
  etime: z.union([z.string(), z.number()]).optional(),
}).passthrough();
export type RawHotSearchStatData = z.infer<typeof RawHotSearchStatDataSchema>;

/** 单条热搜词原始条目。 */
export const RawHotSearchItemSchema = z.object({
  /** 可直接用于视频搜索的词。 */
  keyword: z.string(),
  /** 平台展示名称。 */
  show_name: z.string().optional(),
  /** 展示图标。 */
  icon: z.string().optional(),
  /** 平台报告的当前热度值。 */
  heat_score: z.union([z.number(), z.string()]).optional(),
  /** 平台热度层级，例如 B。 */
  heat_layer: z.string().optional(),
  /** 平台列表位置，从 1 开始。 */
  pos: z.union([z.number(), z.string()]).optional(),
  /** 商业标记和词条时间窗口。 */
  stat_datas: RawHotSearchStatDataSchema.optional(),
}).passthrough();
export type RawHotSearchItem = z.infer<typeof RawHotSearchItemSchema>;

/** `main/hotword` 完整响应。 */
export const RawHotSearchResponseSchema = z.object({
  /** 0 表示成功。 */
  code: z.number().int(),
  message: z.string().optional(),
  /** 普通热搜词条。逐条校验由 adapter 完成。 */
  list: z.array(z.unknown()).nullish().transform((value) => value ?? []),
  /** 平台置顶词条；不能静默忽略，adapter 会放在普通列表之前处理。 */
  top_list: z.array(z.unknown()).nullish().transform((value) => value ?? []),
  /** 平台快照 Unix 秒时间。 */
  timestamp: z.union([z.number(), z.string()]).optional(),
  /** 平台报告的词条总数。 */
  total_count: z.union([z.number(), z.string()]).optional(),
  /** 本次热搜响应标识。 */
  seid: z.union([z.number(), z.string()]).optional(),
}).passthrough();
export type RawHotSearchResponse = z.infer<typeof RawHotSearchResponseSchema>;

/** 解析热搜响应；结构不符合预期时抛 ZodError。 */
export function decodeHotSearchResponse(rawJson: unknown): RawHotSearchResponse {
  return RawHotSearchResponseSchema.parse(rawJson);
}
