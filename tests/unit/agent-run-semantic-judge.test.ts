/**
 * eval/semantic-judge.ts 单元测试。
 *
 * 覆盖：
 * - SemanticCriterionSchema 严格校验；
 * - buildJudgePrompt 稳定生成（相同输入产生相同输出 + 包含关键字段）；
 * - summarizeJudgeResult 按 threshold 通过/失败判定；
 * - runSemanticJudgeWithLLM 用 mock LLM 注入结果解析；
 * - runSemanticJudgeWithLLM 在 LLM 返回非 JSON 时抛错。
 */
import { describe, expect, it } from "vitest";
import {
  SemanticCriterionSchema,
  SemanticJudgeResultSchema,
  buildJudgePrompt,
  runSemanticJudgeWithLLM,
  summarizeJudgeResult,
  type JudgeCaseContext,
  type JudgeRunContext,
} from "../../eval/semantic-judge.js";

function makeCase(
  overrides: Partial<JudgeCaseContext> = {},
): JudgeCaseContext {
  return {
    caseId: "test-case",
    category: "content_summary",
    userRequest: "帮我总结视频",
    expectedRequiredActions: ["调用 subtitle"],
    expectedForbiddenBehaviors: ["不要 default 要 comments"],
    criteria: [
      {
        name: "中心性归纳",
        description: "是否围绕中心问题归纳",
        threshold: 0.7,
      },
      {
        name: "时间锚定",
        description: "是否标注字幕时间",
        threshold: 0.5,
      },
    ],
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<JudgeRunContext> = {},
): JudgeRunContext {
  return {
    caseId: "test-case",
    prompt: "帮我总结视频",
    toolTrace: [
      { tool: "metadata", outcome: "success" },
      { tool: "subtitle", outcome: "success" },
    ],
    finalAnswer: "作者在 03:15 提出了核心结论。",
    ...overrides,
  };
}

describe("SemanticCriterionSchema", () => {
  it("合法输入通过", () => {
    const c = SemanticCriterionSchema.parse({
      name: "X",
      description: "Y",
      threshold: 0.7,
    });
    expect(c.name).toBe("X");
  });

  it("threshold 必须 0-1", () => {
    expect(() =>
      SemanticCriterionSchema.parse({ name: "X", description: "Y", threshold: 1.5 }),
    ).toThrow();
    expect(() =>
      SemanticCriterionSchema.parse({ name: "X", description: "Y", threshold: -0.1 }),
    ).toThrow();
  });

  it("严格模式：未知字段被拒绝", () => {
    expect(() =>
      SemanticCriterionSchema.parse({
        name: "X",
        description: "Y",
        threshold: 0.5,
        extra: "z",
      }),
    ).toThrow();
  });
});

describe("buildJudgePrompt", () => {
  it("稳定生成：相同输入产生相同输出", () => {
    const c = makeCase();
    const r = makeRun();
    const a = buildJudgePrompt(c, r);
    const b = buildJudgePrompt(c, r);
    expect(a).toBe(b);
  });

  it("包含 case 关键信息", () => {
    const c = makeCase({ caseId: "my-case", category: "my-cat" });
    const r = makeRun();
    const prompt = buildJudgePrompt(c, r);
    expect(prompt).toContain("my-case");
    expect(prompt).toContain("my-cat");
  });

  it("包含 final_answer", () => {
    const c = makeCase();
    const r = makeRun({ finalAnswer: "特别标识 ABC123XYZ" });
    const prompt = buildJudgePrompt(c, r);
    expect(prompt).toContain("ABC123XYZ");
  });

  it("包含每个 criterion 名称和阈值", () => {
    const c = makeCase();
    const r = makeRun();
    const prompt = buildJudgePrompt(c, r);
    expect(prompt).toContain("中心性归纳");
    expect(prompt).toContain("阈值 0.7");
    expect(prompt).toContain("时间锚定");
    expect(prompt).toContain("阈值 0.5");
  });

  it("包含工具调用 trace", () => {
    const c = makeCase();
    const r = makeRun({ toolTrace: [{ tool: "metadata", outcome: "success" }] });
    const prompt = buildJudgePrompt(c, r);
    expect(prompt).toContain("metadata [success]");
  });

  it("空 criteria 时显示「未声明 semantic_criteria」", () => {
    const c = makeCase({ criteria: [] });
    const r = makeRun();
    const prompt = buildJudgePrompt(c, r);
    expect(prompt).toMatch(/未声明 semantic_criteria/);
  });
});

describe("summarizeJudgeResult", () => {
  it("所有维度达到阈值即通过", () => {
    const c = makeCase();
    const result = SemanticJudgeResultSchema.parse({
      scores: { 中心性归纳: 0.9, 时间锚定: 0.6 },
      rationale: "ok",
    });
    const summary = summarizeJudgeResult(result, c.criteria);
    expect(summary.passed).toBe(true);
    expect(summary.failedCriteria).toEqual([]);
  });

  it("任一维度低于阈值则失败", () => {
    const c = makeCase();
    const result = SemanticJudgeResultSchema.parse({
      scores: { 中心性归纳: 0.9, 时间锚定: 0.3 },
    });
    const summary = summarizeJudgeResult(result, c.criteria);
    expect(summary.passed).toBe(false);
    expect(summary.failedCriteria).toEqual(["时间锚定"]);
  });

  it("缺失分数视为 0（未通过）", () => {
    const c = makeCase();
    const result = SemanticJudgeResultSchema.parse({
      scores: { 中心性归纳: 0.9 },
    });
    const summary = summarizeJudgeResult(result, c.criteria);
    expect(summary.failedCriteria).toEqual(["时间锚定"]);
  });
});

describe("runSemanticJudgeWithLLM", () => {
  it("接受合法 JSON 返回", async () => {
    const c = makeCase();
    const r = makeRun();
    const result = await runSemanticJudgeWithLLM(c, r, {
      call: async () =>
        JSON.stringify({
          scores: { 中心性归纳: 0.85, 时间锚定: 0.6 },
          rationale: "ok",
        }),
    });
    expect(result.scores["中心性归纳"]).toBe(0.85);
  });

  it("接受 markdown 包裹的 JSON", async () => {
    const c = makeCase();
    const r = makeRun();
    const result = await runSemanticJudgeWithLLM(c, r, {
      call: async () =>
        "```json\n" +
        JSON.stringify({ scores: { 中心性归纳: 0.5, 时间锚定: 0.5 } }) +
        "\n```",
    });
    expect(result.scores["中心性归纳"]).toBe(0.5);
  });

  it("LLM 返回非 JSON 抛错", async () => {
    const c = makeCase();
    const r = makeRun();
    await expect(
      runSemanticJudgeWithLLM(c, r, {
        call: async () => "不是 JSON 啊",
      }),
    ).rejects.toThrow(/非 JSON/);
  });

  it("LLM 返回 JSON 缺 scores 字段抛错（schema 拒绝）", async () => {
    const c = makeCase();
    const r = makeRun();
    await expect(
      runSemanticJudgeWithLLM(c, r, {
        call: async () => JSON.stringify({ rationale: "no scores" }),
      }),
    ).rejects.toThrow();
  });
});
