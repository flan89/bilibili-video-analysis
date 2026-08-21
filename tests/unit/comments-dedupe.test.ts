/**
 * tests/unit/comments-dedupe.test.ts: 薄 deterministic preprocessing 单测 ().
 */
import { describe, expect, it } from "vitest";

import type { Comment } from "../../scripts/models/comment.js";
import {
  countByRole,
  dedupeByRpid,
  mergeCommentSamples,
  sortByReplyCount,
  validateCoverage,
} from "../../scripts/comments/dedupe.js";

/** 构造一条 Comment 用于测试. */
function makeComment(overrides: Partial<Comment> & { id: string }): Comment {
  const { id, ...rest } = overrides;
  return {
    rootId: undefined,
    parentId: undefined,
    oid: "2",
    user: { userId: "u" + id, name: "u" + id },
    content: "text " + id,
    likeCount: 0,
    replyCount: 0,
    publishedAt: 1700000000,
    floor: 1,
    isPinned: false,
    repliesComplete: false,
    replies: [],
    metadata: {},
    ...rest,
    id,
  } as Comment;
}

describe("comments/dedupe", () => {
  describe("dedupeByRpid", () => {
    it("按 rpid (id) 去重, 保留第一次", () => {
      const a = makeComment({ id: "1" });
      const b = makeComment({ id: "2" });
      const c = makeComment({ id: "1" }); // 重复
      const result = dedupeByRpid([a, b, c, a]);
      expect(result.map((c) => c.id)).toEqual(["1", "2"]);
    });

    it("空数组返空", () => {
      expect(dedupeByRpid([])).toEqual([]);
    });

    it("无重复保持原顺序", () => {
      const items = [makeComment({ id: "1" }), makeComment({ id: "2" }), makeComment({ id: "3" })];
      expect(dedupeByRpid(items).map((c) => c.id)).toEqual(["1", "2", "3"]);
    });
  });

  describe("countByRole", () => {
    it("按 role 计数", () => {
      const comments = [
        makeComment({ id: "1" }),
        makeComment({ id: "2" }),
        makeComment({ id: "3" }),
      ];
      const roles = ["Pain", "Job", "Pain"];
      expect(countByRole(comments, roles)).toEqual({ Pain: 2, Job: 1 });
    });

    it("length 不一致抛错", () => {
      const comments = [makeComment({ id: "1" }), makeComment({ id: "2" })];
      const roles = ["Pain"];
      expect(() => countByRole(comments, roles)).toThrow(/length/);
    });

    it("空数组返空", () => {
      expect(countByRole([], [])).toEqual({});
    });
  });

  describe("sortByReplyCount", () => {
    it("按 replyCount 降序", () => {
      const items = [
        makeComment({ id: "1", replyCount: 5 }),
        makeComment({ id: "2", replyCount: 100 }),
        makeComment({ id: "3", replyCount: 20 }),
      ];
      expect(sortByReplyCount(items).map((c) => c.id)).toEqual(["2", "3", "1"]);
    });

    it("不修改原数组", () => {
      const items = [
        makeComment({ id: "1", replyCount: 5 }),
        makeComment({ id: "2", replyCount: 10 }),
      ];
      const before = items.map((c) => c.id);
      sortByReplyCount(items);
      expect(items.map((c) => c.id)).toEqual(before);
    });

    it("空数组返空", () => {
      expect(sortByReplyCount([])).toEqual([]);
    });
  });

  describe("validateCoverage", () => {
    it("默认不传 fetchComplete → tier=unknown, 不论 sample size", () => {
      const comments = Array.from({ length: 50 }, (_, i) =>
        makeComment({ id: String(i) }),
      );
      const report = validateCoverage(comments, 1000);
      expect(report.tier).toBe("unknown");
      expect(report.rootCommentCount).toBe(50);
      expect(report.totalReported).toBe(1000);
    });

    it("fetchComplete=true + 小评论区 (< 200) → tier=small", () => {
      const comments = Array.from({ length: 50 }, (_, i) =>
        makeComment({ id: String(i) }),
      );
      const report = validateCoverage(comments, 1000, { fetchComplete: true });
      expect(report.tier).toBe("small");
    });

    it("fetchComplete=true + 中评论区 (200-5000) → tier=medium", () => {
      const comments = Array.from({ length: 500 }, (_, i) =>
        makeComment({ id: String(i) }),
      );
      const report = validateCoverage(comments, 88978, { fetchComplete: true });
      expect(report.tier).toBe("medium");
    });

    it("fetchComplete=true + 大评论区 (>= 5000) → tier=large", () => {
      const comments = Array.from({ length: 6000 }, (_, i) =>
        makeComment({ id: String(i) }),
      );
      const report = validateCoverage(comments, 88978, { fetchComplete: true });
      expect(report.tier).toBe("large");
    });

    it("fetchComplete=true + totalReported=0 → tier=small (按 size 推)", () => {
      const comments = [makeComment({ id: "1" })];
      const report = validateCoverage(comments, 0, { fetchComplete: true });
      expect(report.tier).toBe("small");
    });

    it("未传 fetchComplete 时 unknown 含 tier 不可用警告", () => {
      const comments = [makeComment({ id: "1" })];
      const report = validateCoverage(comments, 0);
      expect(report.tier).toBe("unknown");
      expect(
        report.warnings.some((w) => w.includes("tier 不可用")),
      ).toBe(true);
    });

    it("rootCommentCount > totalReported → warning", () => {
      const comments = Array.from({ length: 2000 }, (_, i) =>
        makeComment({ id: String(i) }),
      );
      const report = validateCoverage(comments, 100, { fetchComplete: true });
      expect(report.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("mergeCommentSamples", () => {
    it("合并 + dedupe + coverage", () => {
      const hot = {
        comments: [
          makeComment({ id: "1", replyCount: 10 }),
          makeComment({ id: "2", replyCount: 5 }),
        ],
        totalReported: 88978,
      };
      const time = {
        comments: [
          makeComment({ id: "1", replyCount: 10 }), // 重复
          makeComment({ id: "3", replyCount: 3 }),
        ],
        totalReported: 88978,
      };
      const result = mergeCommentSamples([hot, time]);
      expect(result.comments.map((c) => c.id)).toEqual(["1", "2", "3"]);
      // 默认 fetchComplete=false → tier=unknown, 即便 sample 3 条
      expect(result.coverage.tier).toBe("unknown");
      expect(result.coverage.totalReported).toBe(88978);
      expect(result.byRole).toEqual({});
    });

    it("mergeCommentSamples 传 fetchComplete=true → tier 按 size 推", () => {
      const collections = [
        {
          comments: Array.from({ length: 300 }, (_, i) =>
            makeComment({ id: String(i) }),
          ),
          totalReported: 500,
        },
      ];
      const result = mergeCommentSamples(collections, undefined, {
        fetchComplete: true,
      });
      expect(result.coverage.tier).toBe("medium");
    });

    it("带 roleMap 时输出 byRole", () => {
      const hot = { comments: [makeComment({ id: "1" }), makeComment({ id: "2" })] };
      const result = mergeCommentSamples([hot], ["Pain", "Job"]);
      expect(result.byRole).toEqual({ Pain: 1, Job: 1 });
    });

    it("取最大 totalReported (覆盖最广)", () => {
      const a = { comments: [makeComment({ id: "1" })], totalReported: 100 };
      const b = { comments: [makeComment({ id: "2" })], totalReported: 200 };
      const result = mergeCommentSamples([a, b]);
      expect(result.coverage.totalReported).toBe(200);
    });
  });
});
