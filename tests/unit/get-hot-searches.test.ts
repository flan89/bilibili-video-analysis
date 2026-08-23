/**
 * tests/unit/get-hot-searches.test.ts: `bilibili.hot_searches` Tool 端到端测试.
 *
 * 覆盖 (AGENTS_M8 §15.2):
 * - success / missing / partial / failed 四种采集状态;
 * - limit 只做本地确定性截取, 不触发额外请求;
 * - 风控 (hot_search_risk_control) 的结构化表达;
 * - dataKind=hot_search_topics 与快照性质元信息 (含 traceId);
 * - 平台时间、报告总数、热度层级和商业标记得到保留;
 * - 原子边界: Tool 只返回词条, 不展开搜索.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHotSearchList } from "../../scripts/discovery/bilibili-hot-search-adapter.js";

vi.mock("../../scripts/discovery/bilibili-hot-search-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/discovery/bilibili-hot-search-adapter.js")>(
    "../../scripts/discovery/bilibili-hot-search-adapter.js",
  );
  return {
    ...actual,
    fetchHotSearchList: vi.fn(),
  };
});

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/hot-search/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

import { getBilibiliHotSearches } from "../../scripts/index.js";
import { decodeHotSearchResponse } from "../../scripts/discovery/bilibili-hot-search-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

function decodedFixture(name: string): ReturnType<typeof decodeHotSearchResponse> {
  return decodeHotSearchResponse(fixture(name));
}

describe("getBilibiliHotSearches", () => {
  beforeEach(() => {
    vi.mocked(fetchHotSearchList).mockReset();
  });

  it("正常响应: success + 采集记录 + 词条标准化", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-normal.json"));

    const result = await getBilibiliHotSearches({});

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.topics).toHaveLength(10);
    expect(result.topics[0]?.keyword).toBe("国产3A新作实机演示");
    expect(result.topics[4]?.isCommercial).toBe(true);
    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.dataKind).toBe("hot_search_topics");
    expect(result.acquisition.itemCount).toBe(10);
    expect(result.acquisition.source).toBe("bilibili_web_api");
    // 快照性质元信息: 供 Agent 表述来源机制边界 (搜索关注度快照, 非事件背景).
    expect(result.acquisition.metadata?.snapshotNature).toBe("platform_hot_search_snapshot");
    expect(result.acquisition.metadata?.limit).toBe(10);
    expect(result.acquisition.metadata?.rawReturnedCount).toBe(10);
    expect(result.acquisition.metadata?.traceId).toBe("4552989185385350399");
    expect(result.topics[0]?.heatLevel).toBe("A");
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("保留平台时间与报告总数", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-normal.json"));

    const result = await getBilibiliHotSearches({});

    expect(result.platformObservedAt).toBe("2026-08-22T17:00:59.000Z");
    expect(result.reportedTotal).toBe(10);
  });

  it("limit 只做本地确定性截取, 不触发额外请求", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-normal.json"));

    const result = await getBilibiliHotSearches({ limit: 3 });

    expect(result.topics).toHaveLength(3);
    // 只截前 3 条, 保留平台顺序.
    expect(result.topics.map((t) => t.keyword)).toEqual([
      "国产3A新作实机演示",
      "城市德比决赛",
      "台风路径最新消息",
    ]);
    expect(fetchHotSearchList).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchHotSearchList).mock.calls[0]?.[1]).toEqual({ limit: 3 });
    // rawReturnedCount 保留平台真实返回规模, 便于回查.
    expect(result.acquisition.metadata?.rawReturnedCount).toBe(10);
    expect(result.acquisition.itemCount).toBe(3);
  });

  it("空列表: success=true + acquisition.status=missing", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-empty.json"));

    const result = await getBilibiliHotSearches({});

    expect(result.success).toBe(true);
    expect(result.topics).toHaveLength(0);
    expect(result.acquisition.status).toBe("missing");
    expect(result.acquisition.itemCount).toBe(0);
  });

  it("个别条目异常: partial + warnings 公开跳过数量", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-partial.json"));

    const result = await getBilibiliHotSearches({});

    expect(result.success).toBe(true);
    expect(result.topics).toHaveLength(2);
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.itemCount).toBe(2);
    expect(result.acquisition.metadata?.rawReturnedCount).toBe(4);
    expect(result.acquisition.warnings.join("\n")).toContain("已跳过");
  });

  it("风控: failed + hot_search_risk_control + retryable=true", async () => {
    vi.mocked(fetchHotSearchList).mockRejectedValue(
      new BilibiliError({
        code: "hot_search_risk_control",
        message: "B 站热搜接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
        httpStatus: 412,
        retryable: true,
      }),
    );

    const result = await getBilibiliHotSearches({});

    expect(result.success).toBe(false);
    expect(result.topics).toHaveLength(0);
    expect(result.error?.code).toBe("hot_search_risk_control");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.httpStatus).toBe(412);
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("hot_search_risk_control");
  });

  it("全部条目无法解析: failed + hot_search_invalid_response", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(
      decodeHotSearchResponse({
        code: 0,
        list: [{ unexpected: 1 }],
        top_list: [],
      }),
    );

    const result = await getBilibiliHotSearches({});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("hot_search_invalid_response");
    expect(result.acquisition.status).toBe("failed");
  });

  it("limit 默认 10 并透传到 adapter, 且只调一次热搜接口", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-empty.json"));

    await getBilibiliHotSearches({});

    expect(fetchHotSearchList).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchHotSearchList).mock.calls[0]?.[1]).toEqual({ limit: 10 });
  });

  it("相同输入不依赖前一次调用留下的状态 (无状态)", async () => {
    vi.mocked(fetchHotSearchList).mockResolvedValue(decodedFixture("hot-search-normal.json"));

    const first = await getBilibiliHotSearches({});
    const second = await getBilibiliHotSearches({});

    expect(first.topics).toHaveLength(10);
    expect(second.topics).toHaveLength(10);
    expect(fetchHotSearchList).toHaveBeenCalledTimes(2);
  });

  it("limit 超出第一版上限 10 或非正数时拒绝输入", async () => {
    await expect(getBilibiliHotSearches({ limit: 11 })).rejects.toThrow();
    await expect(getBilibiliHotSearches({ limit: 0 })).rejects.toThrow();
    expect(fetchHotSearchList).not.toHaveBeenCalled();
  });
});
