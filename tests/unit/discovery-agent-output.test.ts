import { describe, expect, it } from "vitest";

import {
  toAgentHotSearchesOutput,
  toAgentPopularVideosOutput,
  toAgentRelatedVideosOutput,
  toAgentSearchVideosOutput,
} from "../../scripts/cli/discovery/agent-output.js";
import { HotSearchesOutputSchema } from "../../scripts/discovery/hot-searches.js";
import { PopularVideosOutputSchema } from "../../scripts/discovery/popular-videos.js";
import { RelatedVideosOutputSchema } from "../../scripts/discovery/related-videos.js";
import { SearchVideosOutputSchema } from "../../scripts/discovery/search-videos.js";

const observedAt = "2026-08-23T01:02:03.000Z";
const candidate = {
  video: { bvid: "BV1xx411c7mD" },
  title: "候选标题",
  description: "紧凑输出应省略这段较长简介",
  author: {
    userId: "123",
    name: "示例作者",
    avatarUrl: "https://i0.hdslb.com/example-avatar.jpg",
  },
  publishedAt: 1_787_418_059,
  durationSeconds: 125,
  coverUrl: "https://i0.hdslb.com/example-cover.jpg",
  tags: ["测试"],
  stats: { viewCount: 100 },
  position: 1,
  sourceUrl: "https://www.bilibili.com/video/BV1xx411c7mD/",
};

function expectCompactCandidate(output: unknown): void {
  const value = output as { candidates: Array<Record<string, unknown>> };
  expect(value.candidates[0]).toMatchObject({
    video: { bvid: "BV1xx411c7mD" },
    title: "候选标题",
    author: { userId: "123", name: "示例作者" },
    position: 1,
  });
  expect(value.candidates[0]).not.toHaveProperty("description");
  expect(value.candidates[0]).not.toHaveProperty("coverUrl");
  expect(value.candidates[0]?.author).not.toHaveProperty("avatarUrl");
}

describe("发现 Tool 的 Agent 紧凑输出", () => {
  it("搜索与热门省略展示资源，但保留分页、状态和警告", () => {
    const search = SearchVideosOutputSchema.parse({
      success: true,
      query: { keyword: "测试", order: "relevance", page: 1, pageSize: 20 },
      candidates: [candidate],
      pageInfo: { page: 1, pageSize: 20, returnedCount: 1, hasNextPage: false },
      reportedTotal: 1,
      observedAt,
      acquisition: {
        dataKind: "video_candidates",
        status: "partial",
        itemCount: 1,
        message: "存在字段缺口",
        warnings: ["搜索警告不能丢失"],
      },
    });
    const popular = PopularVideosOutputSchema.parse({
      success: true,
      candidates: [candidate],
      pageInfo: { page: 1, pageSize: 20, returnedCount: 1, hasNextPage: false },
      observedAt,
      acquisition: {
        dataKind: "popular_video_candidates",
        status: "partial",
        itemCount: 1,
        warnings: ["热门警告不能丢失"],
      },
    });

    const compactSearch = toAgentSearchVideosOutput(search);
    const compactPopular = toAgentPopularVideosOutput(popular);
    expectCompactCandidate(compactSearch);
    expectCompactCandidate(compactPopular);
    expect(compactSearch).toMatchObject({
      pageInfo: { returnedCount: 1 },
      acquisition: { status: "partial", warnings: ["搜索警告不能丢失"] },
    });
    expect(compactPopular).toMatchObject({
      acquisition: { status: "partial", warnings: ["热门警告不能丢失"] },
    });
  });

  it("热搜与关联保留来源边界所需字段和警告", () => {
    const hot = HotSearchesOutputSchema.parse({
      success: true,
      topics: [{
        keyword: "示例热词",
        position: 1,
        heatScore: 123,
        heatLevel: "B",
        isCommercial: true,
      }],
      observedAt,
      platformObservedAt: observedAt,
      reportedTotal: 10,
      acquisition: {
        dataKind: "hot_search_topics",
        status: "partial",
        itemCount: 1,
        warnings: ["热搜警告不能丢失"],
      },
    });
    const related = RelatedVideosOutputSchema.parse({
      success: true,
      seedVideo: { bvid: "BV1C48C6BEDN" },
      candidates: [candidate],
      returnedCount: 2,
      observedAt,
      acquisition: {
        dataKind: "related_video_candidates",
        status: "partial",
        itemCount: 1,
        warnings: ["已过滤种子视频自身"],
      },
    });

    const compactHot = toAgentHotSearchesOutput(hot);
    const compactRelated = toAgentRelatedVideosOutput(related);
    expect(compactHot).toMatchObject({
      topics: [{ heatLevel: "B", isCommercial: true }],
      platformObservedAt: observedAt,
      reportedTotal: 10,
      acquisition: { status: "partial", warnings: ["热搜警告不能丢失"] },
    });
    expectCompactCandidate(compactRelated);
    expect(compactRelated).toMatchObject({
      seedVideo: { bvid: "BV1C48C6BEDN" },
      returnedCount: 2,
      acquisition: { status: "partial", warnings: ["已过滤种子视频自身"] },
    });
  });
});
