/**
 * scripts/cli/commands/tool.ts: 调单个 Tool 的实现细节.
 *
 * Tool 使用静态注册，发布时会和依赖一起打进单文件运行包。
 * 因此正式 Skill 包不需要源码、node_modules，也不依赖 process.cwd().
 */
import { getBilibiliMetadata } from "../../metadata/get.js";
import { getBilibiliSubtitle } from "../../subtitle/get.js";
import { getBilibiliDanmaku } from "../../danmaku/get.js";
import { getBilibiliComments } from "../../comments/get.js";
import { getBilibiliCommentReplies } from "../../comments/get-replies.js";
import { getBilibiliFrames } from "../../visual/get.js";
import { searchBilibiliVideos } from "../../discovery/search-videos.js";
import { getBilibiliPopularVideos } from "../../discovery/popular-videos.js";
import { getBilibiliHotSearches } from "../../discovery/hot-searches.js";
import { getBilibiliRelatedVideos } from "../../discovery/related-videos.js";
import { toAgentSubtitleOutput } from "../subtitle/agent-output.js";
import { toAgentDanmakuOutput } from "../danmaku/agent-output.js";
import { toAgentCommentsOutput } from "../comments/agent-output.js";
import {
  toAgentHotSearchesOutput,
  toAgentPopularVideosOutput,
  toAgentRelatedVideosOutput,
  toAgentSearchVideosOutput,
} from "../discovery/agent-output.js";

type ToolFunction = (input: never) => Promise<unknown>;

/** Tool 注册表：name → 导出函数名 + 实际函数。 */
const TOOL_MAP: Record<string, { functionName: string; run: ToolFunction; compact?: (result: never) => unknown }> = {
  metadata: {
    functionName: "getBilibiliMetadata",
    run: getBilibiliMetadata as ToolFunction,
  },
  subtitle: {
    functionName: "getBilibiliSubtitle",
    run: getBilibiliSubtitle as ToolFunction,
    compact: toAgentSubtitleOutput as (result: never) => unknown,
  },
  danmaku: {
    functionName: "getBilibiliDanmaku",
    run: getBilibiliDanmaku as ToolFunction,
    compact: toAgentDanmakuOutput as (result: never) => unknown,
  },
  comments: {
    functionName: "getBilibiliComments",
    run: getBilibiliComments as ToolFunction,
    compact: toAgentCommentsOutput as (result: never) => unknown,
  },
  "comment-replies": {
    functionName: "getBilibiliCommentReplies",
    run: getBilibiliCommentReplies as ToolFunction,
  },
  frames: {
    functionName: "getBilibiliFrames",
    run: getBilibiliFrames as ToolFunction,
  },
  "search-videos": {
    functionName: "searchBilibiliVideos",
    run: searchBilibiliVideos as ToolFunction,
    compact: toAgentSearchVideosOutput as (result: never) => unknown,
  },
  "popular-videos": {
    functionName: "getBilibiliPopularVideos",
    run: getBilibiliPopularVideos as ToolFunction,
    compact: toAgentPopularVideosOutput as (result: never) => unknown,
  },
  "hot-searches": {
    functionName: "getBilibiliHotSearches",
    run: getBilibiliHotSearches as ToolFunction,
    compact: toAgentHotSearchesOutput as (result: never) => unknown,
  },
  "related-videos": {
    functionName: "getBilibiliRelatedVideos",
    run: getBilibiliRelatedVideos as ToolFunction,
    compact: toAgentRelatedVideosOutput as (result: never) => unknown,
  },
};

export const TOOL_NAMES = Object.keys(TOOL_MAP);

export const TOOL_USAGE = `Usage: tool <tool-name> <input-json>

Available tools:
${Object.keys(TOOL_MAP)
  .map((k) => `  - ${k.padEnd(18)} -> ${TOOL_MAP[k]!.functionName}`)
  .join("\n")}

Input: JSON 字符串 (e.g. '{"video":"BV1xx411c7mD"}')
Option: --compact（支持 subtitle / danmaku / comments 及四个 discovery Tool）
Output: 完整 Tool 结果 JSON 到 stdout, 错误 JSON 到 stderr
`;

/**
 * 执行单个 Tool 调用.
 *
 * @param args 来自 router 拆好的 argv (tool name + input json)
 * @returns exit code (0 / 1 / 2)
 */
export async function runToolCommand(args: string[]): Promise<number> {
  const toolName = args[0];
  const inputJson = args[1];

  if (!toolName) {
    process.stderr.write(TOOL_USAGE);
    return 2;
  }
  if (!(toolName in TOOL_MAP)) {
    process.stderr.write(`Error: unknown tool "${toolName}"\n\n`);
    process.stderr.write(TOOL_USAGE);
    return 2;
  }
  if (!inputJson) {
    process.stderr.write(`Error: missing <input-json> argument\n`);
    process.stderr.write(TOOL_USAGE);
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(inputJson);
  } catch (e) {
    process.stderr.write(
      `Error: invalid JSON input: ${(e as Error).message}\n`,
    );
    return 2;
  }

  const tool = TOOL_MAP[toolName]!;
  try {
    const compactRequested = args.slice(2).includes("--compact");
    if (compactRequested && !tool.compact) {
      process.stderr.write(`Error: tool "${toolName}" does not support --compact\n`);
      return 2;
    }
    const result = await tool.run(input as never);
    const output = compactRequested ? tool.compact!(result as never) : result;
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return 0;
  } catch (e) {
    const err = e as Error;
    const errorOutput = {
      tool: toolName,
      error: err.name ?? "Error",
      message: err.message,
    };
    process.stderr.write(JSON.stringify(errorOutput, null, 2) + "\n");
    return 1;
  }
}
