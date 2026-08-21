import { z } from "zod";
import {
  EntityIdSchema,
  ExtraMetadataSchema,
  MediaTimeSecondsSchema,
} from "../models/common.js";

/** 字幕/转写来源。 */
export const TranscriptSourceSchema = z.enum(["official", "official_ai", "asr"]);
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;

/**
 * 最小字幕片段。
 * 必须保留 start/end，而不是只保存一坨完整文本：后续弹幕峰值、关键帧、
 * 评论提到的具体片段，都需要通过时间轴与字幕关联。
 */
export const TranscriptSegmentSchema = z.object({
  /** 字幕片段唯一 ID。 */
  id: EntityIdSchema,
  /** 片段开始位置，单位：秒。 */
  startSeconds: MediaTimeSecondsSchema,
  /** 片段结束位置，单位：秒。 */
  endSeconds: MediaTimeSecondsSchema,
  /** 字幕/转写原始文本。 */
  text: z.string(),

  /** ASR 场景可用；官方字幕通常没有可信的逐段置信度。 */
  confidence: z.number().min(0).max(1).optional(),
  /** 预留说话人分离结果，V1 不要求实现。 */
  speaker: z.string().optional(),
  /** 片段级原始/扩展字段。 */
  metadata: ExtraMetadataSchema.optional(),
}).refine((segment) => segment.endSeconds >= segment.startSeconds, {
  message: "字幕片段 endSeconds 必须大于等于 startSeconds",
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

/** 一个分P或目标媒体范围内的字幕/ASR结果。 */
export const TranscriptSchema = z.object({
  /** 字幕来源：官方人工、官方AI或本地/外部 ASR。 */
  source: TranscriptSourceSchema,
  /** BCP-47/常见语言标识，例如 zh-CN；V1 不做强枚举。 */
  language: z.string().min(1).default("zh-CN"),

  /** 多P视频中，该 transcript 对应的 cid；单P也建议填。 */
  cid: z.string().optional(),
  /** ASR/字幕提供方，例如 bilibili / FunASR。 */
  provider: z.string().optional(),
  /** 按时间排序的字幕片段集合。 */
  segments: z.array(TranscriptSegmentSchema),

  /**
   * 是否覆盖完整目标视频/分P。
   * 例如 overview 只转写前 10 分钟时必须为 false，防止生成“全片”结论。
   */
  complete: z.boolean().default(true),
  /** 字幕级补充信息，例如原始语言代码、模型版本、采集页码等。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/**
 * 字幕预处理过程中发现的结构化问题。
 * `code` 供程序稳定判断，`message` 供开发者和后续 Agent 阅读。
 */
export const TranscriptProcessingWarningSchema = z.object({
  /** 稳定原因码，例如 empty_segment_dropped、segments_reordered。 */
  code: z.string().min(1),
  /** 对问题和处理方式的中文说明。 */
  message: z.string().min(1),
  /** 受影响的原始字幕片段 ID；没有具体片段时可以为空。 */
  segmentIds: z.array(EntityIdSchema).default([]),
});
export type TranscriptProcessingWarning = z.infer<typeof TranscriptProcessingWarningSchema>;

/** 字幕经过确定性清理后的数量变化，供 Agent 判断 Tool 实际做了什么。 */
export const TranscriptCleaningStatsSchema = z.object({
  /** 清理前的原始有效/无效字幕片段总数。 */
  inputSegmentCount: z.number().int().nonnegative(),
  /** 清理后返回给 Agent 的字幕片段数。 */
  outputSegmentCount: z.number().int().nonnegative(),
  /** 因清理后为空而丢弃的片段数。 */
  emptySegmentCount: z.number().int().nonnegative(),
  /** 被并入相邻完全相同字幕的片段数。 */
  duplicateSegmentCount: z.number().int().nonnegative(),
});
export type TranscriptCleaningStats = z.infer<typeof TranscriptCleaningStatsSchema>;

/**
 * 由相邻字幕片段合并得到的技术性文本块。
 *
 * 它只解决上下文过碎和输入尺寸问题，不表示语义章节或内容重要性。
 */
export const TranscriptChunkSchema = z.object({
  /** 稳定文本块 ID，供 Agent 分页读取和回查来源。 */
  id: EntityIdSchema,
  /** 文本块所属分P cid；不得跨 cid 合并。 */
  cid: z.string().min(1).optional(),
  /** 文本块开始位置，单位：秒。 */
  startSeconds: MediaTimeSecondsSchema,
  /** 文本块结束位置，单位：秒。 */
  endSeconds: MediaTimeSecondsSchema,
  /** 仅做格式清理和保守去重后的连续字幕原文。 */
  text: z.string().min(1),
  /**
   * 本块覆盖的全部原始字幕 ID。
   * 即使相邻重复字幕被合并，也必须保留每个来源 ID，保证后续可以完整回查。
   */
  segmentIds: z.array(EntityIdSchema).min(1),
  /** 文本块级补充信息，例如清理后的字幕单元数量。 */
  metadata: ExtraMetadataSchema.optional(),
}).refine((chunk) => chunk.endSeconds >= chunk.startSeconds, {
  message: "字幕文本块 endSeconds 必须大于等于 startSeconds",
});
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;

/** 一次字幕预处理的可核对统计。 */
export const TranscriptPreprocessingStatsSchema = z.object({
  /** 输入的原始字幕片段数。 */
  inputSegmentCount: z.number().int().nonnegative(),
  /** 因清理后为空而丢弃的片段数。 */
  emptySegmentCount: z.number().int().nonnegative(),
  /** 被并入相邻相同文本、但来源 ID 仍保留的重复片段数。 */
  duplicateSegmentCount: z.number().int().nonnegative(),
  /** 清洗和保守去重后参与分段的字幕单元数。 */
  cleanedUnitCount: z.number().int().nonnegative(),
  /** 最终生成的技术性文本块数。 */
  chunkCount: z.number().int().nonnegative(),
  /** 最终文本块能够回指的非空原始字幕片段数。 */
  mappedSegmentCount: z.number().int().nonnegative(),
});
export type TranscriptPreprocessingStats = z.infer<typeof TranscriptPreprocessingStatsSchema>;

/**
 * Agent 分页读取字幕时使用的确定性派生结构。
 *
 * 这里只保存技术性文本块和来源关系；真正的语义章节和内容选择由 Agent 完成。
 */
export const PreparedTranscriptSchema = z.object({
  /** 与原始 Transcript 相同的字幕来源。 */
  source: TranscriptSourceSchema,
  /** 与原始 Transcript 相同的语言。 */
  language: z.string().min(1),
  /** 当前预处理结果所属分P cid。 */
  cid: z.string().min(1).optional(),
  /** 原始 Transcript 是否声明覆盖完整目标分P。 */
  sourceComplete: z.boolean(),
  /** 所有非空原始字幕是否都能通过 chunk.segmentIds 回查。 */
  coverageComplete: z.boolean(),
  /** 只有来源完整、技术处理覆盖完整且至少存在一个可用文本块时才为 true。 */
  complete: z.boolean(),
  /** 按时间排序的技术性文本块。 */
  chunks: z.array(TranscriptChunkSchema),
  /** 清洗和分段过程中发现的问题。 */
  warnings: z.array(TranscriptProcessingWarningSchema).default([]),
  /** 便于测试覆盖率和排查数据损失的处理统计。 */
  stats: TranscriptPreprocessingStatsSchema,
  /** 预处理版本与实际规则配置，便于结果复现。 */
  metadata: ExtraMetadataSchema.optional(),
}).superRefine((prepared, context) => {
  const expectedComplete = prepared.sourceComplete
    && prepared.coverageComplete
    && prepared.chunks.length > 0;
  if (prepared.complete !== expectedComplete) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["complete"],
      message: "complete 必须与来源完整性、映射完整性和可用文本块保持一致",
    });
  }

  if (prepared.stats.chunkCount !== prepared.chunks.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "chunkCount"],
      message: "chunkCount 必须等于实际 chunks 数量",
    });
  }

  const mappedSegmentCount = new Set(
    prepared.chunks.flatMap((chunk) => chunk.segmentIds),
  ).size;
  if (prepared.stats.mappedSegmentCount !== mappedSegmentCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stats", "mappedSegmentCount"],
      message: "mappedSegmentCount 必须等于 chunks 实际映射的唯一字幕 ID 数量",
    });
  }

  const chunkIds = prepared.chunks.map((chunk) => chunk.id);
  if (new Set(chunkIds).size !== chunkIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["chunks"],
      message: "PreparedTranscript 中的 chunk ID 必须唯一",
    });
  }

  for (let index = 0; index < prepared.chunks.length; index += 1) {
    const chunk = prepared.chunks[index];
    if (!chunk) continue;
    if (chunk.cid !== prepared.cid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks", index, "cid"],
        message: "chunk cid 必须与 PreparedTranscript cid 一致",
      });
    }
    const previous = prepared.chunks[index - 1];
    if (previous && chunk.startSeconds < previous.startSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chunks", index, "startSeconds"],
        message: "PreparedTranscript chunks 必须按开始时间排序",
      });
    }
  }
});
export type PreparedTranscript = z.infer<typeof PreparedTranscriptSchema>;
