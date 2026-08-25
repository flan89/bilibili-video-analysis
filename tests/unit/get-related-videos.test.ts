/**
 * tests/unit/get-related-videos.test.ts: `bilibili.related_videos` Tool 端到端测试.
 *
 * 覆盖 (AGENTS_M8 §10 / 批次 C):
 * - success / missing / partial / failed 四种采集状态;
 * - 种子自身过滤与重复去重进入 partial warnings;
 * - limit 只做本地确定性截取, 不触发额外请求;
 * - 视频输入解析: BV 号 / URL / av 号; av 号时 seedVideo 缺省并记录 seedAid;
 * - 无效视频输入与风控的结构化失败;
 * - 原子边界: Tool 只返回候选, 不递归获取"关联视频的关联视频".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRelatedList } from "../../scripts/discovery/bilibili-related-adapter.js";

vi.mock("../../scripts/discovery/bilibili-related-adapter.js", async () => {
  const actual = await vi.importActual<typeof import("../../scripts/discovery/bilibili-related-adapter.js")>(
    "../../scripts/discovery/bilibili-related-adapter.js",
  );
  return {
    ...actual,
    fetchRelatedList: vi.fn(),
  };
});

function fixture(name: string): unknown {
  const url = new URL(`../fixtures/related/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

import { getBilibiliRelatedVideos } from "../../scripts/index.js";
import { decodeRelatedResponse } from "../../scripts/discovery/bilibili-related-raw-schema.js";
import { BilibiliError } from "../../scripts/bilibili/errors.js";

const SEED = "BV1C48C6BEDN";

function decodedFixture(name: string): ReturnType<typeof decodeRelatedResponse> {
  return decodeRelatedResponse(fixture(name));
}

describe("getBilibiliRelatedVideos", () => {
  beforeEach(() => {
    vi.mocked(fetchRelatedList).mockReset();
  });

  it("正常响应: success + 种子引用 + 采集记录", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-normal.json"));

    const result = await getBilibiliRelatedVideos({ video: SEED });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.seedVideo).toEqual({ bvid: SEED });
    expect(result.candidates).toHaveLength(5);
    expect(result.returnedCount).toBe(5);
    expect(result.acquisition.status).toBe("success");
    expect(result.acquisition.dataKind).toBe("related_video_candidates");
    expect(result.acquisition.itemCount).toBe(5);
    expect(result.acquisition.source).toBe("bilibili_web_api");
    // 快照性质元信息: 供 Agent 表述来源机制边界 (推荐邻接关系, 非主题等价).
    expect(result.acquisition.metadata?.snapshotNature).toBe("platform_related_recommendation");
    expect(result.acquisition.metadata?.limit).toBe(20);
    expect(result.acquisition.metadata?.rawReturnedCount).toBe(5);
    expect(result.acquisition.metadata?.seedBvid).toBe(SEED);
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // 种子参数以 bvid 透传, 只调一次关联接口.
    expect(fetchRelatedList).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchRelatedList).mock.calls[0]?.[1]).toEqual({ kind: "bvid", bvid: SEED });
  });

  it("视频 URL 输入解析为同一种子", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-normal.json"));

    const result = await getBilibiliRelatedVideos({
      video: `https://www.bilibili.com/video/${SEED}/`,
    });

    expect(result.seedVideo).toEqual({ bvid: SEED });
    expect(vi.mocked(fetchRelatedList).mock.calls[0]?.[1]).toEqual({ kind: "bvid", bvid: SEED });
  });

  it("av 号输入: seedVideo 缺省并记录 seedAid", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-normal.json"));

    const result = await getBilibiliRelatedVideos({ video: "av170001" });

    expect(result.success).toBe(true);
    expect(result.seedVideo).toBeUndefined();
    expect(result.acquisition.metadata?.seedAid).toBe("170001");
    expect(vi.mocked(fetchRelatedList).mock.calls[0]?.[1]).toEqual({ kind: "aid", aid: "170001" });
  });

  it("av 号输入按 aid 过滤平台返回的种子自身", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-partial.json"));

    const result = await getBilibiliRelatedVideos({ video: "av1155065659" });

    expect(result.success).toBe(true);
    expect(result.candidates.map((item) => item.video.bvid)).not.toContain(SEED);
    expect(result.acquisition.warnings.join("\n")).toContain("种子视频自身");
  });

  it("limit 只做本地确定性截取, 不触发额外请求", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-normal.json"));

    const result = await getBilibiliRelatedVideos({ video: SEED, limit: 2 });

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((c) => c.video.bvid)).toEqual(["BV1TM4m1r7xT", "BV19u816fE92"]);
    expect(fetchRelatedList).toHaveBeenCalledTimes(1);
    expect(result.returnedCount).toBe(5);
    expect(result.acquisition.metadata?.rawReturnedCount).toBe(5);
    expect(result.acquisition.metadata?.limit).toBe(2);
    expect(result.acquisition.itemCount).toBe(2);
  });

  it("空列表: success=true + acquisition.status=missing", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-empty.json"));

    const result = await getBilibiliRelatedVideos({ video: SEED });

    expect(result.success).toBe(true);
    expect(result.candidates).toHaveLength(0);
    expect(result.returnedCount).toBe(0);
    expect(result.acquisition.status).toBe("missing");
    expect(result.acquisition.itemCount).toBe(0);
  });

  it("种子自身 + 重复 + 跳过: partial + warnings 公开缺口", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-partial.json"));

    const result = await getBilibiliRelatedVideos({ video: SEED });

    expect(result.success).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.acquisition.status).toBe("partial");
    expect(result.acquisition.itemCount).toBe(1);
    expect(result.returnedCount).toBe(5);
    const warnings = result.acquisition.warnings.join("\n");
    expect(warnings).toContain("种子视频自身");
    expect(warnings).toContain("BV 号重复");
    expect(warnings).toContain("OGV");
  });

  it("风控: failed + related_risk_control + retryable=true", async () => {
    vi.mocked(fetchRelatedList).mockRejectedValue(
      new BilibiliError({
        code: "related_risk_control",
        message: "B 站关联推荐接口触发风控 (HTTP 412)，稍后重试可能恢复，但不应立即连续重试",
        httpStatus: 412,
        retryable: true,
      }),
    );

    const result = await getBilibiliRelatedVideos({ video: SEED });

    expect(result.success).toBe(false);
    expect(result.candidates).toHaveLength(0);
    expect(result.error?.code).toBe("related_risk_control");
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.httpStatus).toBe(412);
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.reasonCode).toBe("related_risk_control");
  });

  it("全部条目无法解析: failed + related_invalid_response", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(
      decodeRelatedResponse({
        code: 0,
        data: [{ unexpected: 1 }],
      }),
    );

    const result = await getBilibiliRelatedVideos({ video: SEED });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("related_invalid_response");
    expect(result.acquisition.status).toBe("failed");
  });

  it("无效视频输入: failed 且不调用关联接口", async () => {
    const result = await getBilibiliRelatedVideos({ video: "完全无法识别的输入" });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("invalid_video_input");
    expect(result.error?.message).toContain("尚未向B站发起请求");
    expect(result.error?.retryable).toBe(false);
    expect(result.acquisition.status).toBe("failed");
    expect(result.acquisition.source).toBe("local_validation");
    expect(result.acquisition.message).toContain("输入校验未通过");
    expect(result.acquisition.metadata?.seedInput).toBe("完全无法识别的输入");
    expect(fetchRelatedList).not.toHaveBeenCalled();
  });

  it("相同输入不依赖前一次调用留下的状态 (无状态)", async () => {
    vi.mocked(fetchRelatedList).mockResolvedValue(decodedFixture("related-normal.json"));

    const first = await getBilibiliRelatedVideos({ video: SEED });
    const second = await getBilibiliRelatedVideos({ video: SEED });

    expect(first.candidates).toHaveLength(5);
    expect(second.candidates).toHaveLength(5);
    expect(fetchRelatedList).toHaveBeenCalledTimes(2);
  });

  it("limit 超出第一版上限 40 或非正数时拒绝输入", async () => {
    await expect(getBilibiliRelatedVideos({ video: SEED, limit: 41 })).rejects.toThrow();
    await expect(getBilibiliRelatedVideos({ video: SEED, limit: 0 })).rejects.toThrow();
    expect(fetchRelatedList).not.toHaveBeenCalled();
  });
});
