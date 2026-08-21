/**
 * tests/unit/get-comments.test.ts: `bilibili.get_comments` Tool 端到端测试.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getMainRepliesPage } from "../../scripts/comments/bilibili-adapter.js";

vi.mock("../../scripts/comments/bilibili-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/comments/bilibili-adapter.js")>(
    "../../scripts/comments/bilibili-adapter.js",
  );
  return {
    ...actual,
    getMainRepliesPage: vi.fn(),
  };
});

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

interface CommentsFixtureClientOptions {
  metadataFixture?: "view-single.json" | "view-multi.json";
  failure?: "metadata";
  resolvedUrl?: string;
}

class CommentsFixtureClient {
  readonly resolvedUrls: string[] = [];
  private readonly metadataFixture: "view-single.json" | "view-multi.json";
  private readonly failure?: "metadata";
  private readonly resolvedUrl?: string;

  constructor(options: CommentsFixtureClientOptions = {}) {
    this.metadataFixture = options.metadataFixture ?? "view-single.json";
    this.failure = options.failure;
    this.resolvedUrl = options.resolvedUrl;
  }

  async getApiData<T>(
    path: string,
    _query: Record<string, string | number | boolean | undefined>,
    schema: { parse: (input: unknown) => T },
  ): Promise<T> {
    if (!path.includes("/view")) {
      throw new Error(`未知 fixture path: ${path}`);
    }
    if (this.failure === "metadata") {
      throw new Error("metadata_failed");
    }
    return schema.parse(fixture(this.metadataFixture));
  }

  async resolveFinalUrl(url: string): Promise<string> {
    this.resolvedUrls.push(url);
    return this.resolvedUrl ?? url;
  }

  async getBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async getJsonFromUrl<T>(_url: string, schema: { parse: (input: unknown) => T }): Promise<T> {
    return schema.parse({});
  }
}

import { getBilibiliComments } from "../../scripts/index.js";
import { decodeMainReplies } from "../../scripts/comments/bilibili-raw-schema.js";

describe("getBilibiliComments", () => {
  beforeEach(() => {
    vi.mocked(getMainRepliesPage).mockReset();
  });

  it("单P视频拉取成功, video 只含 bvid (不分P, 不选 cid)", async () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      {
        client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient,
      },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    // video 不再含 cid (评论是 aid 级, 不绑 cid)
    expect(result.video).toEqual({ bvid: "BV15wGR6CEhY" });
    expect(result.collection?.comments).toHaveLength(20);
    expect(result.collection?.totalReported).toBeGreaterThan(0);
    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.dataKind).toBe("comments");
  });

  it("多P视频也直接用 aid 拉, 不再要求选 P", async () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    const result = await getBilibiliComments(
      { video: "av999000111" },
      { client: new CommentsFixtureClient({ metadataFixture: "view-multi.json" }) as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    // 不再有 selection_required 状态
    expect(result.outcome).not.toBe("selection_required");
    // view-multi.json 的 bvid 是 BV1TESTMULTIP
    expect(result.video).toEqual({ bvid: "BV1TESTMULTIP" });
    expect(getMainRepliesPage).toHaveBeenCalledTimes(1);
  });

  it("metadata 接口失败: 评论 Tool 失败", async () => {
    const client = new CommentsFixtureClient({ failure: "metadata" });
    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      { client: client as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    expect(result.outcome).toBe("failed");
    expect(result.acquisition.source).toBe("bilibili_web_api");
    expect(getMainRepliesPage).not.toHaveBeenCalled();
  });

  it("adapter 抛 BilibiliError: 包成结构化 failed", async () => {
    vi.mocked(getMainRepliesPage).mockRejectedValue(
      new (await import("../../scripts/bilibili/errors.js")).BilibiliError({
        code: "comments_api_error",
        message: "B 站评论接口返 code=-403: 访问权限不足",
        retryable: true,
        apiCode: -403,
      }),
    );

    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      { client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("comments_api_error");
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("comments_api_error");
  });

  it("adapter 抛非 BilibiliError: 兜底成 unexpected_error", async () => {
    vi.mocked(getMainRepliesPage).mockRejectedValue(new Error("redis 炸了"));

    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      { client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("unexpected_error");
  });

  it("sort / pageSize / cursor 透传到 adapter (pageNum 已删)", async () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    await getBilibiliComments(
      { video: "BV15wGR6CEhY", sort: 2, pageSize: 10, cursor: "CAEiAggC" },
      { client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    const call = vi.mocked(getMainRepliesPage).mock.calls[0]?.[1];
    expect(call?.mode).toBe(2);
    expect(call?.ps).toBe(10);
    expect(call?.next).toBe("CAEiAggC");
  });

  it("Comment.oid 填的是 aid 不是 cid", async () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      { client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    // 拿第一条评论, oid 应该是 aid (114550001234567) 不是 cid
    const firstComment = result.collection?.comments[0];
    expect(firstComment?.oid).toBe("114550001234567");
  });

  it("nextCursor 从响应透传到 output", async () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      { client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    expect(result.nextCursor).toBeDefined();
  });

  it("totalReported 大于 comments.length 时 warning 出现", async () => {
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    const result = await getBilibiliComments(
      { video: "BV15wGR6CEhY" },
      { client: new CommentsFixtureClient() as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    expect(result.acquisition.warnings.length).toBeGreaterThan(0);
    expect(result.acquisition.warnings[0]).toContain("totalReported");
  });

  it("没有 selection_required 状态", async () => {
    // 多P 视频 (view-multi.json 有 2 P) 不再触发 selection_required
    const raw = fixture("comments-main-replies.json");
    const decoded = decodeMainReplies(raw);
    vi.mocked(getMainRepliesPage).mockResolvedValue(decoded);

    const result = await getBilibiliComments(
      { video: "av999000111" },
      { client: new CommentsFixtureClient({ metadataFixture: "view-multi.json" }) as unknown as import("../../scripts/bilibili/client.js").BilibiliSubtitleClient },
    );

    // 直接 success, 不需要 cid 选择
    expect(result.outcome).toBe("success");
  });
});
