/**
 * tests/unit/search-raw-schema.test.ts: B 站搜索原始 Schema 单元测试.
 *
 * 覆盖: 正常响应 / 空结果 / 缺 data / 结构变化 / 单条条目校验.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RawSearchVideoItemSchema,
  decodeSearchResponse,
} from "../../scripts/discovery/bilibili-search-raw-schema.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/search/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("search raw schema", () => {
  it("正常搜索响应可以 decode, 原始字段保留", () => {
    const decoded = decodeSearchResponse(fixture("search-video-normal.json"));

    expect(decoded.code).toBe(0);
    expect(decoded.data?.numResults).toBe(235);
    expect(decoded.data?.result).toHaveLength(3);

    const first = decoded.data?.result?.[0] as Record<string, unknown>;
    // 原始字段不做业务清理: 高亮标记原样保留, 由 adapter 负责.
    expect(first.title).toContain("<em class=\"keyword\">");
    expect(first.arcurl).toBe("//www.bilibili.com/video/BV1WMgp6aEND");
    expect(first.play).toBe("128000");
  });

  it("空结果响应可以 decode, result 归一为空数组", () => {
    const decoded = decodeSearchResponse(fixture("search-video-empty.json"));

    expect(decoded.code).toBe(0);
    expect(decoded.data?.numResults).toBe(0);
    expect(decoded.data?.result).toEqual([]);
  });

  it("result 为 null 也能 decode 为空数组", () => {
    const decoded = decodeSearchResponse({
      code: 0,
      message: "0",
      data: { page: 1, pagesize: 20, numResults: 0, result: null },
    });

    expect(decoded.data?.result).toEqual([]);
  });

  it("风控业务错误响应可以 decode (envelope 本身结构合法)", () => {
    const decoded = decodeSearchResponse(fixture("search-video-api-error.json"));

    expect(decoded.code).toBe(-412);
    expect(decoded.data).toBeUndefined();
  });

  it("result 从数组变成对象时 decode 失败 (结构变化)", () => {
    expect(() =>
      decodeSearchResponse(fixture("search-video-invalid-structure.json")),
    ).toThrow();
  });

  it("envelope 缺 code 时 decode 失败", () => {
    expect(() => decodeSearchResponse({ message: "没有 code" })).toThrow();
  });

  it("单条视频条目: 缺 title 视为结构异常", () => {
    const result = RawSearchVideoItemSchema.safeParse({
      type: "video",
      bvid: "BV1WMgp6aEND",
      arcurl: "//www.bilibili.com/video/BV1WMgp6aEND",
    });
    expect(result.success).toBe(false);
  });

  it("单条视频条目: 最小字段 (title) 即可通过, 其余可选", () => {
    const result = RawSearchVideoItemSchema.safeParse({
      title: "只有标题的条目",
    });
    expect(result.success).toBe(true);
  });

  it("单条视频条目: passthrough 保留未知字段", () => {
    const result = RawSearchVideoItemSchema.parse({
      title: "带未知字段的条目",
      rec_tags: ["a", "b"],
    });
    expect((result as Record<string, unknown>).rec_tags).toEqual(["a", "b"]);
  });

  it("单条视频条目: typeid / pubdate / id 为字符串形式数字时也可解码 (真实响应形态)", () => {
    // 回归 P1-1: 真实响应的 typeid 是字符串 "231", 不能声明为纯 number.
    const result = RawSearchVideoItemSchema.safeParse({
      title: "真实形态条目",
      bvid: "BV1XQ3kz3E9S",
      typeid: "231",
      pubdate: "1759716067",
      id: "115601882912200",
      play: 14305,
    });
    expect(result.success).toBe(true);
  });

  it("真实响应形态 fixture 可以完整 decode", () => {
    const decoded = decodeSearchResponse(fixture("search-video-real-shape.json"));

    expect(decoded.code).toBe(0);
    expect(decoded.data?.seid).toBe("14566805769571780000");
    expect(decoded.data?.numResults).toBe(1000);
    expect(decoded.data?.result).toHaveLength(3);
    const first = RawSearchVideoItemSchema.parse(decoded.data?.result[0]);
    expect(first.pic).toBe("//i2.hdslb.com/bfs/archive/abc123.jpg");
  });
});
