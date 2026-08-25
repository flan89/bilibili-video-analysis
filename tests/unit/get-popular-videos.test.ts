/**
 * tests/unit/get-popular-videos.test.ts: `bilibili.popular_videos` Tool 端到端测试.
 *
 * 覆盖 (AGENTS_M8 §15.1):
 * - success / missing / partial / failed 四种采集状态;
 * - hasNextPage 优先根据平台 no_more 确定;
 * - 风控 (popular_risk_control) 的结构化表达;
 * - Tool 一次只请求一页, 不自动翻页;
 * - dataKind=popular_video_candidates 与快照性质元信息.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPopularPage } from "../../scripts/discovery/bilibili-popular-adapter.js";

vi.mock("../../scripts/discovery/bilibili-popular-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/discovery/bilibili-popular-adapter.js")>(
    "../../scripts/discovery/bilibili-popular-adapter.js",
  );
  return {
    ...actual,
    fetchPopularPage: vi.fn(),
  };
});

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/popular/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

import { getBilibiliPopularVideos } from "../../scripts/index.js";
import { decodePopularResponse } from "../../scripts/discovery/bilibili-popular-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

function decodedFixture(name: string): ReturnType<typeof decodePopularResponse> {
  return decodePopularResponse(fixture(name));
}

describe("getBilibiliPopularVideos", () => {
  beforeEach(() => {
    vi.mocked(fetchPopularPage).mockReset();
  });

  it("正常页: success + 采集记录 + 候选标准化", async () => {
    vi.mocked(fetchPopularPage).mockResolvedValue(decodedFixture("popular-page-normal.json"));

    const result = await getBilibiliPopularVideos({});

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.video.bvid).toBe("BV1G48M6XEBt");
    expect(result.candidates[0]?.discoveryReason).toBe("百万播放");
    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.dataKind).toBe("popular_video_candidates");
    expect(result.acquisition.itemCount).toBe(3);
    expect(result.acquisition.source).toBe("bilibili_web_api");
    // 快照性质元信息: 供 Agent 表述来源机制边界.
    expect(result.acquisition.metadata?.snapshotNature).toBe("platform_popular_mechanism");
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("no_more=false 时 hasNextPage=true", async () => {
    vi.mocked(fetchPopularPage).mockResolvedValue(decodedFixture("popular-page-normal.json"));

    const result = await getBilibiliPopularVideos({ page: 1, pageSize: 3 });

    expect(result.pageInfo).toEqual({
      page: 1,
      pageSize: 3,
      returnedCount: 3,
      hasNextPage: true,
    });
  });

  it("no_more=true 时 hasNextPage=false (即使满页)", async () => {
    const lastPage = decodePopularResponse({
      ...(fixture("popular-page-normal.json") as Record<string, unknown>),
      data: {
        list: (fixture("popular-page-normal.json") as { data: { list: unknown[] } }).data.list,
        no_more: true,
      },
    });
    vi.mocked(fetchPopularPage).mockResolvedValue(lastPage);

    const result = await getBilibiliPopularVideos({ page: 5, pageSize: 3 });

    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.acquisition.status).toBe("success");
  });

  it("缺少 no_more 标记时按满页保守估计并写入 warning", async () => {
    const noFlag = decodePopularResponse({
      ...(fixture("popular-page-normal.json") as Record<string, unknown>),
      data: {
        list: (fixture("popular-page-normal.json") as { data: { list: unknown[] } }).data.list,
      },
    });
    vi.mocked(fetchPopularPage).mockResolvedValue(noFlag);

    const result = await getBilibiliPopularVideos({ pageSize: 3 });

    expect(result.pageInfo.hasNextPage).toBe(true);
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.warnings.join("\n")).toContain("no_more");
  });

  it("空列表: success=true + acquisition.status=missing", async () => {
    vi.mocked(fetchPopularPage).mockResolvedValue(decodedFixture("popular-page-empty.json"));

    const result = await getBilibiliPopularVideos({});

    expect(result.success).toBe(true);
    expect(result.candidates).toHaveLength(0);
    expect(result.acquisition.status).toBe("missing");
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("个别条目异常: partial + warnings 公开跳过数量", async () => {
    vi.mocked(fetchPopularPage).mockResolvedValue(decodedFixture("popular-page-partial.json"));

    const result = await getBilibiliPopularVideos({});

    expect(result.success).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.itemCount).toBe(1);
    expect(result.pageInfo.returnedCount).toBe(4);
  });

  it("风控: failed + popular_risk_control + retryable=true", async () => {
    vi.mocked(fetchPopularPage).mockRejectedValue(
      new BilibiliError({
        code: "popular_risk_control",
        message: "B 站热门接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
        httpStatus: 412,
        retryable: true,
      }),
    );

    const result = await getBilibiliPopularVideos({});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("popular_risk_control");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.httpStatus).toBe(412);
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("popular_risk_control");
    expect(result.pageInfo.returnedCount).toBe(0);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("参数透传到 adapter, 且只调一次热门接口 (不自动翻页)", async () => {
    vi.mocked(fetchPopularPage).mockResolvedValue(decodedFixture("popular-page-empty.json"));

    await getBilibiliPopularVideos({ page: 3, pageSize: 15 });

    expect(fetchPopularPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchPopularPage).mock.calls[0]?.[1]).toEqual({ page: 3, pageSize: 15 });
  });

  it("相同输入不依赖前一次调用留下的状态 (无状态)", async () => {
    vi.mocked(fetchPopularPage).mockResolvedValue(decodedFixture("popular-page-normal.json"));

    const first = await getBilibiliPopularVideos({});
    const second = await getBilibiliPopularVideos({});

    expect(first.candidates).toHaveLength(3);
    expect(second.candidates).toHaveLength(3);
    expect(fetchPopularPage).toHaveBeenCalledTimes(2);
  });

  it("pageSize 超过第一版上限 20 时拒绝输入", async () => {
    await expect(getBilibiliPopularVideos({ pageSize: 50 })).rejects.toThrow();
    expect(fetchPopularPage).not.toHaveBeenCalled();
  });
});
