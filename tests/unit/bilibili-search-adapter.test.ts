/**
 * tests/unit/bilibili-search-adapter.test.ts: B 站视频搜索适配层单元测试.
 *
 * 覆盖 (AGENTS_M7 §11.1):
 * - 排序 / 时长 / 分页参数映射;
 * - 高亮清理 / arcurl 规范化 / 时长解析 / "--" 统计转换;
 * - 非视频条目 / 缺 BV 条目 / 结构异常条目的过滤与 warning;
 * - 真实响应形态回归 (typeid 字符串 / av 号 arcurl / pic 封面字段);
 * - HTTP 412 / 业务 -412 / 非 JSON / 结构变化的结构化错误.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractBvidFromArcurl,
  normalizeProtocolRelativeUrl,
  normalizeSearchVideoResults,
  parseDurationToSeconds,
  searchVideoPage,
  stripHighlightTags,
  toCount,
} from "../../scripts/discovery/bilibili-search-adapter.js";
import { decodeSearchResponse } from "../../scripts/discovery/bilibili-search-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";
import type { WbiSigner } from "../../scripts/bilibili/wbi.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/search/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/** 假签名器: 不做 MD5, 只把业务参数拼成 query string, 便于断言参数映射. */
function makeFakeSigner(): WbiSigner {
  return {
    signRequest: async (
      _client: unknown,
      params: Record<string, string | number | boolean | undefined>,
    ) =>
      new URLSearchParams(
        Object.entries(params).map(([key, value]) => [key, String(value)]),
      ).toString(),
  } as unknown as WbiSigner;
}

/** fetch stub: 返回指定状态码和 JSON 载荷. */
function makeFetchStub(payload: unknown, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

const BASE_OPTIONS = { page: 1, pageSize: 20 };

describe("确定性清理工具", () => {
  it("stripHighlightTags 去掉 em 高亮标记并保留内文", () => {
    expect(
      stripHighlightTags('如何设计 <em class="keyword">Agent</em> <em class="keyword">Skill</em>：思路'),
    ).toBe("如何设计 Agent Skill：思路");
  });

  it("parseDurationToSeconds 支持 MM:SS 和 H:MM:SS", () => {
    expect(parseDurationToSeconds("15:32")).toBe(932);
    expect(parseDurationToSeconds("1:02:03")).toBe(3723);
    expect(parseDurationToSeconds("0:30")).toBe(30);
    // 真实响应的两段格式分钟段可超过 60 (总分:秒), 不进位为小时.
    expect(parseDurationToSeconds("303:15")).toBe(18195);
  });

  it("parseDurationToSeconds 非法格式返回 undefined", () => {
    expect(parseDurationToSeconds("30")).toBeUndefined();
    expect(parseDurationToSeconds("ab:cd")).toBeUndefined();
    expect(parseDurationToSeconds("")).toBeUndefined();
  });

  it("toCount 转换字符串统计, '--' 和非法值返回 undefined", () => {
    expect(toCount("128000")).toBe(128000);
    expect(toCount(4096)).toBe(4096);
    expect(toCount("--")).toBeUndefined();
    expect(toCount(undefined)).toBeUndefined();
    expect(toCount(-1)).toBeUndefined();
  });

  it("extractBvidFromArcurl 从协议相对地址提取 BV 号", () => {
    expect(extractBvidFromArcurl("//www.bilibili.com/video/BV1WMgp6aEND")).toBe("BV1WMgp6aEND");
    expect(extractBvidFromArcurl("https://www.bilibili.com/video/BV1AbCdEfGh2/?p=2")).toBe("BV1AbCdEfGh2");
    expect(extractBvidFromArcurl("//www.bilibili.com/bangumi/play/ep123456")).toBeUndefined();
  });

  it("normalizeProtocolRelativeUrl 补全协议相对地址", () => {
    expect(normalizeProtocolRelativeUrl("//i0.hdslb.com/a.jpg")).toBe("https://i0.hdslb.com/a.jpg");
    expect(normalizeProtocolRelativeUrl("http://i0.hdslb.com/a.jpg")).toBe("http://i0.hdslb.com/a.jpg");
    expect(normalizeProtocolRelativeUrl("https://i0.hdslb.com/a.jpg")).toBe("https://i0.hdslb.com/a.jpg");
    expect(normalizeProtocolRelativeUrl("i0.hdslb.com/a.jpg")).toBeUndefined();
  });
});

describe("searchVideoPage 参数映射与错误转换", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("稳定参数映射为 B 站原始参数 (order/duration/分页)", async () => {
    const fetchStub = makeFetchStub(fixture("search-video-empty.json"));
    await searchVideoPage(
      { signer: makeFakeSigner(), fetchImpl: fetchStub },
      { keyword: "Agent Skill", page: 2, pageSize: 20, order: "latest", duration: "10_to_30m" },
    );

    const url = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain("x/web-interface/wbi/search/type?");
    expect(url).toContain("search_type=video");
    expect(url).toContain("keyword=Agent+Skill");
    expect(url).toContain("page=2");
    expect(url).toContain("page_size=20");
    expect(url).toContain("order=pubdate");
    expect(url).toContain("duration=2");
  });

  it("relevance 映射为 totalrank, 未传 duration 时不携带该参数", async () => {
    const fetchStub = makeFetchStub(fixture("search-video-empty.json"));
    await searchVideoPage(
      { signer: makeFakeSigner(), fetchImpl: fetchStub },
      { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
    );

    const url = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(url).toContain("order=totalrank");
    expect(url).not.toContain("duration=");
  });

  it("HTTP 412 转成 search_risk_control, retryable=true", async () => {
    await expect(
      searchVideoPage(
        { signer: makeFakeSigner(), fetchImpl: makeFetchStub({}, 412) },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({
      code: "search_risk_control",
      httpStatus: 412,
      retryable: true,
    });
  });

  it("业务 code -412 转成 search_risk_control, retryable=true", async () => {
    await expect(
      searchVideoPage(
        { signer: makeFakeSigner(), fetchImpl: makeFetchStub(fixture("search-video-api-error.json")) },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({
      code: "search_risk_control",
      apiCode: -412,
      retryable: true,
    });
  });

  it("其它业务错误转成 search_api_error", async () => {
    await expect(
      searchVideoPage(
        { signer: makeFakeSigner(), fetchImpl: makeFetchStub({ code: -400, message: "请求错误" }) },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({
      code: "search_api_error",
      apiCode: -400,
      retryable: false,
    });
  });

  it("响应不是 JSON 转成 search_invalid_json", async () => {
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    })) as unknown as typeof fetch;

    await expect(
      searchVideoPage(
        { signer: makeFakeSigner(), fetchImpl: fetchStub },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({ code: "search_invalid_json" });
  });

  it("响应结构变化转成 search_invalid_response", async () => {
    await expect(
      searchVideoPage(
        { signer: makeFakeSigner(), fetchImpl: makeFetchStub(fixture("search-video-invalid-structure.json")) },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({ code: "search_invalid_response" });
  });

  it("网络异常转成 search_network_error, retryable=true", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      searchVideoPage(
        { signer: makeFakeSigner(), fetchImpl: fetchStub },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({
      code: "search_network_error",
      retryable: true,
    });
  });

  it("WBI 签名阶段原生网络错误转成 search_network_error, 不退化为 unexpected_error", async () => {
    // 回归评审 P2: WbiSigner 未注入 fetchImpl 时, nav 请求失败抛原生 TypeError,
    // 曾被 toBilibiliError 包装成 unexpected_error (retryable=false).
    const brokenSigner = {
      signRequest: async () => {
        throw new TypeError("fetch failed");
      },
    } as unknown as WbiSigner;

    await expect(
      searchVideoPage(
        { signer: brokenSigner, fetchImpl: makeFetchStub({}) },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({
      code: "search_network_error",
      retryable: true,
    });
  });

  it("WBI 签名阶段业务错误保留 code 与 retryable, 不被搜索域错误覆盖", async () => {
    const brokenSigner = {
      signRequest: async () => {
        throw new BilibiliError({
          code: "wbi_keys_unavailable",
          message: "wbi_img 缺失",
          retryable: true,
        });
      },
    } as unknown as WbiSigner;

    await expect(
      searchVideoPage(
        { signer: brokenSigner, fetchImpl: makeFetchStub({}) },
        { keyword: "测试", page: 1, pageSize: 20, order: "relevance" },
      ),
    ).rejects.toMatchObject({
      code: "wbi_keys_unavailable",
      retryable: true,
    });
  });
});

describe("normalizeSearchVideoResults 标准化", () => {
  it("正常响应: 高亮清理 / URL 规范化 / 时长解析 / 统计转换", () => {
    const raw = decodeSearchResponse(fixture("search-video-normal.json"));
    const normalized = normalizeSearchVideoResults(raw, BASE_OPTIONS);

    expect(normalized.candidates).toHaveLength(3);
    expect(normalized.reportedTotal).toBe(235);
    expect(normalized.warnings).toEqual([]);

    const first = normalized.candidates[0]!;
    expect(first.title).not.toContain("<em");
    expect(first.title).toBe("如何设计一个 Agent Skill：完整思路与常见坑");
    expect(first.video.bvid).toBe("BV1WMgp6aEND");
    expect(first.sourceUrl).toBe("https://www.bilibili.com/video/BV1WMgp6aEND/");
    expect(first.coverUrl).toBe("https://i0.hdslb.com/bfs/archive/agent-skill-cover-a.jpg");
    expect(first.durationSeconds).toBe(932);
    expect(first.publishedAt).toBe(1767225600);
    expect(first.author?.userId).toBe("12345678");
    expect(first.author?.name).toBe("示例UP主A");
    expect(first.tags).toEqual(["Agent", "人工智能", "编程", "效率工具"]);
    expect(first.stats?.viewCount).toBe(128000);
    expect(first.stats?.danmakuCount).toBe(3200);
    expect(first.stats?.favoriteCount).toBe(8800);
    expect(first.position).toBe(1);
  });

  it("缺 bvid 字段时从 arcurl 兜底提取; '--' 统计不进入 stats", () => {
    const raw = decodeSearchResponse(fixture("search-video-normal.json"));
    const normalized = normalizeSearchVideoResults(raw, BASE_OPTIONS);

    const second = normalized.candidates[1]!;
    expect(second.video.bvid).toBe("BV1AbCdEfGh2");
    expect(second.stats?.viewCount).toBeUndefined();
    expect(second.stats?.danmakuCount).toBe(156);
    expect(second.stats?.favoriteCount).toBeUndefined();
    expect(second.tags).toEqual([]);
  });

  it("数字类型统计直接转换; http 封面原样保留", () => {
    const raw = decodeSearchResponse(fixture("search-video-normal.json"));
    const normalized = normalizeSearchVideoResults(raw, BASE_OPTIONS);

    const third = normalized.candidates[2]!;
    expect(third.stats?.viewCount).toBe(4096);
    expect(third.coverUrl).toBe("https://i1.hdslb.com/bfs/archive/skill-boundary-cover-c.jpg");
  });

  it("空结果: candidates 为空, 无 warning", () => {
    const raw = decodeSearchResponse(fixture("search-video-empty.json"));
    const normalized = normalizeSearchVideoResults(raw, BASE_OPTIONS);

    expect(normalized.candidates).toEqual([]);
    expect(normalized.rawReturnedCount).toBe(0);
    expect(normalized.reportedTotal).toBe(0);
    expect(normalized.warnings).toEqual([]);
  });

  it("混入特殊条目/缺 BV 条目/结构异常条目: 过滤并产生 warning, 保留原始 position", () => {
    const raw = decodeSearchResponse(fixture("search-video-partial-fields.json"));
    const normalized = normalizeSearchVideoResults(raw, BASE_OPTIONS);

    expect(normalized.rawReturnedCount).toBe(4);
    expect(normalized.candidates).toHaveLength(1);

    // 保留原始页内位置 (第 4 条), 便于回查当前搜索结果页.
    const only = normalized.candidates[0]!;
    expect(only.position).toBe(4);
    expect(only.video.bvid).toBe("BV1Partial1x");
    expect(only.stats).toBeUndefined();

    const warningText = normalized.warnings.join("\n");
    expect(warningText).toContain("1 条搜索结果不是视频条目");
    expect(warningText).toContain("1 条搜索结果无法提取 BV 号");
    expect(warningText).toContain("1 条搜索结果条目结构与预期不一致");
  });

  it("所有条目都无法解析时抛 search_invalid_response, 不伪装成空结果", () => {
    const raw = decodeSearchResponse({
      code: 0,
      message: "0",
      data: { page: 1, pagesize: 20, numResults: 10, result: [{ foo: 1 }, { bar: 2 }] },
    });

    expect(() => normalizeSearchVideoResults(raw, BASE_OPTIONS)).toThrow(BilibiliError);
    expect(() => normalizeSearchVideoResults(raw, BASE_OPTIONS)).toThrow(
      expect.objectContaining({ code: "search_invalid_response" }),
    );
  });

  it("真实响应形态 (typeid 字符串 / av 号 arcurl / number 统计): 全部候选解析成功", () => {
    // 回归 P1-1: 早期 schema 把 typeid 声明为 number, 真实响应是字符串 "231",
    // 导致逐条 safeParse 全失败并误报 search_invalid_response.
    const raw = decodeSearchResponse(fixture("search-video-real-shape.json"));
    const normalized = normalizeSearchVideoResults(raw, BASE_OPTIONS);

    expect(normalized.candidates).toHaveLength(3);
    expect(normalized.warnings).toEqual([]);
    expect(normalized.rawReturnedCount).toBe(3);
    expect(normalized.reportedTotal).toBe(1000);
    expect(normalized.platformPageSize).toBe(3);

    const first = normalized.candidates[0]!;
    expect(first.video.bvid).toBe("BV1XQ3kz3E9S");
    expect(first.title).not.toContain("<em");
    expect(first.publishedAt).toBe(1759716067);
    expect(first.durationSeconds).toBe(18195);
    expect(first.sourceUrl).toBe("https://www.bilibili.com/video/BV1XQ3kz3E9S/");
    expect(first.coverUrl).toBe("https://i2.hdslb.com/bfs/archive/abc123.jpg");
    expect(first.stats?.viewCount).toBe(14305);
    expect(first.author?.userId).toBe("14362343");
  });
});
