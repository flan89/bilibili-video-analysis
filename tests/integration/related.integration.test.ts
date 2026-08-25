import { describe, expect, it } from "vitest";
import { getBilibiliRelatedVideos } from "../../scripts/discovery/related-videos.js";

/**
 * tests/integration/related.integration.test.ts: related-videos 真实网络测试, 默认关闭.
 *
 * 背景 (M7 P1-1 教训): fixture 必须与真实响应形态一致, 否则 Tool 在真实环境
 * 全部解析失败. 本测试负责守住"真实关联推荐响应形态可解析"这条底线,
 * 包括真实响应中混入的 OGV 番剧条目 (无 bvid, 应被确定性跳过而不是整体失败).
 *
 * 手工开启:
 * RUN_BILIBILI_INTEGRATION=1 npm run test:integration
 *
 * 关联推荐接口不需要 WBI 签名和 Cookie, 但 adapter 内部统一携带 Web UA +
 * bilibili.com Referer; 本测试刻意不传 Cookie (Tool 契约也不接受).
 */
const enabled = process.env.RUN_BILIBILI_INTEGRATION === "1";

const suite = enabled ? describe : describe.skip;

/** 网络不稳定 / 风控类原因允许通过并告警, 避免把环境抖动当成回归. */
const ENVIRONMENTAL_FAILURES = new Set([
  "related_risk_control",
  "related_network_error",
  "related_http_error",
]);

/** 真实存在的种子视频: 本仓库 fixture 与测试一直使用的 BV 号. */
const SEED_BVID = "BV1C48C6BEDN";

suite("bilibili.related_videos 真实集成测试", () => {
  it("真实响应可以被解析为候选列表 (守住真实形态回归底线)", async () => {
    // 一次小流量请求: 单次调用, limit 少量, 接口本身无分页.
    const result = await getBilibiliRelatedVideos({
      video: SEED_BVID,
      limit: 5,
    });

    if (!result.success) {
      const reason = result.acquisition.reasonCode;
      if (reason !== undefined && ENVIRONMENTAL_FAILURES.has(reason)) {
        console.warn(`related-videos 集成测试遇到环境性失败 (${reason}), 跳过结构断言`);
        return;
      }
      throw new Error(`related-videos 集成测试失败: ${JSON.stringify(result.error)}`);
    }

    // 关联推荐对正常视频几乎不会为空; 允许 missing 但此时无法验证解析, 明确告警.
    if (result.acquisition.status === "missing") {
      console.warn("related-videos 集成测试返回 missing, 未验证到候选解析路径");
      return;
    }

    expect(["success", "partial"]).toContain(result.acquisition.status);
    expect(result.candidates.length).toBeGreaterThan(0);

    // 每个候选都必须有可回查的 BV 号与标题 (OGV 条目无 bvid 应已被跳过).
    for (const candidate of result.candidates) {
      expect(candidate.video.bvid).toMatch(/^BV/);
      expect(candidate.title.length).toBeGreaterThan(0);
    }

    expect(result.acquisition.itemCount).toBe(result.candidates.length);
    expect(result.returnedCount).toBeGreaterThan(0);
    // 种子可回查信息: BV 号输入时 seedVideo 与 metadata.seedBvid 都应存在.
    expect(result.seedVideo?.bvid).toBe(SEED_BVID);
    expect(result.acquisition.metadata?.seedBvid).toBe(SEED_BVID);
    // 快照性质标记必须存在, 供 Agent 表述来源边界.
    expect(result.acquisition.metadata?.snapshotNature).toBe(
      "platform_related_recommendation",
    );
  }, 30_000);
});
