import { describe, expect, it, vi } from "vitest";
import type { BilibiliApiClient } from "../../scripts/bilibili/client.js";
import {
  parseBilibiliVideoInput,
  resolveBilibiliVideoInput,
} from "../../scripts/bilibili/url.js";

// URL parser 不访问网络，因此适合覆盖各种用户输入形式。
describe("parseBilibiliVideoInput", () => {
  it("解析纯 BV 号", () => {
    const result = parseBilibiliVideoInput("BV15wGR6CEhY");
    expect(result.kind).toBe("bvid");
    if (result.kind === "bvid") {
      expect(result.bvid).toBe("BV15wGR6CEhY");
      expect(result.canonicalUrl).toBe("https://www.bilibili.com/video/BV15wGR6CEhY/");
    }
  });

  it("解析带跟踪参数的 B站 URL，并输出干净 canonicalUrl", () => {
    const result = parseBilibiliVideoInput(
      "https://www.bilibili.com/video/BV15wGR6CEhY/?spm_id_from=333.1391.0.0",
    );
    expect(result.kind).toBe("bvid");
    if (result.kind !== "bvid") {
      throw new Error(`预期解析为 bvid，实际为 ${result.kind}`);
    }
    expect(result.canonicalUrl).toBe("https://www.bilibili.com/video/BV15wGR6CEhY/");
  });

  it("保留具有业务语义的分P参数，同时去掉跟踪参数", () => {
    const result = parseBilibiliVideoInput(
      "https://www.bilibili.com/video/BV15wGR6CEhY/?p=4&spm_id_from=333.1391.0.0",
    );
    expect(result.kind).toBe("bvid");
    if (result.kind !== "bvid") {
      throw new Error(`预期解析为 bvid，实际为 ${result.kind}`);
    }
    expect(result.requestedPage).toBe(4);
    expect(result.canonicalUrl).toBe("https://www.bilibili.com/video/BV15wGR6CEhY/?p=4");
  });

  it("拒绝无效的分P参数", () => {
    expect(() => parseBilibiliVideoInput(
      "https://www.bilibili.com/video/BV15wGR6CEhY?p=0",
    )).toThrow(/从 1 开始的整数/);
    expect(() => parseBilibiliVideoInput(
      "https://www.bilibili.com/video/BV15wGR6CEhY?p=abc",
    )).toThrow(/从 1 开始的整数/);
  });

  it("解析移动端域名", () => {
    const result = parseBilibiliVideoInput("https://m.bilibili.com/video/BV15wGR6CEhY");
    expect(result.kind).toBe("bvid");
  });

  it("解析 av 号", () => {
    const result = parseBilibiliVideoInput("av170001");
    expect(result.kind).toBe("aid");
    if (result.kind === "aid") {
      expect(result.aid).toBe("170001");
    }
  });

  it("识别短链但不在纯解析阶段访问网络", () => {
    const result = parseBilibiliVideoInput("https://b23.tv/abc123");
    expect(result.kind).toBe("short_url");
  });

  it("短链展开后保留最终 URL 的分P参数", async () => {
    const resolveFinalUrl = vi.fn(async () =>
      "https://www.bilibili.com/video/BV15wGR6CEhY?p=3");
    const client = { resolveFinalUrl } as unknown as BilibiliApiClient;

    const result = await resolveBilibiliVideoInput("https://b23.tv/abc123", client);

    expect(resolveFinalUrl).toHaveBeenCalledOnce();
    expect(result.kind).toBe("bvid");
    expect(result.requestedPage).toBe(3);
  });

  it("拒绝非 B站域名", () => {
    expect(() => parseBilibiliVideoInput("https://example.com/video/BV15wGR6CEhY"))
      .toThrow(/只支持 B站域名/);
  });
});
