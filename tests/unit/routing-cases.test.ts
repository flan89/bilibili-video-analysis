/**
 * routing-cases.json 双轴评测。
 *
 * 该测试把评测拆成两条独立轴：
 *
 * - Task Routing Correctness：判断 Intent / Focus / Depth / Clarification 是否
 *   反映了用户真实目标，且不被当前 Tool Availability 反向影响；
 * - Data Plan Executability：判断 Required Data / Avoid / Capability Gap 是否
 *   反映当前 Skill 真实能力，是否包含 capability gap 报告。
 *
 * 两轴独立验证的原因：某项任务需要的 Tool 尚不可用时，Intent 仍然应该
 * 正确，而 Data Plan 应当报告 capability gap。
 *
 * Focus 是开放集合：测试不应要求字符串逐字匹配，也不应枚举白名单。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DataKindSchema,
  TaskDepthSchema,
  TaskIntentSchema,
} from "../../scripts/models/index.js";

const RoutingCaseSchema = z
  .object({
    id: z.number().int().positive(),
    user_request: z.string().min(1),
    expected: z
      .object({
        primary_intent: TaskIntentSchema.nullable(),
        clarification_needed: z.boolean(),
        depth: TaskDepthSchema.nullable(),
        focus_semantics: z.array(z.string().min(1)),
        must_require: z.array(DataKindSchema),
        must_not_default: z.array(z.string().min(1)),
        acceptance_note: z.string().min(1).optional(),
        // 复合 Intent 辅助：P1-2 引入，可选。
        // 只有当 secondary_intents 非空时表示 Primary + Secondary 组合任务。
        secondary_intents: z.array(TaskIntentSchema).optional(),
        // capability_gap 是可选字段：当声明时表示该 case 期望 LLM 在
        // 当前 Skill 缺少该数据能力时，仍能保持 Intent 路由正确并报告缺口。
        // 元素可以是 DataKind 或策略性字符串（如 full_video、full_danmaku）。
        capability_gap: z.array(z.string().min(1)).optional(),
      })
      .strict(),
  })
  .strict();

function loadRoutingCases(): unknown {
  const url = new URL("../routing-cases.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

/**
 * 当前 Skill 已实现的数据能力。DataKind 包含但未实现的也视作"仍未实现"。
 * 这是评估"Capability Gap"是否需要被报告的固定事实集。
 */
const V1_AVAILABLE_DATA_KINDS: ReadonlySet<string> = new Set([
  "metadata",
  "transcript",
  "comments",
  "replies",
  "danmaku",
  "frames",
  // M7 新增：主题发现阶段的视频搜索候选。
  "video_candidates",
  // M8 批次 A 新增：当前热门快照候选。
  "popular_video_candidates",
  // M8 批次 B 新增：当前热搜词列表（是主题词，不是视频）。
  "hot_search_topics",
  // M8 批次 C 新增：种子视频的关联推荐候选。
  "related_video_candidates",
]);

/**
 * 把 case 期望的 must_require 拆成"已实现"和"Capability Gap"两组。
 * 用来在 Data Plan 评测中确保 Capability Gap 报告没有被静默吞掉。
 */
function partitionDataPlan(caseExpected: {
  must_require: readonly string[];
  capability_gap?: readonly string[] | undefined;
}): { available: string[]; gap: string[] } {
  const all = new Set(caseExpected.must_require);
  const available: string[] = [];
  const gap: string[] = [];
  for (const kind of all) {
    if (V1_AVAILABLE_DATA_KINDS.has(kind)) {
      available.push(kind);
    } else {
      gap.push(kind);
    }
  }
  // 与 case 显式声明的 capability_gap 合并去重；保留声明顺序。
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const k of [...gap, ...(caseExpected.capability_gap ?? [])]) {
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(k);
    }
  }
  return { available, gap: merged };
}

describe("routing-cases 数据基线", () => {
  it("69 条案例都符合当前任务路由契约，且 ID 不重复", () => {
    const cases = z.array(RoutingCaseSchema).length(69).parse(loadRoutingCases());
    const ids = new Set(cases.map((item) => item.id));

    expect(ids.size).toBe(cases.length);
  });
});

/**
 * 轴一：Task Routing Correctness。
 * 只评估 Intent / Focus / Depth / Clarification 是否反映用户真实目标。
 * 该轴独立于当前 Tool Availability：即使 Required Data 未实现，Intent 仍应正确。
 */
describe("routing-cases 任务路由正确性", () => {
  const cases = z.array(RoutingCaseSchema).length(69).parse(loadRoutingCases());

  it("Focus 是开放集合：不允许把 focus_semantics 固化为 enum 白名单或要求逐字匹配", () => {
    // 该断言通过"不存在的字符串"也能通过的方式守护开放集合：
    // 测试只校验 focus 字段非空且为字符串数组，不对取值做白名单匹配。
    for (const c of cases) {
      expect(c.expected.focus_semantics.length).toBeGreaterThan(0);
      for (const f of c.expected.focus_semantics) {
        expect(typeof f).toBe("string");
        expect(f.length).toBeGreaterThan(0);
      }
    }
  });

  it("澄清型请求：primary_intent 允许为 null 且 depth 也允许为 null", () => {
    const clarificationCases = cases.filter(
      (c) => c.expected.clarification_needed === true,
    );
    expect(clarificationCases.length).toBeGreaterThan(0);
    for (const c of clarificationCases) {
      expect(c.expected.primary_intent).toBeNull();
      expect(c.expected.depth).toBeNull();
    }
  });

  it("非澄清请求：primary_intent 与 depth 都应有意义", () => {
    const nonClarification = cases.filter(
      (c) => !c.expected.clarification_needed,
    );
    expect(nonClarification.length).toBeGreaterThan(0);
    for (const c of nonClarification) {
      expect(c.expected.primary_intent).not.toBeNull();
      expect(c.expected.depth).not.toBeNull();
    }
  });

  it("市场研究 Intent 必须由明确的商业信号触发，不应来自纯学习目标", () => {
    // smoke 验证：至少有 1 条 market_research case，且它们的 focus 中包含
    // 痛点/竞品/付费/机会/替代等市场语义信号（开放集合内的语义族）。
    const marketCases = cases.filter(
      (c) => c.expected.primary_intent === "market_research",
    );
    expect(marketCases.length).toBeGreaterThanOrEqual(3);

    const marketSignalKeywords = [
      "痛点",
      "需求",
      "竞品",
      "替代",
      "付费",
      "价格",
      "机会",
      "抱怨",
      "购买",
      "上线",
      "用户访谈",
    ];
    for (const c of marketCases) {
      const focusText = c.expected.focus_semantics.join(" / ");
      const hasMarketSignal = marketSignalKeywords.some((kw) =>
        focusText.includes(kw),
      );
      expect(hasMarketSignal, `market case ${c.id} focus 缺市场信号`).toBe(
        true,
      );
    }
  });

  it("Cap 4 条：未实现 Intent 不应被错误降级到 content_learn", () => {
    // 这是核心保护：capability_gap 声明的 case 期望 LLM 仍路由到正确 Intent。
    // 在 Task Routing 轴验证：纯 capability_gap case（无 secondary_intents）
    // 的 primary_intent 必须是 visual_decode / audience_insight / market_research /
    // topic_research（M7：榜单/趋势等缺口），而不是 content_learn / overview。
    // 复合 Intent case（content_learn primary + audience/market secondary）允许
    // capability_gap，因为 gap 是为 secondary 服务的。
    const pureGapCases = cases.filter(
      (c) =>
        (c.expected.capability_gap?.length ?? 0) > 0 &&
        (!c.expected.secondary_intents ||
          c.expected.secondary_intents.length === 0),
    );
    expect(pureGapCases.length).toBeGreaterThanOrEqual(3);
    for (const c of pureGapCases) {
      expect(
        ["visual_decode", "audience_insight", "market_research", "topic_research"],
        `case ${c.id} 期望 Capability Gap 但 primary_intent 是 content_learn/overview，未体现缺口路由`,
      ).toContain(c.expected.primary_intent);
    }
  });
});

/**
 * 轴二：Data Plan Executability。
 * 评估 Required / Avoid / Capability Gap 是否与当前 Skill 真实能力一致。
 */
describe("routing-cases 数据计划可执行性", () => {
  const cases = z.array(RoutingCaseSchema).length(69).parse(loadRoutingCases());

  it("未实现数据的 case 必须显式声明 capability_gap，避免 Agent 误降级为 content_learn", () => {
    const unmet = cases.filter((c) => {
      const { gap } = partitionDataPlan(c.expected);
      return gap.length > 0;
    });
    expect(unmet.length).toBeGreaterThan(0);
    for (const c of unmet) {
      const { gap } = partitionDataPlan(c.expected);
      // 存在未实现数据时，必须有 capability_gap 字段且包含这些数据。
      expect(
        c.expected.capability_gap,
        `case ${c.id} 期望的 must_require 包含未实现数据 ${gap.join(",")}，但未声明 capability_gap`,
      ).toBeDefined();
      for (const k of gap) {
        expect(
          c.expected.capability_gap!,
          `case ${c.id} capability_gap 应包含 ${k}`,
        ).toContain(k);
      }
    }
  });

  it("基础数据矩阵：content_learn 至少要求 transcript，且不应默认要评论/回复", () => {
    const contentCases = cases.filter(
      (c) => c.expected.primary_intent === "content_learn",
    );
    expect(contentCases.length).toBeGreaterThan(0);
    for (const c of contentCases) {
      expect(c.expected.must_require, `case ${c.id} content_learn 缺 transcript`).toContain(
        "transcript",
      );
      // must_not_default 是"当前任务下不应默认获取"的列表。
      // 纯 content_learn case 必须显式声明不要默认抓 comments / replies
      // （"full_*" 策略性写法也接受），避免 Agent 误以为内容学习任务
      // 默认需要评论/回复。
      //
      // 复合 Intent case（content_learn + audience/market secondary）允许
      // comments/replies 出现在 must_require，must_not_default 自然不要求包含。
      const isComposite = (c.expected.secondary_intents?.length ?? 0) > 0;
      if (isComposite) continue;

      const notDefault = c.expected.must_not_default;
      const hasNoComments =
        notDefault.includes("comments") || notDefault.includes("full_comments");
      const hasNoReplies =
        notDefault.includes("replies") || notDefault.includes("full_replies");
      expect(
        hasNoComments,
        `case ${c.id} content_learn must_not_default 应包含 comments 或 full_comments`,
      ).toBe(true);
      expect(
        hasNoReplies,
        `case ${c.id} content_learn must_not_default 应包含 replies 或 full_replies`,
      ).toBe(true);
    }
  });

  it("市场研究必须有真实用户反馈数据，不能仅凭 transcript", () => {
    const marketCases = cases.filter(
      (c) => c.expected.primary_intent === "market_research",
    );
    for (const c of marketCases) {
      // 必须要求 comments（除非 case 显式说明替代）
      if (c.expected.must_require.length > 0) {
        expect(
          c.expected.must_require.some((k) =>
            ["comments", "danmaku", "replies"].includes(k),
          ),
          `case ${c.id} market_research 必须依赖真实用户反馈数据`,
        ).toBe(true);
      }
    }
  });
});

/**
 * 轴三：覆盖度与边界（P1-2 引入）。
 * 验证复合 Intent / clarification 边界 / overview 路径 / 市场 vs 观众边界
 * 等关键路由情形有代表性 case 覆盖，避免后续 P1-3 LLM Judge 缺乏输入。
 */
describe("routing-cases Intent × Focus 覆盖度与边界", () => {
  const cases = z.array(RoutingCaseSchema).length(69).parse(loadRoutingCases());

  it("澄清型请求至少 2 条，覆盖不同分叉（学内容 vs 学制作、复述 vs 创作）", () => {
    const clarificationCases = cases.filter(
      (c) => c.expected.clarification_needed === true,
    );
    expect(clarificationCases.length).toBeGreaterThanOrEqual(2);
    const focusTexts = clarificationCases
      .flatMap((c) => c.expected.focus_semantics)
      .join(" / ");
    // 至少有 1 条提到"内容 vs 制作"分叉
    expect(
      focusTexts.includes("内容") && focusTexts.includes("制作"),
      "clarification 边界应包含「内容 vs 制作」类分叉",
    ).toBe(true);
    // 至少有 1 条提到"复述 vs 创作"分叉
    expect(
      focusTexts.includes("复述") && focusTexts.includes("创作"),
      "clarification 边界应包含「复述 vs 创作」类分叉",
    ).toBe(true);
  });

  it("Primary + Secondary 组合：content_learn 主导、audience_insight 辅助 至少 1 条", () => {
    const combined = cases.filter(
      (c) =>
        c.expected.primary_intent === "content_learn" &&
        (c.expected as { secondary_intents?: string[] }).secondary_intents?.includes(
          "audience_insight",
        ),
    );
    // P1-2 阶段约定至少 1 条；当前 46/47/48 共 3 条满足
    expect(combined.length).toBeGreaterThanOrEqual(1);
  });

  it("Primary + Secondary 组合：content_learn 主导、market_research 辅助 至少 1 条", () => {
    const combined = cases.filter(
      (c) =>
        c.expected.primary_intent === "content_learn" &&
        (c.expected as { secondary_intents?: string[] }).secondary_intents?.includes(
          "market_research",
        ),
    );
    expect(combined.length).toBeGreaterThanOrEqual(1);
  });

  it("overview 路径至少 2 条：典型 overview + 极简宽泛请求", () => {
    const overviewCases = cases.filter(
      (c) => c.expected.primary_intent === "overview",
    );
    expect(overviewCases.length).toBeGreaterThanOrEqual(2);
    // 极简宽泛请求（如"帮我看看这个视频"）应进 overview 而不是 content_learn
    const hasMinimalOverview = overviewCases.some((c) =>
      c.user_request.length <= 12,
    );
    expect(
      hasMinimalOverview,
      "至少 1 条 overview case 应该是极简宽泛请求（长度 <= 12 字符）",
    ).toBe(true);
  });

  it("市场 vs 观众边界：用户夸好（共识）属于 audience_insight，", () => {
    // 避免把 audience 维度的"共识/夸赞"误判为 market_research
    const praiseCases = cases.filter((c) => {
      const focusText = c.expected.focus_semantics.join(" / ");
      return (
        c.expected.primary_intent === "audience_insight" &&
        (focusText.includes("共识") || focusText.includes("观点分布"))
      );
    });
    expect(
      praiseCases.length,
      "audience_insight 应有「共识/观点分布」类 case 防止误升级 market",
    ).toBeGreaterThanOrEqual(1);
  });

  it("市场 vs 观众边界：明确价格/购买/上线询问属于 market_research", () => {
    const marketCases = cases.filter((c) => {
      const focusText = c.expected.focus_semantics.join(" / ");
      return (
        c.expected.primary_intent === "market_research" &&
        (focusText.includes("购买") ||
          focusText.includes("价格") ||
          focusText.includes("上线"))
      );
    });
    expect(
      marketCases.length,
      "market_research 应有「购买/价格/上线」类 case 防止漏触发",
    ).toBeGreaterThanOrEqual(1);
  });

  /**
   * M7 批次 B：topic_research 路由覆盖度。
   * 守护主题发现场景的代表性 case，防止后续改动丢失关键判定边界。
   */
  it("M7 topic_research 覆盖：主题研究 / quick 找视频 / 榜单缺口 / 趋势 / 单视频不误触发搜索", () => {
    const topicCases = cases.filter(
      (c) => c.expected.primary_intent === "topic_research",
    );
    expect(
      topicCases.length,
      "topic_research 应有代表性 case（标准研究/quick/榜单/趋势）",
    ).toBeGreaterThanOrEqual(4);

    // 榜单请求：Intent 正确 + 报告能力缺口，不偷偷改成关键词搜索冒充榜单
    const rankingCase = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        (c.expected.capability_gap ?? []).includes("trending_ranking"),
    );
    expect(rankingCase).toBeDefined();

    // 趋势请求：不因缺少历史能力被降级成普通内容总结
    const trendCase = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        (c.expected.capability_gap ?? []).includes("historical_trend_data"),
    );
    expect(trendCase).toBeDefined();

    // 单视频定向主题问题仍是 content_learn，且不触发搜索
    const singleVideoCase = cases.find(
      (c) =>
        c.expected.primary_intent === "content_learn" &&
        c.expected.must_not_default.includes("video_candidates"),
    );
    expect(singleVideoCase).toBeDefined();

    // 市场目标 + 跨视频发现：market_research 主导 + topic_research 辅助
    const marketTopicCombo = cases.find(
      (c) =>
        c.expected.primary_intent === "market_research" &&
        (c.expected as { secondary_intents?: string[] }).secondary_intents?.includes(
          "topic_research",
        ),
    );
    expect(marketTopicCombo).toBeDefined();
  });

  /**
   * M8 批次 A：当前热门路由覆盖度。
   * 守护热门快照 / 热门内容分析 / 榜单缺口 / 趋势快照边界四条关键判定，
   * 防止后续改动丢失来源选择边界（AGENTS_M8 §15.5 第 1/2/7/8 条）。
   */
  it("M8 当前热门覆盖：quick 快照 / 先热门后正文 / 排行榜缺口 / 趋势快照边界", () => {
    // 热门 quick：只需 popular_video_candidates，不深入也不搜索冒充
    const popularQuick = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        c.expected.depth === "quick" &&
        c.expected.must_require.includes("popular_video_candidates"),
    );
    expect(popularQuick).toBeDefined();
    expect(popularQuick!.expected.must_not_default).toContain("video_candidates");

    // 热门内容分析：先热门快照再选少量视频取 Transcript
    const popularDeep = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        c.expected.must_require.includes("popular_video_candidates") &&
        c.expected.must_require.includes("transcript"),
    );
    expect(popularDeep).toBeDefined();

    // 明确排行榜：热门 Tool 不是分区榜单，继续报告能力缺口
    const rankingGap = cases.filter((c) =>
      (c.expected.capability_gap ?? []).includes("trending_ranking"),
    );
    expect(
      rankingGap.length,
      "热门 Tool 上线后仍应保留榜单缺口 case（分区榜单无能力）",
    ).toBeGreaterThanOrEqual(2);

    // 趋势边界：单次热门/搜索快照不能证明持续变化
    const trendGap = cases.filter((c) =>
      (c.expected.capability_gap ?? []).includes("historical_trend_data"),
    );
    expect(
      trendGap.length,
      "热门快照上线后仍应保留趋势边界 case",
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * M8 批次 B：当前热搜路由覆盖度。
   * 守护热搜 quick 快照 / 热搜词→搜索两步流程两条关键判定，
   * 防止后续改动丢失热搜来源边界（AGENTS_M8 §15.5 第 3/4 条）。
   */
  it("M8 当前热搜覆盖：quick 快照 / 热搜词进入主题研究两步流程", () => {
    // 热搜 quick：只需 hot_search_topics，不自动展开搜索也不深入视频
    const hotSearchQuick = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        c.expected.depth === "quick" &&
        c.expected.must_require.includes("hot_search_topics"),
    );
    expect(hotSearchQuick).toBeDefined();
    expect(hotSearchQuick!.expected.must_not_default).toContain("video_candidates");

    // 从热搜选一个词进入主题研究：hot_search_topics + video_candidates 两步
    const hotSearchResearch = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        c.expected.must_require.includes("hot_search_topics") &&
        c.expected.must_require.includes("video_candidates"),
    );
    expect(hotSearchResearch).toBeDefined();
  });

  /**
   * M8 批次 C：关联推荐路由覆盖度。
   * 守护给定视频继续发现 / 单视频正文问题不误触发两条关键判定，
   * 防止后续改动丢失关联推荐来源边界。
   */
  it("M8 关联推荐覆盖：给定视频继续发现 / 单视频正文问题不误触发", () => {
    // 给定视频且目标是继续发现：must_require 含 related_video_candidates
    const relatedDiscovery = cases.find(
      (c) =>
        c.expected.primary_intent === "topic_research" &&
        c.expected.must_require.includes("related_video_candidates"),
    );
    expect(relatedDiscovery).toBeDefined();
    expect(relatedDiscovery!.expected.must_not_default).toContain("transcript");

    // 给定视频但问题针对正文：仍走 content_learn，不误触发关联推荐
    const singleVideoNoRelated = cases.find(
      (c) =>
        c.expected.primary_intent === "content_learn" &&
        c.expected.must_not_default.includes("related_video_candidates"),
    );
    expect(singleVideoNoRelated).toBeDefined();
    expect(singleVideoNoRelated!.expected.must_require).toContain("transcript");
  });
});
