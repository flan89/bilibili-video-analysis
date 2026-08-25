/**
 * tests/unit/bilibili-hot-search-adapter.test.ts: B 站热搜适配层单元测试.
 *
 * 覆盖 (AGENTS_M8 §15.2):
 * - 正常 10 条标准化: keyword / displayName / position / heatScore / heatLayer / 商业标记;
 * - show_name 与 keyword 不同 (赛事包装) / show_name、图标、热度缺失;
 * - icon 的 http / https / 协议相对 / 空字符串四种形态;
 * - 商业标记存在 (true/false) 与缺失 (不写字段);
 * - 空列表 / 个别条目异常 (partial warnings) / 全部异常 (结构变化 failed);
 * - HTTP 412 / 业务 -352/-412 / -400 / 非 JSON / Envelope 变化的结构化错误;
 * - 必需的 User-Agent / Referer 请求头; 一次调用只发起一次请求.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  fetchHotSearchList,
  normalizeHotSearchTopics,
} from "../../scripts/discovery/bilibili-hot-search-adapter.js";
import { decodeHotSearchResponse } from "../../scripts/discovery/bilibili-hot-search-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/hot-search/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/** fetch stub: 返回指定状态码和 JSON 载荷, 并记录请求 URL 与 headers. */
function makeFetchStub(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

/** fetch stub: json() 抛错, 模拟非 JSON 响应. */
function makeNonJsonFetchStub(status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("invalid json");
    },
  })) as unknown as typeof fetch;
}

describe("normalizeHotSearchTopics", () => {
  it("正常 10 条: 词条字段完整标准化且保留平台顺序", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-normal.json")),
    );

    expect(normalized.topics).toHaveLength(10);
    expect(normalized.rawReturnedCount).toBe(10);
    expect(normalized.warnings).toHaveLength(0);
    expect(normalized.traceId).toBe("4552989185385350399");
    expect(normalized.platformObservedAt).toBe("2026-08-22T17:00:59.000Z");
    expect(normalized.reportedTotal).toBe(10);

    const first = normalized.topics[0]!;
    expect(first.keyword).toBe("国产3A新作实机演示");
    expect(first.displayName).toBe("国产3A新作实机演示");
    expect(first.position).toBe(1);
    expect(first.heatScore).toBe(8452913);
    expect(first.iconUrl).toBe("https://i0.hdslb.com/bfs/activity-plat/hot-icon-new.png");
    expect(first.heatLevel).toBe("A");
    expect(first.isCommercial).toBe(false);

    expect(normalized.topics.map((t) => t.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("show_name 与 keyword 不同时保留两者 (赛事包装场景)", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-normal.json")),
    );
    const match = normalized.topics[1]!;
    // keyword 是可交给 search-videos 的词; displayName 仅供展示.
    expect(match.keyword).toBe("城市德比决赛");
    expect(match.displayName).toBe("城市德比决赛 vs 卫冕冠军");
    expect(match.iconUrl).toBe("http://i0.hdslb.com/bfs/activity-plat/hot-icon-match.png");
  });

  it("show_name / 图标 / 热度缺失时不写对应字段", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-normal.json")),
    );
    // 第 3 条无 show_name; 第 8 条无 icon 与 heat_score.
    const noShowName = normalized.topics[2]!;
    expect(noShowName.keyword).toBe("台风路径最新消息");
    expect(noShowName.displayName).toBeUndefined();

    const minimal = normalized.topics[7]!;
    expect(minimal.keyword).toBe("老字号小吃探店");
    expect(minimal.iconUrl).toBeUndefined();
    expect(minimal.heatScore).toBeUndefined();
  });

  it("协议相对图标地址被规范化为 https, 空字符串视为缺省", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-normal.json")),
    );
    expect(normalized.topics[3]?.iconUrl).toBe(
      "https://i0.hdslb.com/bfs/activity-plat/hot-icon-film.png",
    );
    expect(normalized.topics[2]?.iconUrl).toBeUndefined();
  });

  it("字符串形式热度值被转换为数值", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-normal.json")),
    );
    expect(normalized.topics[3]?.heatScore).toBe(5810342);
  });

  it("商业标记: 平台的字符串/数值/布尔形态转换为布尔值, 缺失不写字段", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-normal.json")),
    );
    expect(normalized.topics[4]?.isCommercial).toBe(true);
    expect(normalized.topics[5]?.isCommercial).toBe(false);
    expect(normalized.topics[0]?.isCommercial).toBe(false);
    expect(normalized.topics[6]?.isCommercial).toBeUndefined();
  });

  it("空列表: 无词条且无 warning", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-empty.json")),
    );
    expect(normalized.topics).toHaveLength(0);
    expect(normalized.rawReturnedCount).toBe(0);
    expect(normalized.warnings).toHaveLength(0);
    expect(normalized.traceId).toBe("4552989185385350399");
  });

  it("list 为 null 时归一为空数组 (不抛错)", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse({ code: 0, list: null, top_list: null }),
    );
    expect(normalized.topics).toHaveLength(0);
    expect(normalized.rawReturnedCount).toBe(0);
  });

  it("个别条目异常: 跳过并计数 warning, position 保留原始位置", () => {
    const normalized = normalizeHotSearchTopics(
      decodeHotSearchResponse(fixture("hot-search-partial.json")),
    );

    expect(normalized.topics).toHaveLength(2);
    expect(normalized.rawReturnedCount).toBe(4);
    const warnings = normalized.warnings.join("\n");
    // 缺 keyword 字段 1 条 → 结构异常跳过.
    expect(warnings).toContain("1 条热搜词条结构与预期不一致");
    // 空白 keyword 1 条 → 缺可用搜索词跳过.
    expect(warnings).toContain("1 条热搜词条缺少可用搜索词");
    // position 保留原始列表位置 (第 1、4 条), 不是重新编号.
    expect(normalized.topics.map((t) => t.position)).toEqual([1, 4]);
    expect(normalized.traceId).toBe("4552989185385350400");
  });

  it("全部条目无法解析: 抛 hot_search_invalid_response (结构变化不当成空列表)", () => {
    const broken = {
      code: 0,
      list: [{ unexpected: 1 }, { also: "different" }],
      top_list: [],
    };
    let caught: unknown;
    try {
      normalizeHotSearchTopics(decodeHotSearchResponse(broken));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BilibiliError);
    expect((caught as BilibiliError).code).toBe("hot_search_invalid_response");
  });

  it("条目结构可解析但所有搜索词均为空时同样视为响应异常", () => {
    const raw = decodeHotSearchResponse({
      code: 0,
      list: [{ keyword: "" }, { keyword: "   " }],
      top_list: [],
    });

    expect(() => normalizeHotSearchTopics(raw)).toThrowError(
      expect.objectContaining({ code: "hot_search_invalid_response" }),
    );
  });
});

describe("fetchHotSearchList 请求与错误转换", () => {
  it("请求 main/hotword；limit 只在 Tool 本地截取", async () => {
    const fetchStub = makeFetchStub(fixture("hot-search-empty.json"));
    await fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 });

    const url = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toBe("https://s.search.bilibili.com/main/hotword");
  });

  it("必须携带普通 Web User-Agent 与首页 Referer", async () => {
    const fetchStub = makeFetchStub(fixture("hot-search-empty.json"));
    await fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 });

    const init = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla\/5\.0/);
    expect(headers["Referer"]).toBe("https://www.bilibili.com/");
  });

  it("一次调用只发起一次请求, 不自动追加请求", async () => {
    const fetchStub = makeFetchStub(fixture("hot-search-normal.json"));
    await fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("HTTP 412 → hot_search_risk_control (retryable=true)", async () => {
    const fetchStub = makeFetchStub({}, 412);
    await expect(fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_risk_control", retryable: true, httpStatus: 412 });
  });

  it("业务 -352 / -412 → hot_search_risk_control (retryable=true)", async () => {
    const riskOne = makeFetchStub({ code: -352, message: "风控拦截" });
    await expect(fetchHotSearchList({ fetchImpl: riskOne }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_risk_control", retryable: true, apiCode: -352 });

    const riskTwo = makeFetchStub({ code: -412, message: "风控拦截" });
    await expect(fetchHotSearchList({ fetchImpl: riskTwo }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_risk_control", retryable: true, apiCode: -412 });
  });

  it("其它业务错误 → hot_search_api_error (-400 不可重试, -509 可重试)", async () => {
    const badRequest = makeFetchStub({ code: -400, message: "请求错误" });
    await expect(fetchHotSearchList({ fetchImpl: badRequest }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_api_error", apiCode: -400, retryable: false });

    const rateLimited = makeFetchStub({ code: -509, message: "请求频繁" });
    await expect(fetchHotSearchList({ fetchImpl: rateLimited }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_api_error", apiCode: -509, retryable: true });
  });

  it("非 2xx HTTP → hot_search_http_error (5xx/429 可重试, 4xx 不可)", async () => {
    const serverError = makeFetchStub({}, 503);
    await expect(fetchHotSearchList({ fetchImpl: serverError }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_http_error", httpStatus: 503, retryable: true });

    const notFound = makeFetchStub({}, 404);
    await expect(fetchHotSearchList({ fetchImpl: notFound }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_http_error", httpStatus: 404, retryable: false });
  });

  it("非 JSON 响应 → hot_search_invalid_json", async () => {
    const fetchStub = makeNonJsonFetchStub();
    await expect(fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_invalid_json" });
  });

  it("Envelope 结构变化 → hot_search_invalid_response", async () => {
    const fetchStub = makeFetchStub({ unexpected: "structure" });
    await expect(fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_invalid_response" });
  });

  it("网络异常 → hot_search_network_error (retryable=true)", async () => {
    const fetchStub = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchHotSearchList({ fetchImpl: fetchStub }, { limit: 10 }))
      .rejects.toMatchObject({ code: "hot_search_network_error", retryable: true });
  });
});
