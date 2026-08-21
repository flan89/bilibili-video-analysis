import { z } from "zod";

/**
 * B站 JSON 接口通用 envelope.
 *
 * 字幕/元数据/评论等具体端点的 schema 已按能力拆到:
 *   - subtitle/bilibili-raw-schema.ts
 *   - metadata/bilibili-raw-schema.ts
 * 这里只保留跨能力共享的 envelope 结构.
 */
export const BilibiliApiEnvelopeSchema = z.object({
  /** 0 通常表示成功;非 0 交由 Client 转成结构化错误. */
  code: z.number().int(),
  /** 接口返回的人类可读消息. */
  message: z.string().optional(),
  /** 部分接口会使用 msg 字段,保留兼容. */
  msg: z.string().optional(),
  /** 具体业务数据;由调用方继续使用专用 Schema 校验. */
  data: z.unknown().optional(),
}).passthrough();
export type BilibiliApiEnvelope = z.infer<typeof BilibiliApiEnvelopeSchema>;
