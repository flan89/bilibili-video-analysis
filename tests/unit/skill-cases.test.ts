import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VerificationSchema } from "../../eval/index.js";
import { SemanticCriterionSchema } from "../../eval/index.js";

/**
 * M1 Skill 行为评估的 category 集合。
 *
 * 三个 content_learn 的细分子类按 references/analysis/content-learn.md
 * §4 中已经定义的专业阅读策略划分，区分不同 Focus 的实际行为差异
 * （CODEX_IMPLEMENTATION_NOTES.md §4 要求）。
 */
const SkillCaseCategorySchema = z.enum([
  // 通用 content_learn 场景
  "content_summary",
  "tutorial_steps",
  "focused_question",
  // 三个 Focus 强化子类
  "high_value_knowledge",
  "viewpoint_curation",
  "tool_scenario_mapping",
  // 降级 / 异常分支
  "multipart_selection",
  "subtitle_missing",
  "subtitle_partial",
  "tool_failure",
  // M3 audience_insight 子类 (M3 Stage 3)
  "audience_discussion_topics",
  "audience_resonance",
  // M5 visual_decode 子类 (M5.2)
  "visual_editing_rhythm",
  "visual_ppt_layout",
  "visual_targeted_question",
  // M5.3 跨 Intent 协同 (M5.3)
  "content_learn_cross_intent",
  // M4 market_research 5 条 (M4)
  "market_pain_discovery",
  "market_competitor_landscape",
  "market_purchase_intent",
  "market_coverage_rejection",
  "market_cross_source_alignment",
  // M4.1 market_research Focus 拆分 (M4.1)
  "market_generic_purchase_intent",
  "market_latest_purchase_intent",
  "market_realtime_reaction_alignment",
  "market_creator_feedback_alignment",
  "market_full_cross_source",
  // M6 跨 Intent 协同 (M6)
  "cross_intent_content_visual",
  "cross_intent_content_audience",
  "cross_intent_content_market",
  "cross_intent_four_ultimate",
  "cross_intent_one_source_failed",
  // M6 降级 / 主动停止 (M6)
  "degrade_subtitle_failure",
  "degrade_danmaku_empty",
  "stop_insufficient_coverage",
  // M7 topic_research 场景 (M7 批次 B)
  "topic_quick_finding",
  "topic_standard_research",
  "topic_search_empty",
  "topic_search_risk_control",
  "topic_audience_question",
  "topic_visual_question",
  "topic_market_combo",
  // M7 V1 回归 (M7 批次 B)
  "single_video_v1_regression",
  // M8 当前热门场景 (M8 批次 A)
  "popular_snapshot_stop",
  "popular_deep_dive",
  "popular_source_failure",
  "popular_trend_boundary",
  // M8 当前热搜场景 (M8 批次 B)
  "hot_search_faithful_list",
  "hot_search_single_word_dive",
  // M8 关联推荐场景 (M8 批次 C)
  "related_no_recursion",
  "related_failure_no_substitution",
]);

/**
 * 已声明的 verification 工具名集合，与
 * eval/verification.ts 的 VERIFIABLE_TOOL_NAMES 保持一致。
 */
const VERIFIABLE_TOOL_NAMES = new Set([
  // M7 新增：视频搜索 Tool（CLI 名 search-videos，归一化为 search）。
  "search",
  // M8 新增：当前热门 Tool（CLI 名 popular-videos，归一化为 popular）。
  "popular",
  // M8 批次 B 新增：当前热搜 Tool（CLI 名 hot-searches，归一化为 hot-search）。
  "hot-search",
  // M8 批次 C 新增：关联推荐 Tool（CLI 名 related-videos，归一化为 related）。
  "related",
  "metadata",
  "subtitle",
  "comments",
  "replies",
  "danmaku",
  "video",
  "frames",
  "audio",
  "timeline",
  "cover",
]);

const SkillCaseSchema = z.object({
  /** 稳定案例编号，供人工或 Agent 验收记录引用。 */
  id: z.string().min(1),
  /** 当前 M1 必须覆盖的内容学习或降级分支。 */
  category: SkillCaseCategorySchema,
  /**
   * 真实视频案例、注入固定 Tool 结果的边界案例，或 M7 主题型请求（无给定视频）。
   * 注意: M7 的空结果 / 风控行为测试属于 fixture_result (注入固定搜索结果),
   * 不依赖真实网络偶发的 missing / 412, 保证可重复执行.
   */
  execution: z.enum(["real_video", "fixture_result", "real_topic"]),
  /** 当前可用于重复执行真实验收的公开视频；平台变化后允许替换。 */
  sample_video: z.string().url().optional(),
  /** 测试样本目标分P的 cid，只供记录和核对，不注入自然用户请求。 */
  sample_cid: z.string().min(1).optional(),
  /**
   * `{{video}}` 在执行时替换为目标视频 URL 或 BV号。
   * 注入固定结果的主题型行为测试没有给定视频，不含占位符。
   */
  user_request: z.string().min(1),
  /** 该案例需要提供给 Agent 的字幕 Tool 结果类型。 */
  tool_outcome: z.enum([
    "success",
    "selection_required",
    "missing",
    "success_partial",
    "failed",
  ]),
  expected: z.object({
    /** Agent 为完成用户目标必须表现出的可观察行为。 */
    required_actions: z.array(z.string().min(1)).min(1),
    /** 代表越界、虚构或没有完成闭环的行为。 */
    forbidden_behaviors: z.array(z.string().min(1)).min(1),
  }).strict(),
  /**
   * 结构化 verification 字段（P1-1）。
   * 未声明时 verify 工具走自然语言 fallback；
   * 声明时优先按本字段的强类型规则做确定性检查。
   */
  verification: VerificationSchema.optional(),
  /**
   * 语义评分维度（P1-3）。
   * 未声明时跳过 LLM Judge；声明时 verify 工具会标记为 pending。
   */
  semantic_criteria: z.array(SemanticCriterionSchema).optional(),
}).strict();

function loadSkillCases(): unknown {
  const url = new URL("../skill-cases.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}

describe("M1 Skill 行为评估案例", () => {
  it("50 条案例覆盖：M1 content_learn 三个正向 + 三个 Focus 子类 + 全部必要降级分支 + M3 audience_insight 两个 Focus + M5.3 跨 Intent 协同 + M4 market_research 5 条 + M4.1 Positive-path 5 条 + M6 跨 Intent 4 + 降级 2 + 停止 1 + M7 topic_research 7 + V1 回归 1 + M8 当前热门 4 + M8 当前热搜 2 + M8 关联推荐 2", () => {
    const cases = z.array(SkillCaseSchema).length(50).parse(loadSkillCases());
    const ids = new Set(cases.map((item) => item.id));
    const categories = new Set(cases.map((item) => item.category));

    expect(ids.size).toBe(cases.length);
    expect(categories).toEqual(new Set(SkillCaseCategorySchema.options));
    expect(cases.filter((item) => item.execution === "real_video")).toHaveLength(29);
    expect(
      cases
        .filter((item) => item.execution === "real_video")
        .every((item) => item.sample_video),
    ).toBe(true);
    // 声明了 sample_video 的 case 必须含 {{video}} 占位符 (执行时要替换成真实视频);
    // 反向不强制: fixture_result 既可以是注入固定结果的行为测试 (不含占位符),
    // 也可以是占位符注入演示 (含占位符), 两种形态都允许.
    for (const c of cases) {
      if (c.sample_video !== undefined) {
        expect(
          c.user_request.includes("{{video}}"),
          `case ${c.id} (${c.execution}) 声明了 sample_video 但 user_request 缺 {{video}} 占位符`,
        ).toBe(true);
      }
    }
  });

  it("三个 Focus 强化子类必须存在，且期望覆盖全片（quick 任务除外）", () => {
    const cases = z.array(SkillCaseSchema).length(50).parse(loadSkillCases());
    const focusCases = cases.filter((item) =>
      ["high_value_knowledge", "viewpoint_curation", "tool_scenario_mapping"].includes(
        item.category,
      ),
    );
    expect(focusCases).toHaveLength(3);

    // 这三类 Focus 都依赖全片判断，不允许退化为局部扫描。
    for (const c of focusCases) {
      const allActions = [
        ...c.expected.required_actions,
        ...c.expected.forbidden_behaviors,
      ].join(" / ");
      expect(
        allActions.includes("全片") || allActions.includes("覆盖全片"),
        `case ${c.id} (${c.category}) 应明确全片覆盖`,
      ).toBe(true);
    }
  });

  it("声明 verification 字段的 case：工具名必须在白名单内", () => {
    const cases = z.array(SkillCaseSchema).length(50).parse(loadSkillCases());
    for (const c of cases) {
      if (!c.verification) continue;
      for (const t of [
        ...c.verification.mustCallTools,
        ...c.verification.mustNotCallTools,
      ]) {
        expect(
          VERIFIABLE_TOOL_NAMES.has(t),
          `case ${c.id} verification 中含未知工具名：${t}`,
        ).toBe(true);
      }
    }
  });

  /**
   * CODEX §2.1：普通 content_learn 不应强制调用 Metadata。
   * Subtitle Tool 内部已获取"定位字幕"所需的最小 metadata（DECISIONS D25），
   * 不应让 Eval 反过来奖励 over-fetch。
   * 例外：focused-question 已经被 cover；subtitle-missing 已在 Phase A 修过。
   * 真正需要 metadata 的 case（如基于标题的封面分析）应显式声明。
   */
  it("普通 content_learn case 不强制调用 metadata", () => {
    const cases = z.array(SkillCaseSchema).length(50).parse(loadSkillCases());
    const pureContentLearnCases = cases.filter(
      (c) =>
        c.category !== "subtitle_missing" &&
        c.category !== "tutorial_steps" &&
        c.category !== "multipart_selection" &&
        c.category !== "subtitle_partial" &&
        c.category !== "tool_failure" &&
        c.verification !== undefined,
    );
    expect(pureContentLearnCases.length).toBeGreaterThan(0);
    for (const c of pureContentLearnCases) {
      // mustCallTools 不能包含 metadata，除非 case acceptance_note 显式解释
      const hasMetadata = c.verification!.mustCallTools.includes("metadata");
      if (hasMetadata) {
        const note =
          c.expected.required_actions.join(" / ") +
          " " +
          c.expected.forbidden_behaviors.join(" / ") +
          " " +
          ((c.verification as { acceptance_note?: string }).acceptance_note ?? "");
        expect(
          /标题|简介|author|发布|tag|作者|封面|cover|meta/i.test(note),
          `case ${c.id} mustCallTools 包含 metadata 但 expected 中未明确说明为什么需要 metadata`,
        ).toBe(true);
      }
    }
  });

  /**
   * M3 Stage 3: audience_insight case 验证
   *  - 必须调 comments 或 danmaku (不调 subtitle)
   *  - mustCallTools / mustNotCallTools 不冲突
   *  - audience case 的 tool_outcome 都是 success (受 Tool Availability 限制)
   */
  it("audience case 必调 comments 或 danmaku, 不调 subtitle", () => {
    const cases = z.array(SkillCaseSchema).length(50).parse(loadSkillCases());
    const audienceCases = cases.filter((item) =>
      item.id.startsWith("audience-"),
    );
    expect(audienceCases.length).toBeGreaterThanOrEqual(2);
    for (const c of audienceCases) {
      const must = c.verification?.mustCallTools ?? [];
      expect(
        must.includes("comments") || must.includes("danmaku"),
        `case ${c.id} audience case 必须调 comments 或 danmaku, 实际: ${must.join(",")}`,
      ).toBe(true);
      expect(
        !must.includes("subtitle"),
        `case ${c.id} audience case 不应把 subtitle 当作必调 (audience 是用户层, 不是作者层)`,
      ).toBe(true);
    }
  });

  it("audience case 的 mustCallTools / mustNotCallTools 不冲突", () => {
    const cases = z.array(SkillCaseSchema).length(50).parse(loadSkillCases());
    const audienceCases = cases.filter((item) =>
      item.id.startsWith("audience-"),
    );
    for (const c of audienceCases) {
      if (!c.verification) continue;
      const must = new Set(c.verification.mustCallTools);
      const mustNot = new Set(c.verification.mustNotCallTools);
      for (const t of must) {
        expect(
          !mustNot.has(t),
          `case ${c.id} mustCallTools / mustNotCallTools 冲突: ${t}`,
        ).toBe(true);
      }
    }
  });
});
