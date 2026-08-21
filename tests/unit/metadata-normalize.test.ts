import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RawTagListSchema, RawVideoViewDataSchema } from "../../scripts/metadata/bilibili-raw-schema.js";
import { normalizeVideoMetadata } from "../../scripts/metadata/bilibili-adapter.js";

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("normalizeVideoMetadata", () => {
  it("把 B站单P原始字段转换为内部 VideoMetadata", () => {
    const view = RawVideoViewDataSchema.parse(fixture("view-single.json"));
    const tags = RawTagListSchema.parse(fixture("tags.json"));
    const result = normalizeVideoMetadata(
      view,
      "https://www.bilibili.com/video/BV15wGR6CEhY/",
      tags,
    );

    expect(result.bvid).toBe("BV15wGR6CEhY");
    expect(result.author?.name).toBe("示例UP主");
    expect(result.stats?.viewCount).toBe(10000);
    expect(result.stats?.commentCount).toBe(88);
    expect(result.tags).toEqual(["AI", "Agent", "编程工具"]);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.cid).toBe("3001002001");
  });

  it("保留多P cid，不把第一P错误当成整视频 activeCid", () => {
    const view = RawVideoViewDataSchema.parse(fixture("view-multi.json"));
    const result = normalizeVideoMetadata(
      view,
      "https://www.bilibili.com/video/BV1TESTMULTIP/",
      [],
    );

    expect(result.pages).toHaveLength(2);
    expect(result.pages.map((p) => p.cid)).toEqual(["81001", "81002"]);
    expect(result.pages.map((p) => p.title)).toEqual(["第一部分", "第二部分"]);
  });
});
