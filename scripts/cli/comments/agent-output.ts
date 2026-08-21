/**
 * scripts/cli/comments/agent-output.ts: 评论 Tool 的 Agent 紧凑视图.
 *
 * 跟 subtitle-agent-output / danmaku-agent-output 风格一致:
 * 隐藏 cid / pageNum / mode 等内部细节, 只暴露 Agent 真正关心的字段.
 */
import type { GetCommentsOutput } from "../../comments/get.js";

export function toAgentCommentsOutput(result: GetCommentsOutput): unknown {
  if (!result.success) {
    return {
      success: false,
      outcome: result.outcome,
      ...(result.error ? { error: result.error } : {}),
      ...(result.video ? { video: result.video } : {}),
    };
  }

  const collection = result.collection;
  if (!collection) {
    return {
      success: true,
      outcome: result.outcome,
      video: result.video,
      collection: null,
    };
  }

  const sampled = collection.comments.map((c) => ({
    id: c.id,
    content: c.content,
    likeCount: c.likeCount,
    replyCount: c.replyCount,
    isPinned: c.isPinned,
    publishedAt: c.publishedAt,
    user: c.user ? { userId: c.user.userId, name: c.user.name } : undefined,
    repliesPreview: c.replies.length > 0 ? c.replies.length : 0,
    repliesComplete: c.repliesComplete,
  }));

  return {
    success: true,
    outcome: result.outcome,
    video: result.video,
    acquisition: {
      status: result.acquisition.status,
      itemCount: result.acquisition.itemCount,
      warnings: result.acquisition.warnings,
    },
    collection: {
      totalReturned: collection.comments.length,
      totalReported: collection.totalReported,
      complete: collection.complete,
      samplingStrategy: collection.samplingStrategy,
      sampled,
      nextCursor: result.nextCursor,
    },
  };
}
