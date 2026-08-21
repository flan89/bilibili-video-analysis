import { z } from "zod";
import {
  EntityIdSchema,
  ExtraMetadataSchema,
  MediaRangeSchema,
  MediaTimeSecondsSchema,
} from "./common.js";

/**
 * 抽帧原因不是装饰字段，它支持成本评估和可解释性：
 * 后续应该能回答“为什么选了这张图”。
 */
export const FrameReasonSchema = z.enum([
  "interval",
  "scene_change",
  "visual_change",
  "ppt_change",
  "danmaku_peak",
  "semantic_anchor",
  "cover",
  "manual",
  "timestamp", // M5 mode=timestamp 显式指定时间点
]);
export type FrameReason = z.infer<typeof FrameReasonSchema>;

/** 单张代表性视频帧。 */
export const FrameSchema = z.object({
  /** Skill 内部帧 ID。 */
  id: EntityIdSchema,
  /** 所属分P cid。 */
  cid: z.string().optional(),
  /** 该帧在分P时间轴上的位置，单位：秒。 */
  timestampSeconds: MediaTimeSecondsSchema,

  /**
   * 使用 URI 而不是只存本地 path，未来可兼容 file://、对象存储、
   * Agent workspace 文件引用等不同存储方式。
   */
  uri: z.string().min(1),
  /** 为什么抽取这张帧，用于可解释性与成本分析。 */
  reason: FrameReasonSchema,
  /** 对 reason 的人类可读补充，例如“弹幕峰值前后 2 秒”。 */
  reasonDetail: z.string().optional(),
  /** 图像宽度，单位像素。 */
  width: z.number().int().positive().optional(),
  /** 图像高度，单位像素。 */
  height: z.number().int().positive().optional(),
  /** 可选感知哈希，用于相似帧去重，避免把近似画面重复交给多模态模型。 */
  perceptualHash: z.string().optional(),
  /** 帧级补充信息，例如编码格式、原始截图参数等。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type Frame = z.infer<typeof FrameSchema>;

/**
 * 比单帧更高一级的视觉时间结构。
 *
 * 标 deprecated: V1 没有消费者, kind/summary 已经在靠近 Agent 视觉语义
 *   理解 (PPT / TalkingHead / B-roll 自动分类), 容易诱发 VisualAnalyzer 这类
 *   内部模型重新承担语义工作 (违反 D23).
 *
 * 当前使用: 0
 * 当前建议: 视觉段分类由 Agent Vision 推断, 留在 references/analysis/visual-decode.md
 *   协议层处理, 不是程序模型.
 *
 * 如果未来需要程序化视觉段:
 * - 段分类 (kind) 由 Tool 简单规则判断 (e.g. ffmpeg 静止帧检测 → static_segment)
 * - 段描述 (summary) 由 Agent 写, 不进程序
 * - 不要重新引入类似 VisualAnalyzer 的内部模型
 *
 * 此 schema 保留以不破坏可能的 import, 但不导出. 调用方应改用
 *   references/analysis/visual-decode.md 协议层分析.
 *
 * @deprecated V1 无人使用, M5.2 起不导出. 视觉段语义由 Agent 处理.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
const _VisualSegmentSchema_Deprecated = z.object({
  /** 视觉段唯一 ID。 */
  id: EntityIdSchema,
  /** 所属分P cid。 */
  cid: z.string().optional(),
  /** 该视觉段覆盖的时间范围。 */
  range: MediaRangeSchema,
  /** 例如 ppt、screen_recording、talking_head、broll；保持开放字符串便于扩展。 */
  kind: z.string().min(1),
  /** 对该段视觉内容的简短客观描述；不是深度分析结论。 */
  summary: z.string().optional(),
  /** 可代表该视觉段的 Frame ID 列表。 */
  frameIds: z.array(EntityIdSchema).default([]),
  /** 段级补充信息。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type VisualSegment = z.infer<typeof _VisualSegmentSchema_Deprecated>;
/* eslint-enable @typescript-eslint/no-unused-vars */
