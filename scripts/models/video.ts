/**
 * scripts/models/video.ts: Video 共享模型 (跨能力域).
 *
 * 抽: subtitle / danmaku / visual / metadata 四个能力域都依赖
 *   VideoRefSchema, 之前定义在 metadata/model.ts, 这是真正的 cross-capability
 *   Contract, 应该属于 shared models 层.
 *
 * 为保持向后兼容, metadata/model.ts 仍然 re-export 这个 schema.
 */
import { z } from "zod";

/**
 * 视频引用.
 *
 * 单P 视频: bvid + cid
 * 多P 视频: bvid (cid 跟 Tool 内部 page 选择有关, 见各 Tool 文档)
 * 评论类: bvid (评论是 aid 级, 不绑 cid)
 */
export const VideoRefSchema = z.object({
  /** B 站 BV 号, 公开视频唯一标识. */
  bvid: z.string().min(1),
  /** 可选分P cid. */
  cid: z.string().optional(),
}).strict();
export type VideoRef = z.infer<typeof VideoRefSchema>;
