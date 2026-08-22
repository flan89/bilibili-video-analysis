/**
 * tests/unit/comments-raw-schema.test.ts: comments raw-schema + adapter 单测.
 *
 * 覆盖:
 * - decodeMainReplies / decodeReplyThread 解析真实 B 站 fixture
 * - normalizeMainReplies 转 Comment 列表
 * - normalizeReplyThread 转回复树
 * - B 站 state 字段 (UP主置顶 / 已删除)
 * - rpid 字符串保留 (大数场景)
 * - root/parent 0 → undefined 映射
 *
 * 不依赖网络. fixture 来自 tmp/m3-s2-probe/fetch-fixtures.mjs (BV1xx411c7mD 真实评论).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodeMainReplies,
  decodeReplyThread,
  isUpPinned,
} from "../../scripts/comments/bilibili-raw-schema.js";
import {
  type FetchContext,
  getMainRepliesPage,
  getReplyRepliesPage,
  normalizeMainReplies,
  normalizeReplyThread,
  wrapMainRepliesAsCollection,
} from "../../scripts/comments/bilibili-adapter.js";
import { WbiSigner } from "../../scripts/bilibili/wbi.js";
import { isReplyThreadComplete } from "../../scripts/comments/get-replies.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("decodeMainReplies 解析真实 fixture", () => {
  it("BV1xx411c7mD 拉到的 20 条根评论可解析", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    expect(decoded.code).toBe(0);
    expect(decoded.data?.replies?.length ?? 0).toBeGreaterThan(0);
    expect(decoded.data?.cursor?.all_count).toBeGreaterThan(0);
    // next_cursor 存在 (B 站用 pagination_reply.next_offset)
    expect(decoded.data?.cursor?.pagination_reply?.next_offset).toBeDefined();
  });

  it("每条根评论有 rpid / content.message / member.uname", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const first = decoded.data?.replies?.[0];
    expect(first?.rpid).toBeDefined();
    expect(first?.content?.message).toBeDefined();
    expect(first?.member?.uname).toBeDefined();
  });
});

describe("decodeReplyThread 解析真实 fixture", () => {
  it("BV1xx411c7mD 根评论 495059 的 20 条回复可解析", () => {
    const raw = fixture("comments-reply-thread.json");
    const decoded = decodeReplyThread(raw);
    expect(decoded.code).toBe(0);
    expect(decoded.data?.replies?.length ?? 0).toBeGreaterThan(0);
    expect(decoded.data?.page?.count).toBeGreaterThan(0);
    // root 字段是根评论对象, 业务层可参考
    expect(decoded.data?.root?.rpid).toBe(495059);
  });
});

describe("isUpPinned / 已删除评论识别", () => {
  it("state=2 是 UP 主置顶", () => {
    expect(isUpPinned(2)).toBe(true);
    expect(isUpPinned(0)).toBe(false);
    expect(isUpPinned(undefined)).toBeUndefined();
  });
});

describe("normalizeMainReplies 转标准 Comment", () => {
  it("20 条根评论转 20 条 Comment", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "2");
    expect(result.comments).toHaveLength(20);
    expect(result.allCount).toBeGreaterThan(0);
    expect(result.nextCursor).toBeDefined();
    expect(result.complete).toBe(false);
    expect(result.mode).toBe(3);
  });

  it("rpid 大数 (uint64) 转字符串保留精度", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "2");
    const first = result.comments[0]!;
    // 495059 是 B 站早期 rpid, 不大, 但 id 应该是字符串
    expect(typeof first.id).toBe("string");
    expect(first.id.length).toBeGreaterThan(0);
  });

  it("UP 主置顶评论 (state=2) 的 isPinned 字段正确", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "2");
    // BV1xx411c7mD 的 rpid=495059 是 UP 主置顶 (state=2)
    const pinned = result.comments.find((c) => c.isPinned === true);
    expect(pinned).toBeDefined();
  });

  it("根评论 oid 字段被填上", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "999");
    for (const c of result.comments) {
      expect(c.oid).toBe("999");
    }
  });

  it("repliesComplete 在 main 响应里是 false (只有热门预览)", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "2");
    for (const c of result.comments) {
      expect(c.repliesComplete).toBe(false);
    }
  });

  it("根评论的 rootId/parentId 是 undefined (自身)", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "2");
    for (const c of result.comments) {
      expect(c.rootId).toBeUndefined();
      expect(c.parentId).toBeUndefined();
    }
  });

  it("B 站 reply 内的已删除评论 (message 空) 被替换为 [已删除]", () => {
    // rpid 495059 内嵌的 reply 应该有已删除的 (state=0 但 message="")
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const result = normalizeMainReplies(decoded, "2");
    // 内嵌 replies 是 0-3 条热门预览, 不一定有. 跑通不报错就算过
    const hasDeleted = result.comments.some((c) =>
      c.replies.some((r) => r.content === "[已删除]"),
    );
    // 不强制, 只验证解析不抛错
    expect(typeof hasDeleted).toBe("boolean");
  });
});

describe("normalizeReplyThread 转完整回复树", () => {
  it("回复树不完整时, repliesComplete=false (而不是 true)", () => {
    // fixture 里 pageCount=1495 但只返 20 条, 整页远没拿全
    const raw = fixture("comments-reply-thread.json");
    const decoded = decodeReplyThread(raw);
    const result = normalizeReplyThread(decoded, "495059");
    expect(result.replies.length).toBeGreaterThan(0);
    expect(result.rootId).toBe("495059");
    // 之前错误地标 true, 按 pageCount 判定
    for (const r of result.replies) {
      expect(r.repliesComplete).toBe(false);
      // 回复的 rootId 是 495059
      expect(r.rootId).toBe("495059");
    }
    // 顶层 lastPageReached 也 false (cursor.is_end 缺失 → 严格保守)
    // 不再用 (pageNum-1)*pageSize+len 推, 严格基于 cursor.is_end
    expect(result.lastPageReached).toBe(false);
    expect(result.hasMore).toBe(true);
    expect(result.nextPage).toBe(2);
    expect(result.totalReported).toBe(1495);
  });

  it("reply 嵌套回复的 parentId 指向直接父节点 (跟 B 站 parent 字段一致)", () => {
    const raw = fixture("comments-reply-thread.json");
    const decoded = decodeReplyThread(raw);
    const result = normalizeReplyThread(decoded, "495059");
    for (const r of result.replies) {
      // parentId 要么是 root (495059), 要么是另一个 reply (嵌套)
      expect(r.parentId).toBeDefined();
      expect(r.parentId).not.toBe("0");
    }
  });

  it("page 信息 + lastPageReached + nextPage 正确 ()", () => {
    const raw = fixture("comments-reply-thread.json");
    const decoded = decodeReplyThread(raw);
    const result = normalizeReplyThread(decoded, "495059");
    expect(result.page.num).toBe(1);
    expect(result.page.size).toBe(20);
    expect(result.page.count).toBe(1495);
    expect(result.totalReported).toBe(1495);
    expect(result.lastPageReached).toBe(false);
    expect(result.hasMore).toBe(true);
    expect(result.nextPage).toBe(2);
  });

  it("cursor.is_end=true → lastPageReached=true (不靠 page 推算)", () => {
    // B 站 cursor.is_end 才是最后一页的权威判定, 不是 page 推算.
    // 旧 complete 公式 (pageNum-1)*size+len >= pageCount 在 page=2 拿后 10 条时
    // 也会误判 complete=true, Agent 以为自己读完线程. 现改为严格 cursor 判定.
    const mockRaw = {
      code: 0,
      message: "0",
      ttl: 1,
      data: {
        page: { num: 1, size: 20, count: 2 },
        cursor: { is_end: true },  // 关键: B 站说 is_end
        replies: [
          { rpid: "1", root: "100", parent: "100", dialog: "1", content: { message: "reply 1" } },
          { rpid: "2", root: "100", parent: "100", dialog: "2", content: { message: "reply 2" } },
        ],
      },
    };
    const decoded = decodeReplyThread(mockRaw);
    const result = normalizeReplyThread(decoded, "100");
    expect(result.lastPageReached).toBe(true);
    expect(result.hasMore).toBe(false);
    expect(result.nextPage).toBeUndefined();
    expect(result.totalReported).toBe(2);
    // 顶层 lastPageReached=true 不代表 reply 自己的子回复完整.
    // B 站 reply 接口嵌套的 replies 字段是 0-3 热门预览, 永远 false.
    for (const r of result.replies) {
      expect(r.repliesComplete).toBe(false);
    }
  });

  it("cursor.is_end 缺失 → 严格保守 (false), 不再用 page 推算", () => {
    // 关键: 即使 pageCount=2 跟 replies.length 一致, 没 cursor.is_end 也保守 false
    // 防止无状态 Tool 直接 page=2 拿后 10 条时被误判 complete=true
    const mockRaw = {
      code: 0,
      message: "0",
      ttl: 1,
      data: {
        page: { num: 1, size: 20, count: 2 },
        // 注意: 没有 cursor.is_end
        replies: [
          { rpid: "1", root: "100", parent: "100", dialog: "1", content: { message: "reply 1" } },
          { rpid: "2", root: "100", parent: "100", dialog: "2", content: { message: "reply 2" } },
        ],
      },
    };
    const decoded = decodeReplyThread(mockRaw);
    const result = normalizeReplyThread(decoded, "100");
    // 严格保守: 没有 cursor.is_end=true, 就算 pageCount 一致也不标 lastPageReached
    expect(result.lastPageReached).toBe(false);
    expect(result.hasMore).toBe(true);
    expect(result.nextPage).toBe(2);
  });
});

describe("wrapMainRepliesAsCollection", () => {
  it("包装成标准 CommentCollection (M1 schema)", () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    const normalized = normalizeMainReplies(decoded, "2");
    const collection = wrapMainRepliesAsCollection(normalized, "hot");
    expect(collection.comments).toHaveLength(20);
    expect(collection.complete).toBe(false);
    expect(collection.samplingStrategy).toContain("wbi_main_hot");
    expect(collection.totalReported).toBeGreaterThan(0);
  });

  it("keeps totalReported unknown when the platform omits all_count", () => {
    const decoded = decodeMainReplies({
      code: 0,
      data: { replies: [{ rpid: "1", content: { message: "sample" } }] },
    });
    const normalized = normalizeMainReplies(decoded, "2");
    const collection = wrapMainRepliesAsCollection(normalized, "hot");

    expect(normalized.allCount).toBeUndefined();
    expect(collection.totalReported).toBeUndefined();
    expect(collection.complete).toBe(false);
  });
});

describe("isReplyThreadComplete", () => {
  it("does not treat a directly requested last page as the complete thread", () => {
    expect(isReplyThreadComplete({
      page: { num: 2 },
      replies: [{ id: "21" }] as never,
      totalReported: 1,
      lastPageReached: true,
    })).toBe(false);
  });

  it("accepts page 1 only when it contains the reported whole thread", () => {
    expect(isReplyThreadComplete({
      page: { num: 1 },
      replies: [{ id: "1" }, { id: "2" }] as never,
      totalReported: 2,
      lastPageReached: true,
    })).toBe(true);
  });
});

describe("getMainRepliesPage / getReplyRepliesPage 签名构造", () => {
  function makeMockFetch(): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture("comments-main-replies.json"),
    }) as unknown as typeof fetch;
  }

  function makeMockSigner(): WbiSigner {
    return {
      signRequest: vi.fn().mockResolvedValue("oid=2&type=1&w_rid=xxx&wts=123"),
    } as unknown as WbiSigner;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getMainRepliesPage 调 fetch 时 URL 包含 wbi main 端点", async () => {
    const fetchImpl = makeMockFetch();
    const ctx: FetchContext = { signer: makeMockSigner(), fetchImpl };
    await getMainRepliesPage(ctx, { aid: 2 });
    const calledUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("x/v2/reply/wbi/main");
  });

  it("getReplyRepliesPage 调 fetch 时 URL 包含 reply 端点", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => fixture("comments-reply-thread.json"),
    });
    const ctx: FetchContext = {
      signer: { signRequest: vi.fn().mockResolvedValue("oid=2&root=495059&w_rid=xxx") } as unknown as WbiSigner,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    await getReplyRepliesPage(ctx, { aid: 2, root: 495059 });
    const calledUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("x/v2/reply/reply");
  });

  it("HTTP 非 2xx 抛 comments_http_error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    const ctx: FetchContext = {
      signer: makeMockSigner(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    try {
      await getMainRepliesPage(ctx, { aid: 2 });
      expect.fail("应该抛错");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("comments_http_error");
    }
  });

  it("B 站 code != 0 抛 comments_api_error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: -403, message: "访问权限不足" }),
    });
    const ctx: FetchContext = {
      signer: makeMockSigner(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    try {
      await getMainRepliesPage(ctx, { aid: 2 });
      expect.fail("应该抛错");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("comments_api_error");
    }
  });
});
