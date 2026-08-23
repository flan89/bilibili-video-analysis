import { describe, expect, it } from "vitest";
import { getBilibiliHotSearches } from "../../scripts/discovery/hot-searches.js";

/**
 * tests/integration/hot-search.integration.test.ts: hot-searches 真实网络测试, 默认关闭.
 *
 * 背景 (M7 P1-1 教训): fixture 必须与真实响应形态一致, 否则 Tool 在真实环境
 * 全部解析失败. 本测试负责守住"真实热搜响应形态可解析"这条底线.
 *
 * 手工开启:
 * RUN_BILIBILI_INTEGRATION=1 npm run test:integration
 *
 * 热搜接口不需要 WBI 签名和 Cookie, 但要求普通 Web UA + Referer;
 * 这些由 adapter 内部固定携带, 本测试刻意不传 Cookie (Tool 契约也不接受).
 */
const enabled = process.env.RUN_BILIBILI_INTEGRATION === "1";

const suite = enabled ? describe : describe.skip;

/** 网络不稳定 / 风控类原因允许通过并告警, 避免把环境抖动当成回归. */
const ENVIRONMENTAL_FAILURES = new Set([
  "hot_search_risk_control",
  "hot_search_network_error",
  "hot_search_http_error",
]);

suite("bilibili.hot_searches 真实集成测试", () => {
  it("真实响应可以被解析为词条列表 (守住真实形态回归底线)", async () => {
    // 一次小流量请求: 只取少量词条, limit 不触发额外请求.
    const result = await getBilibiliHotSearches({ limit: 5 });

    if (!result.success) {
      const reason = result.acquisition.reasonCode;
      if (reason !== undefined && ENVIRONMENTAL_FAILURES.has(reason)) {
        console.warn(`hot-searches 集成测试遇到环境性失败 (${reason}), 跳过结构断言`);
        return;
      }
      throw new Error(`hot-searches 集成测试失败: ${JSON.stringify(result.error)}`);
    }

    // 平台热搜列表几乎不可能为空; 允许 missing 但此时无法验证解析, 明确告警.
    if (result.acquisition.status === "missing") {
      console.warn("hot-searches 集成测试返回 missing, 未验证到词条解析路径");
      return;
    }

    expect(["success", "partial"]).toContain(result.acquisition.status);
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topics.length).toBeLessThanOrEqual(5);

    // 每个词条都必须有可执行的搜索词与列表内位置.
    for (const topic of result.topics) {
      expect(topic.keyword.length).toBeGreaterThan(0);
      expect(topic.position).toBeGreaterThanOrEqual(1);
    }

    expect(result.acquisition.itemCount).toBe(result.topics.length);
    // 快照性质标记必须存在, 供 Agent 表述来源边界 (搜索关注度快照, 非事件背景).
    expect(result.acquisition.metadata?.snapshotNature).toBe(
      "platform_hot_search_snapshot",
    );
  }, 30_000);
});
