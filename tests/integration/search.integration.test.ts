import { describe, expect, it } from "vitest";
import { searchBilibiliVideos } from "../../scripts/discovery/search-videos.js";
import { WbiSigner } from "../../scripts/bilibili/wbi.js";

/**
 * tests/integration/search.integration.test.ts: search-videos 真实网络测试, 默认关闭.
 *
 * 背景 (评审 P1-1): 人工构造 fixture 曾把 typeid 写成 number,
 * 而真实响应是字符串, 导致 Tool 在真实环境全部解析失败.
 * 本测试负责守住"真实响应形态可解析"这条底线.
 *
 * 手工开启:
 * RUN_BILIBILI_INTEGRATION=1 npm run test:integration
 *
 * 可通过 BILIBILI_COOKIE 传入本机登录态 (匿名搜索更易触发风控);
 * 可通过 BILIBILI_SEARCH_QUERY 指定搜索词 (默认 "智能体").
 * 测试不会打印 Cookie.
 */
const enabled = process.env.RUN_BILIBILI_INTEGRATION === "1";
const searchQuery = process.env.BILIBILI_SEARCH_QUERY ?? "智能体";
const cookie = process.env.BILIBILI_COOKIE;

const suite = enabled ? describe : describe.skip;

/** 网络不稳定 / 风控类原因允许通过并告警, 避免把环境抖动当成回归. */
const ENVIRONMENTAL_FAILURES = new Set([
  "search_risk_control",
  "search_network_error",
]);

suite("bilibili.search_videos 真实集成测试", () => {
  it("真实响应可以被解析为候选列表 (守住 P1-1 回归底线)", async () => {
    const signer = new WbiSigner({ ...(cookie !== undefined ? { cookie } : {}) });
    const result = await searchBilibiliVideos(
      { query: searchQuery, pageSize: 5 },
      { signer, ...(cookie !== undefined ? { cookie } : {}) },
    );

    if (!result.success) {
      const reason = result.acquisition.reasonCode;
      if (reason !== undefined && ENVIRONMENTAL_FAILURES.has(reason)) {
        console.warn(`search-videos 集成测试遇到环境性失败 (${reason}), 跳过结构断言`);
        return;
      }
      throw new Error(`search-videos 集成测试失败: ${JSON.stringify(result.error)}`);
    }

    // 热门词几乎必有候选; 允许 missing 但此时无法验证解析, 明确告警.
    if (result.acquisition.status === "missing") {
      console.warn("search-videos 集成测试返回 missing, 未验证到候选解析路径");
      return;
    }

    expect(["success", "partial"]).toContain(result.acquisition.status);
    expect(result.candidates.length).toBeGreaterThan(0);

    // 每个候选都必须有可回查的 BV 号与标题.
    for (const candidate of result.candidates) {
      expect(candidate.video.bvid).toMatch(/^BV/);
      expect(candidate.title.length).toBeGreaterThan(0);
    }

    expect(result.acquisition.itemCount).toBe(result.candidates.length);
    expect(result.pageInfo.returnedCount).toBeGreaterThan(0);
  }, 30_000);
});
