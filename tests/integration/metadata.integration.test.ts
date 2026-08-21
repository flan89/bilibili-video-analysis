import { describe, expect, it } from "vitest";
import { getBilibiliMetadata } from "../../scripts/metadata/get.js";

/**
 * 真实网络测试默认跳过，避免 CI/本地普通单测受 B站网络、风控或视频失效影响。
 *
 * 手工开启：
 * RUN_BILIBILI_INTEGRATION=1 BILIBILI_TEST_VIDEO=BV15wGR6CEhY npm run test:integration
 */
const enabled = process.env.RUN_BILIBILI_INTEGRATION === "1";
const testVideo = process.env.BILIBILI_TEST_VIDEO ?? "BV15wGR6CEhY";

const suite = enabled ? describe : describe.skip;

suite("bilibili.get_metadata 真实集成测试", () => {
  it("能从真实公开视频得到标准化 metadata", async () => {
    const result = await getBilibiliMetadata({ video: testVideo, includeTags: true });

    expect(result.success).toBe(true);
    expect(result.video?.bvid).toMatch(/^BV/);
    expect(result.metadata?.title.length).toBeGreaterThan(0);
    expect(result.metadata?.pages.length).toBeGreaterThan(0);
    expect(["success", "partial"]).toContain(result.acquisition.status);
  }, 30_000);
});
