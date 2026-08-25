import { z } from "zod";
import { ExtraMetadataSchema, IsoDateTimeSchema } from "./common.js";

/** Skill 当前可能获取的数据种类。后续新增数据源时应优先扩展这里。 */
export const DataKindSchema = z.enum([
  "metadata",
  "cover",
  "transcript",
  "video",
  "audio",
  "frames",
  "timeline",
  "danmaku",
  "comments",
  "replies",
  /** M7 新增: 主题发现阶段的视频搜索候选列表 (V2 topic_research 阶段一). */
  "video_candidates",
  /** M8 新增: 当前热门页面快照的视频候选列表 (平台热门机制, 非全站排名). */
  "popular_video_candidates",
  /** M8 新增: 给定种子视频的平台关联推荐候选列表 (批次 C 接入). */
  "related_video_candidates",
  /** M8 新增: 平台当前热搜词列表 (批次 B 接入); 是主题词, 不是视频. */
  "hot_search_topics",
]);
export type DataKind = z.infer<typeof DataKindSchema>;

/**
 * 单类数据的采集状态。
 *
 * `partial` 很重要：例如评论拿到了 500 条，但深层回复受限。
 * 如果只有 success/failed，分析层很容易把“部分数据”误当“完整数据”。
 */
export const AcquisitionStateSchema = z.enum([
  "not_requested",
  "pending",
  "success",
  "partial",
  "missing",
  "failed",
]);
export type AcquisitionState = z.infer<typeof AcquisitionStateSchema>;

/** 一次具体数据获取尝试的记录。 */
export const AcquisitionRecordSchema = z.object({
  /** 本条记录对应的数据类别。 */
  dataKind: DataKindSchema,
  /** 本次采集最终状态。 */
  status: AcquisitionStateSchema,

  /** 实际采用的数据来源，例如 bilibili_web_api / yt-dlp / funasr / playwright。 */
  source: z.string().optional(),
  /** 本次采集开始时间；用于排查耗时与缓存新鲜度。 */
  requestedAt: IsoDateTimeSchema.optional(),
  /** 本次采集结束时间。 */
  completedAt: IsoDateTimeSchema.optional(),

  /** 已成功得到的记录数，对 comments/frames/danmaku 等集合数据尤其有用。 */
  itemCount: z.number().int().nonnegative().optional(),

  /** 程序可判断的原因码，例如 api_limit、no_subtitle、login_required。 */
  reasonCode: z.string().optional(),
  /** 给人和 LLM 阅读的原因说明，不建议在业务代码中依赖该文本做判断。 */
  message: z.string().optional(),

  /** 部分成功或存在不确定性时记录证据缺口，避免后续分析默认为完整数据。 */
  warnings: z.array(z.string()).default([]),
  /** 与采集过程有关但尚未稳定建模的补充字段，例如 HTTP 状态或重试次数。 */
  metadata: ExtraMetadataSchema.optional(),
});
export type AcquisitionRecord = z.infer<typeof AcquisitionRecordSchema>;

/**
 * Tool 失败时给 Agent 的环境准备提示.
 *
 * 跟 doc §十三 "Tool 不自动安装" 原则一致: Tool 永远不自己 pip install / 装 ffmpeg,
 * 而是返回 setupHint。命令拆成 executable + args，Agent 不需要解析 shell 字符串。
 *
 * 字段:
 * - capability: 跟 doctor 的能力分类对齐 (media / asr)
 * - reason: 人类可读的简短原因 (跟 reasonCode 互补, reasonCode 给程序, reason 给人)
 * - doctorCommand: 只读检查
 * - planCommand: 展示将发生的变化
 * - applyCommand: 只有用户明确授权后才执行
 */
const RuntimeCommandSchema = z.object({
  /** 要执行的程序，通常是当前 Node.js 绝对路径。 */
  executable: z.string().min(1),
  /** 已拆分的参数，避免路径空格和 shell 转义问题。 */
  args: z.array(z.string()),
});

export const SetupHintSchema = z.object({
  /** 哪类能力缺失, 跟 doctor 的 capability 对齐 */
  capability: z.enum(["media", "asr"]),
  /** 简短原因 (跟 acquisition.reasonCode 互补) */
  reason: z.string().min(1),
  /** 只检测当前能力，不修改机器。 */
  doctorCommand: RuntimeCommandSchema,
  /** 展示安装步骤、空间、时间与网络成本，不修改机器。 */
  planCommand: RuntimeCommandSchema,
  /** 真正修改环境；Agent 必须先取得用户明确授权。 */
  applyCommand: RuntimeCommandSchema,
});
export type SetupHint = z.infer<typeof SetupHintSchema>;
