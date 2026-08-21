/**
 * scripts/cli/danmaku/agent-output.ts: 把完整 Tool JSON 转成适合直接进入 Agent
 * 上下文的紧凑结果 (跟 subtitle-agent-output.ts 对齐).
 *
 * 完整 Tool 契约不变; 这里只移除 B站原始字段 (color / pool / weight / midHash 等),
 * 保留 Agent 判断完整性和抽样所需的最小信息.
 */
import type { GetDanmakuOutput } from "../../danmaku/get.js";

/** 面向 Agent 的紧凑弹幕片段. */
export interface AgentDanmakuSegment {
  /** 当前结果中的连续编号, 便于 Agent 在同一次回答中引用. */
  segmentNumber: number;
  /** 弹幕出现时间, 单位: 秒. */
  startSeconds: number;
  /** 弹幕文本. */
  text: string;
  /** 弹幕模式 (normal/bottom/top/reverse/advanced/code/bas). */
  mode: string;
  /** 弹幕颜色 hex. */
  color: string;
  /** 弹幕发送时间 ISO 8601, 可选. */
  sendTime?: string;
  /** 发送者 midHash (脱敏). */
  midHash?: string;
}

/** 命令行返回给 Agent 的紧凑弹幕结果. */
export interface AgentDanmakuOutput {
  success: boolean;
  outcome: GetDanmakuOutput["outcome"];
  video: GetDanmakuOutput["video"];
  danmaku?: {
    source: "bilibili_danmaku";
    language: string;
    cid?: string;
    total: number;
    segmentCount: number;
    complete: boolean;
    segments: AgentDanmakuSegment[];
  };
  acquisition: {
    status: GetDanmakuOutput["acquisition"]["status"];
    reasonCode?: string;
    message?: string;
    itemCount?: number;
    warnings: string[];
  };
  pageChoices: GetDanmakuOutput["pageChoices"];
  error: GetDanmakuOutput["error"];
}

/**
 * 把完整 Tool JSON 转成适合直接进入 Agent 上下文的紧凑结果.
 */
export function toAgentDanmakuOutput(result: GetDanmakuOutput): AgentDanmakuOutput {
  return {
    success: result.success,
    outcome: result.outcome,
    video: result.video,
    danmaku: result.danmaku
      ? {
          source: "bilibili_danmaku",
          language: result.danmaku.language,
          cid: result.danmaku.cid,
          total: result.danmaku.total,
          segmentCount: result.danmaku.segmentCount,
          complete: result.danmaku.complete,
          segments: result.danmaku.segments.map((segment, index) => ({
            segmentNumber: index + 1,
            startSeconds: segment.startSeconds,
            text: segment.text,
            mode: segment.mode,
            color: segment.color,
            sendTime: segment.sendTime,
            midHash: segment.midHash,
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
    pageChoices: result.pageChoices,
    error: result.error,
  };
}
