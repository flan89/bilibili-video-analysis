/**
 * tests/unit/bilibili-related-adapter.test.ts: 关联推荐适配层测试.
 *
 * 覆盖 (AGENTS_M8 批次 C):
 * - 详情卡片形态条目 → VideoCandidate 标准化 (URL 规范化 / 统计转换 / 分区);
 * - 种子自身过滤、重复 BV 号去重并保留原始位置;
 * - OGV 无 BV 条目与缺标题条目的跳过计数;
 * - 全部无法解析时抛 related_invalid_response;
 * - fetch: bvid/aid 请求参数、请求头、单次请求与全部错误码映射.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  fetchRelatedList,
  normalizeRelatedResults,
} from "../../scripts/discovery/bilibili-related-adapter.js";
import { decodeRelatedResponse } from "../../scripts/discovery/bilibili-related-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

function fixture(name: string): ReturnType<typeof decodeRelatedResponse> {
  const url = new URL(`../fixtures/related/${name}`, import.meta.url);
  return decodeRelatedResponse(JSON.parse(readFileSync(fileURLToPath(url), "utf8")));
}

describe("normalizeRelatedResults", () => {
  it("正常响应: 全部条目标准化并保留平台顺序", () => {
    const normalized = normalizeRelatedResults(fixture("related-normal.json"), { bvid: "BV1C48C6BEDN" });

    expect(normalized.rawReturnedCount).toBe(5);
    expect(normalized.candidates).toHaveLength(5);
    expect(normalized.warnings).toHaveLength(0);
    expect(normalized.seedFilteredCount).toBe(0);
    expect(normalized.duplicateRemovedCount).toBe(0);

    const first = normalized.candidates[0];
    expect(first?.video.bvid).toBe("BV1TM4m1r7xT");
    expect(first?.title).toBe("展开说说台湾当归产业【主播说三农】");
    expect(first?.position).toBe(1);
    expect(first?.publishedAt).toBe(1716634841);
    expect(first?.durationSeconds).toBe(108);
    // http 封面原样保留 (已是绝对地址), 作者信息最小化.
    expect(first?.coverUrl).toBe(
      "http://i1.hdslb.com/bfs/archive/4f999e3367d205099c37a50757d338cc09491318.jpg",
    );
    expect(first?.author?.userId).toBe("1343321779");
    expect(first?.author?.name).toBe("央视农业");
    // 详情卡片统计齐全: 含 like/reply/coin/share.
    expect(first?.stats?.viewCount).toBe(953125);
    expect(first?.stats?.likeCount).toBe(187289);
    expect(first?.stats?.replyCount).toBe(2012);
    expect(first?.stats?.coinCount).toBe(14007);
    expect(first?.stats?.shareCount).toBe(5718);
    // 分区最小信息来自 tid / tname.
    expect(first?.category).toEqual({ id: 251, name: "三农" });
    // 该接口实测不返回推荐理由文本: 空字符串不写 discoveryReason.
    expect(first?.discoveryReason).toBeUndefined();
    // 空 desc 不写 description.
    expect(first?.description).toBeUndefined();
    expect(first?.tags).toEqual([]);
    expect(first?.sourceUrl).toBe("https://www.bilibili.com/video/BV1TM4m1r7xT/");

    expect(normalized.candidates.map((c) => c.position)).toEqual([1, 2, 3, 4, 5]);
    expect(normalized.candidates[3]?.author?.name).toBe("妙招姐");
    // http 头像同样原样保留.
    expect(normalized.candidates[3]?.author?.avatarUrl).toBe(
      "http://i2.hdslb.com/bfs/face/fcf2043bac475f2894d26fe0f8de3436f2805cce.jpg",
    );
  });

  it("非空 desc 保留为 description", () => {
    const normalized = normalizeRelatedResults(fixture("related-normal.json"), {});

    expect(normalized.candidates[1]?.description).toContain("冒烤鸭");
  });

  it("种子自身被平台返回时确定性过滤并计数", () => {
    const normalized = normalizeRelatedResults(fixture("related-partial.json"), { bvid: "BV1C48C6BEDN" });

    expect(normalized.seedFilteredCount).toBe(1);
    expect(normalized.candidates.map((c) => c.video.bvid)).not.toContain("BV1C48C6BEDN");
    expect(normalized.warnings.join("\n")).toContain("种子视频自身");
  });

  it("av 号输入也按 aid 过滤种子自身", () => {
    const normalized = normalizeRelatedResults(
      fixture("related-partial.json"),
      { aid: "1155065659" },
    );

    expect(normalized.seedFilteredCount).toBe(1);
    expect(normalized.candidates.map((c) => c.video.bvid)).not.toContain("BV1C48C6BEDN");
    expect(normalized.warnings.join("\n")).toContain("种子视频自身");
  });

  it("相同 BV 号只保留第一次出现, position 保留原始位置", () => {
    const normalized = normalizeRelatedResults(fixture("related-partial.json"), { bvid: "BV1C48C6BEDN" });

    expect(normalized.duplicateRemovedCount).toBe(1);
    // 只保留 1 条有效候选 (position 1), 重复条目 (原始位置 3) 被去掉.
    expect(normalized.candidates).toHaveLength(1);
    expect(normalized.candidates[0]?.position).toBe(1);
    expect(normalized.candidates[0]?.title).toBe("展开说说台湾当归产业【主播说三农】");
    expect(normalized.warnings.join("\n")).toContain("BV 号重复");
  });

  it("缺少 BV 号的 OGV 条目与缺标题条目被跳过并计数", () => {
    const normalized = normalizeRelatedResults(fixture("related-partial.json"), { bvid: "BV1C48C6BEDN" });

    expect(normalized.rawReturnedCount).toBe(5);
    expect(normalized.warnings.join("\n")).toContain("OGV");
    expect(normalized.warnings.join("\n")).toContain("已跳过");
  });

  it("未提供种子 bvid 时不做种子过滤", () => {
    const normalized = normalizeRelatedResults(fixture("related-partial.json"), {});

    expect(normalized.seedFilteredCount).toBe(0);
    // 第二条 (原种子) 此时作为普通候选保留, position 为原始位置 2.
    expect(normalized.candidates.map((c) => c.video.bvid)).toContain("BV1C48C6BEDN");
    expect(normalized.candidates.map((c) => c.position)).toContain(2);
  });

  it("空列表: 无候选且无警告", () => {
    const normalized = normalizeRelatedResults(fixture("related-empty.json"), { bvid: "BV1C48C6BEDN" });

    expect(normalized.rawReturnedCount).toBe(0);
    expect(normalized.candidates).toHaveLength(0);
    expect(normalized.warnings).toHaveLength(0);
  });

  it("全部条目无法解析: 抛 related_invalid_response", () => {
    const raw = decodeRelatedResponse({
      code: 0,
      data: [{ unexpected: 1 }, { another: true }],
    });

    try {
      normalizeRelatedResults(raw, { bvid: "BV1C48C6BEDN" });
      expect.unreachable("应当抛出 related_invalid_response");
    } catch (error) {
      expect(error).toBeInstanceOf(BilibiliError);
      expect((error as BilibiliError).code).toBe("related_invalid_response");
    }
  });

  it("data 为 null 时归一为空数组", () => {
    const raw = decodeRelatedResponse({ code: 0, data: null });

    const normalized = normalizeRelatedResults(raw, { bvid: "BV1C48C6BEDN" });
    expect(normalized.rawReturnedCount).toBe(0);
    expect(normalized.candidates).toHaveLength(0);
  });
});

describe("fetchRelatedList", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("按 bvid 构造请求 URL 并携带 UA 与 Referer, 且只请求一次", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: [] }));

    await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.bilibili.com/x/web-interface/archive/related?bvid=BV1C48C6BEDN");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("Mozilla");
    expect(headers.Referer).toBe("https://www.bilibili.com/");
  });

  it("av 号种子使用 aid 参数请求", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: 0, data: [] }));

    await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "aid", aid: "170001" });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.bilibili.com/x/web-interface/archive/related?aid=170001");
  });

  it("HTTP 412 → related_risk_control 且 retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("风控", { status: 412 }));

    try {
      await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
      expect.unreachable("应当抛出风控错误");
    } catch (error) {
      expect(error).toBeInstanceOf(BilibiliError);
      expect((error as BilibiliError).code).toBe("related_risk_control");
      expect((error as BilibiliError).retryable).toBe(true);
      expect((error as BilibiliError).httpStatus).toBe(412);
    }
  });

  it("业务 -352 / -412 → related_risk_control", async () => {
    for (const apiCode of [-352, -412]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: apiCode, message: "风控拦截" }));

      try {
        await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
        expect.unreachable("应当抛出风控错误");
      } catch (error) {
        expect((error as BilibiliError).code).toBe("related_risk_control");
        expect((error as BilibiliError).retryable).toBe(true);
        expect((error as BilibiliError).apiCode).toBe(apiCode);
      }
    }
  });

  it("业务 -400 (种子不存在) → related_api_error 且不可重试", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: -400, message: "请求错误", ttl: 1 }));

    try {
      await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1zzzzzzzzz" });
      expect.unreachable("应当抛出业务错误");
    } catch (error) {
      expect((error as BilibiliError).code).toBe("related_api_error");
      expect((error as BilibiliError).retryable).toBe(false);
      expect((error as BilibiliError).apiCode).toBe(-400);
    }
  });

  it("业务 -509 → related_api_error 且 retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ code: -509, message: "请求频繁" }));

    try {
      await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
      expect.unreachable("应当抛出业务错误");
    } catch (error) {
      expect((error as BilibiliError).code).toBe("related_api_error");
      expect((error as BilibiliError).retryable).toBe(true);
    }
  });

  it("HTTP 5xx / 429 可重试, 4xx 不可重试", async () => {
    for (const [status, retryable] of [
      [500, true],
      [429, true],
      [404, false],
    ] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("错误", { status }));

      try {
        await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
        expect.unreachable("应当抛出 HTTP 错误");
      } catch (error) {
        expect((error as BilibiliError).code).toBe("related_http_error");
        expect((error as BilibiliError).retryable).toBe(retryable);
        expect((error as BilibiliError).httpStatus).toBe(status);
      }
    }
  });

  it("非 JSON 响应 → related_invalid_json", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));

    try {
      await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
      expect.unreachable("应当抛出 JSON 解析错误");
    } catch (error) {
      expect((error as BilibiliError).code).toBe("related_invalid_json");
    }
  });

  it("响应结构异常 → related_invalid_response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));

    try {
      await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
      expect.unreachable("应当抛出结构错误");
    } catch (error) {
      expect((error as BilibiliError).code).toBe("related_invalid_response");
    }
  });

  it("网络异常 → related_network_error 且 retryable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    try {
      await fetchRelatedList({ fetchImpl: fetchImpl as unknown as typeof fetch }, { kind: "bvid", bvid: "BV1C48C6BEDN" });
      expect.unreachable("应当抛出网络错误");
    } catch (error) {
      expect((error as BilibiliError).code).toBe("related_network_error");
      expect((error as BilibiliError).retryable).toBe(true);
    }
  });
});
