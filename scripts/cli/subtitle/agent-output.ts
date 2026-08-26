import type { GetSubtitleOutput } from "../../subtitle/get.js";

/** 面向 Agent 的紧凑字幕片段，省略只供程序回查的重复内部元数据。 */
export interface AgentSubtitleSegment {
  /** 当前结果中的连续编号，便于 Agent 在同一次回答中引用。 */
  segmentNumber: number;
  /** 字幕开始位置，单位：秒。 */
  startSeconds: number;
  /** 字幕结束位置，单位：秒。 */
  endSeconds: number;
  /** 经过确定性清理、但没有语义改写的字幕文本。 */
  text: string;
}

/** 命令行返回给 Agent 的紧凑字幕结果。 */
export interface AgentSubtitleOutput {
  /** 是否取得可用字幕。 */
  success: boolean;
  /** 成功、缺失、待选分P或失败。 */
  outcome: GetSubtitleOutput["outcome"];
  /** 规范化视频和分P身份。 */
  video: GetSubtitleOutput["video"];
  /** 获取成功时返回紧凑字幕正文。 */
  transcript?: {
    source: NonNullable<GetSubtitleOutput["transcript"]>["source"];
    language: string;
    cid?: string;
    provider?: string;
    complete: boolean;
    segments: AgentSubtitleSegment[];
  };
  /** 保留 Agent 判断完整性和失败原因所需的采集信息。 */
  acquisition: {
    status: GetSubtitleOutput["acquisition"]["status"];
    reasonCode?: string;
    message?: string;
    itemCount?: number;
    warnings: string[];
  };
  /** 保留语言选择所需的轨道摘要。 */
  availableTracks: GetSubtitleOutput["availableTracks"];
  /** 保留处理方法、数量变化和可读警告,省略冗长来源编号列表。 */
  processing?: {
    method: "deterministic_v1" | "asr_fallback";
    warnings: Array<{ code: string; message: string }>;
    stats: NonNullable<GetSubtitleOutput["processing"]>["stats"];
  };
  /** 多P尚未选择时返回。 */
  pageChoices: GetSubtitleOutput["pageChoices"];
  /** 无官方字幕时返回。 */
  fallback: GetSubtitleOutput["fallback"];
  /** Tool 失败时返回。 */
  error: GetSubtitleOutput["error"];
  /** 本地媒体或语音识别能力缺失时，保留可执行的环境准备提示。 */
  setupHint: GetSubtitleOutput["setupHint"];
}

/**
 * 把完整 Tool JSON 转成适合直接进入 Agent 上下文的紧凑结果。
 *
 * 完整 Tool 契约不变；这里只移除每条字幕重复的长 sourceId 和 metadata。时间范围、
 * 全部字幕文本、顺序以及完整性状态仍完整保留。
 */
export function toAgentSubtitleOutput(result: GetSubtitleOutput): AgentSubtitleOutput {
  return {
    success: result.success,
    outcome: result.outcome,
    video: result.video,
    transcript: result.transcript
      ? {
          source: result.transcript.source,
          language: result.transcript.language,
          cid: result.transcript.cid,
          provider: result.transcript.provider,
          complete: result.transcript.complete,
          segments: result.transcript.segments.map((segment, index) => ({
            segmentNumber: index + 1,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            text: segment.text,
          })),
        }
      : undefined,
    acquisition: {
      status: result.acquisition.status,
      reasonCode: result.acquisition.reasonCode,
      message: result.acquisition.message,
      itemCount: result.acquisition.itemCount,
      warnings: result.acquisition.warnings,
    },
    availableTracks: result.availableTracks,
    processing: result.processing
      ? {
          method: result.processing.method,
          warnings: result.processing.warnings.map((warning) => ({
            code: warning.code,
            message: warning.message,
          })),
          stats: result.processing.stats,
        }
      : undefined,
    pageChoices: result.pageChoices,
    fallback: result.fallback,
    error: result.error,
    setupHint: result.setupHint,
  };
}
