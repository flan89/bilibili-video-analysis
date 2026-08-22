/**
 * tests/unit/get-danmaku.test.ts: `bilibili.get_danmaku` Tool 端到端测试.
 *
 * 覆盖:
 * - 单P成功 (默认选第1P)
 * - 多P未选 → selection_required
 * - 多P显式 page / cid 选择
 * - cid / page / URL p 冲突
 * - 未知 page / cid → 结构化失败
 * - metadata 接口失败 → 弹幕 Tool 失败 (不污染为成功)
 * - discoverDanmakuSegments 抛错 → structured failed
 * - 部分段拉取失败 (warnings) → status=partial, complete=false
 *
 * 用 mock 替换 `discoverDanmakuSegments`, 避免依赖网络 / protobuf fixture.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BilibiliSubtitleClient } from "../../scripts/bilibili/client.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";
import {
  type DiscoverDanmakuSegmentsResult,
  discoverDanmakuSegments,
} from "../../scripts/danmaku/bilibili-adapter.js";
import { getBilibiliDanmaku } from "../../scripts/danmaku/get.js";

vi.mock("../../scripts/danmaku/bilibili-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/danmaku/bilibili-adapter.js")>(
    "../../scripts/danmaku/bilibili-adapter.js",
  );
  return {
    ...actual,
    discoverDanmakuSegments: vi.fn(),
  };
});

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

interface DanmakuFixtureClientOptions {
  metadataFixture?: "view-single.json" | "view-multi.json";
  failure?: "metadata";
  resolvedUrl?: string;
}

class DanmakuFixtureClient implements BilibiliSubtitleClient {
  readonly resolvedUrls: string[] = [];
  readonly danmakuCalls: Array<Record<string, string | number | boolean | undefined>> = [];
  private readonly metadataFixture: "view-single.json" | "view-multi.json";
  private readonly failure?: "metadata";
  private readonly resolvedUrl?: string;

  constructor(options: DanmakuFixtureClientOptions = {}) {
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
      throw new BilibiliError({
        code: "metadata_failed",
        message: "模拟元信息接口失败",
        retryable: true,
      });
    }
    return schema.parse(fixture(this.metadataFixture));
  }

  async resolveFinalUrl(url: string): Promise<string> {
    this.resolvedUrls.push(url);
    return this.resolvedUrl ?? url;
  }

  async getBinary(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
  ): Promise<Uint8Array> {
    if (path.includes("/x/v2/dm/web/seg.so")) {
      this.danmakuCalls.push(query);
    }
    return new Uint8Array();
  }

  async getJsonFromUrl<T>(_url: string, schema: { parse: (input: unknown) => T }): Promise<T> {
    return schema.parse({});
  }
}

function makeMockDiscoverResult(
  overrides: Partial<DiscoverDanmakuSegmentsResult> = {},
): DiscoverDanmakuSegmentsResult {
  const cid = "3001002001";
  return {
    danmaku: {
      source: "bilibili_danmaku",
      language: "zh-CN",
      cid,
      provider: "bilibili_player_api",
      segments: [
        {
          id: "d-1700000000-12345",
          startSeconds: 1.5,
          endSeconds: 1.5,
          text: "测试弹幕",
          mode: "normal",
          color: "#FFFFFF",
          pool: "normal",
        },
      ],
      total: 1,
      segmentCount: 1,
      complete: true,
      metadata: { totalSegments: 1, truncated: false },
    },
    warnings: [],
    ...overrides,
  };
}

describe("getBilibiliDanmaku", () => {
  beforeEach(() => {
    vi.mocked(discoverDanmakuSegments).mockReset();
  });

  it("单P视频: 默认选第1P, 拉取成功, 标准化弹幕返回", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(makeMockDiscoverResult());

    const result = await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY" },
      { client: new DanmakuFixtureClient() },
    );

    expect(result.success).toBe(true);
    expect(result.outcome).toBe("success");
    expect(result.video).toEqual({ bvid: "BV15wGR6CEhY", cid: "3001002001" });
    expect(result.danmaku?.source).toBe("bilibili_danmaku");
    expect(result.danmaku?.segments).toHaveLength(1);
    expect(result.danmaku?.segments[0]?.text).toBe("测试弹幕");
    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.dataKind).toBe("danmaku");
  });

  it("多P未选: 返回 selection_required, 不发起弹幕拉取", async () => {
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliDanmaku(
      { video: "av999000111" },
      { client },
    );

    expect(result.outcome).toBe("selection_required");
    expect(result.pageChoices?.map((p) => p.cid)).toEqual(["81001", "81002"]);
    expect(result.acquisition.status).toBe("not_requested");
    expect(result.acquisition.reasonCode).toBe("danmaku_cid_required");
    expect(discoverDanmakuSegments).not.toHaveBeenCalled();
  });

  it("多P显式 page: 选择对应分P, 透传 aid+cid 给 adapter", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(makeMockDiscoverResult());
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });

    const result = await getBilibiliDanmaku(
      { video: "av999000111", page: 2 },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
    expect(discoverDanmakuSegments).toHaveBeenCalledTimes(1);
    const call = vi.mocked(discoverDanmakuSegments).mock.calls[0]?.[1];
    expect(call?.cid).toBe(81002);
    expect(call?.aid).toBe(999000111);
  });

  it("多P显式 cid: 只拉目标分P, 不退到第1P", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(makeMockDiscoverResult());
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });

    const result = await getBilibiliDanmaku(
      { video: "av999000111", cid: "81002" },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
    const call = vi.mocked(discoverDanmakuSegments).mock.calls[0]?.[1];
    expect(call?.cid).toBe(81002);
  });

  it("多P URL 的 p 参数直接选择对应分P", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(makeMockDiscoverResult());
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });

    const result = await getBilibiliDanmaku(
      { video: "https://www.bilibili.com/video/av999000111?p=2" },
      { client },
    );

    expect(result.success).toBe(true);
    expect(result.video?.cid).toBe("81002");
  });

  it("cid / page 冲突: 结构化失败, 不发起弹幕拉取", async () => {
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliDanmaku(
      { video: "av999000111", page: 1, cid: "81002" },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("conflicting_page_selection");
    expect(discoverDanmakuSegments).not.toHaveBeenCalled();
  });

  it("URL p 与命令 page 冲突: 结构化失败", async () => {
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliDanmaku(
      { video: "https://www.bilibili.com/video/av999000111?p=1", page: 2 },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("conflicting_page_selection");
    expect(discoverDanmakuSegments).not.toHaveBeenCalled();
  });

  it("未知 page 编号: 结构化失败 (unknown_page), 不回退到第1P", async () => {
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliDanmaku(
      { video: "av999000111", page: 99 },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("unknown_page");
    expect(discoverDanmakuSegments).not.toHaveBeenCalled();
  });

  it("未知 cid: 结构化失败 (unknown_cid)", async () => {
    const client = new DanmakuFixtureClient({ metadataFixture: "view-multi.json" });
    const result = await getBilibiliDanmaku(
      { video: "av999000111", cid: "99999" },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("unknown_cid");
    expect(discoverDanmakuSegments).not.toHaveBeenCalled();
  });

  it("metadata 接口失败: 弹幕 Tool 失败, 不污染成 selection_required", async () => {
    const client = new DanmakuFixtureClient({ failure: "metadata" });
    const result = await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY" },
      { client },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("metadata_failed");
    expect(result.error?.retryable).toBe(true);
    expect(result.acquisition.source).toBe("bilibili_web_api");
    expect(discoverDanmakuSegments).not.toHaveBeenCalled();
  });

  it("adapter 抛 BilibiliError: 包成结构化 failed, 不把异常抛给 Agent", async () => {
    vi.mocked(discoverDanmakuSegments).mockRejectedValue(
      new BilibiliError({
        code: "danmaku_segment_failed",
        message: "所有段都拉取失败",
        retryable: true,
      }),
    );

    const result = await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY" },
      { client: new DanmakuFixtureClient() },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("danmaku_segment_failed");
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("danmaku_segment_failed");
  });

  it("adapter 抛非 BilibiliError: 兜底成 unexpected_error, 不暴露内部异常类型", async () => {
    vi.mocked(discoverDanmakuSegments).mockRejectedValue(new Error("redis 炸了"));

    const result = await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY" },
      { client: new DanmakuFixtureClient() },
    );

    expect(result.outcome).toBe("failed");
    expect(result.error?.code).toBe("unexpected_error");
  });

  it("adapter 返回 warnings (部分段失败): status=partial, complete=false, warnings 透传", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(
      makeMockDiscoverResult({
        warnings: ["segment 3: 拉取失败 - timeout"],
        danmaku: {
          source: "bilibili_danmaku",
          language: "zh-CN",
          cid: "3001002001",
          provider: "bilibili_player_api",
          segments: [
            {
              id: "d-1700000000-1",
              startSeconds: 1.5,
              endSeconds: 1.5,
              text: "存活弹幕",
              mode: "normal",
              color: "#FFFFFF",
              pool: "normal",
            },
          ],
          total: 1,
          segmentCount: 3,
          complete: false,
          metadata: { totalSegments: 3, truncated: false },
        },
      }),
    );

    const result = await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY" },
      { client: new DanmakuFixtureClient() },
    );

    expect(result.success).toBe(true);
    expect(result.acquisition.status).toBe("partial");
    expect(result.danmaku?.complete).toBe(false);
    expect(result.danmaku?.segments).toHaveLength(1);
    expect(result.acquisition.warnings).toContain("segment 3: 拉取失败 - timeout");
  });

  it("complete=false still yields partial when adapter warnings are empty", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(
      makeMockDiscoverResult({
        warnings: [],
        danmaku: {
          source: "bilibili_danmaku",
          language: "zh-CN",
          cid: "3001002001",
          provider: "bilibili_player_api",
          segments: [],
          total: 0,
          segmentCount: 1,
          complete: false,
          metadata: { totalSegments: 1, droppedInvalidCount: 1 },
        },
      }),
    );

    const result = await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY" },
      { client: new DanmakuFixtureClient() },
    );

    expect(result.acquisition.status).toBe("partial");
    expect(result.danmaku?.complete).toBe(false);
  });

  it("maxSegments 透传到 adapter", async () => {
    vi.mocked(discoverDanmakuSegments).mockResolvedValue(makeMockDiscoverResult());

    await getBilibiliDanmaku(
      { video: "BV15wGR6CEhY", maxSegments: 5 },
      { client: new DanmakuFixtureClient() },
    );

    const call = vi.mocked(discoverDanmakuSegments).mock.calls[0]?.[1];
    expect(call?.maxSegments).toBe(5);
  });
});
