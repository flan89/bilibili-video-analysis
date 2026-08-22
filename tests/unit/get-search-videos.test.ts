/**
 * tests/unit/get-search-videos.test.ts: `bilibili.search_videos` Tool 端到端测试.
 *
 * 覆盖 (AGENTS_M7 §11.1):
 * - success / missing / partial / failed 四种采集状态;
 * - 风控 (HTTP 412 与业务 -412) 的结构化表达;
 * - 平台报告总数达到上限时的 warning;
 * - Tool 只调一次搜索接口, 不额外获取详情/字幕/评论;
 * - 相同输入不依赖前一次调用留下的状态.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { searchVideoPage } from "../../scripts/discovery/bilibili-search-adapter.js";

vi.mock("../../scripts/discovery/bilibili-search-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/discovery/bilibili-search-adapter.js")>(
    "../../scripts/discovery/bilibili-search-adapter.js",
  );
  return {
    ...actual,
    searchVideoPage: vi.fn(),
  };
});

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/search/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

import { searchBilibiliVideos } from "../../scripts/index.js";
import { decodeSearchResponse } from "../../scripts/discovery/bilibili-search-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

function decodedFixture(name: string): ReturnType<typeof decodeSearchResponse> {
  return decodeSearchResponse(fixture(name));
}

describe("searchBilibiliVideos", () => {
  beforeEach(() => {
    vi.mocked(searchVideoPage).mockReset();
  });

  it("正常搜索: success + 采集记录 + 候选标准化", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-normal.json"));

    const result = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]?.title).not.toContain("<em");
    expect(result.candidates[0]?.sourceUrl).toBe("https://www.bilibili.com/video/BV1WMgp6aEND/");
    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.dataKind).toBe("video_candidates");
    expect(result.acquisition.itemCount).toBe(3);
    expect(result.acquisition.source).toBe("bilibili_web_api");
    expect(result.reportedTotal).toBe(235);
    expect(result.pageInfo).toEqual({
      page: 1,
      pageSize: 20,
      returnedCount: 3,
      hasNextPage: false,
    });
  });

  it("真实响应形态: 全部候选解析成功, 不误报 search_invalid_response", async () => {
    // 回归 P1-1: typeid 为字符串等真实形态曾导致逐条 safeParse 全失败.
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-real-shape.json"));

    const result = await searchBilibiliVideos({ query: "智能体", pageSize: 3 });

    expect(result.success).toBe(true);
    expect(result.candidates).toHaveLength(3);
    // numResults=1000 达到软上限, 按设计降级为 partial 并公开说明 (不代表解析失败).
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.warnings.join("\n")).toContain("常见上限");
    expect(result.reportedTotal).toBe(1000);
    expect(result.pageInfo.hasNextPage).toBe(true);
  });

  it("query 回显实际执行的稳定查询", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-empty.json"));

    const result = await searchBilibiliVideos({
      query: "Agent Skill",
      page: 2,
      pageSize: 10,
      order: "latest",
      duration: "over_60m",
    });

    expect(result.query).toEqual({
      keyword: "Agent Skill",
      order: "latest",
      page: 2,
      pageSize: 10,
      duration: "over_60m",
    });
  });

  it("满页且未到报告总数时 hasNextPage=true", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-normal.json"));

    const result = await searchBilibiliVideos({ query: "Agent Skill", pageSize: 3 });

    expect(result.pageInfo.returnedCount).toBe(3);
    expect(result.pageInfo.hasNextPage).toBe(true);
  });

  it("参数透传到 adapter, 且只调一次搜索接口 (不额外获取详情/字幕/评论)", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-empty.json"));

    await searchBilibiliVideos({
      query: "Agent Skill",
      page: 2,
      pageSize: 15,
      order: "views",
      duration: "10_to_30m",
    });

    expect(searchVideoPage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(searchVideoPage).mock.calls[0];
    expect(call?.[1]).toEqual({
      keyword: "Agent Skill",
      page: 2,
      pageSize: 15,
      order: "views",
      duration: "10_to_30m",
    });
  });

  it("空结果: success=true + acquisition.status=missing", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-empty.json"));

    const result = await searchBilibiliVideos({ query: "不存在的主题xyz" });

    expect(result.success).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.acquisition.status).toBe("missing");
    expect(result.acquisition.itemCount).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.pageInfo.hasNextPage).toBe(false);
  });

  it("平台报告总数达到上限时写入 warning 并降级为 partial", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-reported-total-cap.json"));

    const result = await searchBilibiliVideos({ query: "宽泛关键词" });

    expect(result.success).toBe(true);
    expect(result.reportedTotal).toBe(1000);
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.warnings.join("\n")).toContain("上限");
    expect(result.acquisition.warnings.join("\n")).toContain("不代表真实总数");
  });

  it("混入非视频条目: 过滤后 partial + warning", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-partial-fields.json"));

    const result = await searchBilibiliVideos({ query: "Agent Skill", page: 2 });

    expect(result.success).toBe(true);
    expect(result.acquisition.status).toBe("partial");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.position).toBe(4);
    expect(result.pageInfo.returnedCount).toBe(4);
  });

  it("业务 code -412 风控: failed + 稳定错误结构 + retryable=true", async () => {
    vi.mocked(searchVideoPage).mockRejectedValue(
      new BilibiliError({
        code: "search_risk_control",
        message: "B 站搜索接口触发风控 (code=-412)",
        apiCode: -412,
        retryable: true,
      }),
    );

    const result = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(result.success).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("search_risk_control");
    expect(result.acquisition.metadata?.apiCode).toBe(-412);
    expect(result.error).toEqual({
      code: "search_risk_control",
      message: "B 站搜索接口触发风控 (code=-412)",
      retryable: true,
      apiCode: -412,
    });
    // 失败时仍回显查询, 便于 Agent 定位失败的搜索词.
    expect(result.query.keyword).toBe("Agent Skill");
  });

  it("HTTP 412 风控: error 保留 httpStatus", async () => {
    vi.mocked(searchVideoPage).mockRejectedValue(
      new BilibiliError({
        code: "search_risk_control",
        message: "B 站搜索接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
        httpStatus: 412,
        retryable: true,
      }),
    );

    const result = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(result.success).toBe(false);
    expect(result.error?.httpStatus).toBe(412);
    expect(result.error?.retryable).toBe(true);
    expect(result.acquisition.metadata?.httpStatus).toBe(412);
  });

  it("结构变化: failed + search_invalid_response", async () => {
    vi.mocked(searchVideoPage).mockRejectedValue(
      new BilibiliError({
        code: "search_invalid_response",
        message: "B 站搜索响应结构与当前适配器预期不一致",
      }),
    );

    const result = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("search_invalid_response");
    expect(result.error?.retryable).toBe(false);
  });

  it("非 BilibiliError 异常兜底成 unexpected_error", async () => {
    vi.mocked(searchVideoPage).mockRejectedValue(new Error("磁盘满了"));

    const result = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("unexpected_error");
  });

  it("无状态: 相同输入连续两次调用结果一致 (除时间戳)", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-normal.json"));

    const first = await searchBilibiliVideos({ query: "Agent Skill" });
    // observedAt 是毫秒精度, 同一毫秒内连续调用时间戳相同属正常现象;
    // 加 2ms 延迟让两次调用落在不同毫秒, 才能验证时间戳确实跟随每次调用.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(second.candidates).toEqual(first.candidates);
    expect(second.query).toEqual(first.query);
    expect(second.pageInfo).toEqual(first.pageInfo);
    expect(second.reportedTotal).toEqual(first.reportedTotal);
    expect(second.acquisition.status).toEqual(first.acquisition.status);
    // observedAt 是每次调用的观察时间, 快照语义本身就应随调用变化.
    expect(second.observedAt).not.toBe(first.observedAt);
  });

  it("observedAt 是合法 ISO 时间, 搜索是当前快照", async () => {
    vi.mocked(searchVideoPage).mockResolvedValue(decodedFixture("search-video-normal.json"));

    const result = await searchBilibiliVideos({ query: "Agent Skill" });

    expect(() => new Date(result.observedAt).toISOString()).not.toThrow();
    expect(new Date(result.observedAt).getTime()).not.toBeNaN();
  });

  it("pageSize 超过第一版上限 20 时直接拒绝 (调用方错误)", async () => {
    await expect(
      searchBilibiliVideos({ query: "Agent Skill", pageSize: 21 }),
    ).rejects.toThrow();
    expect(searchVideoPage).not.toHaveBeenCalled();
  });

  it("空 query 拒绝", async () => {
    await expect(searchBilibiliVideos({ query: "" })).rejects.toThrow();
    expect(searchVideoPage).not.toHaveBeenCalled();
  });
});
