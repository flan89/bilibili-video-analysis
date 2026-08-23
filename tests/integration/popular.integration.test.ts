import { describe, expect, it } from "vitest";
import { getBilibiliPopularVideos } from "../../scripts/discovery/popular-videos.js";

/**
 * tests/integration/popular.integration.test.ts: popular-videos 真实网络测试, 默认关闭.
 *
 * 背景 (M7 P1-1 教训): fixture 必须与真实响应形态一致, 否则 Tool 在真实环境
 * 全部解析失败. 本测试负责守住"真实热门响应形态可解析"这条底线.
 *
 * 手工开启:
 * RUN_BILIBILI_INTEGRATION=1 npm run test:integration
 *
 * 热门接口不需要 WBI 签名和 Cookie, 但要求普通 Web UA + 热门页 Referer;
 * 这些由 adapter 内部固定携带, 本测试刻意不传 Cookie (Tool 契约也不接受).
 */
const enabled = process.env.RUN_BILIBILI_INTEGRATION === "1";

const suite = enabled ? describe : describe.skip;

/** 网络不稳定 / 风控类原因允许通过并告警, 避免把环境抖动当成回归. */
const ENVIRONMENTAL_FAILURES = new Set([
  "popular_risk_control",
  "popular_network_error",
  "popular_http_error",
]);

suite("bilibili.popular_videos 真实集成测试", () => {
  it("真实响应可以被解析为候选列表 (守住真实形态回归底线)", async () => {
    // 一次小流量请求: 只取第一页少量条目, 不翻页.
    const result = await getBilibiliPopularVideos({ page: 1, pageSize: 5 });

    if (!result.success) {
      const reason = result.acquisition.reasonCode;
      if (reason !== undefined && ENVIRONMENTAL_FAILURES.has(reason)) {
        console.warn(`popular-videos 集成测试遇到环境性失败 (${reason}), 跳过结构断言`);
        return;
      }
      throw new Error(`popular-videos 集成测试失败: ${JSON.stringify(result.error)}`);
    }

    // 平台热门列表几乎不可能为空; 允许 missing 但此时无法验证解析, 明确告警.
    if (result.acquisition.status === "missing") {
      console.warn("popular-videos 集成测试返回 missing, 未验证到候选解析路径");
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
    // 快照性质标记必须存在, 供 Agent 表述来源边界.
    expect(result.acquisition.metadata?.snapshotNature).toBe(
      "platform_popular_mechanism",
    );
  }, 30_000);
});
