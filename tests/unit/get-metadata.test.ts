import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { BilibiliApiClient } from "../../scripts/bilibili/client.js";
import { getBilibiliMetadata } from "../../scripts/metadata/get.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

class FixtureClient implements BilibiliApiClient {
  constructor(private readonly tagFailure = false) {}

  async getApiData<T>(path: string, _query: Record<string, string | number | boolean | undefined>, schema: z.ZodType<T>): Promise<T> {
    if (path.includes("/view")) {
      return schema.parse(fixture("view-single.json"));
    }
    if (path.includes("/tags")) {
      if (this.tagFailure) throw new Error("模拟标签接口失败");
      return schema.parse(fixture("tags.json"));
    }
    throw new Error(`未知 fixture path: ${path}`);
  }

  async resolveFinalUrl(url: string): Promise<string> {
    return url;
  }
}

describe("getBilibiliMetadata", () => {
  it("成功时返回独立的 video、metadata 和 acquisition", async () => {
    const result = await getBilibiliMetadata(
      { video: "BV15wGR6CEhY" },
      { client: new FixtureClient() },
    );

    expect(result.success).toBe(true);
    expect(result.video).toEqual({ bvid: "BV15wGR6CEhY" });
    expect(result.metadata?.title).toContain("Pi Agent");
    expect(result.metadata?.pages[0]?.cid).toBe("3001002001");
    expect(result.acquisition.status).toBe("success");
    expect(result).not.toHaveProperty("asset");
  });

  it("标签失败时核心 metadata 仍成功，但 acquisition 为 partial", async () => {
    const result = await getBilibiliMetadata(
      { video: "BV15wGR6CEhY", includeTags: true },
      { client: new FixtureClient(true) },
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.tags).toEqual([]);
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.warnings.length).toBeGreaterThan(0);
  });

  it("非法输入返回结构化 failed，而不是向 Agent 抛出未处理异常", async () => {
    const result = await getBilibiliMetadata(
      { video: "https://example.com/video/abc", includeTags: true },
      { client: new FixtureClient() },
    );

    expect(result.success).toBe(false);
    expect(result.acquisition.status).toBe("failed");
    expect(result.error?.code).toBe("unsupported_video_host");
  });
});
