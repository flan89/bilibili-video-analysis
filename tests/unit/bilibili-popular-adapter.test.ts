/**
 * tests/unit/bilibili-popular-adapter.test.ts: B 站当前热门适配层单元测试.
 *
 * 覆盖 (AGENTS_M8 §15.1):
 * - 正常页标准化: 详情卡片字段 / 统计转换 / 分区 / 推荐理由 / URL 规范化;
 * - 推荐理由字符串与对象两种真实变体;
 * - 空列表 / 个别条目异常 (partial warnings) / 全部异常 (结构变化 failed);
 * - HTTP 412 / 业务 -352 / 非 JSON / Envelope 变化的结构化错误;
 * - 必需的 User-Agent / Referer 请求头;
 * - 一次调用只请求一页.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  extractDiscoveryReason,
  fetchPopularPage,
  normalizePopularResults,
  popularDurationToSeconds,
} from "../../scripts/discovery/bilibili-popular-adapter.js";
import { decodePopularResponse } from "../../scripts/discovery/bilibili-popular-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/popular/${name}`, import.meta.url);
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

describe("确定性清理工具", () => {
  it("extractDiscoveryReason 支持对象与字符串两种真实变体", () => {
    expect(extractDiscoveryReason({ content: "百万播放", corner_mark: 0 })).toBe("百万播放");
    expect(extractDiscoveryReason("千万播放")).toBe("千万播放");
  });

  it("extractDiscoveryReason 空字符串与缺失返回 undefined (不写空标签)", () => {
    expect(extractDiscoveryReason({ content: "", corner_mark: 0 })).toBeUndefined();
    expect(extractDiscoveryReason({ content: "   " })).toBeUndefined();
    expect(extractDiscoveryReason("")).toBeUndefined();
    expect(extractDiscoveryReason(undefined)).toBeUndefined();
  });

  it("popularDurationToSeconds 处理秒数值与字符串形式数字", () => {
    expect(popularDurationToSeconds(250)).toBe(250);
    expect(popularDurationToSeconds("250")).toBe(250);
    expect(popularDurationToSeconds(0)).toBe(0);
    expect(popularDurationToSeconds(undefined)).toBeUndefined();
    expect(popularDurationToSeconds(-1)).toBeUndefined();
    expect(popularDurationToSeconds("abc")).toBeUndefined();
  });
});

describe("normalizePopularResults", () => {
  it("正常页: 详情卡片字段完整标准化", () => {
    const normalized = normalizePopularResults(
      decodePopularResponse(fixture("popular-page-normal.json")),
    );

    expect(normalized.candidates).toHaveLength(3);
    expect(normalized.rawReturnedCount).toBe(3);
    expect(normalized.noMore).toBe(false);
    expect(normalized.warnings).toHaveLength(0);

    const first = normalized.candidates[0]!;
    expect(first.video.bvid).toBe("BV1G48M6XEBt");
    expect(first.title).toBe("复活吧 ！我的（ ）");
    expect(first.description).toBe("挑战高难度关卡的完整过程记录");
    expect(first.author?.userId).toBe("3546883796503085");
    expect(first.author?.name).toBe("HL-Flame");
    expect(first.publishedAt).toBe(1787286645);
    expect(first.durationSeconds).toBe(250);
    expect(first.coverUrl).toBe("http://i0.hdslb.com/bfs/archive/32bd89a388d516e86c9aef3669217f4d9a8b231d.jpg");
    expect(first.stats).toEqual({
      viewCount: 3229743,
      danmakuCount: 2757,
      favoriteCount: 202615,
      likeCount: 398925,
      replyCount: 13850,
      coinCount: 253954,
      shareCount: 31748,
    });
    expect(first.category).toEqual({ id: 65, name: "网络游戏" });
    expect(first.discoveryReason).toBe("百万播放");
    expect(first.position).toBe(1);
    expect(first.sourceUrl).toBe("https://www.bilibili.com/video/BV1G48M6XEBt/");
    expect(first.tags).toEqual([]);
  });

  it("协议相对封面地址被规范化为 https", () => {
    const normalized = normalizePopularResults(
      decodePopularResponse(fixture("popular-page-normal.json")),
    );
    expect(normalized.candidates[2]?.coverUrl).toBe(
      "https://i0.hdslb.com/bfs/archive/protocol-relative-cover-example.jpg",
    );
  });

  it("空推荐理由不写入 discoveryReason", () => {
    const normalized = normalizePopularResults(
      decodePopularResponse(fixture("popular-page-partial.json")),
    );
    // 缺 BV 条目 (rcmd_reason content="") 被跳过; 正常条目有理由.
    const ok = normalized.candidates.find((c) => c.video.bvid === "BV1aa8M6XEBt");
    expect(ok?.discoveryReason).toBe("百万播放");
  });

  it("空列表: 无候选且无 warning", () => {
    const normalized = normalizePopularResults(
      decodePopularResponse(fixture("popular-page-empty.json")),
    );
    expect(normalized.candidates).toHaveLength(0);
    expect(normalized.rawReturnedCount).toBe(0);
    expect(normalized.noMore).toBe(true);
    expect(normalized.warnings).toHaveLength(0);
  });

  it("个别条目异常: 跳过并计数 warning, 不静默丢弃", () => {
    const normalized = normalizePopularResults(
      decodePopularResponse(fixture("popular-page-partial.json")),
    );

    expect(normalized.candidates).toHaveLength(1);
    expect(normalized.rawReturnedCount).toBe(4);
    const warnings = normalized.warnings.join("\n");
    expect(warnings).toContain("1 条热门条目结构与预期不一致");
    // 缺 bvid 与空标题各 1 条, 合并计数为 2.
    expect(warnings).toContain("2 条热门条目缺少 BV 号或标题");
    // position 保留原始列表位置 (第 1 条), 不是重新编号.
    expect(normalized.candidates[0]?.position).toBe(1);
  });

  it("全部条目无法解析: 抛 popular_invalid_response (结构变化不当成空列表)", () => {
    const broken = {
      code: 0,
      data: {
        list: [{ unexpected: 1 }, { also: "different" }],
        no_more: false,
      },
    };
    let caught: unknown;
    try {
      normalizePopularResults(decodePopularResponse(broken));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BilibiliError);
    expect((caught as BilibiliError).code).toBe("popular_invalid_response");
  });

  it("条目结构可解析但全部缺少稳定身份或标题时同样视为响应异常", () => {
    const raw = decodePopularResponse({
      code: 0,
      data: {
        list: [
          { bvid: "", title: "有标题但没有 BV 号" },
          { bvid: "BV1aa8M6XEBt", title: "   " },
        ],
        no_more: false,
      },
    });

    expect(() => normalizePopularResults(raw)).toThrowError(
      expect.objectContaining({ code: "popular_invalid_response" }),
    );
  });
});

describe("fetchPopularPage 请求与错误转换", () => {
  it("请求 URL 与分页参数映射", async () => {
    const fetchStub = makeFetchStub(fixture("popular-page-empty.json"));
    await fetchPopularPage({ fetchImpl: fetchStub }, { page: 2, pageSize: 10 });

    const url = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain("x/web-interface/popular?");
    expect(url).toContain("ps=10");
    expect(url).toContain("pn=2");
  });

  it("必须携带普通 Web User-Agent 与热门页面 Referer (缺少时平台会 -352)", async () => {
    const fetchStub = makeFetchStub(fixture("popular-page-empty.json"));
    await fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 });

    const init = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/Mozilla\/5\.0/);
    expect(headers["Referer"]).toBe("https://www.bilibili.com/v/popular/all");
  });

  it("一次调用只发起一次请求, 不自动翻页", async () => {
    const fetchStub = makeFetchStub(fixture("popular-page-normal.json"));
    await fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("HTTP 412 → popular_risk_control (retryable=true)", async () => {
    const fetchStub = makeFetchStub({}, 412);
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_risk_control", retryable: true, httpStatus: 412 });
  });

  it("业务 -352 → popular_risk_control (retryable=true)", async () => {
    const fetchStub = makeFetchStub({ code: -352, message: "风控拦截" });
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_risk_control", retryable: true, apiCode: -352 });
  });

  it("业务 -412 → popular_risk_control (retryable=true)", async () => {
    const fetchStub = makeFetchStub({ code: -412, message: "风控拦截" });
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_risk_control", retryable: true, apiCode: -412 });
  });

  it("其它业务错误 → popular_api_error", async () => {
    const fetchStub = makeFetchStub({ code: -404, message: "啥都木有" });
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_api_error", apiCode: -404, retryable: false });
  });

  it("非 2xx HTTP → popular_http_error (5xx/429 可重试, 4xx 不可)", async () => {
    const serverError = makeFetchStub({}, 503);
    await expect(fetchPopularPage({ fetchImpl: serverError }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_http_error", httpStatus: 503, retryable: true });

    const notFound = makeFetchStub({}, 404);
    await expect(fetchPopularPage({ fetchImpl: notFound }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_http_error", httpStatus: 404, retryable: false });
  });

  it("非 JSON 响应 → popular_invalid_json", async () => {
    const fetchStub = makeNonJsonFetchStub();
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_invalid_json" });
  });

  it("Envelope 结构变化 → popular_invalid_response", async () => {
    const fetchStub = makeFetchStub({ unexpected: "structure" });
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_invalid_response" });
  });

  it("网络异常 → popular_network_error (retryable=true)", async () => {
    const fetchStub = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchPopularPage({ fetchImpl: fetchStub }, { page: 1, pageSize: 20 }))
      .rejects.toMatchObject({ code: "popular_network_error", retryable: true });
  });
});
